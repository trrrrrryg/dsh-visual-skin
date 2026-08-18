#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ControllerClient } from "@dsh-skin/agent-cli";

const client = new ControllerClient();
const server = new McpServer({ name: "deepseek-harness-skin-studio", version: "0.1.0" });
const empty = {};
const designRevision = { designId: z.string().uuid(), revision: z.number().int().positive() };
const target = { profile: z.string().regex(/^[a-zA-Z0-9_-]{1,40}$/).optional() };
const actor = z.enum(["human", "agent", "system"]).default("agent");

tool("doctor", "Check the local Studio controller and exact DSH compatibility.", empty, async () => client.status());
tool("studio_status", "Return Studio and DSH capability status.", empty, async () => client.status());
tool("studio_start", "Start the local Studio controller if needed.", empty, async () => client.ensureStarted());
tool("studio_open", "Open the independent Studio web UI; returns a copyable URL if opening fails.", empty, async () => { await client.ensureStarted(); return client.request("/api/v1/studio/open"); });
tool("design_create", "Create a shared revisioned design session.", { name: z.string().max(80).optional(), theme: z.unknown().optional() }, async (args) => client.request("/api/v1/session/design", "POST", args));
tool("design_list", "List shared design sessions.", empty, async () => client.request("/api/v1/designs", "GET"));
tool("theme_get", "Read one shared design session.", { designId: z.string().uuid() }, async ({ designId }) => client.request(`/api/v1/design/${designId}`, "GET"));
tool("theme_patch", "Patch a design with optimistic baseRevision conflict protection.", { designId: z.string().uuid(), baseRevision: z.number().int().positive(), patch: z.record(z.unknown()), actor, patchId: z.string().uuid().optional() }, async ({ designId, ...body }) => client.request(`/api/v1/design/${designId}`, "PATCH", body));
tool("design_duplicate", "Duplicate a shared design.", { designId: z.string().uuid(), name: z.string().max(80).optional(), actor, patchId: z.string().uuid().optional() }, async ({ designId, ...body }) => client.request(`/api/v1/design/${designId}/duplicate`, "POST", body));
tool("design_rename", "Rename a design with revision protection.", { designId: z.string().uuid(), name: z.string().max(80), baseRevision: z.number().int().positive(), actor, patchId: z.string().uuid().optional() }, async ({ designId, ...body }) => client.request(`/api/v1/design/${designId}/rename`, "POST", body));
tool("design_delete", "Delete a non-applied design when another design remains.", { designId: z.string().uuid() }, async ({ designId }) => client.request(`/api/v1/design/${designId}`, "DELETE"));
tool("asset_upload", "Upload one bounded local PNG, JPEG, or WebP as base64 and receive its content-addressed asset id.", { mimeType: z.enum(["image/png", "image/jpeg", "image/webp"]), dataBase64: z.string().max(1024 * 1024) }, async (args) => client.request("/api/v1/assets", "POST", args));
tool("theme_validate", "Validate a structured ThemeSpec whitelist.", { theme: z.unknown() }, async (args) => client.request("/api/v1/theme/validate", "POST", args));
const previewReceipt = { previewSessionId: z.string().uuid(), previewGeneration: z.number().int().positive(), renderReceiptHash: z.string().regex(/^[0-9a-f]{64}$/) };
tool("theme_apply_plan", "Return a safe structured diff only after the exact isolated preview render receipt is live.", { ...designRevision, ...previewReceipt, target: z.object(target).optional(), installPlugin: z.boolean().optional() }, async (args) => client.request("/api/v1/theme/apply-plan", "POST", args));
tool("theme_restore_plan", "Return the immutable managed or official restore diff without confirming or mutating.", { ...designRevision, target: z.object(target).optional() }, async (args) => client.request("/api/v1/theme/restore-plan", "POST", args));
tool("preview_start", "Prepare a disposable Controller-owned isolated rc.6 DSH preview. It never targets the user's DSH profile.", { ...designRevision, target: z.object(target).optional() }, async (args) => client.request("/api/v1/preview/start", "POST", args));
tool("preview_session_create", "Create an isolated temporary DSH iframe preview session.", designRevision, async (args) => client.request("/api/v1/preview-sessions", "POST", args));
tool("preview_session_list", "List public state of disposable preview sessions (no token, PID, or home path).", empty, async () => client.request("/api/v1/preview-sessions", "GET"));
tool("preview_session_get", "Read one isolated preview session.", { sessionId: z.string().uuid() }, async ({ sessionId }) => client.request(`/api/v1/preview-sessions/${sessionId}`, "GET"));
tool("preview_session_update", "Update a disposable preview to a new shared revision; it returns to awaiting-render until the real Client receipt arrives.", { sessionId: z.string().uuid(), ...designRevision }, async ({ sessionId, ...body }) => client.request(`/api/v1/preview-sessions/${sessionId}`, "POST", body));
tool("preview_session_stop", "Stop and remove the disposable DSH preview runtime.", { sessionId: z.string().uuid() }, async ({ sessionId }) => client.request(`/api/v1/preview-sessions/${sessionId}`, "DELETE"));
tool("preview_snapshot", "Return the current revision snapshot for visual inspection.", designRevision, async (args) => client.request("/api/v1/preview/snapshot", "POST", args));
tool("preview_stop", "Stop the preview session.", empty, async () => client.request("/api/v1/preview/stop", "POST", {}));
tool("theme_apply", "Request apply after visible Studio confirmation. MCP cannot create or read confirmation material; it also requires a live exact isolated preview receipt and otherwise fails closed.", { ...designRevision, ...previewReceipt, planHash: z.string().regex(/^[0-9a-f]{64}$/), target: z.object(target).optional(), installPlugin: z.boolean().optional() }, async (args) => client.request("/api/v1/theme/apply", "POST", args));
tool("theme_restore", "Request restore after visible Studio confirmation. MCP cannot create or read confirmation material and an unconfirmed call fails closed.", { ...designRevision, planHash: z.string().regex(/^[0-9a-f]{64}$/), target: z.object(target).optional() }, async (args) => client.request("/api/v1/theme/restore", "POST", args));
tool("operation_status", "Read an asynchronous operation record.", { operationId: z.string().uuid() }, async ({ operationId }) => client.request(`/api/v1/operations/${operationId}`, "GET"));

await server.connect(new StdioServerTransport());

function tool(name: string, description: string, schema: z.ZodRawShape, run: (args: Record<string, any>) => Promise<unknown>): void {
  server.tool(name, description, schema, async (args) => {
    try {
      const value = await run(args);
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, result: value }, null, 2) }] };
    } catch (error) {
      const value = error as Error & { code?: string; status?: number; details?: unknown };
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error: { code: value.code || "MCP_ERROR", message: value.message, status: value.status, details: value.details } }, null, 2) }] };
    }
  });
}
