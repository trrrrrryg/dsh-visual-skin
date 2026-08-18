import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { ControllerClient } from "@dsh-skin/agent-cli";
import { DesignSessionCore } from "@dsh-skin/design-session-core";
import { AssetService } from "./assets.js";

const root = await mkdtemp(join(tmpdir(), "dsh-skin-backend-"));
const localAppData = join(root, "local-app-data");
const controllerData = join(root, "controller-data");
const dshHome = join(root, "fixture.dsh");
const profileRoot = join(dshHome, "profiles", "web");
let controller: ChildProcess | undefined;

try {
  await mkdir(join(dshHome, "profiles", "node_modules", "@deepseek-ai", "dsh"), { recursive: true });
  await mkdir(profileRoot, { recursive: true });
  await writeFile(join(dshHome, "profiles", "node_modules", "@deepseek-ai", "dsh", "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.1.0-rc.6" }));
  await writeFile(join(profileRoot, "package.json"), `${JSON.stringify({ name: "fixture-profile", dependencies: { keep: "1.0.0" } }, null, 2)}\n`);
  await writeFile(join(profileRoot, "cordis.patch.yml"), "[]\n");

  const controllerEntry = join(dirname(fileURLToPath(import.meta.url)), "index.js");
  controller = spawn(process.execPath, [controllerEntry], {
    stdio: "ignore", shell: false, windowsHide: true,
    env: { ...process.env, LOCALAPPDATA: localAppData, DSH_SKIN_DATA_DIR: controllerData, DSH_HOME: dshHome, DSH_SKIN_PORT: "0", DSH_WEB_URL: "http://127.0.0.1:9", DSH_SKIN_ISOLATED_PREVIEW_ONLY: "1" }
  });
  const discoveryPath = join(controllerData, "controller-discovery.json");
  const discovery = await waitForJson<{ instanceId: string; url: string }>(discoveryPath);
  process.env.LOCALAPPDATA = localAppData;
  process.env.DSH_SKIN_DATA_DIR = controllerData;
  const discoveredStatus = await new ControllerClient().status();
  assert.equal(discoveredStatus.instanceId, discovery.instanceId, "dynamic discovery must verify controller identity");

  const landing = await fetch(discovery.url);
  assert.equal(landing.status, 200);
  const cookie = landing.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie?.startsWith("dsh_skin_session="), "first Studio GET must establish an HttpOnly browser session");
  assert.match(landing.headers.get("set-cookie") ?? "", /HttpOnly/i);
  assert.match(landing.headers.get("set-cookie") ?? "", /SameSite=Strict/i);
  const status = await jsonRequest<{ csrfToken: string; dsh: { detected: boolean; url: string | null } }>(discovery.url, "/api/v1/status");
  assert.equal(status.dsh.detected, false, "isolated Controller status must not discover an external DSH process");
  assert.equal(status.dsh.url, null, "isolated Controller status must not expose an external DSH URL");
  const headers = { "content-type": "application/json", "x-dsh-skin-csrf": status.csrfToken };
  const design = await jsonRequest<{ id: string; revision: number }>(discovery.url, "/api/v1/session/design", "POST", { name: "Backend self-check" }, headers, 201);

  await jsonRequest(discovery.url, "/api/v1/confirmations", "POST", { action: "apply", designId: design.id, revision: design.revision, installPlugin: true, target: { profile: "web" } }, headers, 404);
  // A permanent apply has no route around an exact isolated Client receipt.
  await jsonRequest(discovery.url, "/api/v1/theme/apply-plan", "POST", { designId: design.id, revision: design.revision, installPlugin: true, target: { profile: "web" } }, headers, 422);
  const preview = await jsonRequest<{ session: { id: string; state: string; operationId: string } }>(discovery.url, "/api/v1/preview-sessions", "POST", { designId: design.id, revision: design.revision }, headers, 202);
  assert.equal(preview.session.state, "provisioning", "isolated preview is asynchronous and never marks itself rendered");
  const publicSession = await jsonRequest<{ session: Record<string, unknown> }>(discovery.url, `/api/v1/preview-sessions/${preview.session.id}`);
  assert.equal("secret" in publicSession.session, false, "public preview state must not leak the plugin secret");
  assert.equal("secretHash" in publicSession.session, false, "public preview state must not leak a reusable secret hash");
  const storedPreview = JSON.parse(await readFile(join(controllerData, "isolated-preview-sessions", `${preview.session.id}.json`), "utf8")) as Record<string, unknown>;
  assert.equal("secret" in storedPreview, false, "preview persistence must not contain a raw secret");
  assert.match(String(storedPreview.secretHash), /^[0-9a-f]{64}$/, "preview persistence must retain only a secret hash");

  const corruptPng = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(32)]).toString("base64");
  await jsonRequest(discovery.url, "/api/v1/assets", "POST", { mimeType: "image/png", dataBase64: corruptPng }, headers, 422);
  const validPng = await sharp({ create: { width: 4, height: 3, channels: 4, background: "#a9553d" } }).png().toBuffer();
  const asset = await jsonRequest<{ id: string; width: number; height: number }>(discovery.url, "/api/v1/assets", "POST", { mimeType: "image/png", dataBase64: validPng.toString("base64") }, headers, 201);
  assert.match(asset.id, /^sha256-[0-9a-f]{64}$/);
  assert.deepEqual([asset.width, asset.height], [4, 3]);

  const core = new DesignSessionCore(join(root, "core"));
  const concurrent = await core.createDesign();
  const patchId = randomUUID();
  const once = await core.patchDesign(concurrent.id, 1, { name: "Idempotent" }, patchId);
  const replay = await core.patchDesign(concurrent.id, 1, { name: "Idempotent" }, patchId);
  assert.deepEqual(replay, once, "patchId replay must return the persisted original result");
  await assert.rejects(() => core.patchDesign(concurrent.id, 1, { name: "Different payload" }, patchId), /different mutation payload/);
  const renameId = randomUUID();
  const renamed = await core.renameDesign(concurrent.id, once.revision, "Renamed", renameId);
  assert.deepEqual(await core.renameDesign(concurrent.id, once.revision, "Renamed", renameId), renamed);
  await assert.rejects(() => core.renameDesign(concurrent.id, once.revision, "Other name", renameId), /different mutation payload/);
  const duplicateId = randomUUID();
  const duplicate = await core.duplicateDesign(concurrent.id, "Duplicate", duplicateId);
  assert.deepEqual(await core.duplicateDesign(concurrent.id, "Duplicate", duplicateId), duplicate);
  await assert.rejects(() => core.duplicateDesign(concurrent.id, "Other duplicate", duplicateId), /different mutation payload/);
  const race = await Promise.allSettled([
    core.patchDesign(concurrent.id, renamed.revision, { name: "Winner A" }, randomUUID()),
    core.patchDesign(concurrent.id, renamed.revision, { name: "Winner B" }, randomUUID())
  ]);
  assert.equal(race.filter((item) => item.status === "fulfilled").length, 1, "CAS under the design lock must admit exactly one writer");

  controller.kill();
  await Promise.race([new Promise<void>((resolveExit) => controller!.once("exit", () => resolveExit())), new Promise<void>((resolveWait) => setTimeout(resolveWait, 2_000))]);
  controller = undefined;
  const assetService = new AssetService(join(root, "asset-direct"));
  await assert.rejects(() => assetService.upload({ mimeType: "image/png", dataBase64: corruptPng }), /decoding failed/);
  process.stdout.write("Controller backend self-check passed: discovery, browser confirmation boundary, isolated preview secrecy, image decode, CAS/idempotency\n");
} finally {
  controller?.kill();
  if (dirname(root) === tmpdir()) await rm(root, { recursive: true, force: true });
}

async function waitForJson<T>(path: string): Promise<T> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { await new Promise((resolveWait) => setTimeout(resolveWait, 80)); }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function jsonRequest<T = unknown>(base: string, path: string, method: "GET" | "POST" = "GET", body?: unknown, headers?: Record<string, string>, expected = 200): Promise<T> {
  const init: RequestInit = { method, ...(headers ? { headers } : {}), ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
  const response = await fetch(`${base}${path}`, init);
  const value = await response.json() as T;
  assert.equal(response.status, expected, `${method} ${path}: ${JSON.stringify(value)}`);
  return value;
}
