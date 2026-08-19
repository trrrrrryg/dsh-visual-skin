import { createHash, randomBytes, randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AtomicJsonStore, AppError, canonicalHash } from "@dsh-skin/design-session-core";
import { ERROR_CODES, SUPPORTED_DSH_VERSION, type CapabilityStatus } from "@dsh-skin/shared";
import type { ThemeSpec } from "@dsh-skin/theme-schema";

export interface DshTarget { dshHome: string; profile: string }
export interface InstallPlan extends DshTarget {
  profileRoot: string;
  packageRoot: string;
  version: string | null;
  compatible: boolean;
  changes: string[];
}
export interface ActiveThemeDocument { designId: string; revision: number; hash: string; theme: ThemeSpec }
export interface IsolatedPluginOptions { previewSessionId?: string; assetDir?: string; ephemeral?: boolean }
interface InstallationRecord {
  targetKey: string;
  profile: string;
  themePath: string;
  assetDir: string;
  managedBlockHash: string;
  installedAt: string;
}
interface PluginSecretRecord { targetKey: string; secret: string; secretHash: string; createdAt: string }

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
// Source-checkout layout: <project>/packages/dsh-plugin.
const sourcePluginSource = join(projectRoot, "packages", "dsh-plugin");
// Installed portable-runtime layout: <runtime>/plugin sits alongside
// <runtime>/node_modules/@dsh-skin/controller/dist, so the dist module is
// four levels deep and the embedded plugin is at <runtime>/plugin.
const runtimePluginSource = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../plugin");
const pluginSourceCandidates = () => {
  const explicit = process.env.DSH_SKIN_PLUGIN_SOURCE;
  const candidates = explicit ? [explicit] : [sourcePluginSource, runtimePluginSource];
  return candidates.filter((candidate) => isAbsolute(candidate) && resolve(candidate) === candidate);
};
const PATCH_START = "# >>> dsh-skin-studio managed block >>>";
const PATCH_END = "# <<< dsh-skin-studio managed block <<<";

export async function detectCapabilities(dshHome: string): Promise<CapabilityStatus> {
  const packageJson = join(dshHome, "profiles", "node_modules", "@deepseek-ai", "dsh", "package.json");
  let detectedVersion: string | null = null;
  try { detectedVersion = (JSON.parse(await readFile(packageJson, "utf8")) as { version?: string }).version ?? null; } catch {}
  const compatible = detectedVersion === SUPPORTED_DSH_VERSION;
  return {
    supportedVersion: SUPPORTED_DSH_VERSION,
    detectedVersion,
    compatible,
    themeRuntime: { available: compatible, methods: compatible ? ["getTheme", "exportInspectTokens", "setTheme", "register", "overrideTokens"] : [], inspectProvider: compatible ? "Theme" : null, inspectMethod: compatible ? "listTokens" : null },
    injection: compatible ? { available: true, mode: "static-plugin" } : { available: false, mode: "unavailable", reason: detectedVersion ? `Unsupported DSH ${detectedVersion}` : "DSH package was not found" }
  };
}

export async function planInstall(target: DshTarget): Promise<InstallPlan> {
  assertTarget(target);
  const profileRoot = join(target.dshHome, "profiles", target.profile);
  const packageRoot = join(target.dshHome, "profiles", "node_modules", "@dsh-skin", "dsh-plugin");
  const capability = await detectCapabilities(target.dshHome);
  return { ...target, profileRoot, packageRoot, version: capability.detectedVersion, compatible: capability.compatible, changes: ["stage managed plugin package", "merge managed loader block", "merge managed dependency", "write rollback journal"] };
}

export function targetKey(target: DshTarget): string { return canonicalHash({ dshHome: resolve(target.dshHome).toLowerCase(), profile: target.profile }); }

export async function getPluginSecret(target: DshTarget, dataDir: string): Promise<string | null> {
  const record = await new AtomicJsonStore(dataDir).read<{ secret: string; targetKey: string }>(`plugin-secrets/${target.profile}.json`);
  return record?.targetKey === targetKey(target) ? record.secret : null;
}

export async function installPlugin(target: DshTarget, dataDir: string, controllerUrl: string, secretOverride?: string, options: IsolatedPluginOptions = {}): Promise<InstallPlan> {
  const plan = await planInstall(target);
  if (!plan.compatible) throw new AppError(ERROR_CODES.unsupported, `Only DSH ${SUPPORTED_DSH_VERSION} is supported`, 409, { detected: plan.version });
  if (options.ephemeral) return installEphemeralPlugin(plan, dataDir, controllerUrl, secretOverride, options);
  const pluginSource = await resolvePluginSource();

  const store = new AtomicJsonStore(dataDir);
  const patchPath = join(plan.profileRoot, "cordis.patch.yml"), packagePath = join(plan.profileRoot, "package.json");
  const oldPatch = await readText(patchPath, "[]\n"), oldPackage = await readText(packagePath, "{}\n");
  const previousInstall = await store.read<InstallationRecord>(`installations/${target.profile}.json`);
  const previousSecret = await store.read<PluginSecretRecord>(`plugin-secrets/${target.profile}.json`);
  const existingBlock = extractManaged(oldPatch);
  if (existingBlock && (!previousInstall || hashText(existingBlock) !== previousInstall.managedBlockHash)) throw new AppError(ERROR_CODES.conflict, "Managed patch drift detected; refusing to overwrite", 409);

  const existingSecret = await getPluginSecret(target, dataDir);
  const secret = secretOverride ?? existingSecret ?? randomBytes(32).toString("base64url");
  if (secret.length < 32) throw new AppError(ERROR_CODES.validation, "Plugin secret override is invalid", 422);
  const themePath = store.path("active", `${target.profile}.json`), assetDir = options.assetDir ? safeAssetDir(dataDir, options.assetDir) : store.path("assets", "content");
  const managed = managedBlock(target.profile, themePath, assetDir, controllerUrl, secret, options);
  const unmanagedPatch = stripManaged(oldPatch);
  const nextPatch = `${unmanagedPatch.trimEnd()}${unmanagedPatch.trim() ? "\n\n" : ""}${managed}\n`;
  const manifest = parseManifest(oldPackage);
  manifest.dependencies = { ...(manifest.dependencies ?? {}), "@dsh-skin/dsh-plugin": "0.1.0" };
  const nextPackage = `${JSON.stringify(manifest, null, 2)}\n`;
  const transactionId = randomUUID();
  const stagePackage = `${plan.packageRoot}.stage-${transactionId}`, rollbackPackage = `${plan.packageRoot}.rollback-${transactionId}`;
  const snapshot = { patchHash: hashText(oldPatch), patchText: oldPatch, packageHash: hashText(oldPackage), packageText: oldPackage, hadPlugin: await exists(plan.packageRoot), rollbackPackage, previousInstall, previousSecret };
  await store.write(`transactions/${transactionId}.json`, { kind: "install", state: "prepared", targetKey: targetKey(target), snapshot, createdAt: new Date().toISOString() });
  let movedOld = false, movedStage = false;
  try {
    await rm(stagePackage, { recursive: true, force: true });
    await mkdir(dirname(stagePackage), { recursive: true });
    await cp(pluginSource, stagePackage, { recursive: true, filter: (source) => !source.includes(`${join(pluginSource, "src")}`) && !source.includes("node_modules") });
    if (snapshot.hadPlugin) { await rename(plan.packageRoot, rollbackPackage); movedOld = true; }
    await rename(stagePackage, plan.packageRoot); movedStage = true;
    await atomicExternalText(packagePath, nextPackage);
    await atomicExternalText(patchPath, nextPatch);
    const record: InstallationRecord = { targetKey: targetKey(target), profile: target.profile, themePath, assetDir, managedBlockHash: hashText(managed), installedAt: new Date().toISOString() };
    await store.write(`installations/${target.profile}.json`, record);
    await store.write(`plugin-secrets/${target.profile}.json`, { targetKey: record.targetKey, secret, secretHash: hashText(secret), createdAt: new Date().toISOString() });
    await store.write(`transactions/${transactionId}.json`, { kind: "install", state: "committed", targetKey: record.targetKey, snapshot, patchAfterHash: hashText(nextPatch), packageAfterHash: hashText(nextPackage), committedAt: new Date().toISOString() });
    if (movedOld) await rm(rollbackPackage, { recursive: true, force: true });
    return plan;
  } catch (error) {
    const compensation: string[] = [];
    const rollbackErrors: string[] = [];
    try { if (hashText(await readText(patchPath, "")) === hashText(nextPatch)) { await atomicExternalText(patchPath, oldPatch); compensation.push("patch"); } } catch (rollback) { rollbackErrors.push(`patch: ${String(rollback)}`); }
    try { if (hashText(await readText(packagePath, "")) === hashText(nextPackage)) { await atomicExternalText(packagePath, oldPackage); compensation.push("package"); } } catch (rollback) { rollbackErrors.push(`package: ${String(rollback)}`); }
    try { if (movedStage) await rm(plan.packageRoot, { recursive: true, force: true }); if (movedOld) await rename(rollbackPackage, plan.packageRoot); compensation.push("plugin"); } catch (rollback) { rollbackErrors.push(`plugin: ${String(rollback)}`); }
    try { if (previousInstall) await store.write(`installations/${target.profile}.json`, previousInstall); else await store.remove(`installations/${target.profile}.json`); compensation.push("installation-record"); } catch (rollback) { rollbackErrors.push(`installation-record: ${String(rollback)}`); }
    try { if (previousSecret) await store.write(`plugin-secrets/${target.profile}.json`, previousSecret); else await store.remove(`plugin-secrets/${target.profile}.json`); compensation.push("plugin-secret"); } catch (rollback) { rollbackErrors.push(`plugin-secret: ${String(rollback)}`); }
    const recordsMatch = canonicalHash(await store.read(`installations/${target.profile}.json`)) === canonicalHash(previousInstall) && canonicalHash(await store.read(`plugin-secrets/${target.profile}.json`)) === canonicalHash(previousSecret);
    if (!recordsMatch) rollbackErrors.push("managed records failed post-compensation verification");
    await store.write(`transactions/${transactionId}.json`, { kind: "install", state: rollbackErrors.length === 0 ? "failed-safe" : "rollback-incomplete", targetKey: targetKey(target), snapshot, compensation, rollbackErrors, error: String(error), failedAt: new Date().toISOString() });
    throw error;
  } finally { await rm(stagePackage, { recursive: true, force: true }); }
}

export async function uninstallPlugin(target: DshTarget, dataDir: string): Promise<void> {
  assertTarget(target);
  const store = new AtomicJsonStore(dataDir);
  const install = await store.read<InstallationRecord>(`installations/${target.profile}.json`);
  if (!install || install.targetKey !== targetKey(target)) throw new AppError(ERROR_CODES.notFound, "No managed installation was found", 404);
  const profileRoot = join(target.dshHome, "profiles", target.profile), patchPath = join(profileRoot, "cordis.patch.yml"), packagePath = join(profileRoot, "package.json");
  const currentPatch = await readText(patchPath, "[]\n"), currentPackage = await readText(packagePath, "{}\n");
  const block = extractManaged(currentPatch);
  if (!block || hashText(block) !== install.managedBlockHash) throw new AppError(ERROR_CODES.conflict, "Managed patch drift detected; refusing uninstall", 409);
  const manifest = parseManifest(currentPackage);
  if (manifest.dependencies?.["@dsh-skin/dsh-plugin"] !== "0.1.0") throw new AppError(ERROR_CODES.conflict, "Managed dependency drift detected; refusing uninstall", 409);
  delete manifest.dependencies["@dsh-skin/dsh-plugin"];
  const secretSnapshot = await store.read<PluginSecretRecord>(`plugin-secrets/${target.profile}.json`);
  const nextPatch = ensureEmptyPatch(stripManaged(currentPatch));
  const nextPackage = `${JSON.stringify(manifest, null, 2)}\n`;
  const packageRoot = join(target.dshHome, "profiles", "node_modules", "@dsh-skin", "dsh-plugin");
  const installedManifest = await readText(join(packageRoot, "package.json"), "");
  if (installedManifest && (JSON.parse(installedManifest) as { name?: string }).name !== "@dsh-skin/dsh-plugin") throw new AppError(ERROR_CODES.conflict, "Plugin directory ownership drift detected", 409);
  const transactionId = randomUUID(), stagedRemoval = `${packageRoot}.remove-${transactionId}`;
  await store.write(`transactions/${transactionId}.json`, { kind: "uninstall", state: "prepared", targetKey: install.targetKey, patchHash: hashText(currentPatch), patchText: currentPatch, packageHash: hashText(currentPackage), packageText: currentPackage, installation: install, secret: secretSnapshot, stagedRemoval, createdAt: new Date().toISOString() });
  try {
    if (await exists(packageRoot)) await rename(packageRoot, stagedRemoval);
    await atomicExternalText(packagePath, nextPackage);
    await atomicExternalText(patchPath, nextPatch);
    await store.remove(`installations/${target.profile}.json`);
    await store.remove(`plugin-secrets/${target.profile}.json`);
    await store.write(`transactions/${transactionId}.json`, { kind: "uninstall", state: "committed", targetKey: install.targetKey, committedAt: new Date().toISOString() });
    await rm(stagedRemoval, { recursive: true, force: true });
  } catch (error) {
    const rollbackErrors: string[] = [];
    try { if (hashText(await readText(patchPath, "")) === hashText(nextPatch)) await atomicExternalText(patchPath, currentPatch); } catch (rollback) { rollbackErrors.push(`patch: ${String(rollback)}`); }
    try { if (hashText(await readText(packagePath, "")) === hashText(nextPackage)) await atomicExternalText(packagePath, currentPackage); } catch (rollback) { rollbackErrors.push(`package: ${String(rollback)}`); }
    try { if (await exists(stagedRemoval)) await rename(stagedRemoval, packageRoot); } catch (rollback) { rollbackErrors.push(`plugin: ${String(rollback)}`); }
    try { await store.write(`installations/${target.profile}.json`, install); } catch (rollback) { rollbackErrors.push(`installation-record: ${String(rollback)}`); }
    try { if (secretSnapshot) await store.write(`plugin-secrets/${target.profile}.json`, secretSnapshot); else await store.remove(`plugin-secrets/${target.profile}.json`); } catch (rollback) { rollbackErrors.push(`plugin-secret: ${String(rollback)}`); }
    const recordsMatch = canonicalHash(await store.read(`installations/${target.profile}.json`)) === canonicalHash(install) && canonicalHash(await store.read(`plugin-secrets/${target.profile}.json`)) === canonicalHash(secretSnapshot);
    if (!recordsMatch || !await exists(packageRoot)) rollbackErrors.push("managed plugin state failed post-compensation verification");
    await store.write(`transactions/${transactionId}.json`, { kind: "uninstall", state: rollbackErrors.length === 0 ? "failed-safe" : "rollback-incomplete", targetKey: install.targetKey, rollbackErrors, error: String(error), failedAt: new Date().toISOString() });
    throw error;
  }
}

export async function writeActiveTheme(target: DshTarget, dataDir: string, document: ActiveThemeDocument, options: { ephemeral?: boolean } = {}): Promise<void> {
  assertTarget(target);
  const store = new AtomicJsonStore(dataDir);
  const install = await store.read<InstallationRecord>(`installations/${target.profile}.json`);
  if (!options.ephemeral && (!install || install.targetKey !== targetKey(target))) throw new AppError(ERROR_CODES.unavailable, "Install the plugin before applying a theme", 409);
  if (canonicalHash(document.theme) !== document.hash) throw new AppError(ERROR_CODES.validation, "Active theme hash does not match its payload", 422);
  await store.write(`active/${target.profile}.json`, document);
}

/** A preview-only install intentionally has no Controller installation/secret/journal record. */
async function installEphemeralPlugin(plan: InstallPlan, dataDir: string, controllerUrl: string, secret: string | undefined, options: IsolatedPluginOptions): Promise<InstallPlan> {
  if (!secret || secret.length < 32 || !options.previewSessionId) throw new AppError(ERROR_CODES.validation, "Ephemeral preview plugin configuration is invalid", 422);
  const pluginSource = await resolvePluginSource();
  const store = new AtomicJsonStore(dataDir);
  const patchPath = join(plan.profileRoot, "cordis.patch.yml"), packagePath = join(plan.profileRoot, "package.json");
  const oldPatch = await readText(patchPath, "[]\n"), oldPackage = await readText(packagePath, "{}\n");
  if (extractManaged(oldPatch) || await exists(plan.packageRoot)) throw new AppError(ERROR_CODES.conflict, "Ephemeral preview home is not clean", 409);
  const themePath = store.path("active", `${plan.profile}.json`), assetDir = options.assetDir ? safeAssetDir(dataDir, options.assetDir) : store.path("assets", "content");
  const managed = managedBlock(plan.profile, themePath, assetDir, controllerUrl, secret, options);
  const manifest = parseManifest(oldPackage); manifest.dependencies = { ...(manifest.dependencies ?? {}), "@dsh-skin/dsh-plugin": "0.1.0" };
  const nextPatch = `${stripManaged(oldPatch).trimEnd()}${stripManaged(oldPatch).trim() ? "\n\n" : ""}${managed}\n`;
  const nextPackage = `${JSON.stringify(manifest, null, 2)}\n`;
  const stagePackage = `${plan.packageRoot}.stage-${randomUUID()}`;
  let moved = false;
  try {
    await mkdir(dirname(stagePackage), { recursive: true });
    await cp(pluginSource, stagePackage, { recursive: true, filter: (source) => !source.includes(`${join(pluginSource, "src")}`) && !source.includes("node_modules") });
    await rename(stagePackage, plan.packageRoot); moved = true;
    await atomicExternalText(packagePath, nextPackage);
    await atomicExternalText(patchPath, nextPatch);
    return plan;
  } catch (error) {
    try { if (hashText(await readText(patchPath, "")) === hashText(nextPatch)) await atomicExternalText(patchPath, oldPatch); } catch {}
    try { if (hashText(await readText(packagePath, "")) === hashText(nextPackage)) await atomicExternalText(packagePath, oldPackage); } catch {}
    try { if (moved) await rm(plan.packageRoot, { recursive: true, force: true }); } catch {}
    throw error;
  } finally { await rm(stagePackage, { recursive: true, force: true }); }
}

function managedBlock(profile: string, themePath: string, assetDir: string, controllerUrl: string, secret: string, options: IsolatedPluginOptions): string {
  const preview = options.previewSessionId ? [`        previewSessionId: '${yamlString(options.previewSessionId)}'`] : [];
  return [PATCH_START, "- insert:", "    - id: dsh-skin-studio", "      name: '@dsh-skin/dsh-plugin'", "      config:", `        profile: '${yamlString(profile)}'`, `        themeFile: '${yamlString(themePath)}'`, `        assetDir: '${yamlString(assetDir)}'`, `        controllerUrl: '${yamlString(controllerUrl)}'`, `        pluginSecret: '${yamlString(secret)}'`, ...preview, PATCH_END].join("\n");
}
function extractManaged(value: string): string | null { return value.match(new RegExp(`${PATCH_START}[\\s\\S]*?${PATCH_END}`))?.[0] ?? null; }
function stripManaged(value: string): string {
  const withoutManaged = value.replace(new RegExp(`${PATCH_START}[\\s\\S]*?${PATCH_END}\\s*`, "g"), "");
  const lines = withoutManaged.split(/\r?\n/);
  const significant = lines.filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  const kept = significant.length === 1 && significant[0]!.trim() === "[]" ? lines.filter((line) => line.trim() !== "[]") : lines;
  return kept.join("\n").trimEnd();
}
function ensureEmptyPatch(value: string): string {
  const significant = value.split(/\r?\n/).filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  return `${value.trimEnd()}${value.trim() ? "\n" : ""}${significant.length === 0 ? "[]\n" : "\n"}`;
}
function yamlString(value: string): string { return value.replaceAll("'", "''"); }
function safeAssetDir(dataDir: string, candidate: string): string {
  const target = resolve(candidate);
  if (!isAbsolute(candidate) || target !== candidate || !target.replaceAll("\\", "/").endsWith("/assets/content")) throw new AppError(ERROR_CODES.badRequest, "Isolated plugin asset directory must be a canonical Controller content-addressed asset store", 400);
  return target;
}
function hashText(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function parseManifest(value: string): { dependencies?: Record<string, string>; [key: string]: unknown } { const parsed = JSON.parse(value) as { dependencies?: Record<string, string> }; if (parsed.dependencies && (typeof parsed.dependencies !== "object" || Array.isArray(parsed.dependencies))) throw new AppError(ERROR_CODES.validation, "Profile dependencies are invalid", 422); return parsed; }
async function readText(path: string, fallback: string): Promise<string> { try { return await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; } }
async function atomicExternalText(path: string, value: string): Promise<void> { await mkdir(dirname(path), { recursive: true }); const temp = join(dirname(path), `.${randomUUID()}.stage`); await writeFile(temp, value, { encoding: "utf8", flag: "wx" }); await rename(temp, path); }
async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
function assertTarget(target: DshTarget): void { if (!target.dshHome || (!resolve(target.dshHome).toLowerCase().endsWith(".dsh") && process.env.DSH_SKIN_ALLOW_ANY_HOME !== "1")) throw new AppError(ERROR_CODES.badRequest, "dshHome must be an explicit .dsh directory", 400); if (!/^[a-zA-Z0-9_-]{1,40}$/.test(target.profile)) throw new AppError(ERROR_CODES.badRequest, "Invalid profile name", 400); }
async function resolvePluginSource(): Promise<string> {
  const candidates = pluginSourceCandidates();
  for (const source of candidates) {
    try {
      if (!(await stat(source)).isDirectory()) continue;
      const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8")) as { name?: string };
      if (manifest.name !== "@dsh-skin/dsh-plugin") continue;
      if (!(await stat(join(source, "dist", "host", "index.js"))).isFile()) continue;
      return source;
    } catch { continue; }
  }
  throw new AppError(ERROR_CODES.unavailable, "DSH_SKIN_PLUGIN_SOURCE does not contain a built managed plugin", 503);
}
