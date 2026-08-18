import { normalizePreviewSession, normalizeThemeSpec, type ApplyPlan, type ControllerPreviewSession, type DesignSession, type DshStatus, type OperationRecord, type PreviewReceiptBinding, type PreviewSession, type StudioEvent, type ThemeSpec } from "./model";

export class ApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number, readonly details?: unknown) {
    super(message);
  }
}

class StudioApi {
  private csrf = "";

  async status(): Promise<DshStatus> {
    const value = await this.request<DshStatus>("/api/v1/status");
    this.csrf = value.csrfToken;
    return value;
  }

  designs(): Promise<DesignSession[]> {
    return this.request<{ designs: DesignSession[] }>("/api/v1/designs").then((value) => value.designs.map(normalizeDesign));
  }

  design(id: string): Promise<DesignSession> {
    return this.request<DesignSession>(`/api/v1/design/${encodeURIComponent(id)}`).then(normalizeDesign);
  }

  createDesign(name?: string, theme?: ThemeSpec): Promise<DesignSession> {
    return this.request<DesignSession>("/api/v1/design", { method: "POST", body: { ...(name ? { name } : {}), ...(theme ? { theme } : {}) } }).then(normalizeDesign);
  }

  patchDesign(id: string, baseRevision: number, patch: Partial<ThemeSpec>, actor: "human" | "agent" | "system" = "human", patchId = crypto.randomUUID()): Promise<DesignSession> {
    return this.request<DesignSession>(`/api/v1/design/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { baseRevision, patch, actor, patchId }
    }).then(normalizeDesign);
  }

  duplicateDesign(id: string): Promise<DesignSession> {
    return this.request<DesignSession>(`/api/v1/design/${encodeURIComponent(id)}/duplicate`, { method: "POST", body: { actor: "human", patchId: crypto.randomUUID() } }).then(normalizeDesign);
  }

  renameDesign(id: string, name: string, baseRevision: number): Promise<DesignSession> {
    return this.request<DesignSession>(`/api/v1/design/${encodeURIComponent(id)}/rename`, { method: "POST", body: { name, baseRevision, actor: "human", patchId: crypto.randomUUID() } }).then(normalizeDesign);
  }

  deleteDesign(id: string): Promise<{ deleted: true }> {
    return this.request(`/api/v1/design/${encodeURIComponent(id)}`, { method: "DELETE", body: {} });
  }

  validate(theme: ThemeSpec): Promise<{ valid: true; theme: ThemeSpec; warnings?: string[] }> {
    return this.request("/api/v1/theme/validate", { method: "POST", body: { theme } });
  }

  async upload(file: File): Promise<{ assetId: string; mime: string; width: number; height: number; bytes: number; url?: string }> {
    const buffer = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
    return this.request<{ id: string; mimeType: string; width: number; height: number; bytes: number }>("/api/v1/assets", {
      method: "POST",
      body: { mimeType: file.type, dataBase64: btoa(binary) }
    }).then((value) => ({ assetId: value.id, mime: value.mimeType, width: value.width, height: value.height, bytes: value.bytes }));
  }

  assetUrl(assetId: string): string {
    return `/api/v1/assets/${encodeURIComponent(assetId)}`;
  }

  createPreviewSession(design: DesignSession): Promise<PreviewSession> {
    return this.request<ControllerPreviewSession | { session: ControllerPreviewSession }>("/api/v1/preview-sessions", {
      method: "POST",
      body: { designId: design.id, revision: design.revision }
    }).then((value) => normalizePreviewSession("session" in value ? value.session : value));
  }

  previewSession(sessionId: string): Promise<PreviewSession> {
    return this.request<ControllerPreviewSession | { session: ControllerPreviewSession }>(`/api/v1/preview-sessions/${encodeURIComponent(sessionId)}`)
      .then((value) => normalizePreviewSession("session" in value ? value.session : value));
  }

  deletePreviewSession(sessionId: string): Promise<PreviewSession> {
    return this.request<ControllerPreviewSession | { session: ControllerPreviewSession }>(`/api/v1/preview-sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE", body: {} })
      .then((value) => normalizePreviewSession("session" in value ? value.session : value));
  }

  applyPlan(design: DesignSession, installPlugin: boolean, preview: PreviewReceiptBinding): Promise<ApplyPlan> {
    return this.request("/api/v1/theme/apply-plan", { method: "POST", body: { designId: design.id, revision: design.revision, target: { profile: "web" }, installPlugin, ...preview } });
  }

  restorePlan(design: DesignSession): Promise<ApplyPlan> {
    return this.request("/api/v1/theme/restore-plan", { method: "POST", body: { designId: design.id, revision: design.revision, target: { profile: "web" } } });
  }

  confirmAndApply(design: DesignSession, installPlugin: boolean, planHash: string, preview: PreviewReceiptBinding): Promise<{ operation: OperationRecord; restartRequired: true; verificationRequired: true }> {
    return this.request("/api/v1/theme/confirm-and-apply", {
      method: "POST",
      body: {
        designId: design.id,
        revision: design.revision,
        planHash,
        target: { profile: "web" },
        installPlugin,
        ...preview
      }
    });
  }

  confirmAndRestore(design: DesignSession, planHash: string): Promise<{ operation: OperationRecord; restartRequired: true; verificationRequired: true; restores: string }> {
    return this.request("/api/v1/theme/confirm-and-restore", {
      method: "POST",
      body: {
        designId: design.id,
        revision: design.revision,
        planHash,
        target: { profile: "web" }
      }
    });
  }

  operation(id: string): Promise<OperationRecord> {
    return this.request(`/api/v1/operations/${encodeURIComponent(id)}`);
  }

  openStudio(): Promise<{ opened: boolean; url: string }> {
    return this.request("/api/v1/studio/open", { method: "POST", body: {} });
  }

  events(onEvent: (event: StudioEvent) => void): () => void {
    const source = new EventSource("/api/v1/events");
    const handler = (event: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(event.data) as StudioEvent & { session?: ControllerPreviewSession; previewSession?: ControllerPreviewSession };
        if (parsed.type === "preview.session.changed") {
          const raw = parsed.previewSession ?? parsed.session;
          if (raw) onEvent({ ...parsed, session: normalizePreviewSession(raw) });
          return;
        }
        onEvent(parsed);
      } catch { /* ignore malformed local event */ }
    };
    source.addEventListener("design", handler as EventListener);
    source.addEventListener("operation", handler as EventListener);
    source.addEventListener("preview.session.changed", handler as EventListener);
    source.onerror = () => onEvent({ type: "operation", state: "failed", detail: "EVENT_STREAM_DISCONNECTED" });
    return () => source.close();
  }

  private async request<T>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
    const method = options.method ?? "GET";
    const headers = new Headers({ accept: "application/json" });
    if (method !== "GET" && method !== "HEAD") {
      headers.set("content-type", "application/json");
      headers.set("x-dsh-skin-csrf", this.csrf);
    }
    let response: Response;
    try {
      response = await fetch(path, {
        method,
        headers,
        credentials: "same-origin",
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
      });
    } catch {
      throw new ApiError("LOCAL_SERVICE_UNAVAILABLE", "无法连接本地 Skin Studio 服务。请重新打开 Studio 后重试。", 0);
    }
    const payload = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string; details?: unknown } };
    if (!response.ok) throw new ApiError(payload.error?.code ?? "HTTP_ERROR", payload.error?.message ?? `HTTP ${response.status}`, response.status, payload.error?.details);
    return payload as T;
  }
}

function normalizeDesign(design: DesignSession): DesignSession {
  return { ...design, theme: normalizeThemeSpec(design.theme) };
}

export const api = new StudioApi();
