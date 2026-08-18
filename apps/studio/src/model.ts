import type { DesignSession as SharedDesignSession, OperationRecord } from "@dsh-skin/shared";
export type { OperationRecord } from "@dsh-skin/shared";

export type AppearanceMode = "light" | "dark" | "system";
/** The isolated preview lifecycle. It never describes the user's persistent DSH. */
export type PreviewState = "staging" | "live" | "updating" | "expired" | "error";

/** Exact public session shape emitted by the Controller. */
export interface ControllerPreviewSession {
  id: string;
  designId: string;
  revision: number;
  hash: string;
  generation: number;
  state: "provisioning" | "awaiting-host" | "awaiting-render" | "live" | "updating" | "stopping" | "stopped" | "expired" | "failed-safe";
  createdAt: string;
  expiresAt: string;
  url?: string;
  operationId?: string;
  renderReceiptHash?: string;
  error?: { code: string; message: string };
}

export interface PreviewSession {
  sessionId: string;
  state: PreviewState;
  generation: number;
  designId: string;
  revision: number;
  themeHash: string;
  renderReceiptHash?: string;
  /** Undefined while Controller is still provisioning the disposable DSH process. */
  previewUrl?: string;
  isolated: true;
  persistentTargetTouched: false;
  expiresAt: string;
}

export interface PreviewReceiptBinding {
  previewSessionId: string;
  previewGeneration: number;
  renderReceiptHash: string;
}

export function normalizePreviewSession(value: ControllerPreviewSession): PreviewSession {
  return {
    sessionId: value.id,
    state: normalizePreviewState(value.state),
    generation: value.generation,
    designId: value.designId,
    revision: value.revision,
    themeHash: value.hash,
    ...(value.renderReceiptHash ? { renderReceiptHash: value.renderReceiptHash } : {}),
    ...(value.url ? { previewUrl: value.url } : {}),
    isolated: true,
    persistentTargetTouched: false,
    expiresAt: value.expiresAt
  };
}

function normalizePreviewState(state: ControllerPreviewSession["state"]): PreviewState {
  if (state === "live") return "live";
  if (state === "updating") return "updating";
  if (state === "expired" || state === "stopped" || state === "stopping") return "expired";
  if (state === "failed-safe") return "error";
  return "staging";
}

export interface TokenModes {
  light: string;
  dark: string;
}

interface BackdropBase {
  opacity: number;
  blurPx: number;
}
export type BackdropSpec = BackdropBase & (
  | { kind: "solid" | "linear-gradient" | "radial-gradient"; colors: string[]; angle: number }
  | { kind: "image"; assetId: string; fit: "cover" | "contain" | "fill"; position: { xPercent: number; yPercent: number }; overlay: { color: string; opacity: number } }
);

export type BackgroundRegion = "sidebar" | "main";
type LegacyThemeSpec = Omit<ThemeSpec, "schemaVersion" | "appearance"> & {
  schemaVersion: 1;
  appearance: Omit<ThemeSpec["appearance"], "regions">;
};

export interface ThemeSpec {
  schemaVersion: 2;
  id: string;
  name: string;
  appearance: {
    base: "light" | "dark";
    /** A v1-compatible mirror of the main region. Never edit it independently. */
    backdrop: BackdropSpec;
    regions: {
      linked: boolean;
      divider: boolean;
      sidebar: BackdropSpec;
      main: BackdropSpec;
    };
    glass: { opacity: number; blurPx: number; radiusPx: number };
    tokens: Record<string, TokenModes>;
  };
}

export type DesignSession = SharedDesignSession<ThemeSpec> & {
  stableRevision?: number;
  lastActor?: string;
};

export interface DshStatus {
  ok: true;
  version: string;
  studioUrl: string;
  csrfToken: string;
  instanceId: string;
  capabilities: {
    supportedVersion: string;
    detectedVersion: string | null;
    compatible: boolean;
    themeRuntime: { available: boolean; methods: string[] };
    injection: { available: boolean; mode: "static-plugin" | "unavailable"; reason?: string };
  };
  dsh: {
    detected: boolean;
    url: string | null;
    profile: string | null;
    pluginInstalled: boolean;
    pluginHealthy: boolean;
    pluginInstanceId?: string;
    activeMode?: "stable" | "preview";
    activeRevision?: number;
    activeHash?: string;
    preview: "live" | "degraded" | "studio-only";
    previewDesignId?: string;
    previewRevision?: number;
    previewHash?: string;
  };
}

export interface ApplyPlan {
  action?: "restore";
  designId: string;
  revision: number;
  target: { profile: string };
  compatible: boolean;
  planHash: string;
  preview?: PreviewReceiptBinding;
  diff: Array<{ path: string; before: unknown; after: unknown }>;
  plugin?: { profile: string; version: string | null; compatible: boolean; changes: string[] };
  restores?: "managed" | "official";
  confirmationRequired: true;
  restartRequired: true;
}

export interface StudioEvent {
  type?: "design.changed" | "operation" | "preview.session.changed";
  designId?: string;
  revision?: number;
  actor?: string;
  patchId?: string;
  eventId?: number;
  operation?: OperationRecord;
  id?: string;
  kind?: OperationRecord["kind"];
  state?: OperationRecord["state"];
  detail?: string;
  error?: OperationRecord["error"];
  /** New isolated-preview events may be sent as either the payload or { session }. */
  session?: PreviewSession;
  previewSession?: PreviewSession;
  sessionId?: string;
  generation?: number;
  themeHash?: string;
  renderReceiptHash?: string;
  previewUrl?: string;
  isolated?: boolean;
  persistentTargetTouched?: boolean;
  expiresAt?: string;
}

export interface UiNotice {
  tone: "neutral" | "success" | "warning" | "danger";
  message: string;
}

export function cloneTheme(theme: ThemeSpec): ThemeSpec {
  return structuredClone(normalizeThemeSpec(theme));
}

/** Accept persisted v1 designs while always returning the canonical v2 shape. */
export function normalizeThemeSpec(theme: ThemeSpec | LegacyThemeSpec): ThemeSpec {
  if (theme.schemaVersion === 2 && "regions" in theme.appearance) {
    const main = theme.appearance.regions.main ?? theme.appearance.backdrop;
    const linked = Boolean(theme.appearance.regions.linked);
    const divider = Boolean(theme.appearance.regions.divider);
    return {
      ...theme,
      schemaVersion: 2,
      appearance: {
        ...theme.appearance,
        backdrop: main,
        regions: { linked, divider, main, sidebar: linked ? main : theme.appearance.regions.sidebar }
      }
    };
  }
  const legacy = theme as LegacyThemeSpec;
  return {
    ...legacy,
    schemaVersion: 2,
    appearance: {
      ...legacy.appearance,
      backdrop: legacy.appearance.backdrop,
      regions: { linked: true, divider: false, sidebar: legacy.appearance.backdrop, main: legacy.appearance.backdrop }
    }
  };
}

export function backdropForRegion(theme: ThemeSpec, region: BackgroundRegion): BackdropSpec {
  const normalized = normalizeThemeSpec(theme);
  return normalized.appearance.regions[normalized.appearance.regions.linked ? "main" : region];
}

export function setRegionBackdrop(theme: ThemeSpec, region: BackgroundRegion, backdrop: BackdropSpec): ThemeSpec {
  const current = normalizeThemeSpec(theme);
  const linked = current.appearance.regions.linked;
  const divider = current.appearance.regions.divider;
  const regions = linked
    ? { linked, divider, sidebar: backdrop, main: backdrop }
    : { ...current.appearance.regions, [region]: backdrop };
  return { ...current, appearance: { ...current.appearance, backdrop: regions.main, regions } };
}

export function setRegionsLinked(theme: ThemeSpec, linked: boolean): ThemeSpec {
  const current = normalizeThemeSpec(theme);
  const main = current.appearance.regions.main;
  const divider = current.appearance.regions.divider;
  const regions = linked
    ? { linked: true, divider, main, sidebar: main }
    : { ...current.appearance.regions, linked: false };
  return { ...current, appearance: { ...current.appearance, backdrop: regions.main, regions } };
}

/** Divider state is independent from whether two regions share one backdrop. */
export function setRegionsDivider(theme: ThemeSpec, divider: boolean): ThemeSpec {
  const current = normalizeThemeSpec(theme);
  const regions = { ...current.appearance.regions, divider };
  return { ...current, appearance: { ...current.appearance, backdrop: regions.main, regions } };
}

export function backgroundCss(theme: ThemeSpec, assetUrl?: string, region: BackgroundRegion = "main"): string {
  return backgroundCssForBackdrop(backdropForRegion(theme, region), assetUrl);
}

export function backgroundCssForBackdrop(bg: BackdropSpec, assetUrl?: string): string {
  if (bg.kind === "image" && assetUrl) {
    const overlay = bg.overlay.color;
    const strength = Math.max(0, Math.min(1, bg.overlay.opacity));
    return `linear-gradient(${hexToRgba(overlay, strength)}, ${hexToRgba(overlay, strength)}), url("${assetUrl}")`;
  }
  if (bg.kind === "linear-gradient") return `linear-gradient(${bg.angle}deg, ${bg.colors.join(", ")})`;
  if (bg.kind === "radial-gradient") return `radial-gradient(circle at center, ${bg.colors.join(", ")})`;
  return bg.kind === "image" ? "#151716" : bg.colors[0] ?? "#151716";
}

function hexToRgba(value: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) return `rgb(0 0 0 / ${alpha})`;
  const n = Number.parseInt(match[1]!, 16);
  return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${alpha})`;
}
