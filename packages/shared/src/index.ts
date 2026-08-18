export const API_VERSION = "v1" as const;
export const SUPPORTED_DSH_VERSION = "0.1.0-rc.6" as const;

export type OperationKind = "preview" | "apply" | "restore" | "plugin-install" | "plugin-uninstall";
export type OperationState = "queued" | "running" | "pending-restart" | "pending-verification" | "succeeded" | "failed" | "failed-safe";

export interface OperationRecord {
  id: string;
  kind: OperationKind;
  state: OperationState;
  createdAt: string;
  updatedAt: string;
  detail?: string;
  error?: { code: string; message: string };
  expected?: { profile: string; revision: number; hash: string; designId?: string; previousPluginInstanceId?: string };
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface CapabilityStatus {
  supportedVersion: string;
  detectedVersion: string | null;
  compatible: boolean;
  themeRuntime: {
    available: boolean;
    methods: string[];
    inspectProvider: string | null;
    inspectMethod: string | null;
  };
  injection: {
    available: boolean;
    mode: "static-plugin" | "unavailable";
    reason?: string;
  };
}

export interface ControllerStatus {
  ok: true;
  version: string;
  studioUrl: string;
  csrfToken: string;
  instanceId: string;
  capabilities: CapabilityStatus;
  dsh: DshRuntimeStatus;
  /** Controller-owned, disposable rc.6 instances used only by the Studio iframe. */
  previewSessions?: PreviewSessionStatus[];
}

export type PreviewSessionState = "provisioning" | "awaiting-host" | "awaiting-render" | "live" | "updating" | "stopping" | "stopped" | "expired" | "failed-safe";
export interface PreviewSessionStatus {
  id: string;
  designId: string;
  revision: number;
  hash: string;
  generation: number;
  state: PreviewSessionState;
  createdAt: string;
  expiresAt: string;
  /** Disposable loopback iframe origin; no home path, PID, or secret is exposed. */
  url?: string;
  operationId?: string;
  renderReceiptHash?: string;
  error?: { code: string; message: string };
}

export interface DesignSession<TTheme = unknown> {
  id: string;
  name: string;
  revision: number;
  theme: TTheme;
  createdAt: string;
  updatedAt: string;
}

export interface PatchDesignRequest<TTheme = unknown> {
  baseRevision: number;
  patch: Partial<TTheme>;
  actor?: "human" | "agent" | "system";
  patchId?: string;
}

export interface DesignChangedEvent {
  type: "design.changed";
  designId: string;
  revision: number;
  actor: "human" | "agent" | "system";
  patchId?: string;
}

export interface AssetRecord {
  id: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  bytes: number;
  width: number;
  height: number;
  createdAt: string;
}

export interface DshRuntimeStatus {
  detected: boolean;
  url: string | null;
  profile: string | null;
  pluginInstalled: boolean;
  pluginHealthy: boolean;
  pluginInstanceId?: string;
  activeMode?: "stable" | "preview";
  activeDesignId?: string;
  activeRevision?: number;
  activeHash?: string;
  preview: "live" | "degraded" | "studio-only";
  previewRevision?: number;
  previewHash?: string;
  previewDesignId?: string;
}

export const ERROR_CODES = {
  badRequest: "BAD_REQUEST",
  csrf: "CSRF_REQUIRED",
  forbiddenOrigin: "FORBIDDEN_ORIGIN",
  forbiddenHost: "FORBIDDEN_HOST",
  notFound: "NOT_FOUND",
  conflict: "REVISION_CONFLICT",
  validation: "THEME_VALIDATION_FAILED",
  confirmation: "USER_CONFIRMATION_REQUIRED",
  unsupported: "UNSUPPORTED_DSH_VERSION",
  unavailable: "CAPABILITY_UNAVAILABLE",
  internal: "INTERNAL_ERROR"
} as const;
