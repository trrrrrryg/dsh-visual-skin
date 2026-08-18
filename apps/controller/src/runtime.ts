import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { DshRuntimeStatus } from "@dsh-skin/shared";

const execFileAsync = promisify(execFile);

export async function detectDshRuntime(defaultDshHome: string): Promise<DshRuntimeStatus> {
  if (isIsolatedPreviewOnly(defaultDshHome)) {
    // Never consult DSH_WEB_URL or enumerate processes from an isolated
    // Controller. A Studio iframe must only learn the disposable preview URL.
    return { detected: false, url: null, profile: null, pluginInstalled: false, pluginHealthy: false, preview: "studio-only" };
  }
  const discovered = await discoverUrl();
  const pluginInstalled = await exists(join(defaultDshHome, "profiles", "node_modules", "@dsh-skin", "dsh-plugin", "package.json"));
  let detected = false;
  let pluginHealthy = false;
  let pluginState: { pluginInstanceId?: string; mode?: "stable" | "preview"; designId?: string; revision?: number; hash?: string } = {};
  if (discovered.url) {
    detected = await responds(discovered.url, "/");
    if (detected) {
      pluginState = await pluginResponds(discovered.url);
      pluginHealthy = Boolean(pluginState.pluginInstanceId);
    }
  }
  return {
    detected,
    url: detected ? discovered.url : null,
    profile: detected ? discovered.profile : null,
    pluginInstalled,
    pluginHealthy,
    ...(pluginState.pluginInstanceId ? { pluginInstanceId: pluginState.pluginInstanceId } : {}),
    ...(pluginState.mode ? { activeMode: pluginState.mode } : {}),
    ...(pluginState.designId ? { activeDesignId: pluginState.designId } : {}),
    ...(pluginState.revision !== undefined ? { activeRevision: pluginState.revision } : {}),
    ...(pluginState.hash ? { activeHash: pluginState.hash } : {}),
    preview: pluginHealthy ? "live" : detected ? "degraded" : "studio-only"
  };
}

/** Explicit opt-in plus a conservative temp-home inference for CI/preview runs. */
export function isIsolatedPreviewOnly(dshHome: string): boolean {
  if (process.env.DSH_SKIN_ISOLATED_PREVIEW_ONLY === "1") return true;
  const home = resolve(dshHome).toLowerCase();
  const temp = resolve(tmpdir()).toLowerCase();
  const separator = process.platform === "win32" ? "\\" : "/";
  return home.startsWith(`${temp}${separator}`) && home.endsWith(".dsh");
}

async function discoverUrl(): Promise<{ url: string | null; profile: string | null }> {
  const explicit = process.env.DSH_WEB_URL;
  if (explicit && isLoopbackUrl(explicit)) return { url: explicit.replace(/\/$/, ""), profile: process.env.DSH_PROFILE || "web" };
  if (process.platform !== "win32") return { url: null, profile: null };
  const executable = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const script = "$p=Get-CimInstance Win32_Process|Where-Object{$_.CommandLine -match '@deepseek-ai[\\\\/]dsh[\\\\/]lib[\\\\/]bin\\.js' -and $_.CommandLine -match '--profile\\s+web'}|Select-Object -First 1;if($p){$c=Get-NetTCPConnection -OwningProcess $p.ProcessId -State Listen -ErrorAction SilentlyContinue|Where-Object{$_.LocalAddress -in @('127.0.0.1','::1')}|Select-Object -First 1;if($c){[pscustomobject]@{port=$c.LocalPort;profile='web'}|ConvertTo-Json -Compress}}";
  try {
    const { stdout } = await execFileAsync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 3000, maxBuffer: 16_384 });
    const value = JSON.parse(stdout.trim()) as { port?: number; profile?: string };
    return Number.isInteger(value.port) ? { url: `http://127.0.0.1:${value.port}`, profile: value.profile || "web" } : { url: null, profile: null };
  } catch { return { url: null, profile: null }; }
}

async function responds(base: string, path: string): Promise<boolean> {
  try { const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(700) }); return response.ok; } catch { return false; }
}
async function pluginResponds(base: string): Promise<{ pluginInstanceId?: string; mode?: "stable" | "preview"; designId?: string; revision?: number; hash?: string }> {
  try {
    const response = await fetch(`${base}/dsh-skin/health`, { signal: AbortSignal.timeout(700), headers: { accept: "application/json" } });
    if (!response.ok || !(response.headers.get("content-type") || "").includes("application/json")) return {};
    const body = await response.json() as { ok?: boolean; plugin?: string; pluginInstanceId?: string; mode?: string; designId?: string | null; revision?: number | null; hash?: string | null };
    if (body.ok !== true || body.plugin !== "@dsh-skin/dsh-plugin" || typeof body.pluginInstanceId !== "string") return {};
    return {
      pluginInstanceId: body.pluginInstanceId,
      ...(body.mode === "stable" || body.mode === "preview" ? { mode: body.mode } : {}),
      ...(typeof body.designId === "string" ? { designId: body.designId } : {}),
      ...(Number.isInteger(body.revision) ? { revision: body.revision! } : {}),
      ...(typeof body.hash === "string" && /^[0-9a-f]{64}$/.test(body.hash) ? { hash: body.hash } : {})
    };
  } catch { return {}; }
}
function isLoopbackUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname); } catch { return false; }
}
async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
