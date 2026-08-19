import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { canonicalHash, DesignSessionCore } from "../packages/design-session-core/dist/index.js";
import { parseThemeSpec } from "../packages/theme-schema/dist/index.js";
import { apply as applyHost, buildPersistentSkinStyle, injectPersistentSkinStyle, normalizeBalancePayload, resolveBalanceApiKey } from "../packages/dsh-plugin/dist/host/index.js";
import { PreviewRuntime } from "../apps/controller/dist/preview-runtime.js";
import { runGarbageCollection } from "../apps/controller/dist/gc.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const controllerRequire = createRequire(pathToFileURL(join(projectRoot, "apps", "controller", "package.json")));
const sharp = controllerRequire("sharp");
const fixtureDshBin = resolveDshBin();
const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const spawnedPids = new Set();
const childOutput = new WeakMap();
// Source-contract debugging can intentionally omit the separately packaged
// runtime. The default/full suite never sets this flag and therefore skips
// nothing.
const coldSkillTest = process.env.DSH_TEST_SKIP_COLD_SKILL === "1" ? test.skip : test;

test("production Controller selfcheck covers confirmation, pending restart, preview ack, image decode and managed uninstall", { timeout: 30_000 }, () => {
  const result = run(process.execPath, [join(projectRoot, "apps", "controller", "dist", "selfcheck.js")]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Controller backend self-check passed/);
});

test("DesignSession CAS admits one writer and patchId replay is durable", async () => {
  const root = await tempRoot("core");
  try {
    const core = new DesignSessionCore(root);
    const design = await core.createDesign();
    const patchId = randomUUID();
    const first = await core.patchDesign(design.id, 1, { name: "First" }, patchId);
    const replay = await core.patchDesign(design.id, 1, { name: "First" }, patchId);
    assert.deepEqual(replay, first);
    await assert.rejects(() => core.patchDesign(design.id, 1, { name: "Different replay" }, patchId), /different mutation payload/);
    const renameId = randomUUID();
    const renamed = await core.renameDesign(design.id, first.revision, "Renamed", renameId);
    assert.deepEqual(await core.renameDesign(design.id, first.revision, "Renamed", renameId), renamed);
    await assert.rejects(() => core.renameDesign(design.id, first.revision, "Other", renameId), /different mutation payload/);
    const duplicateId = randomUUID();
    const duplicate = await core.duplicateDesign(design.id, "Copy", duplicateId);
    assert.deepEqual(await core.duplicateDesign(design.id, "Copy", duplicateId), duplicate);
    await assert.rejects(() => core.duplicateDesign(design.id, "Other copy", duplicateId), /different mutation payload/);
    const race = await Promise.allSettled([
      core.patchDesign(design.id, renamed.revision, { name: "A" }, randomUUID()),
      core.patchDesign(design.id, renamed.revision, { name: "B" }, randomUUID())
    ]);
    assert.equal(race.filter((entry) => entry.status === "fulfilled").length, 1);
    assert.equal(race.filter((entry) => entry.status === "rejected").length, 1);
  } finally { await safeRemove(root); }
});

test("garbage collector prunes only provably dead records and rotates a large journal", async () => {
  const root = await tempRoot("gc");
  try {
    const core = new DesignSessionCore(root);
    const now = Date.now();
    const oldIso = new Date(now - 2 * 24 * 60 * 60_000).toISOString();
    const freshIso = new Date().toISOString();
    const designId = randomUUID();
    const previewId = randomUUID();

    await core.store.write("browser-sessions/expired.json", { createdAt: oldIso, expiresAt: oldIso });
    await core.store.write("browser-sessions/valid.json", { createdAt: freshIso, expiresAt: new Date(now + 60_000).toISOString() });
    await core.store.write("confirmations/used.json", { usedAt: oldIso, expiresAt: oldIso });
    await core.store.write("confirmations/expired.json", { expiresAt: oldIso });
    await core.store.write("confirmations/valid.json", { expiresAt: new Date(now + 60_000).toISOString() });
    await core.store.write("operations/old-done.json", { state: "succeeded", updatedAt: oldIso });
    await core.store.write("operations/fresh-done.json", { state: "failed", updatedAt: freshIso });
    await core.store.write("operations/old-pending.json", { state: "pending-verification", updatedAt: oldIso });
    await core.store.write(`patches/${designId}/old.json`, { appliedAt: oldIso });
    await core.store.write(`patches/${designId}/fresh.json`, { appliedAt: freshIso });
    await core.store.write("transactions/old.json", { failedAt: oldIso });
    await core.store.write("transactions/fresh.json", { failedAt: freshIso });
    await core.store.write("transactions/old-committed.json", { state: "committed", committedAt: oldIso });
    await core.store.write("transactions/old-prepared.json", { state: "prepared", createdAt: oldIso });
    await core.store.write("transactions/fresh-prepared.json", { state: "prepared", createdAt: freshIso });
    await core.store.write(`isolated-preview-sessions/${previewId}.json`, { state: "stopped", createdAt: oldIso });
    await core.store.write("isolated-preview-sessions/fresh-live.json", { state: "live", createdAt: oldIso });
    await core.store.write(`isolated-preview-runtime/${previewId}/plugin/package.json`, { name: "junk" });
    await core.store.write(`isolated-preview-cleanup/${previewId}.json`, { id: previewId });
    await core.store.append("operations/journal.jsonl", { line: "x".repeat(1_100_000) });

    const summary = await runGarbageCollection(core, { rotateJournal: true });

    assert.equal(summary.browserSessions, 1);
    assert.equal(summary.confirmations, 2);
    assert.equal(summary.operations, 1);
    assert.equal(summary.patches, 1);
    assert.equal(summary.transactions, 3);
    assert.equal(summary.previewSessions, 1);
    assert.equal(summary.previewRuntimeDirs, 1);
    assert.equal(summary.cleanupRecords, 1);
    assert.equal(summary.journalRotated, true);
    assert.equal(summary.errors, 0);
    // Durable or still-relevant records survive.
    assert.notEqual(await core.store.read("browser-sessions/valid.json"), null);
    assert.notEqual(await core.store.read("confirmations/valid.json"), null);
    assert.notEqual(await core.store.read("operations/fresh-done.json"), null);
    assert.notEqual(await core.store.read("operations/old-pending.json"), null);
    assert.notEqual(await core.store.read(`patches/${designId}/fresh.json`), null);
    assert.notEqual(await core.store.read("transactions/fresh.json"), null);
    assert.notEqual(await core.store.read("transactions/fresh-prepared.json"), null);
    assert.notEqual(await core.store.read("isolated-preview-sessions/fresh-live.json"), null);
    // Dead records are gone.
    assert.equal(await core.store.read("browser-sessions/expired.json"), null);
    assert.equal(await core.store.read("confirmations/used.json"), null);
    assert.equal(await core.store.read("operations/old-done.json"), null);
    assert.equal(await core.store.read(`patches/${designId}/old.json`), null);
    assert.equal(await core.store.read("transactions/old.json"), null);
    assert.equal(await core.store.read("transactions/old-committed.json"), null);
    assert.equal(await core.store.read("transactions/old-prepared.json"), null);
    assert.equal(await core.store.read(`isolated-preview-sessions/${previewId}.json`), null);
    assert.equal(await core.store.read(`isolated-preview-cleanup/${previewId}.json`), null);
    // The journal rotated into a timestamped archive instead of being pruned.
    const jsonl = await core.store.list("operations", ".jsonl");
    assert.equal(jsonl.includes("journal.jsonl"), false);
    assert.equal(jsonl.filter((name) => name.startsWith("journal-")).length, 1);
  } finally { await safeRemove(root); }
});

test("legacy v1 themes normalize into canonical linked v2 regions", () => {
  const legacy = {
    schemaVersion: 1, id: "legacy-region-proof", name: "Legacy region proof",
    appearance: {
      backdrop: { kind: "solid", colors: ["#ff00ff"], angle: 0, opacity: 1, blurPx: 0 },
      base: "dark", glass: { opacity: 0.78, blurPx: 18, radiusPx: 18 }, tokens: {}
    }
  };
  const normalized = parseThemeSpec(legacy);
  assert.equal(normalized.schemaVersion, 2);
  assert.equal(normalized.appearance.regions.linked, true);
  assert.equal(normalized.appearance.regions.divider, false, "pre-divider themes must default to a seamless linked canvas");
  assert.deepEqual(normalized.appearance.regions.main, legacy.appearance.backdrop);
  assert.deepEqual(normalized.appearance.regions.sidebar, legacy.appearance.backdrop);
  assert.deepEqual(normalized.appearance.backdrop, normalized.appearance.regions.main);
});

test("rc.6 regional discovery supports both New Session and opened conversation anchors", async () => {
  const clientSource = await readFile(join(projectRoot, "packages", "dsh-plugin", "src", "client", "index.ts"), "utf8");
  assert.match(
    clientSource,
    /uniqueElement\("div\.wSkVaW_heroWorkspaceRow"\)\s*\?\?\s*uniqueElement\("div\.wSkVaW_root"\)/,
    "the capability-pinned selector must fall back from the New Session hero to the unique opened-conversation root"
  );
});

test("rc.6 regional discovery accepts fractional compositing edges but not a structural gap", async () => {
  const clientSource = await readFile(join(projectRoot, "packages", "dsh-plugin", "src", "client", "index.ts"), "utf8");
  assert.match(clientSource, /const REGIONAL_GEOMETRY_TOLERANCE_PX = Math\.max\(1, Math\.ceil\(window\.devicePixelRatio \|\| 1\)\);/, "the client must use a bounded compositing tolerance that grows with the device pixel ratio");
  assert.match(clientSource, /compositeBounds\.right \+ REGIONAL_GEOMETRY_TOLERANCE_PX >= Math\.max\(mainBounds\.right, sidebarBounds\.right\)/, "the right edge must tolerate only the declared bounded rasterization difference");
  const spans = (composite, main, sidebar) => composite.left - 1 <= Math.min(main.left, sidebar.left)
    && composite.top - 1 <= Math.min(main.top, sidebar.top)
    && composite.right + 1 >= Math.max(main.right, sidebar.right)
    && composite.bottom + 1 >= Math.max(main.bottom, sidebar.bottom);
  assert.equal(spans(
    { left: 0, top: 0, right: 1135.4544677734375, bottom: 852.7272338867188 },
    { left: 280, top: 0, right: 1135.4545288085938, bottom: 852.7272338867188 },
    { left: 0, top: 0, right: 280, bottom: 852.7272338867188 }
  ), true, "the real observed fractional rc.6 edge must not be rejected");
  assert.equal(spans(
    { left: 0, top: 0, right: 1133, bottom: 852 },
    { left: 280, top: 0, right: 1135, bottom: 852 },
    { left: 0, top: 0, right: 280, bottom: 852 }
  ), false, "a greater-than-one-pixel gap must remain fail-closed");
});

test("rc.6 regional hydration reuses the verified local backdrop before the polling fallback", async () => {
  const clientSource = await readFile(join(projectRoot, "packages", "dsh-plugin", "src", "client", "index.ts"), "utf8");
  assert.match(clientSource, /const REGIONAL_LAYOUT_DEBOUNCE_MS = 48;/, "regional hydration must use a short coalescing window");
  assert.match(clientSource, /layoutObserver\.observe\(document\.documentElement, \{ attributes: true, attributeFilter: \["class", "data-phase"\], childList: true, subtree: true \}\)/, "the Client must observe regional replacement and route phase changes for fast remounting");
  assert.match(clientSource, /\[\.\.\.record\.addedNodes, \.\.\.record\.removedNodes\]\.some\(\(node\) => isRegionalLayoutNode\(node, backdropLayers\)\)/, "only capability-pinned regional DOM changes (or removal of a skin-owned target) may trigger the fast path");
  assert.match(clientSource, /targets\.sidebar\.isConnected/, "a replaced sidebar target must invalidate the cached backdrop");
  assert.match(clientSource, /layerTargets\.every\(\(target\) => target\.isConnected\)/, "a removed managed layer target must invalidate the cached backdrop");
  assert.match(clientSource, /data-dsh-skin-studio-backdrop.*data-dsh-skin-studio-boundary/, "removing a skin-owned layer must trigger the local remount path");
  assert.match(clientSource, /remountCachedBackdrops = \(\) =>/, "a replaced conversation root must use the already acknowledged in-memory theme");
  assert.match(clientSource, /box-shadow", active \? `inset 0 0 0 9999px/, "the split conversation mask must not replace an image background");
  assert.match(clientSource, /const schedulePollingRefresh = \(\) =>/, "local route remounts must preserve the bounded state-update polling channel");
});

test("installed DSH plugin exposes Skin Studio in the native Plugins settings section", async () => {
  const manifest = JSON.parse(await readFile(join(projectRoot, "packages", "dsh-plugin", "package.json"), "utf8"));
  const clientSource = await readFile(join(projectRoot, "packages", "dsh-plugin", "src", "client", "index.ts"), "utf8");
  const hostSource = await readFile(join(projectRoot, "packages", "dsh-plugin", "src", "host", "index.ts"), "utf8");
  assert.ok(manifest.dsh.client.inject.includes("@deepseek-ai/dsh-client-ui-settings-plugins"), "the plugin must compose the native DSH Plugins settings surface");
  assert.match(clientSource, /settings\.plugin\.item/, "the Client must register a card in the native plugin settings slot");
  assert.match(clientSource, /data-dsh-skin-settings-card/, "the settings entry must be discoverable without relying on translated text");
  assert.match(clientSource, /启动并打开 Skin Studio/, "the native settings card must offer a one-click Studio launch");
  assert.match(hostSource, /path: "\/dsh-skin\/studio"/, "the Host must provide a same-origin, loopback-only Studio launch route");
});

test("Studio only exposes persistent write after the live preview has settled", async () => {
  const studioSource = await readFile(join(projectRoot, "apps", "studio", "src", "App.tsx"), "utf8");
  assert.match(studioSource, /preview === "live"/, "the write affordance must require a live preview state");
  assert.match(studioSource, /PREVIEW_RENEWAL_LEAD_MS = 30_000/, "the write affordance must reserve time before automatic preview renewal");
  assert.match(studioSource, /previewHasApplyGrace\(verifiedPreview\)/, "the first click must not race the warm-preview renewal window");
  assert.match(studioSource, /previewTimer\.current === undefined/, "a pending debounced preview must block the first write click");
  assert.match(studioSource, /!previewInFlight\.current/, "an in-flight preview update must block the first write click");
  assert.match(studioSource, /queuedPreview\.current === null/, "a queued preview revision must block stale-plan creation");
  assert.match(studioSource, /const previewReadyNow = \(\) =>/, "the async plan path must recheck the live receipt after queued saves settle");
  assert.match(studioSource, /const ensureApplyReceipt = async/, "the first plan click must recover an expired warm receipt instead of requiring manual regeneration");
  assert.match(studioSource, /await api\.previewSession\(active\.sessionId\)/, "plan generation must poll the current isolated session until its real receipt is live");
  assert.match(studioSource, /if \(!\(error instanceof ApiError\) \|\| error\.status !== 409\) throw error/, "a stale receipt conflict must retry once against the refreshed isolated preview");
  assert.match(studioSource, /applyAction && applyResult === "idle" && !applyPlanLoading && applyPlan !== null/, "late preview events must not paint a false error while the first plan request is still loading");
  assert.match(studioSource, /applyActionRef\.current !== null/, "the renewal timer must not enqueue a new preview after the confirmation dialog opens");
  assert.match(studioSource, /const planForEvent = applyPlanRef\.current/, "preview events must read the latest plan even while the EventSource effect is re-binding");
  assert.match(studioSource, /if \(applyActionRef\.current === null\) invalidatePlan\(\)/, "just-in-time receipt renewal must not invalidate the dialog before its plan request completes");
  assert.match(studioSource, /if \(applyActionRef\.current !== null && applyPlanRef\.current !== null\) return;/, "a duplicate receipt event must not clear a plan that was already returned with HTTP 200");
});

test("Client promotes the rc.6 sidebar stacking context for native settings portals", async () => {
  const clientSource = await readFile(join(projectRoot, "packages", "dsh-plugin", "src", "client", "index.ts"), "utf8");
  assert.match(clientSource, /promoteSidebarStacking\(targets\.sidebar\)/, "the settings portal parent must be promoted above the main composer");
  assert.match(clientSource, /z-index\", \"2147483645\"/, "the promotion must remain below the plugin selection toolbar");
  assert.match(clientSource, /restoreSidebarStacking\(\)/, "the stacking override must be reversible on rebind and dispose");
});

test("Apply dialog does not show a stale-preview error while its first plan is loading", async () => {
  const dialogSource = await readFile(join(projectRoot, "apps", "studio", "src", "components", "Dialogs.tsx"), "utf8");
  assert.match(dialogSource, /!previewReady && !planLoading && error/, "the transient preflight state must show the spinner instead of a false invalid-plan alert");
});

test("Controller refreshes the visible Studio browser session on same-origin API GETs", async () => {
  const controllerSource = await readFile(join(projectRoot, "apps", "controller", "src", "index.ts"), "utf8");
  assert.match(controllerSource, /req\.method === "GET" && !isPluginPrivatePath\(url\.pathname\).*establishBrowserSession/s, "API GETs must recover a missing/expired Studio cookie without touching plugin Host routes");
  assert.match(controllerSource, /await core\.validateBrowserSession\(current\)/, "existing browser cookies must be validated before they are reused");
});

test("Host fails closed without rc.6 effect and disposes every route", () => {
  const config = { profile: "web", themeFile: "Z:/missing/theme.json", assetDir: "Z:/missing/assets", controllerUrl: "http://127.0.0.1:9", pluginSecret: "x".repeat(43) };
  assert.throws(() => applyHost({ inject(_names, callback) { callback({ webServer: { register() { return () => {}; } } }); } }, config), /effect lifecycle/);
  let cleanup;
  let disposed = 0;
  applyHost({ inject(_names, callback) { callback({ webServer: { register() { return () => { disposed += 1; }; }, tapIndex() { return () => { disposed += 1; }; } }, effect(factory) { cleanup = factory(); } }); } }, config);
  assert.equal(typeof cleanup, "function");
  cleanup();
  assert.equal(disposed, 10);
});

test("Host exposes version check and one-click update routes", () => {
  const hostSource = readFileSync(join(projectRoot, "packages", "dsh-plugin", "src", "host", "index.ts"), "utf8");
  assert.match(hostSource, /path: "\/dsh-skin\/version"/, "the Host must expose a version check route");
  assert.match(hostSource, /path: "\/dsh-skin\/update"/, "the Host must expose a one-click update route");
  assert.match(hostSource, /releases\/latest/, "the version check must query the GitHub latest release");
  assert.match(hostSource, /function isNewerVersion/, "dotted versions must be compared with a stable comparator");
  assert.match(hostSource, /updateAvailable/, "the version payload must carry an explicit updateAvailable flag");
  const clientSource = readFileSync(join(projectRoot, "packages", "dsh-plugin", "src", "client", "index.ts"), "utf8");
  assert.match(clientSource, /data-dsh-skin-version-row/, "the settings card must render a version row");
  assert.match(clientSource, /一键更新/, "the settings card must offer a one-click update button when an update exists");
});

test("persistent skin style pins the theme onto html body and never touches the API key", async () => {
  const hostSource = await readFile(join(projectRoot, "packages", "dsh-plugin", "src", "host", "index.ts"), "utf8");
  assert.match(hostSource, /webServer\.tapIndex/, "the Host must inject the persistent base through the official index seam");
  assert.match(hostSource, /html body::before/, "the linked backdrop must be a body-level persistent canvas");
  assert.match(hostSource, /mode === "dark" \? "\[data-ds-dark-theme\]"/, "the persistent tokens must follow the dark palette selector");
  assert.match(hostSource, /:has\(div\.wSkVaW_heroWorkspaceRow\)/, "the conversation mask must be default-on and disabled only by the hero workspace row");
});

test("persistent skin style generation covers linked, split, tokens, and idempotent injection", () => {
  const assetId = `sha256-${"a".repeat(64)}`;
  const theme = {
    schemaVersion: 2, id: "t", name: "T",
    appearance: {
      backdrop: { kind: "solid", colors: ["#111111"], angle: 0, opacity: 1, blurPx: 0 },
      regions: {
        linked: true, divider: true,
        sidebar: { kind: "solid", colors: ["#222222"], angle: 0, opacity: 1, blurPx: 0 },
        main: { kind: "image", assetId, fit: "cover", position: { xPercent: 54, yPercent: 40 }, opacity: 1, blurPx: 0, overlay: { color: "#000000", opacity: 0.39 } }
      },
      base: "dark", glass: { opacity: 0.78, blurPx: 18, radiusPx: 18 },
      tokens: { "--dsw-alias-bg-base": { light: "#eee", dark: "#111" } }
    }
  };
  const css = buildPersistentSkinStyle(theme);
  assert.match(css, /html body \{\s*--dsw-alias-bg-base: #eee;/);
  assert.match(css, /html body\[data-ds-dark-theme\] \{\s*--dsw-alias-bg-base: #111;/);
  assert.match(css, /html body\{background-image:linear-gradient\(rgb\(0 0 0 \/ 0\.39\)/, "the zero-blur linked backdrop must be painted directly on the body background");
  assert.match(css, /background-attachment:fixed!important/);
  assert.match(css, new RegExp(`linear-gradient\\(rgb\\(0 0 0 \\/ 0\\.39\\), rgb\\(0 0 0 \\/ 0\\.39\\)\\), url\\("/dsh-skin/assets/${assetId}"`), "the persistent image must include the configured overlay before the Client hydrates");
  assert.match(css, new RegExp(`dsh-skin/assets/${assetId}`));
  assert.match(css, /html body \.pI_x6G_centerCol\{background-color:rgb\(0 0 0 \/ 0\.7\)!important\}/, "the mask must be default-on for the main region");
  assert.match(css, /html body:has\(div\.wSkVaW_heroWorkspaceRow\) \.pI_x6G_centerCol\{background-color:transparent!important\}/, "the mask must be off only on the hero");
  assert.doesNotMatch(css, /#222222/, "linked mode must not use the split sidebar colour");
  const blurred = buildPersistentSkinStyle({ ...theme, appearance: { ...theme.appearance, regions: { ...theme.appearance.regions, main: { ...theme.appearance.regions.main, blurPx: 12 } } } });
  assert.match(blurred, /html body::before\{/, "a blurred backdrop must still use the pseudo canvas");
  const doc = { designId: "d", revision: 1, hash: "h".repeat(64), theme };
  const html = injectPersistentSkinStyle("<html><head></head><body></body></html>", () => doc);
  assert.match(html, /id="dsh-skin-persistent"/);
  assert.equal(injectPersistentSkinStyle(html, () => doc), html, "double injection must be idempotent");
  const split = buildPersistentSkinStyle({ ...theme, appearance: { ...theme.appearance, regions: { ...theme.appearance.regions, linked: false } } });
  assert.match(split, /\.pI_x6G_sidebarCol\{/);
  assert.match(split, /\.pI_x6G_centerCol\{/);
  assert.doesNotMatch(split, /body::before/, "split mode must not use the linked body canvas");
});

test("Host balance proxy resolves the key from credentials and normalizes the DeepSeek payload", async () => {
  const root = await tempRoot("balance");
  try {
    const credentials = join(root, ".credentials.yaml");
    await writeFile(credentials, "OMNIROUTE_API_KEY: 'sk-omniroute'\nDEEPSEEK_API_KEY: \"sk-deepseek-real\"\nother: plain\n");
    assert.equal(resolveBalanceApiKey(root), "sk-deepseek-real");
    assert.equal(resolveBalanceApiKey(join(root, "missing")), null);
    assert.equal(normalizeBalancePayload(null), null);
    assert.equal(normalizeBalancePayload({ is_available: true, balance_infos: [] }), null);
    assert.equal(normalizeBalancePayload({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: 110 }] }), null, "string balances only");
    assert.deepEqual(normalizeBalancePayload({
      is_available: true,
      balance_infos: [{ currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" }]
    }), { currency: "CNY", total: "110.00", granted: "10.00", toppedUp: "100.00", isAvailable: true });
  } finally { await safeRemove(root); }
});

test("Balance chip is capability-pinned and the Host route never leaks the API key", async () => {
  const clientSource = await readFile(join(projectRoot, "packages", "dsh-plugin", "src", "client", "index.ts"), "utf8");
  const hostSource = await readFile(join(projectRoot, "packages", "dsh-plugin", "src", "host", "index.ts"), "utf8");
  assert.match(clientSource, /data-dsh-skin-balance/, "the composer must expose a discoverable balance chip");
  assert.match(clientSource, /div\.FJxK0a_root/, "the chip must be capability-pinned to the rc.6 composer dock");
  assert.match(clientSource, /div\.uV2eYG_trailing/, "the chip must also mount on the always-present composer trailing row");
  assert.match(clientSource, /dsh-skin-balance:v1/, "the chip must persist its value in localStorage so a reload paints immediately");
  assert.match(clientSource, /fetch\(`\/dsh-skin\/balance/, "the chip must query the same-origin Host proxy");
  assert.match(hostSource, /path: "\/dsh-skin\/balance"/, "the Host must provide the same-origin balance proxy route");
  assert.match(hostSource, /BALANCE_API_KEY_ENV/, "the balance key must resolve from the conventional DeepSeek env/credentials name");
  assert.match(hostSource, /authorization: `Bearer \$\{apiKey\}`/, "the resolved key may only be placed in the outgoing authorization header");
  assert.doesNotMatch(hostSource, /message: [^,;]*\$\{apiKey\}/, "error responses must never interpolate the resolved key");
});

test("sidebar balance button mounts above settings and the mask is CSS-owned when the base is present", async () => {
  const clientSource = await readFile(join(projectRoot, "packages", "dsh-plugin", "src", "client", "index.ts"), "utf8");
  const hostSource = await readFile(join(projectRoot, "packages", "dsh-plugin", "src", "host", "index.ts"), "utf8");
  assert.match(clientSource, /data-dsh-skin-balance-button/, "the sidebar must expose a balance button");
  assert.match(clientSource, /hHd-Xa_settingsArea/, "the balance button must mount inside the settings area");
  assert.match(clientSource, /persistentBaseActive\(\)/, "the client must know when the persistent base owns the mask");
  assert.match(clientSource, /if \(persistentBaseActive\(\)\) return;/, "inline mask painting must yield to the persistent stylesheet");
  assert.match(hostSource, /\.pI_x6G_sidebarCol \.hHd-Xa_root\{background:transparent!important;position:relative!important;z-index:1!important\}/, "the persistent base must keep the sidebar content root transparent and stacked on any replacement");
  assert.match(clientSource, /installConversationMaskAccelerator/, "the client must accelerate the conversation mask onto the click instant");
  assert.match(clientSource, /YDXeBa_sessionRow/, "the mask controller must trigger on explicit conversation-row clicks");
  assert.match(clientSource, /wSkVaW_heroWorkspaceRow/, "the mask controller must observe the hero row as a non-click fallback");
  assert.match(clientSource, /data-dsh-skin-view/, "the mask must be keyed on an explicit client-held view attribute");
  assert.match(clientSource, /pinned/, "an opening conversation must be pinned against hero-row churn");
  assert.match(clientSource, /DEBOUNCE_MS = 400/, "the hero-row fallback must be debounced so transient churn cannot flip the view");
  assert.match(clientSource, /#root \.pI_x6G_centerCol/, "the injected rules must outrank the persistent stylesheet via the #root id");
  assert.match(clientSource, /alphaColor\(contextMaskColor\(main\), 0\.7\)/, "the conversation mask must retain the configured 70% opacity");
  assert.match(clientSource, /ACTIVE_ROOT_SELECTOR = "div\.wSkVaW_root\[data-phase=active\]"/, "the active conversation phase must be the authoritative mask trigger");
  assert.match(clientSource, /document\.addEventListener\("pointerdown", onNavigationIntent, true\)/, "conversation navigation must pin the mask before route DOM replacement");
  assert.match(clientSource, /style\.dataset\.dshSkinMask === signature/, "the accelerator stylesheet must refresh when a preview theme changes");
  assert.match(clientSource, /ackSignature !== lastAckedSignature/, "the client must only POST the render receipt when the acknowledged theme changes");
  assert.match(clientSource, /Math\.min\(ackBackoffMs \* 2, 30_000\)/, "failed render receipts must back off exponentially with a bounded cap");
});

test("MCP stdio exposes plans and operations but no confirmation creation tool", { timeout: 15_000 }, () => {
  const script = "import assert from 'node:assert/strict'; import {Client} from '@modelcontextprotocol/sdk/client/index.js'; import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js'; const c=new Client({name:'test',version:'1'}); const t=new StdioClientTransport({command:process.execPath,args:['dist/index.js'],cwd:process.cwd(),stderr:'pipe'}); await c.connect(t); const r=await c.listTools(); assert.ok(r.tools.some(x=>x.name==='theme_restore_plan')); assert.ok(r.tools.some(x=>x.name==='operation_status')); assert.ok(!r.tools.some(x=>x.name.includes('confirmation'))); await c.close(); console.log(r.tools.length);";
  const result = run(process.execPath, ["--input-type=module", "-e", script], { cwd: join(projectRoot, "packages", "mcp-server") });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  // Isolation controls add tools over time; confirmation creation remains
  // deliberately absent from the agent-facing surface.
  assert.match(result.stdout, /^(2[1-9]|[3-9]\d)\n?$/m);
});

coldSkillTest("Skill validates and cold-installs a source-independent runtime into an isolated CodexHome", { timeout: 180_000 }, async () => {
  const skill = join(projectRoot, "agents", "codex-skill", "deepseek-harness-skin-studio");
  const skillText = await readFile(join(skill, "SKILL.md"), "utf8");
  assert.match(skillText, /^---\r?\nname:\s*deepseek-harness-skin-studio\r?\n/);
  assert.match(skillText, /\r?\ndescription:\s*\S+/);
  for (const required of ["scripts/install-local.ps1", "scripts/open-studio.ps1", "runtime/node_modules/@dsh-skin/controller/dist/index.js", "runtime/node_modules/@dsh-skin/mcp-server/dist/index.js", "runtime/plugin/dist/host/index.js"]) {
    assert.equal(existsSync(join(skill, ...required.split("/"))), true, `Skill package is missing ${required}`);
  }
  if (process.env.CODEX_SKILL_VALIDATOR) {
    const validator = strictAbsolutePath(process.env.CODEX_SKILL_VALIDATOR, "CODEX_SKILL_VALIDATOR");
    assert.equal(existsSync(validator), true, `CODEX_SKILL_VALIDATOR does not exist: ${validator}`);
    const validated = run("python", [validator, skill]);
    assert.equal(validated.status, 0, validated.stderr || validated.stdout);
  }
  const root = await tempRoot("codex-home");
  const dshHome = join(root, "isolated.dsh");
  const dataDir = join(root, "controller-data");
  const localAppData = join(root, "local-app-data");
  let controllerPid;
  try {
    await mkdir(dshHome, { recursive: true });
    const isolatedEnv = { ...process.env, DSH_HOME: dshHome, DSH_SKIN_DATA_DIR: dataDir, LOCALAPPDATA: localAppData, DSH_SKIN_PROJECT_ROOT: join(root, "source-project-does-not-exist") };
    const installed = run(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(skill, "scripts", "install-local.ps1"), "-CodexHome", root, "-SkipMcpRegistration"], { cwd: root, env: isolatedEnv, timeout: 150_000 });
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    const destination = join(root, "skills", "deepseek-harness-skin-studio");
    const runtime = join(destination, "runtime");
    assert.equal(existsSync(join(destination, "SKILL.md")), true);
    assert.equal(existsSync(join(destination, "runtime.local.json")), true);
    assert.match(installed.stdout, /"mcp"\s*:\s*"not-registered"/);
    await assertPortableRuntime(runtime);

    const opened = run(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(destination, "scripts", "open-studio.ps1"), "-NoBrowser"], { cwd: root, env: isolatedEnv, timeout: 15_000 });
    assert.equal(opened.status, 0, opened.stderr || opened.stdout);
    const discovery = JSON.parse(await readFile(join(dataDir, "controller-discovery.json"), "utf8"));
    assert.ok(Number.isSafeInteger(discovery.pid) && discovery.pid > 0);
    controllerPid = discovery.pid;
    spawnedPids.add(controllerPid);
    const openedResult = parseJsonOutput(opened.stdout);
    const studioUrl = openedResult?.result?.url ?? discovery.url;
    assert.match(studioUrl, /^http:\/\/(127\.0\.0\.1|localhost):\d+$/);
    const landing = await waitHttp(studioUrl, 10_000);
    assert.equal(landing.status, 200);
    assert.match(await landing.text(), /<div id="root"><\/div>/);

    assert.equal(discovery.url, studioUrl);

    const mcpEntry = join(runtime, "node_modules", "@dsh-skin", "mcp-server", "dist", "index.js");
    const mcpClientUrl = pathToFileURL(join(runtime, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client", "index.js")).href;
    const mcpStdioUrl = pathToFileURL(join(runtime, "node_modules", "@modelcontextprotocol", "sdk", "dist", "esm", "client", "stdio.js")).href;
    const mcpScript = `import assert from 'node:assert/strict'; import {Client} from ${JSON.stringify(mcpClientUrl)}; import {StdioClientTransport} from ${JSON.stringify(mcpStdioUrl)}; const env=Object.fromEntries(Object.entries(process.env).filter(([,v])=>typeof v==='string')); const c=new Client({name:'cold-test',version:'1'}); const t=new StdioClientTransport({command:process.execPath,args:[${JSON.stringify(mcpEntry)}],cwd:${JSON.stringify(dirname(mcpEntry))},env,stderr:'pipe'}); await c.connect(t); const listed=await c.listTools(); assert.ok(listed.tools.length>=21); assert.ok(!listed.tools.some((tool)=>tool.name.includes('confirmation'))); const doctor=await c.callTool({name:'doctor',arguments:{}}); assert.notEqual(doctor.isError,true); await c.close(); console.log('bundled-mcp-ok');`;
    const mcp = run(process.execPath, ["--input-type=module", "-e", mcpScript], { cwd: projectRoot, env: isolatedEnv });
    assert.equal(mcp.status, 0, mcp.stderr || mcp.stdout);
    assert.match(mcp.stdout, /bundled-mcp-ok/);
  } finally {
    if (!controllerPid && existsSync(join(dataDir, "controller-discovery.json"))) {
      try {
        const discovered = JSON.parse(await readFile(join(dataDir, "controller-discovery.json"), "utf8"));
        if (Number.isSafeInteger(discovered.pid) && discovered.pid > 0 && /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(discovered.url)) {
          controllerPid = discovered.pid;
          spawnedPids.add(controllerPid);
        }
      } catch {}
    }
    if (controllerPid) await stopOwnedPid(controllerPid);
    await safeRemove(root);
  }
});

if (process.env.DSH_REAL_HOME_READONLY && process.env.DSH_REAL_PID) {
  test("opt-in real DSH check is read-only and has no managed skin plugin", async () => {
    const home = strictAbsolutePath(process.env.DSH_REAL_HOME_READONLY, "DSH_REAL_HOME_READONLY");
    const pid = Number(process.env.DSH_REAL_PID);
    assert.ok(Number.isSafeInteger(pid) && pid > 0, "DSH_REAL_PID must be a positive integer");
    assert.doesNotThrow(() => process.kill(pid, 0));
    assert.equal(existsSync(join(home, "profiles", "node_modules", "@dsh-skin", "dsh-plugin", "package.json")), false);
    const patch = join(home, "profiles", "web", "cordis.patch.yml");
    const content = existsSync(patch) ? await readFile(patch, "utf8") : "";
    assert.doesNotMatch(content, /@dsh-skin\/dsh-plugin|dsh-skin-studio/);
  });
}

test("preview bearer persistence, failed provisioning, restart reconciliation, and PID-reuse safety stay isolated", { timeout: 90_000 }, async () => {
  const root = await tempRoot("preview-recovery");
  const dshHome = join(root, "controller.dsh");
  const dataDir = join(root, "controller-data");
  let controller;
  let restarted;
  let sleeper;
  try {
    await mkdir(dshHome, { recursive: true });
    const port = await freePort();
    controller = spawnManaged(process.execPath, [join(projectRoot, "apps", "controller", "dist", "index.js")], { cwd: projectRoot, shell: false, windowsHide: true, stdio: "ignore", env: { ...process.env, DSH_HOME: dshHome, DSH_SKIN_DATA_DIR: dataDir, DSH_SKIN_PORT: String(port), DSH_RC6_BIN: fixtureDshBin, DSH_SKIN_ISOLATED_PREVIEW_ONLY: "1" } });
    const base = `http://127.0.0.1:${port}`;
    await waitHttp(`${base}/api/v1/status`);
    const status = await request(base, "/api/v1/status");
    const headers = { "content-type": "application/json", "x-dsh-skin-csrf": status.csrfToken };
    const design = await request(base, "/api/v1/session/design", "POST", { name: "reconciliation" }, headers, 201);
    const started = await request(base, "/api/v1/preview-sessions", "POST", { designId: design.id, revision: design.revision }, headers, 202);
    const awaiting = await waitPreviewSession(base, started.session.id, (session) => session.state === "awaiting-render");
    const id = awaiting.id;
    const home = join(tmpdir(), `dsh-skin-isolated-${id}.dsh`);
    const runtimeData = join(dataDir, "isolated-preview-runtime", id);
    const cleanupPath = join(dataDir, "isolated-preview-cleanup", `${id}.json`);
    const stored = JSON.parse(await readFile(join(dataDir, "isolated-preview-sessions", `${id}.json`), "utf8"));
    assert.equal(stored.secret, undefined);
    assert.match(stored.secretHash, /^[0-9a-f]{64}$/);
    await assertNoPreviewBearerPersistence(dataDir);
    JSON.parse(await readFile(cleanupPath, "utf8"));
    assert.equal(existsSync(home), true);
    assert.equal(existsSync(runtimeData), true);

    // Hard-crash only the owning Controller, deliberately leaving its DSH child
    // for the successor's reconciliation path. Do not use /T here.
    await crashOwnedChild(controller); controller = undefined;
    await waitHttpUnavailable(base, 10_000);
    const restartPort = await freePort();
    restarted = spawnManaged(process.execPath, [join(projectRoot, "apps", "controller", "dist", "index.js")], { cwd: projectRoot, shell: false, windowsHide: true, stdio: "ignore", env: { ...process.env, DSH_HOME: dshHome, DSH_SKIN_DATA_DIR: dataDir, DSH_SKIN_PORT: String(restartPort), DSH_RC6_BIN: fixtureDshBin, DSH_SKIN_ISOLATED_PREVIEW_ONLY: "1" } });
    const restartedBase = `http://127.0.0.1:${restartPort}`;
    await waitHttp(`${restartedBase}/api/v1/status`, 20_000);
    const reconciled = await waitPreviewSession(restartedBase, id, (session) => session.state === "failed-safe", 20_000);
    assert.equal(reconciled.state, "failed-safe", "a restart must fail-safe an unrecoverable isolated preview");
    assert.equal(existsSync(home), false, "verified owned preview home must be reaped after restart");
    assert.equal(existsSync(runtimeData), false, "verified owned runtime data must be reaped after restart");
    assert.equal(existsSync(cleanupPath), false, "verified cleanup metadata must be consumed after restart");
    await waitHttpUnavailable(awaiting.url, 15_000);

    // A plausible-looking PID record with a mismatched creation date and no
    // managed patch evidence must not terminate or delete any candidate path.
    const core = new DesignSessionCore(dataDir);
    const fakeId = randomUUID();
    const fakeHome = join(tmpdir(), `dsh-skin-isolated-${fakeId}.dsh`);
    const fakeRuntime = join(dataDir, "isolated-preview-runtime", fakeId);
    sleeper = spawnManaged(process.execPath, ["-e", "setInterval(() => {}, 1000)", "web", "--port", "27123"], { cwd: projectRoot, shell: false, windowsHide: true, stdio: "ignore" });
    await mkdir(fakeHome, { recursive: true }); await mkdir(fakeRuntime, { recursive: true });
    const fakeDesign = await core.createDesign({ name: "fake cleanup record" });
    await core.store.write(`isolated-preview-sessions/${fakeId}.json`, { id: fakeId, designId: fakeDesign.id, revision: fakeDesign.revision, hash: "0".repeat(64), generation: 1, theme: fakeDesign.theme, secretHash: "f".repeat(64), state: "awaiting-render", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() });
    await core.store.write(`isolated-preview-cleanup/${fakeId}.json`, { id: fakeId, pid: sleeper.pid, port: 27123, bin: process.execPath, home: fakeHome, runtimeData: fakeRuntime, createdAt: new Date().toISOString(), processCreationDate: "/Date(0)/" });
    await crashOwnedChild(restarted); restarted = undefined;
    const safePort = await freePort();
    restarted = spawnManaged(process.execPath, [join(projectRoot, "apps", "controller", "dist", "index.js")], { cwd: projectRoot, shell: false, windowsHide: true, stdio: "ignore", env: { ...process.env, DSH_HOME: dshHome, DSH_SKIN_DATA_DIR: dataDir, DSH_SKIN_PORT: String(safePort), DSH_RC6_BIN: fixtureDshBin, DSH_SKIN_ISOLATED_PREVIEW_ONLY: "1" } });
    const safeBase = `http://127.0.0.1:${safePort}`;
    await waitHttp(`${safeBase}/api/v1/status`, 20_000);
    const fakeSession = await waitPreviewSession(safeBase, fakeId, (session) => session.state === "failed-safe", 20_000);
    assert.doesNotThrow(() => process.kill(sleeper.pid, 0), "PID-reuse guard must not kill an unverified process");
    assert.equal(existsSync(fakeHome), true, "PID-reuse guard must not remove an unverified home");
    assert.equal(existsSync(fakeRuntime), true, "PID-reuse guard must not remove unverified runtime data");
    assert.equal(existsSync(join(dataDir, "isolated-preview-cleanup", `${fakeId}.json`)), false, "unverified metadata may be discarded without touching candidate paths");
    assert.equal(fakeSession.state, "failed-safe");
    await stopChild(sleeper); sleeper = undefined;
    await rm(fakeHome, { recursive: true, force: true }); await rm(fakeRuntime, { recursive: true, force: true });
  } finally {
    await stopChild(sleeper);
    await stopChild(restarted);
    await stopChild(controller);
    await safeRemove(root);
  }
});

test("failed isolated provisioning leaves no disposable home, runtime data, or cleanup record", { timeout: 30_000 }, async () => {
  const root = await tempRoot("preview-provision-failure");
  const dshHome = join(root, "controller.dsh");
  const dataDir = join(root, "controller-data");
  let controller;
  try {
    await mkdir(dshHome, { recursive: true });
    const port = await freePort();
    controller = spawnManaged(process.execPath, [join(projectRoot, "apps", "controller", "dist", "index.js")], { cwd: projectRoot, shell: false, windowsHide: true, stdio: "ignore", env: { ...process.env, DSH_HOME: dshHome, DSH_SKIN_DATA_DIR: dataDir, DSH_SKIN_PORT: String(port), DSH_RC6_BIN: join(root, "missing-rc6-bin.js"), DSH_SKIN_ISOLATED_PREVIEW_ONLY: "1" } });
    const base = `http://127.0.0.1:${port}`;
    await waitHttp(`${base}/api/v1/status`);
    const status = await request(base, "/api/v1/status");
    const headers = { "content-type": "application/json", "x-dsh-skin-csrf": status.csrfToken };
    const design = await request(base, "/api/v1/session/design", "POST", { name: "provision failure" }, headers, 201);
    const started = await request(base, "/api/v1/preview-sessions", "POST", { designId: design.id, revision: design.revision }, headers, 202);
    const failed = await waitPreviewSession(base, started.session.id, (session) => session.state === "failed-safe", 15_000);
    assert.equal(failed.error?.code, "UNSUPPORTED_DSH_VERSION");
    assert.equal(existsSync(join(tmpdir(), `dsh-skin-isolated-${failed.id}.dsh`)), false);
    assert.equal(existsSync(join(dataDir, "isolated-preview-runtime", failed.id)), false);
    assert.equal(existsSync(join(dataDir, "isolated-preview-cleanup", `${failed.id}.json`)), false);
    await assertNoPreviewBearerPersistence(dataDir);
  } finally { await stopChild(controller); await safeRemove(root); }
});

test("a delayed warm-host health response cannot restore a stale pre-update preview record", async () => {
  const root = await tempRoot("warm-await-host-race");
  const core = new DesignSessionCore(root);
  const id = randomUUID();
  const originalFetch = globalThis.fetch;
  let releaseHealth;
  let healthRequested;
  try {
    const first = await core.createDesign({ name: "await host race" });
    const latest = await core.patchDesign(first.id, first.revision, { appearance: { backdrop: { kind: "solid", colors: ["#506070"], angle: 0, opacity: 1, blurPx: 0 } } }, randomUUID());
    const runtime = new PreviewRuntime(core, { controllerUrl: () => "http://127.0.0.1:9", controllerInstanceId: () => randomUUID(), changed: () => {} });
    // This race test covers record reconciliation only; avoid provisioner I/O.
    runtime.writeSessionTheme = async () => {};
    await core.store.write(`isolated-preview-sessions/${id}.json`, {
      id, designId: first.id, revision: first.revision, hash: canonicalHash(first.theme), generation: 1, theme: first.theme,
      secretHash: "f".repeat(64), state: "awaiting-host", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), operationId: undefined, url: "http://127.0.0.1:29999"
    });
    globalThis.fetch = async () => {
      healthRequested?.();
      return new Promise((resolveResponse) => { releaseHealth = () => resolveResponse(new Response("ok", { status: 200 })); });
    };
    const awaitingHost = runtime.awaitHost(id, "http://127.0.0.1:29999");
    await new Promise((resolveRequested) => { healthRequested = resolveRequested; });
    const updated = await runtime.update(id, latest.id, latest.revision);
    assert.equal(updated.generation, 2);
    assert.equal(updated.revision, latest.revision);
    releaseHealth();
    await awaitingHost;
    const stored = await runtime.get(id);
    assert.equal(stored.generation, 2, "late g1 health completion must not overwrite the newer generation");
    assert.equal(stored.revision, latest.revision, "late g1 health completion must not restore the old revision");
    assert.equal(stored.hash, canonicalHash(latest.theme), "late g1 health completion must not restore the old theme hash");
    assert.equal(stored.state, "awaiting-render");
    await runtime.stop(id);
  } finally {
    globalThis.fetch = originalFetch;
    await safeRemove(root);
  }
});

test("an acknowledgement racing a warm update cannot resurrect the old receipt", async () => {
  const root = await tempRoot("warm-ack-race");
  const core = new DesignSessionCore(root);
  const id = randomUUID();
  const controllerInstanceId = randomUUID();
  const secret = "x".repeat(43);
  const originalWrite = core.store.write.bind(core.store);
  let releaseAckWrite;
  let ackWriteStarted;
  let blockAckWrite = false;
  try {
    const first = await core.createDesign({ name: "ack race" });
    const latest = await core.patchDesign(first.id, first.revision, { appearance: { backdrop: { kind: "solid", colors: ["#607080"], angle: 0, opacity: 1, blurPx: 0 } } }, randomUUID());
    const runtime = new PreviewRuntime(core, { controllerUrl: () => "http://127.0.0.1:9", controllerInstanceId: () => controllerInstanceId, changed: () => {} });
    runtime.writeSessionTheme = async () => {};
    await core.store.write(`isolated-preview-sessions/${id}.json`, {
      id, designId: first.id, revision: first.revision, hash: canonicalHash(first.theme), generation: 1, theme: first.theme,
      secretHash: canonicalHash(secret), state: "awaiting-render", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), operationId: undefined
    });
    core.store.write = async (path, value) => {
      if (blockAckWrite && path === `isolated-preview-sessions/${id}.json` && value?.generation === 1 && value?.state === "live" && value?.receipt?.pluginInstanceId) {
        ackWriteStarted?.();
        await new Promise((resolveWrite) => { releaseAckWrite = resolveWrite; });
      }
      return originalWrite(path, value);
    };
    blockAckWrite = true;
    const oldReceipt = { sessionId: id, generation: 1, designId: first.id, revision: first.revision, hash: canonicalHash(first.theme), pluginInstanceId: randomUUID(), clientInstanceId: randomUUID(), controllerInstanceId };
    const ack = runtime.acknowledge(id, secret, oldReceipt);
    await new Promise((resolveStarted) => { ackWriteStarted = resolveStarted; });
    const update = runtime.update(id, latest.id, latest.revision);
    // Either the acknowledgement is rejected by a serialized update or it
    // completes first. In both cases releasing it must not restore g1 later.
    releaseAckWrite();
    await Promise.allSettled([ack, update]);
    const final = await runtime.get(id);
    assert.equal(final.generation, 2);
    assert.equal(final.revision, latest.revision);
    assert.equal(final.state, "awaiting-render");
    await assert.rejects(() => runtime.requireLiveReceipt(id, 1, "e".repeat(64), first.id, first.revision, canonicalHash(first.theme)), /exact currently rendered isolated preview/);
    await runtime.stop(id);
  } finally {
    core.store.write = originalWrite;
    await safeRemove(root);
  }
});

test("a duplicate real render acknowledgement keeps the current generation receipt stable", async () => {
  const root = await tempRoot("stable-live-receipt");
  const core = new DesignSessionCore(root);
  const id = randomUUID();
  const controllerInstanceId = randomUUID();
  const secret = "x".repeat(43);
  try {
    const design = await core.createDesign({ name: "stable receipt" });
    const pluginInstanceId = randomUUID();
    const firstClientId = randomUUID();
    await core.store.write(`isolated-preview-sessions/${id}.json`, {
      id, designId: design.id, revision: design.revision, hash: canonicalHash(design.theme), generation: 1, theme: design.theme,
      secretHash: canonicalHash(secret), state: "awaiting-render", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), operationId: undefined
    });
    const runtime = new PreviewRuntime(core, { controllerUrl: () => "http://127.0.0.1:9", controllerInstanceId: () => controllerInstanceId, changed: () => {} });
    runtime.writeSessionTheme = async () => {};
    const first = await runtime.acknowledge(id, secret, { sessionId: id, generation: 1, designId: design.id, revision: design.revision, hash: canonicalHash(design.theme), pluginInstanceId, clientInstanceId: firstClientId, controllerInstanceId });
    const duplicate = await runtime.acknowledge(id, secret, { sessionId: id, generation: 1, designId: design.id, revision: design.revision, hash: canonicalHash(design.theme), pluginInstanceId, clientInstanceId: randomUUID(), controllerInstanceId });
    assert.equal(first.state, "live");
    assert.equal(duplicate.renderReceiptHash, first.renderReceiptHash, "a second Studio iframe must not revoke an unchanged plan");
    assert.equal(duplicate.generation, first.generation);
    await runtime.requireLiveReceipt(id, first.generation, first.renderReceiptHash, design.id, design.revision, canonicalHash(design.theme));
    await runtime.stop(id);
  } finally { await safeRemove(root); }
});

test("a warm-runner theme-write failure fails safe and clears only its owned disposable resources", async () => {
  const root = await tempRoot("warm-write-failure");
  const core = new DesignSessionCore(root);
  const id = randomUUID();
  const home = join(tmpdir(), `dsh-skin-isolated-${id}.dsh`);
  const runtimeData = join(root, "isolated-preview-runtime", id);
  try {
    const first = await core.createDesign({ name: "warm write failure" });
    const latest = await core.patchDesign(first.id, first.revision, { appearance: { backdrop: { kind: "solid", colors: ["#708090"], angle: 0, opacity: 1, blurPx: 0 } } }, randomUUID());
    const expiresAt = new Date(Date.now() + 40).toISOString();
    const record = {
      id, designId: first.id, revision: first.revision, hash: canonicalHash(first.theme), generation: 1, theme: first.theme,
      secretHash: "f".repeat(64), state: "awaiting-render", createdAt: new Date().toISOString(), expiresAt, operationId: undefined
    };
    await mkdir(home, { recursive: true });
    await mkdir(runtimeData, { recursive: true });
    await core.store.write(`isolated-preview-sessions/${id}.json`, record);
    await core.store.write(`isolated-preview-cleanup/${id}.json`, {
      id, pid: 999999, port: 29999, bin: process.execPath, home, runtimeData, createdAt: new Date().toISOString(), processCreationDate: "/Date(0)/"
    });
    const runtime = new PreviewRuntime(core, { controllerUrl: () => "http://127.0.0.1:9", controllerInstanceId: () => randomUUID(), changed: () => {} });
    runtime.rearmExpiry(record);
    runtime.writeSessionTheme = async () => { throw new Error("forced warm theme write failure"); };
    await assert.rejects(() => runtime.update(id, latest.id, latest.revision), /forced warm theme write failure/);
    const failed = await runtime.get(id);
    assert.equal(failed.state, "failed-safe", "a failed warm update must not remain updating");
    assert.match(failed.error?.message ?? "", /Unable to write the isolated preview theme/);
    await delay(100);
    assert.equal((await runtime.get(id)).state, "failed-safe", "the pre-existing expiry timer must not convert a failed-safe session to expired");
    await runtime.stop(id, true);
    assert.equal((await runtime.get(id)).state, "failed-safe", "an explicit expiry pass must leave failed-safe terminal state intact");
    assert.equal(existsSync(home), false, "failure cleanup must remove its owned disposable DSH home");
    assert.equal(existsSync(runtimeData), false, "failure cleanup must remove its owned runtime data");
    assert.equal(existsSync(join(root, "isolated-preview-cleanup", `${id}.json`)), false, "failure cleanup must remove its owned cleanup metadata");
  } finally { await safeRemove(root); }
});

test("rapid draft edits reuse one warm isolated runner and retain only the final revision", { timeout: 90_000 }, async () => {
  const root = await tempRoot("warm-preview");
  const dshHome = join(root, "controller.dsh");
  const dataDir = join(root, "controller-data");
  let controller;
  try {
    await mkdir(dshHome, { recursive: true });
    const port = await freePort();
    controller = spawnManaged(process.execPath, [join(projectRoot, "apps", "controller", "dist", "index.js")], {
      cwd: projectRoot, shell: false, windowsHide: true, stdio: "ignore",
      env: { ...process.env, DSH_HOME: dshHome, DSH_SKIN_DATA_DIR: dataDir, DSH_SKIN_PORT: String(port), DSH_RC6_BIN: fixtureDshBin, DSH_SKIN_ISOLATED_PREVIEW_ONLY: "1" }
    });
    const base = `http://127.0.0.1:${port}`;
    await waitHttp(`${base}/api/v1/status`);
    const status = await request(base, "/api/v1/status");
    const headers = { "content-type": "application/json", "x-dsh-skin-csrf": status.csrfToken };
    const design = await request(base, "/api/v1/session/design", "POST", { name: "warm preview burst" }, headers, 201);

    // Concurrent callers model Studio bootstrap, Agent calls, and a human edit
    // arriving together. They must share one durable session/temporary DSH.
    const created = await Promise.all(Array.from({ length: 8 }, () => request(base, "/api/v1/preview-sessions", "POST", { designId: design.id, revision: design.revision }, headers, 202)));
    const ids = new Set(created.map((entry) => entry.session.id));
    assert.equal(ids.size, 1, "parallel preview starts must reuse the warm session");
    const id = created[0].session.id;
    const initial = await waitPreviewSession(base, id, (session) => session.state === "awaiting-render");
    const initialGeneration = initial.generation;

    let latest = design;
    for (const color of ["#102030", "#203040", "#304050", "#405060", "#506070"]) {
      latest = await request(base, `/api/v1/design/${design.id}`, "PATCH", {
        baseRevision: latest.revision, actor: "human", patchId: randomUUID(),
        patch: { appearance: { backdrop: { kind: "solid", colors: [color], angle: 0, opacity: 1, blurPx: 0 } } }
      }, headers);
    }
    const finalSession = await waitPreviewSession(base, id, (session) => session.state === "awaiting-render" && session.revision === latest.revision && session.generation === initialGeneration + 1, 20_000);
    assert.equal(finalSession.revision, latest.revision, "the trailing update must render the final burst revision");
    assert.equal(finalSession.generation, initialGeneration + 1, "intermediate burst revisions must not each write the isolated DSH");
    const listed = await request(base, "/api/v1/preview-sessions");
    const active = listed.sessions.filter((session) => !["stopped", "expired", "failed-safe"].includes(session.state));
    assert.equal(active.length, 1, "Controller must keep at most one active isolated preview runner");
    assert.equal(active[0].id, id);
    const cleanupEntries = await readdir(join(dataDir, "isolated-preview-cleanup"));
    assert.equal(cleanupEntries.length, 1, "only the one warm runner may have owned cleanup metadata");
    assert.equal(existsSync(join(dshHome, "profiles", "node_modules", "@dsh-skin", "dsh-plugin", "package.json")), false, "the Controller's persistent DSH home must remain untouched");

    await request(base, `/api/v1/preview-sessions/${id}`, "DELETE", {}, headers);
    await waitHttpUnavailable(initial.url, 15_000);
    assert.equal(existsSync(join(tmpdir(), `dsh-skin-isolated-${id}.dsh`)), false, "stop must remove only the disposable warm runner home");
    assert.equal(existsSync(join(dshHome, "profiles", "node_modules", "@dsh-skin", "dsh-plugin", "package.json")), false, "cleanup must not modify the persistent DSH home");
  } finally { await stopChild(controller); await safeRemove(root); }
});

test("isolated preview sessions render real rc.6 themes and protect the persistent DSH until confirmation", { timeout: 120_000 }, async () => {
  const root = await tempRoot("rc6");
  const dshHome = join(root, "isolated.dsh");
  const dataDir = join(root, "controller-data");
  let controller;
  let browser;
  try {
    await mkdir(dshHome, { recursive: true });
    const fixtureVersion = run(process.execPath, [fixtureDshBin, "--version"]);
    assert.equal(fixtureVersion.status, 0, fixtureVersion.stderr || fixtureVersion.stdout);
    assert.match(fixtureVersion.stdout, /^0\.1\.0-rc\.6\s*$/m);
    const controllerPort = await freePort();
    controller = spawnManaged(process.execPath, [join(projectRoot, "apps", "controller", "dist", "index.js")], { cwd: projectRoot, shell: false, windowsHide: true, stdio: "ignore", env: { ...process.env, DSH_HOME: dshHome, DSH_SKIN_DATA_DIR: dataDir, DSH_SKIN_PORT: String(controllerPort), DSH_RC6_BIN: fixtureDshBin, DSH_SKIN_ISOLATED_PREVIEW_ONLY: "1" } });
    const base = `http://127.0.0.1:${controllerPort}`;
    await waitHttp(`${base}/api/v1/status`);
    const landing = await fetch(base);
    const status = await request(base, "/api/v1/status");
    const headers = { "content-type": "application/json", "x-dsh-skin-csrf": status.csrfToken };
    assert.ok(landing.headers.get("set-cookie"), "browser session cookie must be issued only by Studio");
    const publicStatus = JSON.stringify(status);
    assert.doesNotMatch(publicStatus, /pluginSecret|\"secret\"|\"pid\"|dsh-skin-isolated-|controller-data/i, "public status must not disclose a preview secret, PID, or temp path");
    assert.equal(status.dsh.url, null, "an isolated test Controller must not discover a user DSH URL");
    const design = await request(base, "/api/v1/session/design", "POST", { name: "isolated lifecycle" }, headers, 201);

    await request(base, "/api/v1/theme/apply-plan", "POST", { designId: design.id, revision: design.revision, installPlugin: true, target: { profile: "web" } }, headers, 422);
    const started = await request(base, "/api/v1/preview-sessions", "POST", { designId: design.id, revision: design.revision }, headers, 202);
    const initial = started.session;
    assert.equal(initial.id?.length, 36);
    assert.equal(initial.generation, 1);
    assert.doesNotMatch(JSON.stringify(initial), /secret|pid|dsh-skin-isolated-|controller-data/i);
    const awaiting = await waitPreviewSession(base, initial.id, (session) => session.state === "awaiting-render");
    assert.match(awaiting.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const privateRecord = JSON.parse(await readFile(join(dataDir, "isolated-preview-sessions", `${initial.id}.json`), "utf8"));
    assert.equal(privateRecord.secret, undefined, "Controller persistence must not retain a replayable preview secret");
    assert.match(privateRecord.secretHash, /^[0-9a-f]{64}$/);
    await assertNoPreviewBearerPersistence(dataDir);
    const previewHome = join(tmpdir(), `dsh-skin-isolated-${initial.id}.dsh`);
    const previewRuntimeData = join(dataDir, "isolated-preview-runtime", initial.id);
    const patchText = await readFile(join(previewHome, "profiles", "web", "cordis.patch.yml"), "utf8");
    const privateSecret = /pluginSecret:\s*["']?([A-Za-z0-9_-]{32,})/.exec(patchText)?.[1];
    assert.ok(privateSecret, "test-owned disposable DSH patch must contain the Host bearer secret");
    const badSecret = await fetch(`${base}/api/v1/preview-sessions/${initial.id}/host/state`, { headers: { authorization: "Bearer invalid-preview-secret-xxxxxxxxxxxxxxxx" } });
    assert.equal(badSecret.status, 403);
    const wrongSession = await fetch(`${base}/api/v1/preview-sessions/${randomUUID()}/host/state`, { headers: { authorization: `Bearer ${privateSecret}` } });
    assert.equal(wrongSession.status, 404);
    const hostState = await fetch(`${base}/api/v1/preview-sessions/${initial.id}/host/state`, { headers: { authorization: `Bearer ${privateSecret}` } });
    assert.equal(hostState.status, 200);
    assert.doesNotMatch(await hostState.text(), /secret|pid|dsh-skin-isolated-|controller-data/i);

    browser = await chromium.launch({ executablePath: resolveChromiumExecutable(), headless: true, args: ["--disable-gpu", "--no-sandbox"] });
    const context = await browser.newContext({ colorScheme: "dark" });
    const dshPage = await context.newPage();
    const rejectedRender = await fetch(`${awaiting.url}/dsh-skin/rendered`, { method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1:1" }, body: JSON.stringify({ mode: "preview", sessionId: initial.id, generation: initial.generation, designId: initial.designId, revision: initial.revision, hash: initial.hash, pluginInstanceId: randomUUID(), clientInstanceId: randomUUID() }) });
    assert.equal(rejectedRender.status, 403);
    await dshPage.goto(awaiting.url, { waitUntil: "domcontentloaded" });
    await waitForRenderedClient(dshPage, { ...awaiting, mode: "preview" });
    const initialLinked = regionLayer(dshPage, "linked");
    await initialLinked.waitFor({ state: "attached" });
    const live = await waitPreviewSession(base, initial.id, (session) => session.state === "live" && typeof session.renderReceiptHash === "string");
    assert.equal(await initialLinked.evaluate((node) => getComputedStyle(node).backgroundImage.includes("radial-gradient")), true, "linked v1 migration must visibly install one shared backdrop");
    assert.equal(await regionLayer(dshPage, "sidebar").count(), 0, "linked mode must not create a second sidebar backdrop");
    assert.equal(await regionLayer(dshPage, "main").count(), 0, "linked mode must not create a second main backdrop");
    assert.equal(await boundaryLayer(dshPage).count(), 0, "legacy linked themes must remain seamless without a divider");
    const sidebarShell = dshPage.locator("div.pI_x6G_sidebarCol > div > div.hHd-Xa_root.hHd-Xa_quietBars");
    const sidebarFade = dshPage.locator("div.pI_x6G_sidebarCol .qDHVXG_fade");
    await sidebarShell.waitFor({ state: "attached" });
    await sidebarFade.waitFor({ state: "attached" });
    assert.equal(await sidebarShell.evaluate((node) => getComputedStyle(node).backgroundColor), "rgba(0, 0, 0, 0)", "the opaque rc.6 sidebar shell must not cover a linked canvas");
    assert.deepEqual(await sidebarFade.evaluate((node) => ({ color: getComputedStyle(node).backgroundColor, image: getComputedStyle(node).backgroundImage })), { color: "rgba(0, 0, 0, 0)", image: "none" }, "the native sidebar bottom fade must be neutralized so it cannot leave a black slab above settings");
    assert.equal(await dshPage.locator("div.pI_x6G_sidebarCol").evaluate((node) => getComputedStyle(node).borderRightColor), "rgba(0, 0, 0, 0)", "linked canvas must remove the split-only sidebar boundary");
    const conversationRoot = dshPage.locator("div.wSkVaW_root");
    await conversationRoot.waitFor({ state: "attached" });
    assert.equal(await conversationRoot.getAttribute("data-phase"), "hero", "the real rc.6 New Session page must expose its capability-pinned hero phase");
    const mainMaskSurface = dshPage.locator('[data-dsh-skin-main-mask-surface="1"]');
    assert.equal(await mainMaskSurface.count(), 1, "the capability-pinned main workspace surface must be uniquely marked for conversation masking");
    const sidebarBackdropBeforeConversation = await dshPage.locator("div.pI_x6G_sidebarCol").evaluate((node) => ({ inline: node.getAttribute("style"), color: getComputedStyle(node).backgroundColor }));
    assert.deepEqual(await Promise.all([conversationRoot.getAttribute("data-dsh-skin-main-mask"), mainMaskSurface.evaluate((node) => getComputedStyle(node).backgroundColor)]).then(([mask, background]) => ({ mask, background })), { mask: "base", background: "rgba(0, 0, 0, 0)" }, "the New Session page must retain the configured main backdrop without a conversation mask");
    await conversationRoot.evaluate((node) => { node.setAttribute("data-phase", "active"); });
    await dshPage.waitForFunction(() => document.querySelector("div.wSkVaW_root")?.getAttribute("data-dsh-skin-main-mask") === "70");
    assert.deepEqual(await Promise.all([conversationRoot.getAttribute("data-dsh-skin-main-mask"), mainMaskSurface.evaluate((node) => getComputedStyle(node).backgroundColor)]).then(([mask, background]) => ({ mask, background })), { mask: "70", background: "rgba(0, 0, 0, 0.7)" }, "entering an active conversation must raise only the real main workspace mask to 70 percent");
    assert.deepEqual(await dshPage.locator("div.pI_x6G_sidebarCol").evaluate((node) => ({ inline: node.getAttribute("style"), color: getComputedStyle(node).backgroundColor })), sidebarBackdropBeforeConversation, "the active-conversation mask must not alter the sidebar backdrop");
    await conversationRoot.evaluate((node) => { node.setAttribute("data-phase", "hero"); });
    await dshPage.waitForFunction(() => document.querySelector("div.wSkVaW_root")?.getAttribute("data-dsh-skin-main-mask") === "base");
    assert.deepEqual(await Promise.all([conversationRoot.getAttribute("data-dsh-skin-main-mask"), mainMaskSurface.evaluate((node) => getComputedStyle(node).backgroundColor)]).then(([mask, background]) => ({ mask, background })), { mask: "base", background: "rgba(0, 0, 0, 0)" }, "returning to the New Session hero must restore the configured main mask strength");
    assert.equal(await renderedTokenValue(dshPage, "--dsw-alias-brand-primary"), design.theme.appearance.tokens["--dsw-alias-brand-primary"].dark, "real ThemeRuntime may scope tokens below documentElement");

    const staleAck = await fetch(`${base}/api/v1/preview-sessions/${initial.id}/host/rendered`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${privateSecret}` }, body: JSON.stringify({ sessionId: initial.id, generation: 999, designId: design.id, revision: design.revision, hash: initial.hash, pluginInstanceId: randomUUID(), clientInstanceId: randomUUID(), controllerInstanceId: status.instanceId }) });
    assert.equal(staleAck.status, 409, "wrong generation must be rejected even with the private Host secret");
    const wrongHash = await fetch(`${base}/api/v1/preview-sessions/${initial.id}/host/rendered`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${privateSecret}` }, body: JSON.stringify({ sessionId: initial.id, generation: live.generation, designId: design.id, revision: design.revision, hash: "0".repeat(64), pluginInstanceId: randomUUID(), clientInstanceId: randomUUID(), controllerInstanceId: status.instanceId }) });
    assert.equal(wrongHash.status, 409, "wrong rendered hash must be rejected");

    const solid = await request(base, `/api/v1/design/${design.id}`, "PATCH", { baseRevision: design.revision, actor: "human", patchId: randomUUID(), patch: { appearance: { backdrop: { kind: "solid", colors: ["#102030"], angle: 0, opacity: 1, blurPx: 0 }, tokens: { "--dsw-alias-brand-primary": { light: "#123456", dark: "#00d4aa" } } } } }, headers);
    const solidLive = await waitPreviewSession(base, initial.id, (session) => session.state === "live" && session.generation > live.generation && session.revision === solid.revision && typeof session.renderReceiptHash === "string");
    await waitForRenderedClient(dshPage, { ...solidLive, mode: "preview" });
    assert.equal(await regionLayer(dshPage, "linked").evaluate((node) => getComputedStyle(node).backgroundColor), "rgb(16, 32, 48)", "linked solid revision must visibly apply to one shared canvas");
    assert.equal(await renderedTokenValue(dshPage, "--dsw-alias-brand-primary"), "#00d4aa", "solid revision token must be applied by the real Client");
    const previousLinkedLayer = await regionLayer(dshPage, "linked").elementHandle();
    assert.ok(previousLinkedLayer, "the initial linked layer must exist before simulating an rc.6 hydration replacement");
    let stateRequestsDuringLocalRemount = 0;
    const countStateRequest = (request) => { if (new URL(request.url()).pathname === "/dsh-skin/state") stateRequestsDuringLocalRemount += 1; };
    dshPage.on("request", countStateRequest);
    const remountStartedAt = Date.now();
    await sidebarShell.evaluate((node) => node.replaceWith(node.cloneNode(true)));
    await dshPage.waitForFunction((previous) => previous.isConnected && document.querySelectorAll('[data-dsh-skin-studio-backdrop="linked"]').length === 1, previousLinkedLayer, { timeout: 900 });
    dshPage.off("request", countStateRequest);
    assert.ok(Date.now() - remountStartedAt < 900, "replacing a capability-pinned rc.6 surface must remount before the 1.2s polling fallback");
    assert.equal(stateRequestsDuringLocalRemount, 0, "a route-root remount must reuse its acknowledged theme without another state request");
    const previousReceipt = { previewSessionId: solidLive.id, previewGeneration: solidLive.generation, renderReceiptHash: solidLive.renderReceiptHash };
    const plan = await request(base, "/api/v1/theme/apply-plan", "POST", { designId: solid.id, revision: solid.revision, installPlugin: true, target: { profile: "web" }, ...previousReceipt }, headers);
    assert.deepEqual(plan.preview, previousReceipt, "the immutable apply plan must echo the exact canonical isolated receipt binding used by Studio confirmation");
    const sidebarBytes = await sharp({ create: { width: 4, height: 3, channels: 4, background: "#ff0033" } }).png().toBuffer();
    const mainBytes = await sharp({ create: { width: 4, height: 3, channels: 4, background: "#00ccff" } }).png().toBuffer();
    const studioUploadBytes = await sharp(randomBytes(1024 * 1024 * 3), { raw: { width: 1024, height: 1024, channels: 3 } }).jpeg({ quality: 95, chromaSubsampling: "4:4:4" }).toBuffer();
    assert.ok(studioUploadBytes.length > 720 * 1024 && studioUploadBytes.length <= 4 * 1024 * 1024, "browser upload fixture must exceed the previous 720 KiB ceiling while staying inside the new bounded limit");
    const sidebarImage = await request(base, "/api/v1/assets", "POST", { mimeType: "image/png", dataBase64: sidebarBytes.toString("base64") }, headers, 201);
    const mainImage = await request(base, "/api/v1/assets", "POST", { mimeType: "image/png", dataBase64: mainBytes.toString("base64") }, headers, 201);
    const sidebarResponse = dshPage.waitForResponse((response) => response.url().includes(`/dsh-skin/assets/${sidebarImage.id}`) && response.status() === 200, { timeout: 20_000 });
    const mainResponse = dshPage.waitForResponse((response) => response.url().includes(`/dsh-skin/assets/${mainImage.id}`) && response.status() === 200, { timeout: 20_000 });
    const imageBackdrop = (assetId) => ({ kind: "image", assetId, fit: "cover", position: { xPercent: 50, yPercent: 50 }, opacity: 1, blurPx: 0, overlay: { color: "#000000", opacity: 0 } });
    const updated = await request(base, `/api/v1/design/${solid.id}`, "PATCH", { baseRevision: solid.revision, actor: "human", patchId: randomUUID(), patch: { appearance: { regions: { linked: false, sidebar: imageBackdrop(sidebarImage.id), main: imageBackdrop(mainImage.id) }, tokens: { "--dsw-alias-brand-primary": { light: "#123456", dark: "#e91e63" } } } } }, headers);
    const updatedLive = await waitPreviewSession(base, initial.id, (session) => session.state === "live" && session.generation > solidLive.generation && session.revision === updated.revision && typeof session.renderReceiptHash === "string");
    await waitForRenderedClient(dshPage, { ...updatedLive, mode: "preview" });
    await Promise.all([sidebarResponse, mainResponse]);
    assert.notEqual(sidebarImage.id, mainImage.id, "split mode must retain independently addressable sidebar and main image assets");
    assert.match(await regionLayer(dshPage, "sidebar").evaluate((node) => getComputedStyle(node).backgroundImage), new RegExp(sidebarImage.id), "high-contrast sidebar image must be visibly applied to the sidebar layer");
    assert.match(await regionLayer(dshPage, "main").evaluate((node) => getComputedStyle(node).backgroundImage), new RegExp(mainImage.id), "high-contrast main image must be visibly applied to the main layer");
    const splitImageBeforeConversationMask = await regionLayer(dshPage, "main").evaluate((node) => getComputedStyle(node).backgroundImage);
    await conversationRoot.evaluate((node) => { node.setAttribute("data-phase", "active"); });
    await dshPage.waitForFunction(() => document.querySelector("div.wSkVaW_root")?.getAttribute("data-dsh-skin-main-mask") === "70");
    assert.equal(await regionLayer(dshPage, "main").evaluate((node) => getComputedStyle(node).backgroundImage), splitImageBeforeConversationMask, "entering a conversation must retain the split main image rather than loading a replacement background");
    assert.match(await regionLayer(dshPage, "main").evaluate((node) => getComputedStyle(node).boxShadow), /rgba\(0, 0, 0, 0\.7\)/, "the split main backdrop must receive the 70 percent mask as a lightweight overlay");
    await conversationRoot.evaluate((node) => { node.setAttribute("data-phase", "hero"); });
    await dshPage.waitForFunction(() => document.querySelector("div.wSkVaW_root")?.getAttribute("data-dsh-skin-main-mask") === "base");
    const splitMainImageGeometry = await regionLayer(dshPage, "main").evaluate((node) => ({ size: getComputedStyle(node).backgroundSize, position: getComputedStyle(node).backgroundPosition, layer: node.getBoundingClientRect().toJSON(), target: document.querySelector('[data-dsh-skin-main-mask-surface="1"]')?.getBoundingClientRect().toJSON() }));
    assert.ok(splitMainImageGeometry.size.split(",").every((value) => value.trim() === "cover"), "the split main image must retain its configured fit mode on every background layer");
    assert.ok(splitMainImageGeometry.position.split(",").every((value) => value.trim() === "50% 50%"), "the split main image must start at its configured center position on every background layer");
    assert.deepEqual(splitMainImageGeometry.layer, splitMainImageGeometry.target, "the split main image layer must fill the whole independently derived main workspace surface");
    assert.equal(await sidebarShell.evaluate((node) => getComputedStyle(node).backgroundColor), "rgba(0, 0, 0, 0)", "the sidebar shell must also be transparent in independent-region mode");
    assert.equal(await sidebarShell.evaluate((node) => getComputedStyle(node).zIndex), "1", "the rc.6 sidebar content root must sit above an opaque split image layer so labels and controls remain visible");
    assert.equal(await boundaryLayer(dshPage, "blend").count(), 1, "split mode without a divider must install its managed soft transition band");
    assert.equal(await renderedTokenValue(dshPage, "--dsw-alias-brand-primary"), "#e91e63", "new token revision must be applied by the real Client");
    const repositioned = await request(base, `/api/v1/design/${updated.id}`, "PATCH", { baseRevision: updated.revision, actor: "human", patchId: randomUUID(), patch: { appearance: { regions: { main: { ...updated.theme.appearance.regions.main, position: { xPercent: 7, yPercent: 93 } } } } } }, headers);
    const repositionedLive = await waitPreviewSession(base, initial.id, (session) => session.state === "live" && session.generation > updatedLive.generation && session.revision === repositioned.revision && typeof session.renderReceiptHash === "string");
    await waitForRenderedClient(dshPage, { ...repositionedLive, mode: "preview" });
    const splitMainRepositioned = await regionLayer(dshPage, "main").evaluate((node) => getComputedStyle(node).backgroundPosition);
    assert.ok(splitMainRepositioned.split(",").every((value) => value.trim() === "7% 93%"), "the split main image position controls must update every rendered background layer");
    await request(base, "/api/v1/theme/apply-plan", "POST", { designId: repositioned.id, revision: repositioned.revision, installPlugin: true, target: { profile: "web" }, ...previousReceipt }, headers, 409);
    const repositionedReceipt = { previewSessionId: repositionedLive.id, previewGeneration: repositionedLive.generation, renderReceiptHash: repositionedLive.renderReceiptHash };
    await request(base, "/api/v1/theme/apply-plan", "POST", { designId: repositioned.id, revision: repositioned.revision, installPlugin: true, target: { profile: "web" }, ...repositionedReceipt }, headers);
    const splitColors = await request(base, `/api/v1/design/${repositioned.id}`, "PATCH", { baseRevision: repositioned.revision, actor: "human", patchId: randomUUID(), patch: { appearance: { regions: { linked: false, divider: false, sidebar: { kind: "solid", colors: ["#ff0033"], angle: 0, opacity: 1, blurPx: 0 }, main: { kind: "solid", colors: ["#00ccff"], angle: 0, opacity: 1, blurPx: 0 } } } } }, headers);
    const splitColorsLive = await waitPreviewSession(base, initial.id, (session) => session.state === "live" && session.generation > repositionedLive.generation && session.revision === splitColors.revision && typeof session.renderReceiptHash === "string");
    await waitForRenderedClient(dshPage, { ...splitColorsLive, mode: "preview" });
    assert.equal(await boundaryLayer(dshPage, "blend").count(), 1, "split colors without a divider must use one soft transition band");
    assert.match(await boundaryLayer(dshPage, "blend").evaluate((node) => getComputedStyle(node).backgroundImage), /color\(srgb|linear-gradient/, "the split transition must be composed from the two structured region colors");
    assert.deepEqual(await boundaryLayer(dshPage, "blend").evaluate((node) => ({ width: getComputedStyle(node).width, filter: getComputedStyle(node).filter, opacity: getComputedStyle(node).opacity, shadow: getComputedStyle(node).boxShadow })), { width: "72px", filter: "none", opacity: "1", shadow: "none" }, "the no-divider transition must be an opaque colour cross-fade, never a blurred or glowing separator");
    assert.equal(await dshPage.locator("div.pI_x6G_sidebarCol").evaluate((node) => getComputedStyle(node).borderRightColor), "rgba(0, 0, 0, 0)", "split blending must remove the hard native boundary");
    const splitDivider = await request(base, `/api/v1/design/${splitColors.id}`, "PATCH", { baseRevision: splitColors.revision, actor: "human", patchId: randomUUID(), patch: { appearance: { regions: { divider: true } } } }, headers);
    const splitDividerLive = await waitPreviewSession(base, initial.id, (session) => session.state === "live" && session.generation > splitColorsLive.generation && session.revision === splitDivider.revision && typeof session.renderReceiptHash === "string");
    await waitForRenderedClient(dshPage, { ...splitDividerLive, mode: "preview" });
    assert.equal(await boundaryLayer(dshPage, "blend").count(), 0, "split divider mode must remove the soft transition band");
    assert.equal(await boundaryLayer(dshPage, "divider").count(), 1, "split divider mode must render one managed divider");
    assert.equal(await boundaryLayer(dshPage, "divider").evaluate((node) => getComputedStyle(node).width), "1px", "the managed split divider must remain a visual line");
    const linked = await request(base, `/api/v1/design/${splitDivider.id}`, "PATCH", { baseRevision: splitDivider.revision, actor: "human", patchId: randomUUID(), patch: { appearance: { regions: { linked: true, divider: true, main: imageBackdrop(sidebarImage.id) } } } }, headers);
    const linkedLive = await waitPreviewSession(base, initial.id, (session) => session.state === "live" && session.generation > splitDividerLive.generation && session.revision === linked.revision && typeof session.renderReceiptHash === "string");
    await waitForRenderedClient(dshPage, { ...linkedLive, mode: "preview" });
    const linkedLayer = regionLayer(dshPage, "linked");
    await linkedLayer.waitFor({ state: "attached" });
    assert.match(await linkedLayer.evaluate((node) => getComputedStyle(node).backgroundImage), new RegExp(sidebarImage.id), "linked image must be painted by the one shared canvas");
    assert.equal(await regionLayer(dshPage, "sidebar").count(), 0, "linked image must remove the sidebar-specific layer");
    assert.equal(await regionLayer(dshPage, "main").count(), 0, "linked image must remove the main-specific layer");
    assert.equal(await sidebarShell.evaluate((node) => getComputedStyle(node).backgroundColor), "rgba(0, 0, 0, 0)", "linked image must reach the sidebar through the cleared rc.6 shell");
    assert.equal(await sidebarFade.evaluate((node) => getComputedStyle(node).backgroundImage), "none", "linked image must also clear the native bottom fade");
    assert.equal(await dshPage.locator("div.pI_x6G_sidebarCol").evaluate((node) => getComputedStyle(node).borderRightColor), "rgba(0, 0, 0, 0)", "linked image must remain seamless at the sidebar boundary");
    assert.equal(await boundaryLayer(dshPage, "divider").count(), 1, "linked divider mode must draw one overlay without splitting the shared canvas");
    const linkedGeometry = await dshPage.evaluate(() => {
      const layer = document.querySelector('[data-dsh-skin-studio-backdrop="linked"]');
      const sidebar = document.querySelector("div.pI_x6G_sidebarCol");
      const anchor = document.querySelector("div.wSkVaW_heroWorkspaceRow");
      if (!layer || !sidebar || !anchor) return null;
      let main = anchor;
      while (main?.parentElement && main.parentElement !== document.body) {
        if (main.parentElement.contains(sidebar)) break;
        main = main.parentElement;
      }
      if (!main?.parentElement) return null;
      const rect = (element) => { const value = element.getBoundingClientRect(); return { left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height }; };
      return { layer: rect(layer), composite: rect(layer.parentElement), sidebar: rect(sidebar), main: rect(main) };
    });
    assert.ok(linkedGeometry, "real rc.6 DOM must expose a common split-layout root for the linked canvas");
    assert.equal(linkedGeometry.layer.left, linkedGeometry.composite.left, "the linked layer must be anchored at the common root left edge");
    assert.equal(linkedGeometry.layer.right, linkedGeometry.composite.right, "the linked layer must be anchored at the common root right edge");
    assert.ok(linkedGeometry.composite.left <= Math.min(linkedGeometry.sidebar.left, linkedGeometry.main.left) && linkedGeometry.composite.right >= Math.max(linkedGeometry.sidebar.right, linkedGeometry.main.right), "the single linked canvas must span both regional surfaces");
    const dividerGeometry = await dshPage.evaluate(() => { const divider = document.querySelector('[data-dsh-skin-studio-boundary="divider"]'); const sidebar = document.querySelector("div.pI_x6G_sidebarCol"); if (!divider || !sidebar) return null; const line = divider.getBoundingClientRect(), side = sidebar.getBoundingClientRect(); return { center: line.left + line.width / 2, sidebarRight: side.right, top: line.top, sidebarTop: side.top, bottom: line.bottom, sidebarBottom: side.bottom }; });
    assert.ok(dividerGeometry && Math.abs(dividerGeometry.center - dividerGeometry.sidebarRight) <= 1 && Math.abs(dividerGeometry.top - dividerGeometry.sidebarTop) <= 1 && Math.abs(dividerGeometry.bottom - dividerGeometry.sidebarBottom) <= 1, "linked divider must align to the regional boundary without changing the shared canvas geometry");
    await dshPage.setViewportSize({ width: 1120, height: 760 });
    await dshPage.waitForTimeout(100);
    const resizedLayerCount = await regionLayer(dshPage, "linked").count();
    const resizedGeometry = await dshPage.evaluate(() => {
      const layer = document.querySelector('[data-dsh-skin-studio-backdrop="linked"]');
      const parent = layer?.parentElement;
      if (!layer || !parent) return null;
      const layerRect = layer.getBoundingClientRect(); const parentRect = parent.getBoundingClientRect();
      return { left: layerRect.left, right: layerRect.right, top: layerRect.top, bottom: layerRect.bottom, parentLeft: parentRect.left, parentRight: parentRect.right, parentTop: parentRect.top, parentBottom: parentRect.bottom };
    });
    assert.equal(resizedLayerCount, 1, "resizing must retain one shared linked canvas, not clone one per region");
    assert.deepEqual(resizedGeometry && { left: resizedGeometry.left, right: resizedGeometry.right, top: resizedGeometry.top, bottom: resizedGeometry.bottom }, resizedGeometry && { left: resizedGeometry.parentLeft, right: resizedGeometry.parentRight, top: resizedGeometry.parentTop, bottom: resizedGeometry.parentBottom }, "the linked image canvas must resize with the common split-layout root");
    const linkedNoDivider = await request(base, `/api/v1/design/${linked.id}`, "PATCH", { baseRevision: linked.revision, actor: "human", patchId: randomUUID(), patch: { appearance: { regions: { divider: false } } } }, headers);
    const linkedNoDividerLive = await waitPreviewSession(base, initial.id, (session) => session.state === "live" && session.generation > linkedLive.generation && session.revision === linkedNoDivider.revision && typeof session.renderReceiptHash === "string");
    await waitForRenderedClient(dshPage, { ...linkedNoDividerLive, mode: "preview" });
    assert.equal(await boundaryLayer(dshPage).count(), 0, "linked mode without a divider must restore the fully seamless canvas");

    const studioPage = await context.newPage();
    await studioPage.goto(base, { waitUntil: "domcontentloaded" });
    const studioDividerToggle = studioPage.locator(".regions-divider input");
    const studioLinkedToggle = studioPage.locator(".regions-toggle:not(.regions-divider) input");
    await studioDividerToggle.waitFor({ state: "attached" });
    assert.equal(await studioLinkedToggle.isChecked(), true, "the Studio hover-frame check must run against a linked preview");
    assert.equal(await studioDividerToggle.isChecked(), false, "the Studio divider checkbox must reflect the seamless linked design");
    const studioFrameWrap = studioPage.locator(".frame-wrap");
    await studioFrameWrap.hover();
    const studioLinkedHover = studioPage.locator("[data-dsh-skin-linked-hover]");
    await studioLinkedHover.waitFor({ state: "attached" });
    assert.deepEqual(await studioLinkedHover.evaluate((node) => ({ border: getComputedStyle(node).borderStyle, pointer: getComputedStyle(node).pointerEvents, label: node.textContent })), { border: "dashed", pointer: "none", label: "整合背景区域" }, "hovering the linked Studio preview must always show a non-intercepting blue dashed selection frame");
    await studioDividerToggle.check();
    const studioDividerLive = await waitPreviewSession(base, initial.id, (session) => session.state === "live" && session.generation > linkedNoDividerLive.generation && session.revision > linkedNoDivider.revision && typeof session.renderReceiptHash === "string");
    await waitForRenderedClient(dshPage, { ...studioDividerLive, mode: "preview" });
    assert.equal(await boundaryLayer(dshPage, "divider").count(), 1, "the Studio divider checkbox must render the linked divider in the real DSH iframe");
    await studioDividerToggle.uncheck();
    const studioNoDividerLive = await waitPreviewSession(base, initial.id, (session) => session.state === "live" && session.generation > studioDividerLive.generation && session.revision > studioDividerLive.revision && typeof session.renderReceiptHash === "string");
    await waitForRenderedClient(dshPage, { ...studioNoDividerLive, mode: "preview" });
    assert.equal(await boundaryLayer(dshPage).count(), 0, "turning off the Studio divider checkbox must restore the seamless linked canvas");
    const uploadInput = studioPage.locator('#inspector input[type="file"]');
    await uploadInput.waitFor({ state: "attached" });
    const studioUploadResponse = studioPage.waitForResponse((response) => response.url() === `${base}/api/v1/assets` && response.request().method() === "POST", { timeout: 20_000 });
    await uploadInput.setInputFiles({ name: "studio-upload.jpg", mimeType: "image/jpeg", buffer: studioUploadBytes });
    const studioUploadResult = await studioUploadResponse;
    const studioAsset = await studioUploadResult.json();
    assert.equal(studioUploadResult.status(), 201, `a real Studio file picker upload must reach the local asset API: ${JSON.stringify(studioAsset)}`);
    assert.match(studioAsset.id, /^sha256-[0-9a-f]{64}$/, "a real Studio upload must return a content-addressed asset");
    assert.equal(await studioPage.locator(".upload-error").count(), 0, "a successful real Studio upload must not report Failed to fetch");
    const uploadedLive = await waitPreviewSession(base, initial.id, (session) => session.state === "live" && session.generation > studioNoDividerLive.generation && session.revision > studioNoDividerLive.revision && typeof session.renderReceiptHash === "string");
    await waitForRenderedClient(dshPage, { ...uploadedLive, mode: "preview" });
    assert.match(await regionLayer(dshPage, "linked").evaluate((node) => getComputedStyle(node).backgroundImage), new RegExp(studioAsset.id), "the actual Studio upload must become the linked real DSH backdrop");
    const hostedAsset = await dshPage.evaluate(async (assetId) => { const response = await fetch(`/dsh-skin/assets/${assetId}`); return { status: response.status, bytes: (await response.arrayBuffer()).byteLength }; }, studioAsset.id);
    assert.deepEqual(hostedAsset, { status: 200, bytes: studioAsset.bytes }, "the isolated DSH Host must serve the Studio-uploaded image");
    const frame = studioPage.locator('iframe[title*="隔离"]');
    await frame.waitFor({ state: "attached", timeout: 30_000 });
    const iframeUrl = await frame.getAttribute("src");
    assert.match(iframeUrl ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.notEqual(iframeUrl, "http://127.0.0.1:10402", "Studio must never embed the user DSH URL");
    const studioSession = await waitStatusPreviewUrl(base, iframeUrl);
    assert.equal(studioSession.state, "live", "Studio status must advertise its iframe as a live isolated preview session");
    const embeddedDsh = studioPage.frameLocator('iframe[title*="隔离"]');
    await embeddedDsh.locator('[data-dsh-skin-studio-backdrop="linked"]').waitFor({ state: "attached" });
    await waitFrameRevision(embeddedDsh, uploadedLive.revision);
    assert.equal(await embeddedDsh.locator("html").getAttribute("data-dsh-skin-design"), linked.id);
    assert.equal(await embeddedDsh.locator("html").getAttribute("data-dsh-skin-revision"), String(uploadedLive.revision));
    const sidebarTarget = embeddedDsh.locator("div.pI_x6G_sidebarCol");
    const linkedOverlay = embeddedDsh.locator('button[data-dsh-skin-region-overlay="linked"]');
    await linkedOverlay.waitFor({ state: "attached" });
    assert.equal(await linkedOverlay.evaluate((node) => getComputedStyle(node).pointerEvents), "auto", "linked preview must immediately expose its unified hover-and-click selection frame");
    assert.equal(await embeddedDsh.locator('button[data-dsh-skin-region-overlay="sidebar"]').count(), 0, "linked preview must not hide the selection frame behind separate regional overlays");
    await linkedOverlay.hover();
    assert.deepEqual(await linkedOverlay.evaluate((node) => ({ border: getComputedStyle(node).borderStyle, color: getComputedStyle(node).borderColor, fill: getComputedStyle(node).backgroundColor })), { border: "dashed", color: "rgb(36, 148, 255)", fill: "rgba(36, 148, 255, 0.07)" }, "hovering a linked canvas must visibly render a blue dashed frame");
    assert.equal(await sidebarTarget.evaluate((node) => node.classList.contains("dsh-skin-region-hover")), true, "linked hover must decorate the sidebar surface");
    const linkedOverlayGeometry = await embeddedDsh.locator('button[data-dsh-skin-region-overlay="linked"]').evaluate((overlay) => { const sidebar = document.querySelector("div.pI_x6G_sidebarCol"); const anchor = document.querySelector("div.wSkVaW_heroWorkspaceRow"); if (!sidebar || !anchor) return null; const rect = (element) => element.getBoundingClientRect(); const outer = rect(overlay), left = rect(sidebar), main = rect(anchor); return { outer: { left: outer.left, top: outer.top, right: outer.right, bottom: outer.bottom }, sidebar: { left: left.left, top: left.top, right: left.right, bottom: left.bottom }, main: { left: main.left, top: main.top, right: main.right, bottom: main.bottom } }; });
    assert.ok(linkedOverlayGeometry && linkedOverlayGeometry.outer.left <= linkedOverlayGeometry.sidebar.left && linkedOverlayGeometry.outer.right >= linkedOverlayGeometry.main.right && linkedOverlayGeometry.outer.top <= Math.min(linkedOverlayGeometry.sidebar.top, linkedOverlayGeometry.main.top) && linkedOverlayGeometry.outer.bottom >= Math.max(linkedOverlayGeometry.sidebar.bottom, linkedOverlayGeometry.main.bottom), "linked hover frame must visibly cover both regional surfaces");
    await embeddedDsh.getByRole("button", { name: "结束选区" }).click();
    assert.equal(await linkedOverlay.evaluate((node) => getComputedStyle(node).pointerEvents), "none", "turning off selection must return every DSH control to normal pointer handling");
    // rc.6's onboarding mask legitimately sits above the sidebar. Move the
    // real main-page mouse to the sidebar's screen geometry instead of forcing
    // a synthetic hover through that mask; the iframe document still receives
    // the passive pointer move while normal DSH input remains unblocked.
    const passiveSidebarBox = await sidebarTarget.boundingBox();
    assert.ok(passiveSidebarBox, "the real sidebar must expose screen geometry for passive hover tracking");
    await studioPage.mouse.move(passiveSidebarBox.x + passiveSidebarBox.width / 2, passiveSidebarBox.y + passiveSidebarBox.height / 2);
    assert.deepEqual(await linkedOverlay.evaluate((node) => ({ border: getComputedStyle(node).borderStyle, color: getComputedStyle(node).borderColor, fill: getComputedStyle(node).backgroundColor, pointer: getComputedStyle(node).pointerEvents })), { border: "dashed", color: "rgb(36, 148, 255)", fill: "rgba(36, 148, 255, 0.07)", pointer: "none" }, "linked mode must keep a visible blue dashed hover frame even after selection is ended, without intercepting DSH input");
    await embeddedDsh.getByRole("button", { name: "选择区域" }).click();
    assert.equal(await linkedOverlay.evaluate((node) => getComputedStyle(node).pointerEvents), "auto", "selection toggle must still re-enable clicking after passive hover");
    assert.equal(await linkedOverlay.evaluate((node) => getComputedStyle(node).borderColor), "rgba(0, 0, 0, 0)", "starting selection must clear the passive hover treatment before the click overlay takes over");
    await linkedOverlay.click();
    await studioPage.waitForFunction(() => [...document.querySelectorAll(".draft-regions button")].some((button) => button.textContent?.includes("主工作区") && button.getAttribute("aria-pressed") === "true"));
    assert.equal(await sidebarTarget.evaluate((node) => node.classList.contains("dsh-skin-region-selected")), false, "linked selection must not falsely present the sidebar as an independent edit target");
    assert.equal(await linkedOverlay.evaluate((node) => getComputedStyle(node).borderStyle), "solid", "linked selection must retain the unified frame's canonical edit target");
    const selectorButton = embeddedDsh.getByRole("button", { name: "选择区域" });
    assert.equal(await linkedOverlay.evaluate((node) => getComputedStyle(node).pointerEvents), "none", "ending selection must restore normal DSH pointer interaction");
    await selectorButton.click();
    assert.equal(await linkedOverlay.evaluate((node) => getComputedStyle(node).pointerEvents), "auto", "selection toggle must re-enable the unified bridge overlay");
    await linkedOverlay.focus(); await linkedOverlay.press("Enter");
    assert.equal(await linkedOverlay.evaluate((node) => getComputedStyle(node).borderStyle), "solid", "keyboard Enter must retain the linked canvas blue selection state");
    const embeddedLink = embeddedDsh.locator('label[data-dsh-skin-region-link="1"] input[type="checkbox"]');
    await embeddedLink.uncheck();
    await studioPage.waitForFunction(() => document.querySelector(".regions-toggle input")?.checked === false);
    await studioPage.close();
    await dshPage.close();
    await request(base, `/api/v1/preview-sessions/${initial.id}`, "DELETE", {}, headers);
    await waitHttpUnavailable(awaiting.url, 15_000);
    assert.equal(existsSync(previewHome), false, "stopping a preview may remove only its owned disposable DSH home");
    assert.equal(existsSync(previewRuntimeData), false, "normal stop must remove its owned ephemeral runtime data");
    assert.equal(existsSync(join(dataDir, "isolated-preview-cleanup", `${initial.id}.json`)), false, "normal stop must remove its owned cleanup metadata");
    assert.equal(existsSync(join(dshHome, "profiles", "node_modules", "@dsh-skin", "dsh-plugin", "package.json")), false, "isolated preview must never install into Controller DSH_HOME");
  } finally {
    await browser?.close();
    await stopChild(controller);
    await safeRemove(root);
  }
});

function run(command, args, options = {}) {
  return spawnSync(command, args, { cwd: projectRoot, encoding: "utf8", windowsHide: true, shell: false, timeout: 60_000, ...options });
}

async function tempRoot(label) { return mkdtemp(join(tmpdir(), `dsh-skin-tests-${label}-`)); }
async function safeRemove(path) { if (dirname(path) !== tmpdir() || !path.startsWith(join(tmpdir(), "dsh-skin-tests-"))) throw new Error(`Refusing unsafe cleanup: ${path}`); await rm(path, { recursive: true, force: true }); }
async function freePort() { return new Promise((resolvePort, reject) => { const server = createNetServer(); server.once("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); const port = typeof address === "object" && address ? address.port : 0; server.close((error) => error ? reject(error) : resolvePort(port)); }); }); }
async function waitHttp(url, timeout = 10_000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { try { const response = await fetch(url); if (response.status < 500) return response; } catch {} await new Promise((resolveWait) => setTimeout(resolveWait, 100)); } throw new Error(`Timed out waiting for ${url}`); }
async function waitHttpUnavailable(url, timeout = 10_000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { try { await fetch(url); } catch { return; } await new Promise((resolveWait) => setTimeout(resolveWait, 100)); } throw new Error(`Timed out waiting for ${url} to stop accepting connections`); }
async function request(base, path, method = "GET", body, headers, expected = 200) { const response = await fetch(`${base}${path}`, { method, ...(headers ? { headers } : {}), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const value = await response.json(); assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(value)}`); return value; }
async function waitOperation(base, id, state) { const deadline = Date.now() + 15_000; while (Date.now() < deadline) { const operation = await request(base, `/api/v1/operations/${id}`); if (operation.state === state) return operation; if (["failed", "failed-safe"].includes(operation.state)) throw new Error(JSON.stringify(operation)); await new Promise((resolveWait) => setTimeout(resolveWait, 150)); } throw new Error(`Operation ${id} did not reach ${state}`); }
async function waitSkinMode(base, mode) { const deadline = Date.now() + 15_000; while (Date.now() < deadline) { try { const response = await fetch(`${base}/dsh-skin/state`); if (response.ok) { const state = await response.json(); if (state.mode === mode) return state; } } catch {} await new Promise((resolveWait) => setTimeout(resolveWait, 150)); } throw new Error(`DSH skin state did not reach ${mode}`); }
async function waitPreviewSession(base, id, predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    const payload = await request(base, `/api/v1/preview-sessions/${id}`);
    last = payload.session ?? payload;
    if (predicate(last)) return last;
    await delay(150);
  }
  throw new Error(`Preview session ${id} did not reach expected state: ${JSON.stringify(last)}`);
}
async function waitStatusPreviewUrl(base, expectedUrl, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let match;
  while (Date.now() < deadline) {
    const status = await request(base, "/api/v1/status");
    match = status.previewSessions?.find((session) => session.url === expectedUrl);
    if (match?.state === "live") return match;
    await delay(150);
  }
  throw new Error(`Studio iframe URL was not a live isolated session: ${expectedUrl}; last=${JSON.stringify(match)}`);
}
async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  assert.ok(child.pid && spawnedPids.has(child.pid), "refusing to stop a process that was not spawned by this test run");
  if (process.platform === "win32" && child.pid) {
    spawnSync("C:\\Windows\\System32\\taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { encoding: "utf8", windowsHide: true, shell: false });
  } else {
    child.kill("SIGTERM");
  }
  await Promise.race([new Promise((resolveExit) => child.once("exit", resolveExit)), new Promise((resolveWait) => setTimeout(resolveWait, 3_000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
  if (child.pid) spawnedPids.delete(child.pid);
}

async function crashOwnedChild(child) {
  assert.ok(child?.pid && spawnedPids.has(child.pid), "refusing to crash a process that was not spawned by this test run");
  if (process.platform === "win32") {
    // Do not terminate the process tree: reconciliation must prove it can
    // safely find and reap the independently surviving isolated child.
    spawnSync("C:\\Windows\\System32\\taskkill.exe", ["/PID", String(child.pid), "/F"], { encoding: "utf8", windowsHide: true, shell: false });
  } else child.kill("SIGKILL");
  await Promise.race([new Promise((resolveExit) => child.once("exit", resolveExit)), delay(3_000)]);
  if (child.pid) spawnedPids.delete(child.pid);
}

async function assertNoPreviewBearerPersistence(dataDir) {
  const forbiddenDirectory = join(dataDir, "plugin-secrets");
  assert.equal(existsSync(forbiddenDirectory), false, "isolated preview must not create persistent plugin-secrets data");
  const directories = [dataDir];
  while (directories.length) {
    const directory = directories.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { directories.push(path); continue; }
      if (!/\.json$/i.test(entry.name)) continue;
      assert.doesNotMatch(await readFile(path, "utf8"), /"secret"\s*:/i, `Controller data must not persist a raw preview bearer: ${path}`);
    }
  }
}

function spawnManaged(command, args, options) {
  const child = spawn(command, args, options);
  assert.ok(child.pid, `failed to spawn managed process: ${command}`);
  spawnedPids.add(child.pid);
  childOutput.set(child, "");
  const append = (chunk) => childOutput.set(child, `${childOutput.get(child) ?? ""}${String(chunk)}`.slice(-20_000));
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.once("exit", () => spawnedPids.delete(child.pid));
  return child;
}

function strictAbsolutePath(value, name) {
  assert.ok(value && isAbsolute(value) && resolve(value) === value, `${name} must be a canonical absolute path`);
  return value;
}

function resolveDshBin() {
  if (process.env.DSH_RC6_BIN) {
    const configured = strictAbsolutePath(process.env.DSH_RC6_BIN, "DSH_RC6_BIN");
    assert.equal(existsSync(configured), true, `DSH_RC6_BIN does not exist: ${configured}`);
    return configured;
  }
  const packageJson = require.resolve("@deepseek-ai/dsh/package.json");
  const manifest = require(packageJson);
  assert.equal(manifest.version, "0.1.0-rc.6", "repository DSH fixture must remain pinned to rc.6");
  const bin = join(dirname(packageJson), "lib", "bin.js");
  assert.equal(existsSync(bin), true, `repository DSH fixture bin is missing: ${bin}`);
  return bin;
}

function resolveChromiumExecutable() {
  if (process.env.DSH_CHROMIUM_EXECUTABLE) {
    const configured = strictAbsolutePath(process.env.DSH_CHROMIUM_EXECUTABLE, "DSH_CHROMIUM_EXECUTABLE");
    assert.equal(existsSync(configured), true, `DSH_CHROMIUM_EXECUTABLE does not exist: ${configured}`);
    return configured;
  }
  const candidates = process.platform === "win32"
    ? ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe", "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"]
    : process.platform === "darwin"
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
  const executable = candidates.find((candidate) => existsSync(candidate));
  assert.ok(executable, "No system Chromium browser found; set DSH_CHROMIUM_EXECUTABLE to an absolute Chrome/Edge/Chromium executable");
  return executable;
}

async function linkRc6FixturePackages(dshHome) {
  const pnpmStore = join(projectRoot, "node_modules", ".pnpm");
  const scopeTarget = join(dshHome, "profiles", "node_modules", "@deepseek-ai");
  await mkdir(scopeTarget, { recursive: true });
  const linked = new Set(await readdir(scopeTarget));
  for (const entry of await readdir(pnpmStore, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const scopeSource = join(pnpmStore, entry.name, "node_modules", "@deepseek-ai");
    if (!existsSync(scopeSource)) continue;
    for (const packageEntry of await readdir(scopeSource, { withFileTypes: true })) {
      if (!packageEntry.isDirectory() && !packageEntry.isSymbolicLink()) continue;
      if (linked.has(packageEntry.name)) continue;
      const source = join(scopeSource, packageEntry.name);
      const destination = join(scopeTarget, packageEntry.name);
      if (existsSync(join(source, "package.json"))) {
        await symlink(source, destination, process.platform === "win32" ? "junction" : "dir");
        linked.add(packageEntry.name);
      }
    }
  }
  for (const required of ["dsh-client-runtime", "dsh-client-ui-theme", "dsh-host-webserver", "dsh-host-frontend-static"]) {
    assert.equal(existsSync(join(scopeTarget, required, "package.json")), true, `rc.6 fixture package is missing: @deepseek-ai/${required}`);
  }
}

async function assertPortableRuntime(runtimeRoot) {
  const forbiddenMetadata = new Set([".modules.yaml", ".package-map.json", ".pnpm-workspace-state-v1.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]);
  const sourceMarker = /ruanjianproject|dsh背景更换|dsh%E8%83%8C/i;
  let files = 0;
  assert.equal((await lstat(runtimeRoot)).isSymbolicLink(), false, `portable runtime root is a reparse/symbolic-link entry: ${runtimeRoot}`);
  const directories = [runtimeRoot];
  while (directories.length) {
    const batch = directories.splice(0, 64);
    const listings = await Promise.all(batch.map(async (directory) => ({ directory, entries: await readdir(directory, { withFileTypes: true }) })));
    for (const { directory, entries } of listings) {
      for (const entry of entries) {
        const path = join(directory, entry.name);
        assert.equal(entry.isSymbolicLink(), false, `portable runtime contains a reparse/symbolic-link entry: ${path}`);
        assert.equal(forbiddenMetadata.has(entry.name), false, `portable runtime contains workspace metadata: ${path}`);
        if (entry.isDirectory()) directories.push(path);
        else {
          files += 1;
          const portableMetadata = /package\.json$|\.ya?ml$|\.json$/i.test(entry.name);
          const commandShim = directory.replaceAll("\\", "/").endsWith("/node_modules/.bin");
          if (portableMetadata || commandShim) assert.doesNotMatch(await readFile(path, "utf8"), sourceMarker, `portable metadata leaks the source checkout path: ${path}`);
        }
      }
    }
  }
  assert.ok(files > 100, "portable runtime inspection did not traverse a complete runtime");
}

function parseJsonOutput(value) {
  const start = value.indexOf("{");
  assert.ok(start >= 0, `expected JSON output, received: ${value}`);
  return JSON.parse(value.slice(start));
}

async function stopOwnedPid(pid) {
  assert.ok(spawnedPids.has(pid), "refusing to stop a process not owned by this test run");
  if (process.platform === "win32") {
    spawnSync("C:\\Windows\\System32\\taskkill.exe", ["/PID", String(pid), "/T", "/F"], { encoding: "utf8", windowsHide: true, shell: false });
  } else {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); await delay(100); } catch { break; }
  }
  spawnedPids.delete(pid);
}

async function startBlockedClientHarness() {
  const clientBundle = await readFile(join(projectRoot, "packages", "dsh-plugin", "dist", "client", "index.js"), "utf8");
  const server = createHttpServer((request, response) => {
    if (request.url === "/client.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      response.end(clientBundle);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end('<!doctype html><html><body><script>window.__ModuleLoader__={load(handoff){const exported=handoff.factory(()=>{throw new Error("blocked harness has no injected modules")}); exported.apply({effect(){throw new Error("effect must not run without ThemeRuntime")}})}};</script><script src="/client.js"></script></body></html>');
  });
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolveListen); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { url: `http://127.0.0.1:${address.port}/`, close: () => new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())) };
}

async function waitForRenderedClient(page, state) {
  try {
    await page.waitForFunction((expected) => {
      const data = document.documentElement.dataset;
      return data.dshSkinStatus === expected.mode && data.dshSkinDesign === expected.designId && data.dshSkinRevision === String(expected.revision) && data.dshSkinHash === expected.hash;
    }, { mode: state.mode, designId: state.designId, revision: state.revision, hash: state.hash }, { timeout: 20_000 });
  } catch (error) {
    const debug = await page.evaluate(() => ({
      dataset: { ...document.documentElement.dataset },
      backdrop: Boolean(document.querySelector('[data-dsh-skin-studio-backdrop]')),
      title: document.title,
      body: document.body?.innerText.slice(0, 500),
      semanticRegions: [...document.querySelectorAll("aside,main")].map((element) => ({ tag: element.tagName.toLowerCase(), class: element.className, role: element.getAttribute("role"), ariaLabel: element.getAttribute("aria-label"), attrs: [...element.attributes].map((attribute) => [attribute.name, attribute.value]) })),
      structuralRegions: [...document.querySelectorAll("[class]")].filter((element) => /side|main|layout|workspace/i.test(element.className)).slice(0, 30).map((element) => ({ tag: element.tagName.toLowerCase(), class: element.className, attrs: [...element.attributes].map((attribute) => [attribute.name, attribute.value]) }))
    }));
    throw new Error(`real DSH Client did not render the expected theme: ${String(error)}\n${JSON.stringify(debug)}`);
  }
}

async function waitForStudioHandshake(studioPage, embeddedDsh) {
  try {
    await studioPage.waitForFunction(() => document.querySelector(".preview-badge")?.textContent?.includes("实时") && !document.querySelector(".preview-truth-label"), undefined, { timeout: 15_000 });
  } catch (error) {
    const studio = await studioPage.evaluate(() => ({ badge: document.querySelector(".preview-badge")?.textContent, truth: document.querySelector(".preview-truth-label")?.textContent }));
    const frame = await embeddedDsh.locator("html").evaluate((html) => ({ dataset: { ...html.dataset }, referrer: document.referrer, hasParent: window.parent !== window }));
    throw new Error(`Studio iframe did not accept the real Client render handshake: ${String(error)}\nstudio=${JSON.stringify(studio)} frame=${JSON.stringify(frame)}`);
  }
}

async function renderedTokenValue(page, token) {
  return page.evaluate((name) => {
    const roots = [document.documentElement, document.body, ...document.querySelectorAll("*")];
    for (const element of roots) {
      const value = getComputedStyle(element).getPropertyValue(name).trim();
      if (value) return value;
    }
    return "";
  }, token);
}

function delay(milliseconds) { return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds)); }
async function waitFrameRevision(frame, revision, timeout = 20_000) {
  const expected = String(revision);
  const deadline = Date.now() + timeout;
  let actual;
  while (Date.now() < deadline) {
    actual = await frame.locator("html").getAttribute("data-dsh-skin-revision");
    if (actual === expected) return;
    await delay(150);
  }
  assert.equal(actual, expected, "the visible Studio iframe must advance to the current warm preview revision before bridge assertions");
}

function regionLayer(page, region) { return page.locator(`[data-dsh-skin-studio-backdrop="${region}"]`); }
function boundaryLayer(page, kind) { return kind ? page.locator(`[data-dsh-skin-studio-boundary="${kind}"]`) : page.locator("[data-dsh-skin-studio-boundary]"); }
