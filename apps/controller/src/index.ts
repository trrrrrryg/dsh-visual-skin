import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { z, ZodError } from "zod";
import { DesignSessionCore, AppError, canonicalHash, type ConfirmationBinding } from "@dsh-skin/design-session-core";
import { ERROR_CODES, type ApiErrorBody, type ControllerStatus, type DesignChangedEvent } from "@dsh-skin/shared";
import { mergeThemeSpec, parseThemeSpec, type ThemeSpec } from "@dsh-skin/theme-schema";
import { detectCapabilities, getPluginSecret, installPlugin, planInstall, targetKey, uninstallPlugin, writeActiveTheme, type ActiveThemeDocument, type DshTarget } from "./dsh.js";
import { startGarbageCollector } from "./gc.js";
import { openExternal } from "./open.js";
import { AssetService, MAX_BACKGROUND_ASSET_BASE64_CHARS, MAX_BACKGROUND_ASSET_REQUEST_BYTES } from "./assets.js";
import { detectDshRuntime } from "./runtime.js";
import { PreviewRuntime } from "./preview-runtime.js";

const host = "127.0.0.1";
const requestedPort = numberEnv("DSH_SKIN_PORT", 0);
const dataDir = process.env.DSH_SKIN_DATA_DIR || join(process.env.LOCALAPPDATA || homedir(), "DeepSeekHarnessSkinStudio");
const defaultDshHome = process.env.DSH_HOME || join(homedir(), ".dsh");
const core = new DesignSessionCore(dataDir);
const stopGarbageCollector = startGarbageCollector(core);
const assets = new AssetService(dataDir);
const csrfToken = randomBytes(32).toString("base64url");
const instanceId = randomUUID();
const studioDist = resolve(fileURLToPath(new URL("../../studio/dist", import.meta.url)));
const sseClients = new Set<ServerResponse>();
const FETCH_BLOCKED_PORTS = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080]);
let actualPort = requestedPort;
const previewRuntime = new PreviewRuntime(core, { controllerUrl: studioUrl, controllerInstanceId: () => instanceId, changed: (session) => publish({ type: "preview.session.changed", session }, "preview.session.changed") });

const server = createServer(async (req, res) => {
  setSecurityHeaders(res);
  try {
    enforceHost(req);
    const url = new URL(req.url || "/", `http://${req.headers.host || `${host}:${actualPort}`}`);
    // Studio can survive a Controller restart, a browser tab restore, or a
    // direct navigation to an API-backed route. Refresh the same-origin
    // browser session on every non-plugin GET so the later visible
    // confirmation request is not rejected merely because the initial HTML
    // response was cached or the old cookie expired. Host/plugin routes stay
    // private and never receive a browser session cookie.
    if (req.method === "GET" && !isPluginPrivatePath(url.pathname)) await establishBrowserSession(req, res);
    if (url.pathname.startsWith("/api/")) {
      await routeApi(req, res, url);
    } else {
      await serveStudio(req, res, url.pathname);
    }
  } catch (error) {
    sendError(res, error);
  }
});

if (requestedPort !== 0 && !isFetchSafePort(requestedPort)) throw new Error(`DSH_SKIN_PORT ${requestedPort} is blocked by browser/Fetch port safety rules`);
listenController();

function listenController(): void {
  server.listen(requestedPort, host, () => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    // `listen(0)` can legitimately choose a port prohibited by Fetch (for
    // example 6000 or 6667). Do not publish it; bind another ephemeral port.
    if (!isFetchSafePort(port)) {
      server.close((error) => { if (error) throw error; listenController(); });
      return;
    }
    actualPort = port;
    const url = studioUrl();
    void previewRuntime.reconcile().then(() => core.store.write("controller-discovery.json", { instanceId, url, pid: process.pid, startedAt: new Date().toISOString() }))
      .then(() => process.stdout.write(`DeepSeek Harness Skin Studio: ${url}\n`))
      .catch((error) => { process.stderr.write(`Controller discovery publish failed: ${String(error)}\n`); server.close(() => process.exitCode = 1); });
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { stopGarbageCollector(); void previewRuntime.stopAll().finally(() => server.close(() => process.exit(0))); });
}

async function routeApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method || "GET";
  const pluginPrivate = url.pathname.startsWith("/api/v1/plugin/preview") || url.pathname === "/api/v1/plugin/theme/ack" || /^\/api\/v1\/preview-sessions\/[0-9a-f-]+\/host\//.test(url.pathname);
  if (method !== "GET" && method !== "HEAD" && !pluginPrivate) enforceMutation(req);

  if (method === "GET" && url.pathname === "/api/v1/status") {
    const [capabilities, dsh, previewSessions] = await Promise.all([detectCapabilities(defaultDshHome), detectDshRuntime(defaultDshHome), previewRuntime.list()]);
    const live = previewSessions.find((session) => session.state === "live");
    dsh.preview = live ? "live" : "studio-only";
    if (live) { dsh.previewDesignId = live.designId; dsh.previewRevision = live.revision; dsh.previewHash = live.hash; }
    const body: ControllerStatus = {
      ok: true, version: "0.1.0", studioUrl: studioUrl(), csrfToken, instanceId, capabilities, dsh, previewSessions
    };
    return json(res, 200, body);
  }
  if (method === "POST" && url.pathname === "/api/v1/studio/start") return json(res, 200, { running: true, url: studioUrl() });
  if (method === "POST" && url.pathname === "/api/v1/studio/open") return json(res, 200, await openExternal(studioUrl()));
  if (method === "POST" && (url.pathname === "/api/v1/session/design" || url.pathname === "/api/v1/design")) {
    const body = createDesignSchema.parse(await bodyJson(req));
    if (body.theme !== undefined) await ensureThemeAsset(parseThemeSpec(body.theme));
    const input = { ...(body.name === undefined ? {} : { name: body.name }), ...(body.theme === undefined ? {} : { theme: body.theme }) };
    const created = await core.createDesign(input);
    publish({ type: "design.changed", designId: created.id, revision: created.revision, actor: actorFrom(req) } satisfies DesignChangedEvent, "design");
    return json(res, 201, created);
  }

  if (method === "GET" && url.pathname === "/api/v1/designs") return json(res, 200, { designs: await core.listDesigns() });

  if (method === "POST" && url.pathname === "/api/v1/assets") {
    const body = assetUploadSchema.parse(await bodyJson(req, MAX_BACKGROUND_ASSET_REQUEST_BYTES));
    return json(res, 201, await assets.upload(body));
  }
  const assetMatch = /^\/api\/v1\/assets\/(sha256-[0-9a-f]{64})$/.exec(url.pathname);
  if (assetMatch && method === "GET") {
    const asset = await assets.get(assetMatch[1]!);
    res.writeHead(200, { "content-type": asset.record.mimeType, "content-length": asset.record.bytes, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" });
    res.end(asset.bytes); return;
  }

  const duplicateMatch = /^\/api\/v1\/design\/([0-9a-f-]+)\/duplicate$/.exec(url.pathname);
  if (duplicateMatch && method === "POST") {
    const body = duplicateSchema.parse(await bodyJson(req));
    const created = await core.duplicateDesign(duplicateMatch[1]!, body.name, body.patchId);
    publish({ type: "design.changed", designId: created.id, revision: created.revision, actor: body.actor, ...(body.patchId ? { patchId: body.patchId } : {}) } satisfies DesignChangedEvent, "design");
    return json(res, 201, created);
  }
  const renameMatch = /^\/api\/v1\/design\/([0-9a-f-]+)\/rename$/.exec(url.pathname);
  if (renameMatch && method === "POST") {
    const body = renameSchema.parse(await bodyJson(req));
    const updated = await core.renameDesign(renameMatch[1]!, body.baseRevision, body.name, body.patchId);
    publish({ type: "design.changed", designId: updated.id, revision: updated.revision, actor: body.actor, ...(body.patchId ? { patchId: body.patchId } : {}) } satisfies DesignChangedEvent, "design");
    return json(res, 200, updated);
  }

  const designMatch = /^\/api\/v1\/design\/([0-9a-f-]+)$/.exec(url.pathname);
  if (designMatch && method === "GET") return json(res, 200, await core.getDesign(designMatch[1]!));
  if (designMatch && method === "DELETE") {
    await core.withResourceLock("apply-web", async () => core.deleteDesign(designMatch[1]!, await protectedDesignIds()));
    return json(res, 200, { deleted: true, designId: designMatch[1] });
  }
  if (designMatch && method === "PATCH") {
    const body = patchDesignSchema.parse(await bodyJson(req));
    const current = await core.getDesign(designMatch[1]!);
    if (current.revision === body.baseRevision) await ensureThemeAsset(mergeThemeSpec(current.theme, body.patch));
    const updated = await core.patchDesign(designMatch[1]!, body.baseRevision, body.patch, body.patchId);
    publish({ type: "design.changed", designId: updated.id, revision: updated.revision, actor: body.actor, ...(body.patchId ? { patchId: body.patchId } : {}) } satisfies DesignChangedEvent, "design");
    await previewRuntime.updateForDesign(updated.id, updated.revision);
    return json(res, 200, updated);
  }
  if (method === "POST" && url.pathname === "/api/v1/theme/validate") {
    const validated = core.validateTheme((await bodyJson(req) as { theme?: unknown }).theme);
    await ensureThemeAsset(validated.theme);
    return json(res, 200, validated);
  }
  if (method === "POST" && url.pathname === "/api/v1/preview-sessions") {
    const body = previewStartSchema.parse(await bodyJson(req));
    const design = await requireRevision(body.designId, body.revision); await ensureThemeAsset(design.theme);
    const session = await previewRuntime.create(design.id, design.revision);
    return json(res, 202, { session, operationId: session.operationId, state: session.state, mode: "isolated-dsh-draft", dshInjected: false });
  }
  if (method === "GET" && url.pathname === "/api/v1/preview-sessions") return json(res, 200, { sessions: await previewRuntime.list() });
  const isolatedPreviewMatch = /^\/api\/v1\/preview-sessions\/([0-9a-f-]+)$/.exec(url.pathname);
  if (isolatedPreviewMatch && method === "GET") return json(res, 200, { session: await previewRuntime.get(isolatedPreviewMatch[1]!) });
  if (isolatedPreviewMatch && method === "POST") { const body = previewStartSchema.parse(await bodyJson(req)); const design = await requireRevision(body.designId, body.revision); await ensureThemeAsset(design.theme); return json(res, 202, { session: await previewRuntime.update(isolatedPreviewMatch[1]!, design.id, design.revision) }); }
  if (isolatedPreviewMatch && method === "DELETE") return json(res, 200, { session: await previewRuntime.stop(isolatedPreviewMatch[1]!) });
  const isolatedHostMatch = /^\/api\/v1\/preview-sessions\/([0-9a-f-]+)\/host\/(state|rendered)$/.exec(url.pathname);
  if (isolatedHostMatch && isolatedHostMatch[2] === "state" && method === "GET") return json(res, 200, await previewRuntime.hostState(isolatedHostMatch[1]!, pluginBearer(req)));
  if (isolatedHostMatch && isolatedHostMatch[2] === "rendered" && method === "POST") return json(res, 202, { accepted: true, session: await previewRuntime.acknowledge(isolatedHostMatch[1]!, pluginBearer(req), isolatedRenderAckSchema.parse(await bodyJson(req))) });

  // Legacy aliases intentionally start/stop disposable isolated previews.
  if (method === "POST" && url.pathname === "/api/v1/preview/start") {
    const body = previewStartSchema.parse(await bodyJson(req)); const design = await requireRevision(body.designId, body.revision); await ensureThemeAsset(design.theme);
    const session = await previewRuntime.create(design.id, design.revision);
    return json(res, 202, { session, operationId: session.operationId, state: session.state, mode: "isolated-dsh-draft", dshInjected: false });
  }
  if (method === "POST" && url.pathname === "/api/v1/preview/snapshot") {
    const body = designRevisionSchema.parse(await bodyJson(req));
    const design = await requireRevision(body.designId, body.revision);
    return json(res, 200, { designId: design.id, revision: design.revision, theme: design.theme });
  }
  if (method === "POST" && url.pathname === "/api/v1/preview/stop") { previewStopSchema.parse(await bodyJson(req)); await previewRuntime.stopAll(); return json(res, 200, { stopped: true, restored: "isolated-preview-removed" }); }

  if (method === "GET" && url.pathname === "/api/v1/plugin/preview") {
    const profile = profileSchema.parse(url.searchParams.get("profile") || "web");
    await authorizePlugin(req, profile);
    const preview = await core.getPreview(profile);
    return json(res, 200, { instanceId, session: preview && ["pending", "live"].includes(preview.state) ? preview : null });
  }
  if (method === "POST" && url.pathname === "/api/v1/plugin/preview/ack") {
    const body = pluginAckSchema.parse(await bodyJson(req)); await authorizePlugin(req, body.profile); assertControllerInstance(body.controllerInstanceId);
    if (body.mode !== "preview") throw new AppError(ERROR_CODES.conflict, "Preview acknowledgement mode is invalid", 409);
    const preview = await core.ackPreview(body.profile, body.designId, body.revision, body.hash, body.pluginInstanceId, body.clientInstanceId);
    await finalizeMatchingOperations("preview", body.profile, body.designId, body.revision, body.hash, body.pluginInstanceId);
    return json(res, 200, { accepted: true, state: preview.state });
  }
  if (method === "POST" && url.pathname === "/api/v1/plugin/theme/ack") {
    const body = pluginAckSchema.parse(await bodyJson(req)); await authorizePlugin(req, body.profile); assertControllerInstance(body.controllerInstanceId);
    if (body.mode !== "stable") throw new AppError(ERROR_CODES.conflict, "Stable acknowledgement mode is invalid", 409);
    await finalizeMatchingOperations("stable", body.profile, body.designId, body.revision, body.hash, body.pluginInstanceId);
    return json(res, 200, { accepted: true });
  }

  if (method === "POST" && url.pathname === "/api/v1/theme/apply-plan") {
    const body = applyPlanSchema.parse(await bodyJson(req));
    const design = await requireRevision(body.designId, body.revision);
    await ensureThemeAsset(design.theme);
    const target = normalizeTarget(body.target);
    const receipt = await previewRuntime.requireLiveReceipt(body.previewSessionId, body.previewGeneration, body.renderReceiptHash, design.id, design.revision, canonicalHash(design.theme));
    const current = await core.store.read<ActiveThemeDocument>(`active/${target.profile}.json`);
    const binding = await buildConfirmationBinding("apply", design.id, design.revision, target, body.installPlugin, receipt);
    return json(res, 200, {
      designId: design.id,
      revision: design.revision,
      target: { profile: target.profile },
      compatible: (await detectCapabilities(target.dshHome)).compatible,
      plugin: sanitizeInstallPlan(await planInstall(target)),
      diff: diffValues(current?.theme, design.theme),
      planHash: binding.planHash,
      // This is the immutable binding echoed by the Studio and later passed to
      // confirm-and-apply. Keep the public plan contract identical to the
      // request/confirmation schema; otherwise a valid live receipt is
      // rejected by the Studio's fail-closed comparison.
      preview: { previewSessionId: receipt.id, previewGeneration: receipt.generation, renderReceiptHash: receipt.renderReceiptHash },
      confirmationRequired: true,
      restartRequired: true
    });
  }
  if (method === "POST" && url.pathname === "/api/v1/theme/restore-plan") {
    const body = restorePlanSchema.parse(await bodyJson(req));
    await requireRevision(body.designId, body.revision);
    const target = normalizeTarget(body.target);
    const current = await core.store.read<ActiveThemeDocument>(`active/${target.profile}.json`);
    const restore = await core.store.read<{ active: ActiveThemeDocument | null; applied: unknown; pluginInstalled: boolean }>(`restore-state/${target.profile}.json`);
    if (!restore) throw new AppError(ERROR_CODES.notFound, "No managed restore point exists", 404);
    const binding = await buildConfirmationBinding("restore", body.designId, body.revision, target, false);
    return json(res, 200, {
      action: "restore",
      designId: body.designId,
      revision: body.revision,
      target: { profile: target.profile },
      compatible: (await detectCapabilities(target.dshHome)).compatible,
      restores: restore.pluginInstalled ? "managed" : "official",
      diff: diffValues(current?.theme, restore.active?.theme),
      planHash: binding.planHash,
      confirmationRequired: true,
      restartRequired: true
    });
  }
  if (method === "POST" && url.pathname === "/api/v1/theme/confirm-and-apply") {
    const body = applySchema.parse(await bodyJson(req)); const target = normalizeTarget(body.target);
    return json(res, 202, await performApply(req, body, target, true));
  }
  if (method === "POST" && url.pathname === "/api/v1/theme/confirm-and-restore") {
    const body = restoreSchema.parse(await bodyJson(req)); const target = normalizeTarget(body.target);
    return json(res, 202, await performRestore(req, body, target, true));
  }
  if (method === "POST" && url.pathname === "/api/v1/theme/apply") {
    const body = applySchema.parse(await bodyJson(req)); const target = normalizeTarget(body.target);
    return json(res, 202, await performApply(req, body, target, false));
  }
  if (method === "POST" && url.pathname === "/api/v1/theme/restore") {
    const body = restoreSchema.parse(await bodyJson(req));
    const target = normalizeTarget(body.target);
    return json(res, 202, await performRestore(req, body, target, false));
  }
  if (method === "POST" && url.pathname === "/api/v1/plugin/plan") {
    const body = targetSchema.parse(await bodyJson(req));
    return json(res, 200, sanitizeInstallPlan(await planInstall(normalizeTarget(body))));
  }
  if (method === "POST" && url.pathname === "/api/v1/plugin/install") {
    const body = pluginActionSchema.parse(await bodyJson(req));
    const design = await requireRevision(body.designId, body.revision);
    await ensureThemeAsset(design.theme);
    const target = normalizeTarget(body.target);
    const runtimeBefore = await detectDshRuntime(target.dshHome);
    const op = await core.startOperation("plugin-install", target.profile);
    try {
      const binding = await buildConfirmationBinding("apply", design.id, design.revision, target, true);
      await core.consumeConfirmation(browserSession(req), binding);
      const plan = await installPlugin(target, dataDir, studioUrl());
      const pending = await core.transitionOperation(op.id, "pending-restart", { expected: { profile: target.profile, revision: 0, hash: "plugin-installed", ...(runtimeBefore.pluginInstanceId ? { previousPluginInstanceId: runtimeBefore.pluginInstanceId } : {}) } }); publish(pending);
      return json(res, 202, { operation: pending, plan: sanitizeInstallPlan(plan) });
    } catch (error) { const done = await core.transitionOperation(op.id, "failed-safe", { error: toRecordError(error) }); publish(done); throw error; }
  }
  if (method === "POST" && url.pathname === "/api/v1/plugin/uninstall") {
    const body = pluginActionSchema.parse(await bodyJson(req));
    await requireRevision(body.designId, body.revision);
    const target = normalizeTarget(body.target);
    const binding = await buildConfirmationBinding("restore", body.designId, body.revision, target, false);
    await core.consumeConfirmation(browserSession(req), binding);
    const op = await core.startOperation("plugin-uninstall", target.profile);
    try { await uninstallPlugin(target, dataDir); const pending = await core.transitionOperation(op.id, "pending-restart", { expected: { profile: target.profile, revision: 0, hash: "official" } }); publish(pending); return json(res, 202, { operation: pending }); }
    catch (error) { const done = await core.transitionOperation(op.id, "failed-safe", { error: toRecordError(error) }); publish(done); throw error; }
  }

  const operationMatch = /^\/api\/v1\/operations\/([0-9a-f-]+)$/.exec(url.pathname);
  if (operationMatch && method === "GET") return json(res, 200, await core.getOperation(operationMatch[1]!));
  const finalizeMatch = /^\/api\/v1\/operations\/([0-9a-f-]+)\/finalize$/.exec(url.pathname);
  if (finalizeMatch && method === "POST") return json(res, 200, await finalizeOperation(finalizeMatch[1]!));
  if (method === "GET" && url.pathname === "/api/v1/events") return events(req, res);
  throw new AppError(ERROR_CODES.notFound, "API route not found", 404);
}

async function requireRevision(id: string, revision: number) {
  const design = await core.getDesign(id);
  if (design.revision !== revision) throw new AppError(ERROR_CODES.conflict, "Design revision is stale", 409, { expectedRevision: design.revision });
  return design;
}

async function buildConfirmationBinding(action: "apply" | "restore", designId: string, revision: number, target: DshTarget, installPlugin: boolean, preview?: { id: string; generation: number; renderReceiptHash?: string }): Promise<ConfirmationBinding> {
  const design = await requireRevision(designId, revision);
  await ensureThemeAsset(design.theme);
  const active = await core.store.read<ActiveThemeDocument>(`active/${target.profile}.json`);
  const installation = await core.store.read(`installations/${target.profile}.json`);
  const secretRecord = await core.store.read(`plugin-secrets/${target.profile}.json`);
  const installed = installation !== null;
  const restore = action === "restore" ? await core.store.read<{ active: ActiveThemeDocument | null; applied: unknown; pluginInstalled: boolean }>(`restore-state/${target.profile}.json`) : null;
  if (action === "restore" && !restore) throw new AppError(ERROR_CODES.notFound, "No managed restore point exists", 404);
  const previewBinding = preview?.renderReceiptHash ? { previewSessionId: preview.id, previewGeneration: preview.generation, renderReceiptHash: preview.renderReceiptHash } : {};
  const immutablePlan = { action, designId, revision, themeHash: canonicalHash(design.theme), targetKey: targetKey(target), profile: target.profile, installPlugin, installed, installationHash: canonicalHash(installation), secretRecordHash: canonicalHash(secretRecord), activeHash: active?.hash ?? "official", ...previewBinding, ...(restore ? { restoreActiveHash: restore.active?.hash ?? "official", restoreAppliedHash: canonicalHash(restore.applied), restorePluginInstalled: restore.pluginInstalled } : {}) };
  return { action, designId, revision, targetKey: immutablePlan.targetKey, profile: target.profile, installPlugin, ...previewBinding, planHash: canonicalHash(immutablePlan) };
}

async function performApply(req: IncomingMessage, body: z.infer<typeof applySchema>, target: DshTarget, atomicConfirmation: boolean) {
  return core.withResourceLock(`apply-${target.profile}`, async () => {
    const design = await requireRevision(body.designId, body.revision);
    await ensureThemeAsset(design.theme);
    const receipt = await previewRuntime.requireLiveReceipt(body.previewSessionId, body.previewGeneration, body.renderReceiptHash, design.id, design.revision, canonicalHash(design.theme));
    const binding = await buildConfirmationBinding("apply", design.id, design.revision, target, body.installPlugin, receipt);
    if (body.planHash !== binding.planHash) throw new AppError(ERROR_CODES.conflict, "The displayed apply plan changed; refresh and review it again", 409);
    if (atomicConfirmation) await core.createConfirmation(browserSession(req), binding);
    await core.consumeConfirmation(browserSession(req), binding);
    const operation = await core.startOperation("apply", `${target.profile}:${design.id}@${design.revision}`);
    const runtimeBefore = await detectDshRuntime(target.dshHome);
    const previousActive = await core.store.read<ActiveThemeDocument>(`active/${target.profile}.json`);
    const previousApplied = await core.store.read(`applied-designs/${target.profile}.json`);
    const previousInstallation = await core.store.read(`installations/${target.profile}.json`);
    const previousSecret = await core.store.read<{ secret?: string }>(`plugin-secrets/${target.profile}.json`);
    const previousRestoreState = await core.store.read(`restore-state/${target.profile}.json`);
    const previousPreview = await core.store.read(`previews/${target.profile}.json`);
    const installedBefore = previousInstallation !== null;
    const transactionId = randomUUID();
    await core.store.write(`transactions/${transactionId}.json`, { kind: "apply", state: "prepared", operationId: operation.id, profile: target.profile, previousActive, previousApplied, previousInstallation, previousSecret, previousRestoreState, previousPreview, previousActiveHash: previousActive?.hash ?? null, previousAppliedHash: canonicalHash(previousApplied), installedBefore, createdAt: new Date().toISOString() });
    try {
      await core.store.write(`restore-state/${target.profile}.json`, { active: previousActive, applied: previousApplied, pluginInstalled: installedBefore, installation: previousInstallation, pluginSecret: previousSecret, capturedAt: new Date().toISOString() });
      // A confirmed apply with installPlugin also stages the current managed
      // package when it already exists. Theme-only writes otherwise leave a
      // previously installed Client on an old, incompatible rc.6 contract.
      // installPlugin itself stages and atomically replaces the package, keeps
      // the managed patch stable, and preserves the existing secret.
      if (body.installPlugin) await installPlugin(target, dataDir, studioUrl());
      const hash = canonicalHash(design.theme);
      const document: ActiveThemeDocument = { designId: design.id, revision: design.revision, hash, theme: design.theme };
      await writeActiveTheme(target, dataDir, document);
      await core.store.write(`applied-designs/${target.profile}.json`, { designId: design.id, revision: design.revision, hash, appliedAt: new Date().toISOString() });
      await core.stopPreview(target.profile);
      await core.store.write(`transactions/${transactionId}.json`, { kind: "apply", state: "committed", operationId: operation.id, profile: target.profile, revision: design.revision, hash, committedAt: new Date().toISOString() });
      const pending = await core.transitionOperation(operation.id, "pending-restart", { expected: { profile: target.profile, designId: design.id, revision: design.revision, hash, ...(runtimeBefore.pluginInstanceId ? { previousPluginInstanceId: runtimeBefore.pluginInstanceId } : {}) } });
      publish(pending);
      return { operation: pending, restartRequired: true, verificationRequired: true };
    } catch (error) {
      const compensation: string[] = [];
      const rollbackErrors: string[] = [];
      try { if (previousApplied) await core.store.write(`applied-designs/${target.profile}.json`, previousApplied); else await core.store.remove(`applied-designs/${target.profile}.json`); compensation.push("applied"); } catch (rollback) { rollbackErrors.push(`applied: ${String(rollback)}`); }
      try { if (previousActive) await core.store.write(`active/${target.profile}.json`, previousActive); else await core.store.remove(`active/${target.profile}.json`); compensation.push("active"); } catch (rollback) { rollbackErrors.push(`active: ${String(rollback)}`); }
      try { if (!installedBefore && await core.store.read(`installations/${target.profile}.json`)) { await uninstallPlugin(target, dataDir); compensation.push("plugin"); } } catch (rollback) { rollbackErrors.push(`plugin: ${String(rollback)}`); }
      try { if (previousInstallation) await core.store.write(`installations/${target.profile}.json`, previousInstallation); else await core.store.remove(`installations/${target.profile}.json`); if (previousSecret) await core.store.write(`plugin-secrets/${target.profile}.json`, previousSecret); else await core.store.remove(`plugin-secrets/${target.profile}.json`); compensation.push("managed-records"); } catch (rollback) { rollbackErrors.push(`managed-records: ${String(rollback)}`); }
      try { if (previousRestoreState) await core.store.write(`restore-state/${target.profile}.json`, previousRestoreState); else await core.store.remove(`restore-state/${target.profile}.json`); if (previousPreview) await core.store.write(`previews/${target.profile}.json`, previousPreview); else await core.store.remove(`previews/${target.profile}.json`); compensation.push("restore-preview-state"); } catch (rollback) { rollbackErrors.push(`restore-preview-state: ${String(rollback)}`); }
      const restoredRecords = canonicalHash(await core.store.read(`installations/${target.profile}.json`)) === canonicalHash(previousInstallation) && canonicalHash(await core.store.read(`plugin-secrets/${target.profile}.json`)) === canonicalHash(previousSecret);
      const restoredPlugin = await managedPluginExists(target) === installedBefore;
      if (!restoredRecords || !restoredPlugin || canonicalHash(await core.store.read(`active/${target.profile}.json`)) !== canonicalHash(previousActive) || canonicalHash(await core.store.read(`applied-designs/${target.profile}.json`)) !== canonicalHash(previousApplied) || canonicalHash(await core.store.read(`restore-state/${target.profile}.json`)) !== canonicalHash(previousRestoreState) || canonicalHash(await core.store.read(`previews/${target.profile}.json`)) !== canonicalHash(previousPreview)) rollbackErrors.push("post-compensation snapshot verification failed");
      const safe = rollbackErrors.length === 0;
      await core.store.write(`transactions/${transactionId}.json`, { kind: "apply", state: safe ? "failed-safe" : "rollback-incomplete", operationId: operation.id, compensation, rollbackErrors, error: String(error), failedAt: new Date().toISOString() });
      const failed = await core.transitionOperation(operation.id, safe ? "failed-safe" : "failed", { error: toRecordError(error) }); publish(failed); throw error;
    }
  });
}

async function performRestore(req: IncomingMessage, body: z.infer<typeof restoreSchema>, target: DshTarget, atomicConfirmation: boolean) {
  return core.withResourceLock(`apply-${target.profile}`, async () => {
    await requireRevision(body.designId, body.revision);
    const binding = await buildConfirmationBinding("restore", body.designId, body.revision, target, false);
    if (body.planHash !== binding.planHash) throw new AppError(ERROR_CODES.conflict, "The displayed restore plan changed; refresh and review it again", 409);
    if (atomicConfirmation) await core.createConfirmation(browserSession(req), binding);
    await core.consumeConfirmation(browserSession(req), binding);
    const restore = await core.store.read<{ active: ActiveThemeDocument | null; applied: unknown; pluginInstalled: boolean }>(`restore-state/${target.profile}.json`);
    if (!restore) throw new AppError(ERROR_CODES.notFound, "No managed restore point exists", 404);
    const operation = await core.startOperation("restore", target.profile);
    const runtimeBefore = await detectDshRuntime(target.dshHome);
    const currentActive = await core.store.read<ActiveThemeDocument>(`active/${target.profile}.json`);
    const currentApplied = await core.store.read(`applied-designs/${target.profile}.json`);
    const currentInstallation = await core.store.read(`installations/${target.profile}.json`);
    const currentSecret = await core.store.read<{ secret?: string }>(`plugin-secrets/${target.profile}.json`);
    const currentPreview = await core.store.read(`previews/${target.profile}.json`);
    const transactionId = randomUUID();
    await core.store.write(`transactions/${transactionId}.json`, { kind: "restore", state: "prepared", operationId: operation.id, profile: target.profile, currentActive, currentApplied, currentInstallation, currentSecret, currentPreview, createdAt: new Date().toISOString() });
    try {
      let expected: NonNullable<import("@dsh-skin/shared").OperationRecord["expected"]> = { profile: target.profile, revision: 0, hash: "official" };
      if (restore.active) { await writeActiveTheme(target, dataDir, restore.active); expected = { profile: target.profile, designId: restore.active.designId, revision: restore.active.revision, hash: restore.active.hash, ...(runtimeBefore.pluginInstanceId ? { previousPluginInstanceId: runtimeBefore.pluginInstanceId } : {}) }; }
      else await core.store.remove(`active/${target.profile}.json`);
      if (restore.applied) await core.store.write(`applied-designs/${target.profile}.json`, restore.applied); else await core.store.remove(`applied-designs/${target.profile}.json`);
      await core.stopPreview(target.profile);
      if (!restore.pluginInstalled) await uninstallPlugin(target, dataDir);
      await core.store.write(`transactions/${transactionId}.json`, { kind: "restore", state: "committed", operationId: operation.id, profile: target.profile, committedAt: new Date().toISOString() });
      const pending = await core.transitionOperation(operation.id, "pending-restart", { expected }); publish(pending);
      return { operation: pending, restartRequired: true, verificationRequired: true, restores: restore.pluginInstalled ? "managed-theme" : "official-appearance" };
    } catch (error) {
      const rollbackErrors: string[] = [];
      try { if (currentApplied) await core.store.write(`applied-designs/${target.profile}.json`, currentApplied); else await core.store.remove(`applied-designs/${target.profile}.json`); } catch (rollback) { rollbackErrors.push(`applied: ${String(rollback)}`); }
      try { if (currentActive) await core.store.write(`active/${target.profile}.json`, currentActive); else await core.store.remove(`active/${target.profile}.json`); } catch (rollback) { rollbackErrors.push(`active: ${String(rollback)}`); }
      try { if (currentInstallation && !await managedPluginExists(target)) await installPlugin(target, dataDir, studioUrl(), currentSecret?.secret); if (currentInstallation) await core.store.write(`installations/${target.profile}.json`, currentInstallation); else await core.store.remove(`installations/${target.profile}.json`); if (currentSecret) await core.store.write(`plugin-secrets/${target.profile}.json`, currentSecret); else await core.store.remove(`plugin-secrets/${target.profile}.json`); } catch (rollback) { rollbackErrors.push(`managed-plugin: ${String(rollback)}`); }
      try { if (currentPreview) await core.store.write(`previews/${target.profile}.json`, currentPreview); else await core.store.remove(`previews/${target.profile}.json`); } catch (rollback) { rollbackErrors.push(`preview: ${String(rollback)}`); }
      const restoredRecords = canonicalHash(await core.store.read(`installations/${target.profile}.json`)) === canonicalHash(currentInstallation) && canonicalHash(await core.store.read(`plugin-secrets/${target.profile}.json`)) === canonicalHash(currentSecret);
      const restoredPlugin = await managedPluginExists(target) === (currentInstallation !== null);
      if (!restoredRecords || !restoredPlugin || canonicalHash(await core.store.read(`active/${target.profile}.json`)) !== canonicalHash(currentActive) || canonicalHash(await core.store.read(`applied-designs/${target.profile}.json`)) !== canonicalHash(currentApplied) || canonicalHash(await core.store.read(`previews/${target.profile}.json`)) !== canonicalHash(currentPreview)) rollbackErrors.push("post-compensation snapshot verification failed");
      const safe = rollbackErrors.length === 0;
      await core.store.write(`transactions/${transactionId}.json`, { kind: "restore", state: safe ? "failed-safe" : "rollback-incomplete", operationId: operation.id, profile: target.profile, rollbackErrors, error: String(error), failedAt: new Date().toISOString() });
      const failed = await core.transitionOperation(operation.id, safe ? "failed-safe" : "failed", { error: toRecordError(error) }); publish(failed); throw error;
    }
  });
}

async function establishBrowserSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const current = browserSession(req);
  if (current) {
    try { await core.validateBrowserSession(current); return; }
    catch { /* refresh an expired/stale browser tab session below */ }
  }
  const sessionId = await core.createBrowserSession();
  res.setHeader("set-cookie", `dsh_skin_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`);
}
function browserSession(req: IncomingMessage): string | undefined { const match = (req.headers.cookie || "").match(/(?:^|;\s*)dsh_skin_session=([A-Za-z0-9_-]{32,})/); return match?.[1]; }
function isPluginPrivatePath(pathname: string): boolean {
  return pathname.startsWith("/api/v1/plugin/preview") || pathname === "/api/v1/plugin/theme/ack" || /^\/api\/v1\/preview-sessions\/[0-9a-f-]+\/host\//.test(pathname);
}
async function authorizePlugin(req: IncomingMessage, profile: string): Promise<void> { const expected = await getPluginSecret(normalizeTarget({ profile }), dataDir); const supplied = /^Bearer\s+(.+)$/.exec(req.headers.authorization || "")?.[1]; const expectedHash = expected ? Buffer.from(canonicalHash(expected), "hex") : Buffer.alloc(32); const suppliedHash = supplied ? Buffer.from(canonicalHash(supplied), "hex") : Buffer.alloc(32, 1); if (!expected || !supplied || !timingSafeEqual(expectedHash, suppliedHash)) throw new AppError(ERROR_CODES.confirmation, "Plugin authentication failed", 403); }
function pluginBearer(req: IncomingMessage): string { const token = /^Bearer\s+([A-Za-z0-9_-]{32,})$/.exec(req.headers.authorization || "")?.[1]; if (!token) throw new AppError(ERROR_CODES.confirmation, "Isolated preview Host authentication failed", 403); return token; }
function assertControllerInstance(value: string): void { if (value !== instanceId) throw new AppError(ERROR_CODES.conflict, "Controller instance changed", 409); }
async function finalizeMatchingOperations(kind: "preview" | "stable", profile: string, designId: string, revision: number, hash: string, pluginInstanceId: string): Promise<void> { for (const name of await core.store.list("operations", ".json")) { const operation = await core.store.read<import("@dsh-skin/shared").OperationRecord>(`operations/${name}`); if (!operation?.expected || operation.expected.profile !== profile || operation.expected.designId !== designId || operation.expected.revision !== revision || operation.expected.hash !== hash || operation.expected.previousPluginInstanceId === pluginInstanceId || !["pending-restart", "pending-verification"].includes(operation.state) || (kind === "preview" ? operation.kind !== "preview" : operation.kind === "preview")) continue; const done = await core.transitionOperation(operation.id, "succeeded"); publish(done); } }
async function finalizeOperation(id: string) { const operation = await core.getOperation(id); if (!["pending-restart", "pending-verification"].includes(operation.state) || !operation.expected) return operation; const runtime = await detectDshRuntime(defaultDshHome); if (operation.expected.hash === "official") { if (!runtime.detected || runtime.pluginHealthy) throw new AppError(ERROR_CODES.unavailable, "Official appearance is not yet verified after restart", 409); return core.transitionOperation(id, "succeeded"); } if (!runtime.pluginHealthy || (operation.expected.previousPluginInstanceId && operation.expected.previousPluginInstanceId === runtime.pluginInstanceId)) throw new AppError(ERROR_CODES.unavailable, "Managed plugin restart is not yet verified", 409); if (operation.expected.hash === "plugin-installed") return core.transitionOperation(id, "succeeded"); throw new AppError(ERROR_CODES.unavailable, "The restarted client has not submitted an exact rendered theme acknowledgement", 409); }

function enforceHost(req: IncomingMessage): void {
  const authority = req.headers.host || "";
  if (![`${host}:${actualPort}`, `localhost:${actualPort}`].includes(authority.toLowerCase())) {
    throw new AppError(ERROR_CODES.forbiddenHost, "Host header is not an allowed loopback authority", 403);
  }
}
function enforceMutation(req: IncomingMessage): void {
  if (req.headers["x-dsh-skin-csrf"] !== csrfToken) throw new AppError(ERROR_CODES.csrf, "Missing or invalid CSRF token", 403);
  const origin = req.headers.origin;
  if (origin && origin !== studioUrl() && origin !== `http://localhost:${actualPort}`) throw new AppError(ERROR_CODES.forbiddenOrigin, "Origin is not allowed", 403);
}
async function bodyJson(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += part.length;
    if (size > maxBytes) throw new AppError(ERROR_CODES.badRequest, `Request body exceeds ${Math.floor(maxBytes / (1024 * 1024))} MiB`, 413);
    chunks.push(part);
  }
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new AppError(ERROR_CODES.badRequest, "Request body must be valid JSON", 400); }
}

async function serveStudio(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") throw new AppError(ERROR_CODES.notFound, "Route not found", 404);
  const wanted = pathname === "/" ? "index.html" : normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, "");
  const candidate = resolve(studioDist, wanted);
  if (!candidate.startsWith(`${studioDist}\\`) && candidate !== join(studioDist, "index.html")) throw new AppError(ERROR_CODES.notFound, "Asset not found", 404);
  let file = candidate;
  try { if (!(await stat(file)).isFile()) throw new Error("not-file"); }
  catch { file = join(studioDist, "index.html"); }
  try {
    const content = await readFile(file);
    res.writeHead(200, { "content-type": mime(extname(file)), "cache-control": file.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable" });
    if (req.method === "HEAD") { res.end(); return; }
    res.end(content);
  } catch { throw new AppError(ERROR_CODES.notFound, "Studio has not been built yet", 404); }
}

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' http://127.0.0.1:* http://localhost:*; frame-src http://127.0.0.1:* http://localhost:*; object-src 'none'; base-uri 'none'; form-action 'none'");
}
function json(res: ServerResponse, status: number, body: unknown): void { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(body)); }
function sendError(res: ServerResponse, error: unknown): void {
  if (res.headersSent) { res.end(); return; }
  const app = error instanceof AppError ? error : error instanceof ZodError
    ? new AppError(ERROR_CODES.validation, "Request validation failed", 422, error.issues)
    : new AppError(ERROR_CODES.internal, error instanceof Error ? error.message : "Unexpected error", 500);
  const body: ApiErrorBody = { error: { code: app.code, message: app.message, ...(app.details === undefined ? {} : { details: app.details }) } };
  json(res, app.status, body);
}
function events(_req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
  res.write(": connected\n\n"); sseClients.add(res); res.on("close", () => sseClients.delete(res));
}
function publish(value: unknown, event = "operation"): void { const message = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`; for (const client of sseClients) client.write(message); }
function studioUrl(): string { return `http://${host}:${actualPort}`; }
function numberEnv(name: string, fallback: number): number { const parsed = Number(process.env[name]); return Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535 ? parsed : fallback; }
function isFetchSafePort(port: number): boolean { return Number.isInteger(port) && port > 0 && port <= 65535 && !FETCH_BLOCKED_PORTS.has(port); }
function toRecordError(error: unknown): { code: string; message: string } { return error instanceof AppError ? { code: error.code, message: error.message } : { code: ERROR_CODES.internal, message: error instanceof Error ? error.message : String(error) }; }
function mime(ext: string): string { return ({ ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json; charset=utf-8" } as Record<string,string>)[ext] || "application/octet-stream"; }

function normalizeTarget(input: { profile?: string | undefined } | undefined): DshTarget {
  return { dshHome: defaultDshHome, profile: input?.profile || "web" };
}
function actorFrom(req: IncomingMessage): "human" | "agent" { return req.headers.origin ? "human" : "agent"; }
async function ensureThemeAsset(theme: ThemeSpec): Promise<void> {
  // v2 has independently editable surfaces. Validate every referenced asset
  // before the design is saved or handed to an isolated preview.
  const backdrops = [theme.appearance.backdrop, theme.appearance.regions.sidebar, theme.appearance.regions.main];
  for (const backdrop of backdrops) if (backdrop.kind === "image") await assets.get(backdrop.assetId);
}
async function protectedDesignIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const name of await core.store.list("active", ".json")) {
    const value = await core.store.read<{ designId?: string }>(`active/${name}`); if (value?.designId) ids.add(value.designId);
  }
  for (const name of await core.store.list("applied-designs", ".json")) {
    const value = await core.store.read<{ designId?: string }>(`applied-designs/${name}`);
    if (value?.designId) ids.add(value.designId);
  }
  for (const name of await core.store.list("restore-state", ".json")) {
    const value = await core.store.read<{ active?: { designId?: string } | null; applied?: { designId?: string } | null }>(`restore-state/${name}`); if (value?.active?.designId) ids.add(value.active.designId); if (value?.applied?.designId) ids.add(value.applied.designId);
  }
  for (const name of await core.store.list("previews", ".json")) {
    const value = await core.store.read<{ designId?: string; state?: string }>(`previews/${name}`); if (value?.designId && ["pending", "live"].includes(value.state || "")) ids.add(value.designId);
  }
  for (const id of await previewRuntime.activeDesignIds()) ids.add(id);
  return ids;
}
async function managedPluginExists(target: DshTarget): Promise<boolean> { try { return (await stat(join(target.dshHome, "profiles", "node_modules", "@dsh-skin", "dsh-plugin", "package.json"))).isFile(); } catch { return false; } }
function sanitizeInstallPlan(plan: Awaited<ReturnType<typeof planInstall>>) {
  return { profile: plan.profile, version: plan.version, compatible: plan.compatible, changes: ["install managed plugin package", "update managed profile patch", "record rollback backup"] };
}
function diffValues(before: unknown, after: unknown, path = ""): Array<{ path: string; before: unknown; after: unknown }> {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    return [...keys].sort().flatMap((key) => diffValues(before[key], after[key], `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`));
  }
  return [{ path: path || "/", before: before ?? null, after: after ?? null }];
}
function isPlainObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

const targetSchema = z.object({ profile: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/).default("web") }).strict();
const createDesignSchema = z.object({ name: z.string().min(1).max(80).optional(), theme: z.unknown().optional() }).strict();
const actorSchema = z.enum(["human", "agent", "system"]).default("agent");
const patchDesignSchema = z.object({ baseRevision: z.number().int().positive(), patch: z.record(z.string(), z.unknown()), actor: actorSchema, patchId: z.string().uuid().optional() }).strict();
const duplicateSchema = z.object({ name: z.string().min(1).max(80).optional(), actor: actorSchema, patchId: z.string().uuid().optional() }).strict();
const renameSchema = z.object({ name: z.string().min(1).max(80), baseRevision: z.number().int().positive(), actor: actorSchema, patchId: z.string().uuid().optional() }).strict();
const assetUploadSchema = z.object({ mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]), dataBase64: z.string().min(4).max(MAX_BACKGROUND_ASSET_BASE64_CHARS) }).strict();
const designRevisionSchema = z.object({ designId: z.string().uuid(), revision: z.number().int().positive() }).strict();
const isolatedReceiptSchema = z.object({ previewSessionId: z.string().uuid(), previewGeneration: z.number().int().positive(), renderReceiptHash: z.string().regex(/^[0-9a-f]{64}$/) });
// Plugin packages are versioned runtime code, not merely first-install
// scaffolding. Safe applies default to staging the current managed package;
// callers can explicitly request a theme-only plan when that is intentional.
const applyPlanSchema = designRevisionSchema.extend({ target: targetSchema.optional(), installPlugin: z.boolean().default(true) }).merge(isolatedReceiptSchema).strict();
const restorePlanSchema = designRevisionSchema.extend({ target: targetSchema.optional() }).strict();
const applySchema = designRevisionSchema.extend({ planHash: z.string().regex(/^[0-9a-f]{64}$/), target: targetSchema.optional(), installPlugin: z.boolean().default(true) }).merge(isolatedReceiptSchema).strict();
const restoreSchema = designRevisionSchema.extend({ planHash: z.string().regex(/^[0-9a-f]{64}$/), target: targetSchema.optional() }).strict();
const pluginActionSchema = designRevisionSchema.extend({ target: targetSchema.optional() }).strict();
const profileSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/);
const previewStartSchema = designRevisionSchema.extend({ target: targetSchema.optional() }).strict();
const previewStopSchema = z.object({ target: targetSchema.optional() }).strict();
const pluginAckSchema = z.object({ profile: profileSchema, mode: z.enum(["stable", "preview"]), designId: z.string().uuid(), revision: z.number().int().nonnegative(), hash: z.string().regex(/^[0-9a-f]{64}$/), controllerInstanceId: z.string().uuid(), pluginInstanceId: z.string().uuid(), clientInstanceId: z.string().uuid() }).strict();
const isolatedRenderAckSchema = z.object({ sessionId: z.string().uuid(), generation: z.number().int().positive(), designId: z.string().uuid(), revision: z.number().int().positive(), hash: z.string().regex(/^[0-9a-f]{64}$/), pluginInstanceId: z.string().uuid(), clientInstanceId: z.string().uuid(), controllerInstanceId: z.string().uuid() }).strict();
