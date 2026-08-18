#!/usr/bin/env node
import { ControllerClient } from "./client.js";

const client = new ControllerClient();
const [group = "doctor", action, ...rest] = process.argv.slice(2);

try {
  let result: unknown;
  if (group === "doctor") result = await client.status();
  else if (group === "studio" && action === "start") { await client.ensureStarted(); result = await client.request("/api/v1/studio/start"); }
  else if (group === "studio" && action === "open") { await client.ensureStarted(); result = await client.request("/api/v1/studio/open"); }
  else if (group === "design" && action === "create") result = await client.request("/api/v1/session/design", "POST", parseJson(rest));
  else if (group === "design" && action === "list") result = await client.request("/api/v1/designs", "GET");
  else if (group === "design" && action === "get") result = await client.request(`/api/v1/design/${required(rest[0], "design id")}`, "GET");
  else if (group === "design" && action === "patch") result = await client.request(`/api/v1/design/${required(rest[0], "design id")}`, "PATCH", parseJson(rest.slice(1)));
  else if (group === "design" && action === "duplicate") result = await client.request(`/api/v1/design/${required(rest[0], "design id")}/duplicate`, "POST", parseJson(rest.slice(1)));
  else if (group === "design" && action === "rename") result = await client.request(`/api/v1/design/${required(rest[0], "design id")}/rename`, "POST", parseJson(rest.slice(1)));
  else if (group === "design" && action === "delete") result = await client.request(`/api/v1/design/${required(rest[0], "design id")}`, "DELETE");
  else if (group === "asset" && action === "upload") result = await client.request("/api/v1/assets", "POST", parseJson(rest));
  else if (group === "theme" && action === "validate") result = await client.request("/api/v1/theme/validate", "POST", parseJson(rest));
  else if (group === "theme" && action === "apply-plan") result = await client.request("/api/v1/theme/apply-plan", "POST", parseJson(rest));
  else if (group === "theme" && action === "restore-plan") result = await client.request("/api/v1/theme/restore-plan", "POST", parseJson(rest));
  else if (group === "theme" && action === "apply") result = await client.request("/api/v1/theme/apply", "POST", parseJson(rest));
  else if (group === "theme" && action === "restore") result = await client.request("/api/v1/theme/restore", "POST", parseJson(rest));
  else if (group === "preview" && ["start", "snapshot", "stop"].includes(action || "")) result = await client.request(`/api/v1/preview/${action}`, "POST", parseJson(rest));
  else if (group === "preview-session" && action === "create") result = await client.request("/api/v1/preview-sessions", "POST", parseJson(rest));
  else if (group === "preview-session" && action === "list") result = await client.request("/api/v1/preview-sessions", "GET");
  else if (group === "preview-session" && action === "get") result = await client.request(`/api/v1/preview-sessions/${required(rest[0], "preview session id")}`, "GET");
  else if (group === "preview-session" && action === "update") result = await client.request(`/api/v1/preview-sessions/${required(rest[0], "preview session id")}`, "POST", parseJson(rest.slice(1)));
  else if (group === "preview-session" && action === "stop") result = await client.request(`/api/v1/preview-sessions/${required(rest[0], "preview session id")}`, "DELETE");
  else if (group === "plugin" && ["plan", "install", "uninstall"].includes(action || "")) result = await client.request(`/api/v1/plugin/${action}`, "POST", parseJson(rest));
  else if (group === "operation" && action === "status") result = await client.request(`/api/v1/operations/${required(rest[0], "operation id")}`, "GET");
  else throw new Error("Usage: dsh-skin doctor | studio <start|open> | design <create|list|get|patch|duplicate|rename|delete> | asset upload | theme <validate|apply-plan|restore-plan|apply|restore> | preview <start|snapshot|stop> | preview-session <create|list|get|update|stop> | plugin <plan|install|uninstall> | operation status");
  await writeFully(process.stdout, `${JSON.stringify({ ok: true, result }, null, 2)}\n`);
} catch (error) {
  const value = error as Error & { code?: string; status?: number; details?: unknown };
  await writeFully(process.stderr, `${JSON.stringify({ ok: false, error: { code: value.code || "CLI_ERROR", message: value.message, status: value.status, details: value.details } }, null, 2)}\n`);
  process.exitCode = 1;
}

function writeFully(stream: NodeJS.WritableStream, value: string): Promise<void> {
  return new Promise((resolveWrite, rejectWrite) => {
    stream.write(value, (error?: Error | null) => error ? rejectWrite(error) : resolveWrite());
  });
}

function parseJson(parts: string[]): unknown {
  if (parts.length === 0) return {};
  const text = parts.join(" ");
  try { return JSON.parse(text); } catch { throw new Error("The command payload must be one valid JSON object"); }
}
function required(value: string | undefined, name: string): string { if (!value) throw new Error(`Missing ${name}`); return value; }
