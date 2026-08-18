import { spawn } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface Discovery { instanceId: string; url: string; pid: number; startedAt: string }

export class ControllerClient {
  private baseUrl: string | null;
  private readonly explicitBaseUrl: boolean;
  private expectedInstanceId: string | null = null;
  private csrfToken: string | null = null;
  constructor(baseUrl?: string) {
    const selected = baseUrl || process.env.DSH_SKIN_URL;
    this.explicitBaseUrl = Boolean(selected);
    this.baseUrl = selected ? selected.replace(/\/$/, "") : null;
  }

  async status(): Promise<Record<string, unknown>> {
    const discovery = await this.resolveController();
    const response = await requestJson(`${discovery.url}/api/v1/status`);
    const body = response.body;
    if (response.status < 200 || response.status >= 300) throw apiError(response.status, body);
    const received = typeof body.instanceId === "string" ? body.instanceId : null;
    // `doctor`/`studio_status` is the explicit recovery handshake after a
    // Controller restart. It must be able to adopt the newly discovered
    // instance; mutation requests still compare the discovery record against
    // this refreshed identity immediately before sending a write.
    if (!received) {
      const error = new Error("Controller instance changed; rerun doctor before any mutation") as Error & { code?: string };
      error.code = "CONTROLLER_INSTANCE_CHANGED"; throw error;
    }
    this.expectedInstanceId = received;
    this.baseUrl = discovery.url;
    if (typeof body.csrfToken === "string") this.csrfToken = body.csrfToken;
    return body;
  }

  async request(path: string, method: "GET" | "POST" | "PATCH" | "DELETE" = "POST", body?: unknown): Promise<unknown> {
    if (!this.csrfToken) await this.status();
    const discovery = await this.resolveController();
    if (discovery.instanceId !== this.expectedInstanceId) throw instanceChanged();
    const headers = method === "GET" ? {} : { "content-type": "application/json", "x-dsh-skin-csrf": this.csrfToken! };
    const response = await requestJson(`${discovery.url}${path}`, method, headers, body);
    const value = response.body;
    if (response.status < 200 || response.status >= 300) throw apiError(response.status, value);
    return value;
  }

  async ensureStarted(): Promise<Record<string, unknown>> {
    try { return await this.status(); } catch (error) { if ((error as { code?: string }).code === "CONTROLLER_INSTANCE_CHANGED") throw error; }
    const controllerEntry = await resolveControllerEntry();
    const child = spawn(process.execPath, [controllerEntry], { detached: true, stdio: "ignore", shell: false, windowsHide: true, env: { ...process.env, ...(this.baseUrl ? { DSH_SKIN_PORT: new URL(this.baseUrl).port || "0" } : { DSH_SKIN_PORT: "0" }) } });
    child.unref();
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) { await new Promise((resolveWait) => setTimeout(resolveWait, 150)); try { this.expectedInstanceId = null; return await this.status(); } catch {} }
    throw new Error("Controller did not start. Run: pnpm controller; then rerun doctor to discover its loopback URL.");
  }

  private async resolveController(): Promise<Discovery> {
    if (this.baseUrl && this.explicitBaseUrl) {
      const response = await requestJson(`${this.baseUrl}/api/v1/status`);
      const body = response.body as { instanceId?: string };
      if (response.status < 200 || response.status >= 300 || !body.instanceId) throw new Error(`Controller is unavailable at ${this.baseUrl}`);
      return { instanceId: body.instanceId, url: this.baseUrl, pid: 0, startedAt: "explicit" };
    }
    const controllerDataDir = process.env.DSH_SKIN_DATA_DIR || join(process.env.LOCALAPPDATA || homedir(), "DeepSeekHarnessSkinStudio");
    const path = join(controllerDataDir, "controller-discovery.json");
    const discovery = JSON.parse(await readFile(path, "utf8")) as Discovery;
    const startedAt = Date.parse(discovery.startedAt);
    if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(discovery.url) || !/^[0-9a-f-]{36}$/.test(discovery.instanceId) || !Number.isInteger(discovery.pid) || discovery.pid <= 0 || !Number.isFinite(startedAt) || startedAt > Date.now() + 5 * 60_000 || !pidAlive(discovery.pid)) throw new Error("Controller discovery record is invalid or stale");
    return discovery;
  }
}

async function resolveControllerEntry(): Promise<string> {
  const configured = process.env.DSH_SKIN_CONTROLLER_ENTRY;
  const entry = configured ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../apps/controller/dist/index.js");
  if (configured && (!isAbsolute(configured) || resolve(configured) !== configured)) throw new Error("DSH_SKIN_CONTROLLER_ENTRY must be a canonical absolute path");
  await access(entry);
  if (!(await stat(entry)).isFile() || !entry.toLowerCase().endsWith(".js")) throw new Error("DSH_SKIN_CONTROLLER_ENTRY must identify a JavaScript file");
  return entry;
}

function instanceChanged(): Error & { code: string } { const error = new Error("Controller instance changed; rerun doctor before any mutation") as Error & { code: string }; error.code = "CONTROLLER_INSTANCE_CHANGED"; return error; }
function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
function apiError(status: number, body: Record<string, unknown>): Error & { code?: string; status?: number; details?: unknown } { const payload = typeof body.error === "object" && body.error !== null ? body.error as Record<string, unknown> : body; const error = new Error(typeof payload.message === "string" ? payload.message : `Controller returned HTTP ${status}`) as Error & { code?: string; status?: number; details?: unknown }; error.status = status; if (typeof payload.code === "string") error.code = payload.code; error.details = payload.details; return error; }

function requestJson(url: string, method: "GET" | "POST" | "PATCH" | "DELETE" = "GET", headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const target = new URL(url);
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(target.hostname)) throw new Error("Controller URL must be loopback HTTP");
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolveRequest, rejectRequest) => {
    const request = httpRequest(target, { method, agent: false, headers: { accept: "application/json", connection: "close", ...headers, ...(payload === undefined ? {} : { "content-length": String(Buffer.byteLength(payload)) }) } }, (response) => {
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer | string) => {
        const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += part.length;
        if (size > 4 * 1024 * 1024) request.destroy(new Error("Controller response exceeds 4 MiB"));
        else chunks.push(part);
      });
      response.on("end", () => {
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          const value = text ? JSON.parse(text) as Record<string, unknown> : {};
          resolveRequest({ status: response.statusCode ?? 0, body: value });
        } catch (error) { rejectRequest(error); }
      });
    });
    request.setTimeout(8_000, () => request.destroy(new Error("Controller request timed out")));
    request.on("error", rejectRequest);
    request.end(payload);
  });
}
