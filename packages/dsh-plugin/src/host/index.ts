import { createHash, randomUUID } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { WebServer } from "@deepseek-ai/dsh-host-webserver";

interface ThemeDocument { designId: string; revision: number; hash: string; theme: unknown }
interface PreviewSession extends ThemeDocument { expiresAt: string; sessionId?: string; generation?: number }
interface RenderReceipt { mode: "stable" | "preview"; designId: string; revision: number; hash: string; pluginInstanceId: string; clientInstanceId: string; sessionId?: string; generation?: number }

export interface Config { profile?: string; themeFile?: string; assetDir?: string; controllerUrl?: string; pluginSecret?: string; previewSessionId?: string; controllerEntry?: string; dataDir?: string }
export const inject = ["webServer"];
// Must match the Controller's bounded background-asset storage ceiling.
const MAX_BACKGROUND_ASSET_BYTES = 4 * 1024 * 1024;
const BALANCE_CACHE_TTL_MS = 30_000;
const BALANCE_TIMEOUT_MS = 8_000;
const BALANCE_API_KEY_ENV = "DEEPSEEK_API_KEY";
const BALANCE_BASE_URL = "https://api.deepseek.com";

export interface BalancePayload {
  ok: boolean;
  currency?: string;
  total?: string;
  granted?: string;
  toppedUp?: string;
  isAvailable?: boolean;
  queriedAt?: string;
  cached?: boolean;
  error?: { code: string; message: string };
}

/**
 * Resolve the DeepSeek API key for the balance proxy. The value is read only
 * on the Host: an explicit override, then the conventional environment
 * variable, then the DSH credentials document. It is never returned to the
 * browser and never included in any error response.
 */
export function resolveBalanceApiKey(dshHome: string): string | null {
  const direct = process.env.DSH_SKIN_BALANCE_API_KEY;
  if (direct) return direct;
  const named = process.env[BALANCE_API_KEY_ENV];
  if (named) return named;
  return readCredentialsKey(join(dshHome, ".credentials.yaml"), BALANCE_API_KEY_ENV);
}

export function normalizeBalancePayload(value: unknown): { currency: string; total: string; granted: string; toppedUp: string; isAvailable: boolean } | null {
  if (!value || typeof value !== "object") return null;
  const body = value as { is_available?: unknown; balance_infos?: unknown };
  if (typeof body.is_available !== "boolean" || !Array.isArray(body.balance_infos)) return null;
  const first = body.balance_infos[0];
  if (!first || typeof first !== "object") return null;
  const info = first as { currency?: unknown; total_balance?: unknown; granted_balance?: unknown; topped_up_balance?: unknown };
  if (typeof info.total_balance !== "string") return null;
  return {
    currency: typeof info.currency === "string" ? info.currency : "CNY",
    total: info.total_balance,
    granted: typeof info.granted_balance === "string" ? info.granted_balance : "0",
    toppedUp: typeof info.topped_up_balance === "string" ? info.topped_up_balance : "0",
    isAvailable: body.is_available
  };
}

function readCredentialsKey(path: string, key: string): string | null {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  const match = new RegExp(`(?:^|\\r?\\n)${escapeRegExp(key)}\\s*:\\s*("(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'|[^\\r\\n]+)`).exec(text);
  if (!match) return null;
  let value = match[1]!.trim();
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1).replace(/\\(["'\\])/g, "$1");
  return value || null;
}

async function fetchBalance(apiKey: string): Promise<{ currency: string; total: string; granted: string; toppedUp: string; isAvailable: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BALANCE_TIMEOUT_MS);
  try {
    const response = await fetch(`${BALANCE_BASE_URL}/user/balance`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`balance API HTTP ${response.status}`);
    const payload = normalizeBalancePayload(await response.json());
    if (!payload) throw new Error("balance API response is malformed");
    return payload;
  } finally { clearTimeout(timer); }
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function dshHomeForHost(): string { return process.env.DSH_HOME || join(homedir(), ".dsh"); }

// Persistent skin base, injected through the official webServer.tapIndex seam
// (the same seam the built-in ui-theme uses for its boot theme). The base
// lives at the CSS level on `html body`, so DSH route transitions — which
// replace React subtrees but never the body — cannot remove or reload it. The
// Client layers remain the refinement layer (preview fidelity, exact
// geometry, region picker); this style is the always-on canvas underneath.
const MAX_PERSISTENT_STYLE_BYTES = 64 * 1024;
const TOKEN_PATTERN = /^--dsw-[a-z0-9-]+$/;
const ASSET_ID_PATTERN = /^sha256-[0-9a-f]{64}$/;

export function buildPersistentSkinStyle(theme: unknown): string {
  const appearance = theme && typeof theme === "object" ? (theme as { appearance?: unknown }).appearance : undefined;
  if (!appearance || typeof appearance !== "object") return "";
  const view = appearance as { backdrop?: unknown; regions?: unknown; tokens?: unknown };
  const tokens = isRecord(view.tokens) ? view.tokens as Record<string, { light?: unknown; dark?: unknown }> : undefined;
  const regions = isRecord(view.regions)
    ? view.regions as { linked?: unknown; divider?: unknown; sidebar?: unknown; main?: unknown }
    : { linked: true, divider: false, sidebar: view.backdrop, main: view.backdrop };
  const linked = regions.linked !== false;
  const main = regions.main ?? view.backdrop;
  const sidebar = regions.sidebar ?? view.backdrop;
  const divider = regions.divider === true;
  const parts: string[] = [];
  for (const mode of ["light", "dark"] as const) {
    const lines: string[] = [];
    for (const [name, pair] of Object.entries(tokens ?? {})) {
      if (!TOKEN_PATTERN.test(name)) continue;
      const value = pair?.[mode];
      if (typeof value === "string" && value.length > 0 && value.length <= 64) lines.push(`  ${name}: ${value};`);
    }
    if (lines.length > 0) parts.push(`html body${mode === "dark" ? "[data-ds-dark-theme]" : ""} {\n${lines.join("\n")}\n}`);
  }
  if (linked) {
    const blur = clampNum(isRecord(main) ? main.blurPx : 0, 0, 40);
    const opacity = clampNum(isRecord(main) ? main.opacity : 1, 0, 1);
    const linkedCss = cssBackdrop(main);
    if (opacity >= 1 && blur === 0) {
      // Most robust: paint the backdrop directly on the body background. It
      // sits below every element and cannot disappear during route
      // transitions — no pseudo-element, no z-index, no fixed positioning for
      // a route transition transform to disturb.
      parts.push(`html body{${linkedCss};background-attachment:fixed!important}`);
    } else {
      // A blur or partial opacity needs its own layer (body filter/opacity
      // would leak onto the whole UI). This pseudo canvas remains only for
      // those themes; the zero-blur common case uses the body background.
      parts.push(`html body::before{content:"";position:fixed;inset:-${blur * 2}px;z-index:-1;pointer-events:none;${linkedCss};opacity:${opacity};${blur > 0 ? `filter:blur(${blur}px);` : ""}background-attachment:fixed}`);
    }
    parts.push(`html body .pI_x6G_sidebarCol,html body .pI_x6G_frame,html body .pI_x6G_centerCol{background:transparent!important}`);
    // The sidebar content root must stay transparent AND stacked above the
    // canvas on every route replacement. A stylesheet-level rule applies to
    // whatever element matches at any moment, so a replaced sidebar subtree
    // cannot briefly return to the native opaque panel or slide under the
    // backdrop layer (the Client re-applies the same treatment inline).
    parts.push(`html body .pI_x6G_sidebarCol .hHd-Xa_root{background:transparent!important;position:relative!important;z-index:1!important}`);
    parts.push(`html body .qDHVXG_fade{background:transparent!important}`);
    parts.push(`html body .pI_x6G_sidebarCol{border-right-color:transparent!important}`);
    // The divider is a stylesheet pseudo-element so it can never be detached
    // by a route transition (the Client's DOM decoration is now only a
    // fallback when the index seam is unavailable).
    if (divider) parts.push(...dividerRules());
    // The conversation mask is default-on for the main region and off only on
    // the hero (identified by its unique workspace row). This covers route
    // loading windows too: while a conversation is mounting there is no hero
    // row yet, so the mask stays applied instead of popping on after load.
    const mask = maskColor(main);
    if (mask) {
      parts.push(`html body .pI_x6G_centerCol{background-color:${mask}!important}`);
      parts.push(`html body:has(div.wSkVaW_heroWorkspaceRow) .pI_x6G_centerCol{background-color:transparent!important}`);
    }
  } else {
    const sidebarCss = cssBackdrop(sidebar);
    const mainCss = cssBackdrop(main);
    if (sidebarCss) parts.push(`html body .pI_x6G_sidebarCol{${sidebarCss};background-attachment:fixed!important}`);
    if (mainCss) parts.push(`html body .pI_x6G_centerCol{${mainCss};background-attachment:fixed!important}`);
    parts.push(`html body .pI_x6G_sidebarCol .hHd-Xa_root{background:transparent!important;position:relative!important;z-index:1!important}`);
    parts.push(`html body .qDHVXG_fade{background:transparent!important}`);
    if (divider) parts.push(...dividerRules());
    const mask = maskColor(main);
    if (mask) {
      parts.push(`html body .pI_x6G_centerCol{box-shadow:inset 0 0 0 9999px ${mask}!important}`);
      parts.push(`html body:has(div.wSkVaW_heroWorkspaceRow) .pI_x6G_centerCol{box-shadow:none!important}`);
    }
  }
  const style = parts.join("\n");
  return style.length > 0 && style.length <= MAX_PERSISTENT_STYLE_BYTES ? style : "";
}

export function injectPersistentSkinStyle(html: string, getActive: () => ThemeDocument | null): string {
  if (html.includes("dsh-skin-persistent")) return html;
  const active = getActive();
  const style = active ? buildPersistentSkinStyle(active.theme) : "";
  if (!style) return html;
  return html.replace("</head>", `<style id="dsh-skin-persistent">${style}</style></head>`);
}

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function clampNum(value: unknown, min: number, max: number): number { return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min; }
function cssColor(value: unknown): string | null { return typeof value === "string" && /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : null; }
function alphaOf(hex: string, opacity: number): string {
  const a = Math.min(1, Math.max(0, opacity));
  let expanded = hex;
  if (expanded.length === 4) expanded = expanded.replace(/^#([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/, "#$1$1$2$2$3$3");
  const match = /^#([0-9a-fA-F]{6})$/.exec(expanded);
  if (!match) return `rgb(0 0 0 / ${a})`;
  const n = Number.parseInt(match[1]!, 16);
  return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${a})`;
}
function maskColor(backdrop: unknown): string | null {
  if (isRecord(backdrop) && backdrop.kind === "image") {
    const overlay = isRecord(backdrop.overlay) ? cssColor(backdrop.overlay.color) : null;
    return overlay ? alphaOf(overlay, 0.7) : "rgb(0 0 0 / 0.7)";
  }
  return "rgb(0 0 0 / 0.7)";
}
function dividerRules(): string[] {
  return [
    `html body .pI_x6G_sidebarCol{position:relative!important}`,
    `html body .pI_x6G_sidebarCol::after{content:"";position:absolute;top:0;right:-0.5px;bottom:0;width:1px;pointer-events:none;background:linear-gradient(to bottom, transparent, rgb(230 248 255 / 62%) 10%, rgb(230 248 255 / 82%) 50%, rgb(230 248 255 / 62%) 90%, transparent);box-shadow:0 0 9px rgb(89 192 255 / 36%);z-index:2}`
  ];
}
function cssBackdrop(backdrop: unknown): string {
  if (!isRecord(backdrop)) return "";
  if (backdrop.kind === "image" && typeof backdrop.assetId === "string" && ASSET_ID_PATTERN.test(backdrop.assetId)) {
    const fit = backdrop.fit === "contain" ? "contain" : backdrop.fit === "fill" ? "100% 100%" : "cover";
    const position = isRecord(backdrop.position) ? backdrop.position : {};
    const x = clampNum(position.xPercent, 0, 100);
    const y = clampNum(position.yPercent, 0, 100);
    const overlayRecord = isRecord(backdrop.overlay) ? backdrop.overlay : undefined;
    const overlay = cssColor(overlayRecord?.color);
    const overlayOpacity = clampNum(overlayRecord?.opacity, 0, 1);
    const image = `url("/dsh-skin/assets/${backdrop.assetId}")`;
    return `background-image:${overlay ? `linear-gradient(${alphaOf(overlay, overlayOpacity)}, ${alphaOf(overlay, overlayOpacity)}), ` : ""}${image};background-size:${fit};background-position:${x}% ${y}%;background-repeat:no-repeat`;
  }
  const colors = Array.isArray(backdrop.colors) ? (backdrop.colors as unknown[]).filter((c): c is string => cssColor(c) !== null).slice(0, 4) : [];
  if (colors.length === 0) return "";
  if (backdrop.kind === "linear-gradient") return `background-image:linear-gradient(${clampNum(backdrop.angle, 0, 360)}deg,${colors.join(",")})`;
  if (backdrop.kind === "radial-gradient") return `background-image:radial-gradient(circle at center,${colors.join(",")})`;
  return `background-image:${colors[0]}`;
}

export function apply(ctx: Context, config: Config = {}): void {
  ctx.inject(["webServer"], (httpCtx) => {
    if (typeof httpCtx.effect !== "function") throw new Error("dsh-skin-studio requires the rc.6 effect lifecycle");
    if (!isRc6WebServer(httpCtx.webServer)) throw new Error("dsh-skin-studio requires the rc.6 webServer route/disposer contract");
    if (!config.profile || !/^[a-zA-Z0-9_-]{1,40}$/.test(config.profile) || !config.themeFile || !config.assetDir || !isLoopback(config.controllerUrl) || !config.pluginSecret || config.pluginSecret.length < 32 || (config.previewSessionId !== undefined && !/^[0-9a-f-]{36}$/i.test(config.previewSessionId))) throw new Error("dsh-skin-studio config is incomplete or unsafe");
    httpCtx.effect(() => {
      const pluginInstanceId = randomUUID();
      const abort = new AbortController();
      let stable: ThemeDocument | null = null, preview: PreviewSession | null = null, controllerInstanceId = "";
      let balanceCache: { at: number; value: BalancePayload } | undefined;
      const acknowledge = async (receipt: RenderReceipt) => {
        if (!controllerInstanceId) throw new Error("controller instance is unavailable");
        if (config.previewSessionId) {
          if (receipt.mode !== "preview" || receipt.sessionId !== config.previewSessionId || !Number.isInteger(receipt.generation)) throw new Error("isolated preview receipt is incomplete");
          const { mode: _mode, ...isolatedReceipt } = receipt;
          const response = await fetch(`${config.controllerUrl}/api/v1/preview-sessions/${encodeURIComponent(config.previewSessionId)}/host/rendered`, { method: "POST", signal: abort.signal, headers: auth(config.pluginSecret!), body: JSON.stringify({ ...isolatedReceipt, sessionId: receipt.sessionId, generation: receipt.generation, controllerInstanceId }) });
          if (!response.ok) throw new Error(`isolated render acknowledgement failed: ${response.status}`);
          return;
        }
        const kind = receipt.mode === "preview" ? "preview" : "theme";
        const response = await fetch(`${config.controllerUrl}/api/v1/plugin/${kind}/ack`, { method: "POST", signal: abort.signal, headers: auth(config.pluginSecret!), body: JSON.stringify({ profile: config.profile, mode: receipt.mode, designId: receipt.designId, revision: receipt.revision, hash: receipt.hash, controllerInstanceId, pluginInstanceId, clientInstanceId: receipt.clientInstanceId }) });
        if (!response.ok) throw new Error(`controller render acknowledgement failed: ${response.status}`);
      };
      const disposers = [
        httpCtx.webServer.register({ kind: "exact", path: "/dsh-skin/studio", handler: async (req, res) => {
          if (req.method !== "GET") { res.writeHead(405, { allow: "GET", "x-content-type-options": "nosniff" }); res.end(); return; }
          if (!isLoopbackHost(req.headers.host)) return json(res, 403, { error: "FORBIDDEN_HOST" });
          if (!config.controllerUrl) return json(res, 500, { error: "CONTROLLER_URL_MISSING" });
          // The Controller is a separate process that may have died (or was
          // never started after a reboot). If the installer recorded its
          // entry point, bring it back instead of failing with an unreachable
          // redirect — the settings card's "启动并打开 Skin Studio" must work
          // even after the Controller went away.
          if (!(await controllerAlive(config.controllerUrl))) {
            if (!config.controllerEntry || !config.dataDir) return json(res, 503, { error: "CONTROLLER_UNAVAILABLE", message: "Studio Controller 未运行，且缺少自动启动配置（请重跑 install.ps1）" });
            const started = await spawnController(config);
            if (!started) return json(res, 503, { error: "CONTROLLER_START_FAILED", message: "Studio Controller 启动失败，请查看日志后重试" });
          }
          res.writeHead(302, { location: config.controllerUrl, "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end();
        } }),
        httpCtx.webServer.register({ kind: "exact", path: "/dsh-skin/health", handler: (_req, res) => json(res, 200, { ok: true, plugin: "@dsh-skin/dsh-plugin", version: "0.1.0", pluginInstanceId, mode: preview ? "preview" : "stable", designId: (preview ?? stable)?.designId ?? null, revision: (preview ?? stable)?.revision ?? null, hash: (preview ?? stable)?.hash ?? null }) }),
        httpCtx.webServer.register({ kind: "exact", path: "/dsh-skin/state", handler: async (_req, res) => { await refreshStable(); const active = preview ?? stable; if (!active) return json(res, 503, { error: "THEME_UNAVAILABLE" }); json(res, 200, { mode: preview ? "preview" : "stable", pluginInstanceId, ...active }); } }),
        httpCtx.webServer.register({ kind: "exact", path: "/dsh-skin/theme", handler: async (_req, res) => { await refreshStable(); const active = preview ?? stable; if (!active) return json(res, 503, { error: "THEME_UNAVAILABLE" }); json(res, 200, active.theme); } }),
        httpCtx.webServer.register({ kind: "exact", path: "/dsh-skin/rendered", handler: async (req, res) => {
          if (req.method !== "POST") { res.writeHead(405, { allow: "POST", "x-content-type-options": "nosniff" }); res.end(); return; }
          if (!sameOrigin(req)) return json(res, 403, { error: "FORBIDDEN_ORIGIN" });
          try {
            const receipt = await renderReceipt(req);
            const mode = preview ? "preview" : "stable";
            const active = preview ?? stable;
            if (!active || receipt.mode !== mode || receipt.pluginInstanceId !== pluginInstanceId || receipt.designId !== active.designId || receipt.revision !== active.revision || receipt.hash !== active.hash) return json(res, 409, { error: "RENDER_STATE_MISMATCH" });
            await acknowledge(receipt);
            json(res, 202, { accepted: true });
          } catch (error) { json(res, 400, { error: "INVALID_RENDER_RECEIPT", message: error instanceof Error ? error.message : String(error) }); }
        } }),
        httpCtx.webServer.register({ kind: "prefix", path: "/dsh-skin/assets", handler: (req, res) => serveAsset(config.assetDir!, req, res) }),
        httpCtx.webServer.register({ kind: "exact", path: "/dsh-skin/balance", handler: async (req, res) => {
          if (req.method !== "GET") { res.writeHead(405, { allow: "GET", "x-content-type-options": "nosniff" }); res.end(); return; }
          if (!isLoopbackHost(req.headers.host)) return json(res, 403, { error: "FORBIDDEN_HOST" });
          const url = new URL(req.url || "/", "http://127.0.0.1");
          const refresh = url.searchParams.get("refresh") === "1";
          if (!refresh && balanceCache && Date.now() - balanceCache.at < BALANCE_CACHE_TTL_MS) {
            json(res, 200, { ...balanceCache.value, cached: true });
            return;
          }
          const apiKey = resolveBalanceApiKey(dshHomeForHost());
          if (!apiKey) return json(res, 200, { ok: false, error: { code: "BALANCE_KEY_UNAVAILABLE", message: "未找到 DeepSeek API 密钥（DEEPSEEK_API_KEY）" } });
          try {
            const value = await fetchBalance(apiKey);
            const payload: BalancePayload = { ok: true, ...value, queriedAt: new Date().toISOString(), cached: false };
            balanceCache = { at: Date.now(), value: payload };
            json(res, 200, payload);
          } catch (error) {
            json(res, 200, { ok: false, error: { code: "BALANCE_QUERY_FAILED", message: error instanceof Error ? error.name === "AbortError" ? "余额查询超时" : error.message.replace(/\s+/g, " ").slice(0, 120) : "余额查询失败" } });
          }
        } }),
        // The persistent skin base rides the same official index seam the
        // built-in ui-theme uses. Every served index.html gets a <style> that
        // pins the current theme onto `html body` (and per-region panels), so
        // route transitions can never blank or reload the background.
        httpCtx.webServer.tapIndex((html) => injectPersistentSkinStyle(html, () => preview ?? stable ?? readStableSync()))
      ];

      const refreshStable = async () => {
        try {
          const raw = await readFile(config.themeFile!, "utf8");
          const candidate = JSON.parse(raw) as ThemeDocument;
          if (!validDocument(candidate)) return;
          stable = candidate;
        } catch {}
      };
      // The index seam must paint the persistent base from the very first
      // request, before the first preview poll completes. The theme document
      // is small, so a synchronous fallback read is acceptable per request.
      const readStableSync = (): ThemeDocument | null => {
        try {
          const raw = readFileSync(config.themeFile!, "utf8");
          const candidate = JSON.parse(raw) as ThemeDocument;
          return validDocument(candidate) ? candidate : null;
        } catch { return null; }
      };
      const poll = async () => {
        try {
          await refreshStable();
          const endpoint = config.previewSessionId ? `${config.controllerUrl}/api/v1/preview-sessions/${encodeURIComponent(config.previewSessionId)}/host/state` : `${config.controllerUrl}/api/v1/plugin/preview?profile=${encodeURIComponent(config.profile!)}`;
          const response = await fetch(endpoint, { signal: abort.signal, headers: { authorization: `Bearer ${config.pluginSecret}` } });
          if (!response.ok) { preview = null; return; }
          const payload = await response.json() as { instanceId?: string; session?: PreviewSession | null };
          controllerInstanceId = typeof payload.instanceId === "string" ? payload.instanceId : "";
          const candidate = payload.session;
          if (!candidate || Date.parse(candidate.expiresAt) <= Date.now() || !validDocument(candidate) || (config.previewSessionId && (candidate.sessionId !== config.previewSessionId || !Number.isInteger(candidate.generation) || candidate.generation! < 1))) { preview = null; return; }
          preview = candidate;
        } catch { preview = null; }
      };
      void poll();
      const timer = setInterval(() => { void poll(); }, 800);
      return () => { clearInterval(timer); abort.abort(); preview = null; stable = null; for (const dispose of disposers.reverse()) dispose(); };
    }, "dsh-skin-studio: rc.6 routes and preview poll");
  });
}

function isRc6WebServer(value: unknown): value is WebServer { return typeof value === "object" && value !== null && typeof (value as WebServer).register === "function"; }

function validDocument(value: ThemeDocument): boolean { return typeof value?.designId === "string" && Number.isInteger(value.revision) && value.revision > 0 && /^[0-9a-f]{64}$/.test(value.hash) && value.theme !== null && typeof value.theme === "object" && canonicalHash(value.theme) === value.hash; }
function canonicalHash(value: unknown): string { return createHash("sha256").update(stableStringify(value)).digest("hex"); }
function stableStringify(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`; return JSON.stringify(value); }
function auth(secret: string): Record<string, string> { return { authorization: `Bearer ${secret}`, "content-type": "application/json" }; }
function isLoopback(value: string | undefined): value is string { try { if (!value) return false; const url = new URL(value); return url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname); } catch { return false; } }
function isLoopbackHost(value: string | undefined): boolean { try { const hostname = new URL(`http://${value || ""}`).hostname; return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname); } catch { return false; } }
function sameOrigin(req: IncomingMessage): boolean { try { const origin = req.headers.origin; const host = req.headers.host; if (!origin || !host) return false; const parsed = new URL(origin); return parsed.protocol === "http:" && parsed.host.toLowerCase() === host.toLowerCase() && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname); } catch { return false; } }
async function renderReceipt(req: IncomingMessage): Promise<RenderReceipt> {
  if (!(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) throw new Error("content-type must be application/json");
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += part.length; if (size > 8_192) throw new Error("render receipt exceeds 8 KiB"); chunks.push(part); }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Partial<RenderReceipt>;
  if ((value.mode !== "stable" && value.mode !== "preview") || typeof value.designId !== "string" || !/^[0-9a-f-]{36}$/.test(value.designId) || !Number.isInteger(value.revision) || value.revision! <= 0 || typeof value.hash !== "string" || !/^[0-9a-f]{64}$/.test(value.hash) || typeof value.pluginInstanceId !== "string" || !/^[0-9a-f-]{36}$/.test(value.pluginInstanceId) || typeof value.clientInstanceId !== "string" || !/^[0-9a-f-]{36}$/.test(value.clientInstanceId) || (value.sessionId !== undefined && (!/^[0-9a-f-]{36}$/.test(value.sessionId) || !Number.isInteger(value.generation) || value.generation! < 1))) throw new Error("render receipt fields are invalid");
  return value as RenderReceipt;
}

async function serveAsset(assetDir: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { allow: "GET, HEAD", "x-content-type-options": "nosniff" }); res.end(); return; }
  const id = new URL(req.url || "/", "http://127.0.0.1").pathname.slice("/dsh-skin/assets/".length);
  if (!/^sha256-[0-9a-f]{64}$/.test(id)) return json(res, 400, { error: "INVALID_ASSET_ID" });
  const root = resolve(assetDir);
  for (const [extension, mime] of [[".png", "image/png"], [".jpg", "image/jpeg"], [".webp", "image/webp"]] as const) {
    const path = resolve(root, `${id}${extension}`);
    if (dirname(path) !== root) return json(res, 400, { error: "INVALID_ASSET_PATH" });
    try { const info = await stat(path); if (!info.isFile() || info.size <= 0 || info.size > MAX_BACKGROUND_ASSET_BYTES) return json(res, 413, { error: "ASSET_INVALID" }); res.writeHead(200, { "content-type": mime, "content-length": info.size, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" }); if (req.method === "HEAD") { res.end(); return; } createReadStream(path).pipe(res); return; } catch {}
  }
  json(res, 404, { error: "ASSET_NOT_FOUND" });
}
function json(res: ServerResponse, status: number, body: unknown): void { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(JSON.stringify(body)); }

/**
 * Probe the Studio Controller. `/dsh-skin/health` is the DSH-side plugin
 * route when a preview host is up, while `/api/v1/status` is the Controller's
 * own endpoint — probe the latter since the settings card redirects there.
 */
async function controllerAlive(base: string): Promise<boolean> {
  try {
    const response = await fetch(`${base}/api/v1/status`, { method: "GET", signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return false;
    const body = await response.json() as { ok?: unknown };
    return body.ok === true;
  } catch { return false; }
}

/**
 * Spawn the Controller process from the entry point the installer recorded,
 * then wait for it to become healthy. The child inherits DSH_HOME and is
 * given the same port/data-dir the rest of the integration uses; logs go to
 * %TEMP% so a failed start is diagnosable.
 */
async function spawnController(config: Config): Promise<boolean> {
  if (!config.controllerEntry || !config.controllerUrl || !config.dataDir) return false;
  try {
    const url = new URL(config.controllerUrl);
    const port = Number.parseInt(url.port, 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return false;
    const { spawn } = await import("node:child_process");
    const log = join(process.env.TEMP || ".", "dsh-skin-controller.out.log");
    const errLog = join(process.env.TEMP || ".", "dsh-skin-controller.err.log");
    const child = spawn(process.execPath, [config.controllerEntry], {
      detached: true, stdio: "ignore", windowsHide: true,
      env: { ...process.env, DSH_SKIN_PORT: String(port), DSH_SKIN_DATA_DIR: config.dataDir }
    });
    child.unref();
    void logControllerOutput(child, log, errLog);
    // Give it up to 12s to boot (it links/installs the isolated runtime the
    // first time, which is the slowest path).
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      if (await controllerAlive(config.controllerUrl)) return true;
      await new Promise((resolveWait) => setTimeout(resolveWait, 300));
    }
    return await controllerAlive(config.controllerUrl);
  } catch { return false; }
}

/** Best-effort capture of the spawned Controller's stdout/stderr. */
async function logControllerOutput(child: import("node:child_process").ChildProcess, outLog: string, errLog: string): Promise<void> {
  try {
    const { createWriteStream } = await import("node:fs");
    if (child.stdout) child.stdout.pipe(createWriteStream(outLog, { flags: "a" }));
    if (child.stderr) child.stderr.pipe(createWriteStream(errLog, { flags: "a" }));
  } catch { /* logging must never break the spawn */ }
}
