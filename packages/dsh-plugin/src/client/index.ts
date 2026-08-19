type TokenModes = { light: string; dark: string };
type ThemeRuntimeLike = {
  overrideTokens(source: string, tokens: Record<string, TokenModes>): () => void;
};
type ClientContextLike = {
  theme?: ThemeRuntimeLike;
  slots?: SlotsLike;
  get?(name: string): unknown;
  effect(setup: () => (() => void) | void, label?: string): void;
};

type SlotsLike = {
  inject(name: string, factory: () => unknown): unknown;
  register(options: Record<string, unknown>, component: (props: unknown) => unknown): unknown;
};
type ReactJsxRuntimeLike = {
  jsx(type: unknown, props: Record<string, unknown>): unknown;
  jsxs(type: unknown, props: Record<string, unknown>): unknown;
};

interface ThemePayload {
  schemaVersion: 1 | 2;
  appearance: {
    backdrop: ({ opacity: number; blurPx: number } & (
      | { kind: "solid" | "linear-gradient" | "radial-gradient"; colors: string[]; angle: number }
      | { kind: "image"; assetId: string; fit: "cover" | "contain" | "fill"; position: { xPercent: number; yPercent: number }; overlay: { color: string; opacity: number } }
    ));
    regions?: { linked: boolean; /** Defaults false for persisted pre-divider themes. */ divider?: boolean; sidebar: Backdrop; main: Backdrop };
    glass: { opacity: number; blurPx: number; radiusPx: number };
    tokens: Record<string, TokenModes>;
  };
}
type Backdrop = ThemePayload["appearance"]["backdrop"];

interface SkinState {
  mode: "stable" | "preview";
  theme: ThemePayload;
  designId: string;
  revision: number;
  hash: string;
  pluginInstanceId: string;
  sessionId?: string;
  generation?: number;
}

const SOURCE = "dsh-skin-studio";
const COLOR = /^(#[0-9a-f]{3,8}|rgba?\([0-9.,%\s]+\)|hsla?\([0-9.,%\s]+\)|transparent|currentColor)$/i;
const ASSET = /^sha256-[a-f0-9]{64}$/;
// rc.6's composited split layout can differ from a child edge by a small
// fractional CSS pixel at non-integer device scale. Accept a bounded
// rasterization tolerance that grows with the device pixel ratio; a
// structural gap still fails closed.
const REGIONAL_GEOMETRY_TOLERANCE_PX = Math.max(1, Math.ceil(window.devicePixelRatio || 1));
// These are the same capability-pinned rc.6 nodes used for regional
// discovery. Observing only them lets a session switch remount the backdrop
// immediately without treating ordinary chat-stream DOM updates as a skin
// refresh request.
const REGIONAL_LAYOUT_SELECTORS = [
  "div.pI_x6G_sidebarCol",
  "div.pI_x6G_frame",
  "div.pI_x6G_centerCol",
  "div.wSkVaW_heroWorkspaceRow",
  "div.wSkVaW_root",
  "div.hHd-Xa_root.hHd-Xa_quietBars",
  ".qDHVXG_fade"
] as const;
const REGIONAL_LAYOUT_DEBOUNCE_MS = 48;
const TOKEN_NAMES = new Set([
  "--dsw-alias-bg-base",
  "--dsw-alias-bg-layer-1",
  "--dsw-alias-bg-layer-2",
  "--dsw-alias-bg-layer-3",
  "--dsw-alias-bg-overlay",
  "--dsw-alias-border-l1",
  "--dsw-alias-border-l2",
  "--dsw-alias-border-l3",
  "--dsw-alias-brand-primary",
  "--dsw-alias-brand-text",
  "--dsw-alias-button-primary-fill",
  "--dsw-alias-button-primary-hover",
  "--dsw-alias-interactive-bg-active",
  "--dsw-alias-interactive-bg-hover",
  "--dsw-alias-label-caption",
  "--dsw-alias-label-dimmed",
  "--dsw-alias-label-primary",
  "--dsw-alias-label-secondary",
  "--dsw-alias-label-tertiary",
  "--dsw-alias-state-error-primary",
  "--dsw-alias-state-success-primary",
  "--dsw-alias-state-warn-primary",
  "--dsw-alias-tooltip-bg"
]);

// Cordis service-word injection is distinct from package-level
// `dsh.client.inject` module-graph dependencies in package.json.
export const inject = ["theme", "slots"] as const;

/**
 * DSH rc.6 browser half. All effects are owned by the Cordis fiber and are
 * disposed on stop/update. Theme input is structured and revalidated here;
 * no user CSS, selector, URL, or script crosses this boundary.
 */
export function apply(ctx: ClientContextLike): void {
  installSkinSettingsCard(ctx);
  installQuotaSettingsCard(ctx);
  const themeRuntime = ctx.theme ?? ctx.get?.("theme") as ThemeRuntimeLike | undefined;
  if (!themeRuntime?.overrideTokens || typeof ctx.effect !== "function") {
    document.documentElement.dataset.dshSkinStatus = "blocked";
    return;
  }

  const setup = () => {
    const clientInstanceId = crypto.randomUUID();
    let stopped = false;
    let signature = "";
    let parentOrigin = trustedParentOrigin();
    let lastRendered: SkinState | undefined;
    let disposeTokens: (() => void) | undefined;
    let backdropLayers: RegionalBackdrop | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let remountTimer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let refreshing = false;
    let refreshQueued = false;
    let refreshRequested = false;
    let remountAttempts = 0;
    let lastAckedSignature = "";
    let ackBackoffMs = 5_000;
    let ackRetryAt = 0;
    let refresh: () => Promise<void>;
    let remountCachedBackdrops: () => void;

    const schedulePollingRefresh = () => {
      if (stopped || timer !== undefined) return;
      // State polling is intentionally only a recovery/update channel. Route
      // remounts use the local snapshot, but Studio changes still need this
      // bounded check even when a remount was coalesced in the same turn.
      timer = setTimeout(() => {
        timer = undefined;
        void refresh();
      }, 1200);
    };

    const scheduleRegionalRemount = () => {
      if (stopped) return;
      if (refreshing) { refreshRequested = true; return; }
      if (refreshQueued) return;
      refreshQueued = true;
      remountTimer = setTimeout(() => {
        remountTimer = undefined;
        refreshQueued = false;
        remountCachedBackdrops();
      }, REGIONAL_LAYOUT_DEBOUNCE_MS);
    };
    const layoutObserver = new MutationObserver((records) => {
      if (records.some((record) => {
        if (record.type === "childList") return [...record.addedNodes, ...record.removedNodes].some((node) => isRegionalLayoutNode(node, backdropLayers));
        if (record.type === "attributes" && record.target instanceof Element) return isRegionalLayoutNode(record.target, backdropLayers);
        return false;
      })) scheduleRegionalRemount();
    });
    layoutObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-phase"], childList: true, subtree: true });

    const retryRegionalRemount = () => {
      if (stopped || refreshQueued) return;
      if (remountAttempts >= 6) { void refresh(); return; }
      remountAttempts += 1;
      refreshQueued = true;
      // A conversation route can attach its capability-pinned root over a
      // couple of animation frames. Retry locally first, rather than falling
      // straight through to the one-second network polling recovery path.
      remountTimer = setTimeout(() => {
        remountTimer = undefined;
        refreshQueued = false;
        remountCachedBackdrops();
      }, REGIONAL_LAYOUT_DEBOUNCE_MS / 2 * remountAttempts);
    };

    remountCachedBackdrops = () => {
      if (stopped) return;
      if (refreshing) { refreshRequested = true; return; }
      // The route change has not replaced a skin-owned target after all. Do
      // not pay for a render, state fetch, or image setup in that ordinary
      // chat-stream case.
      if (backdropLayers?.connected()) { remountAttempts = 0; return; }
      // On first hydration there is no verified in-memory snapshot yet, so
      // retain the normal state-load path. Every later session switch can
      // rebuild immediately from the immutable, already acknowledged state.
      if (!lastRendered) { void refresh(); return; }
      try {
        if (!backdropLayers?.rebind()) throw new Error("theme render targets are not rebindable");
        if (typeof disposeTokens !== "function" || !backdropLayers.connected()) throw new Error("theme render targets are not connected");
        remountAttempts = 0;
        document.documentElement.dataset.dshSkinStatus = lastRendered.mode === "preview" ? "preview" : "stable";
        delete document.documentElement.dataset.dshSkinError;
      } catch {
        try {
          // The route replaced the layout root instead of rebinding it. Rebuild
          // from the already acknowledged in-memory snapshot immediately,
          // rather than waiting for the next network polling round.
          disposeTokens?.();
          disposeTokens = themeRuntime.overrideTokens(SOURCE, buildTokenLayer(lastRendered.theme));
          backdropLayers?.dispose();
          backdropLayers = installRegionalBackdrops(lastRendered.theme, lastRendered, parentOrigin, clientInstanceId);
          if (typeof disposeTokens !== "function" || !backdropLayers.connected()) throw new Error("theme render targets are not connected");
          remountAttempts = 0;
          document.documentElement.dataset.dshSkinStatus = lastRendered.mode === "preview" ? "preview" : "stable";
          delete document.documentElement.dataset.dshSkinError;
        } catch {
          // The layout may still be settling. Keep the current snapshot and
          // retry it quickly; a full fetch remains the bounded fallback.
          retryRegionalRemount();
        }
      }
    };

    refresh = async () => {
      if (refreshing) { refreshRequested = true; return; }
      refreshing = true;
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch("/dsh-skin/state", { credentials: "same-origin", cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error(`state HTTP ${response.status}`);
        const state = validateState(await response.json() as unknown);
        const theme = state.theme;
        const nextSignature = `${state.hash}:${state.mode}:${state.designId ?? ""}:${state.revision ?? ""}`;
        // rc.6 continues hydrating/replacing parts of its layout after the
        // client module is first loaded. Re-attach the same immutable theme
        // when that swaps an owned region node; otherwise the old layer is
        // disconnected forever and no render receipt can be safely issued.
        if (nextSignature !== signature) {
          signature = nextSignature;
          disposeTokens?.();
          disposeTokens = themeRuntime.overrideTokens(SOURCE, buildTokenLayer(theme));
          backdropLayers?.dispose();
          backdropLayers = installRegionalBackdrops(theme, state, parentOrigin, clientInstanceId);
        } else if (!backdropLayers?.connected() && !backdropLayers?.rebind()) {
          disposeTokens?.();
          disposeTokens = themeRuntime.overrideTokens(SOURCE, buildTokenLayer(theme));
          backdropLayers?.dispose();
          backdropLayers = installRegionalBackdrops(theme, state, parentOrigin, clientInstanceId);
        }
        if (typeof disposeTokens !== "function" || !backdropLayers?.connected()) throw new Error("theme render targets are not connected");
        await nextPaint();
        // The render receipt is only meaningful when the acknowledged theme
        // changes. A stable page must not POST /dsh-skin/rendered on every
        // 1.2s poll — a persistently failing ack (stale page, host/controller
        // mismatch) would otherwise spam the console with failed fetches.
        // Failures back off exponentially (5s → 30s cap) while the
        // signature-change path stays immediate.
        const ackSignature = `${state.mode}:${state.designId}:${state.revision}:${state.hash}`;
        if (ackSignature !== lastAckedSignature && Date.now() >= ackRetryAt) {
          const rendered = await fetch("/dsh-skin/rendered", {
            method: "POST",
            credentials: "same-origin",
            cache: "no-store",
            signal: controller.signal,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ mode: state.mode, designId: state.designId, revision: state.revision, hash: state.hash, pluginInstanceId: state.pluginInstanceId, clientInstanceId, ...(state.sessionId ? { sessionId: state.sessionId, generation: state.generation } : {}) })
          });
          if (!rendered.ok) {
            ackBackoffMs = Math.min(ackBackoffMs * 2, 30_000);
            ackRetryAt = Date.now() + ackBackoffMs;
            throw new Error(`render ack HTTP ${rendered.status}`);
          }
          lastAckedSignature = ackSignature;
          ackBackoffMs = 5_000;
          ackRetryAt = 0;
        }
        lastRendered = state;
        notifyParent(state, clientInstanceId, parentOrigin);
        document.documentElement.dataset.dshSkinStatus = state.mode === "preview" ? "preview" : "stable";
        document.documentElement.dataset.dshSkinHash = state.hash;
        document.documentElement.dataset.dshSkinDesign = state.designId;
        document.documentElement.dataset.dshSkinRevision = String(state.revision);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          document.documentElement.dataset.dshSkinStatus = "degraded";
          // Keep the fail-closed preview diagnosable without exposing
          // controller data, bearer material, or a stack trace.
          document.documentElement.dataset.dshSkinError = error instanceof Error ? error.message.slice(0, 160) : "unknown-render-error";
        }
      } finally {
        refreshing = false;
        if (!stopped) {
          if (refreshRequested) { refreshRequested = false; scheduleRegionalRemount(); }
          schedulePollingRefresh();
        }
      }
    };
    const onParentHello = (event: MessageEvent) => {
      if (event.source !== window.parent || !event.data || event.data.type !== "dsh-skin-studio-parent-hello" || event.data.parentOrigin !== event.origin) return;
      const verified = loopbackOrigin(event.origin);
      if (!verified) return;
      parentOrigin = verified;
      if (lastRendered) notifyParent(lastRendered, clientInstanceId, parentOrigin);
    };
    addEventListener("message", onParentHello);
    const maskAccelerator = installConversationMaskAccelerator(() => {
      const theme = lastRendered?.theme;
      if (!theme) return null;
      const appearance = theme.appearance as { regions?: { main?: ThemePayload["appearance"]["backdrop"]; linked?: boolean }; backdrop: ThemePayload["appearance"]["backdrop"] };
      const main = appearance.regions?.main ?? appearance.backdrop;
      const linked = appearance.regions?.linked !== false;
      // Conversation mode is intentionally the configured 70% foreground
      // mask. The accelerator applies it synchronously with route intent so
      // the transition does not briefly paint the unmasked background first.
      return { value: alphaColor(contextMaskColor(main), 0.7), linked };
    });
    void refresh();
    return () => {
      stopped = true;
      removeEventListener("message", onParentHello);
      layoutObserver.disconnect();
      maskAccelerator.dispose();
      controller?.abort();
      if (timer !== undefined) clearTimeout(timer);
      if (remountTimer !== undefined) clearTimeout(remountTimer);
      disposeTokens?.();
      backdropLayers?.dispose();
      delete document.documentElement.dataset.dshSkinStatus;
      delete document.documentElement.dataset.dshSkinHash;
      delete document.documentElement.dataset.dshSkinDesign;
      delete document.documentElement.dataset.dshSkinRevision;
      delete document.documentElement.dataset.dshSkinError;
    };
  };

  ctx.effect(setup, "dsh-skin-studio: theme preview");
}

function validateState(input: unknown): SkinState {
  if (!input || typeof input !== "object") throw new Error("skin state is not an object");
  const state = input as Partial<SkinState>;
  if ((state.mode !== "stable" && state.mode !== "preview")
    || typeof state.hash !== "string" || !/^[0-9a-f]{64}$/.test(state.hash)
    || typeof state.designId !== "string" || state.designId.length < 1
    || !Number.isInteger(state.revision) || (state.revision as number) < 1
    || typeof state.pluginInstanceId !== "string" || !/^[0-9a-f-]{36}$/i.test(state.pluginInstanceId)
    || (state.sessionId !== undefined && (typeof state.sessionId !== "string" || !/^[0-9a-f-]{36}$/i.test(state.sessionId) || !Number.isInteger(state.generation) || state.generation! < 1))) {
    throw new Error("invalid skin state envelope");
  }
  return { ...state, theme: validateTheme(state.theme) } as SkinState;
}

function validateTheme(input: unknown): ThemePayload {
  if (!input || typeof input !== "object") throw new Error("theme is not an object");
  const root = input as Partial<ThemePayload>;
  const appearance = root.appearance;
  if ((root.schemaVersion !== 1 && root.schemaVersion !== 2) || !appearance || typeof appearance !== "object") throw new Error("unsupported theme schema");
  validateBackdrop(appearance.backdrop);
  if (root.schemaVersion === 2) {
    const regions = appearance.regions;
    if (!regions || typeof regions !== "object" || typeof regions.linked !== "boolean" || (regions.divider !== undefined && typeof regions.divider !== "boolean")) throw new Error("invalid regional backdrop settings");
    validateBackdrop(regions.sidebar);
    validateBackdrop(regions.main);
    if (regions.linked && (JSON.stringify(regions.sidebar) !== JSON.stringify(regions.main) || JSON.stringify(appearance.backdrop) !== JSON.stringify(regions.main))) throw new Error("linked regional backdrop is not canonical");
    if (!regions.linked && JSON.stringify(appearance.backdrop) !== JSON.stringify(regions.main)) throw new Error("v2 backdrop must mirror main region");
  }
  if (!appearance.glass || !finiteRange(appearance.glass.opacity, .2, 1) || !finiteRange(appearance.glass.blurPx, 0, 40)) throw new Error("invalid glass settings");
  if (!appearance.tokens || typeof appearance.tokens !== "object") throw new Error("invalid token map");
  for (const [name, value] of Object.entries(appearance.tokens)) {
    if (!TOKEN_NAMES.has(name) || !value || !COLOR.test(value.light) || !COLOR.test(value.dark)) throw new Error("invalid token override");
  }
  return root as ThemePayload;
}

function validateBackdrop(backdrop: unknown): asserts backdrop is Backdrop {
  if (!backdrop || typeof backdrop !== "object" || !["solid", "linear-gradient", "radial-gradient", "image"].includes((backdrop as { kind?: unknown }).kind as string)) throw new Error("invalid backdrop");
  const value = backdrop as Backdrop;
  if (value.kind === "image") {
    if (!ASSET.test(value.assetId) || !["cover", "contain", "fill"].includes(value.fit)
      || !finiteRange(value.position?.xPercent, 0, 100) || !finiteRange(value.position?.yPercent, 0, 100)
      || !COLOR.test(value.overlay?.color) || !finiteRange(value.overlay?.opacity, 0, 1)) throw new Error("invalid image backdrop");
  } else if (!Array.isArray(value.colors) || value.colors.length < 1 || value.colors.length > 4 || value.colors.some((color) => !COLOR.test(color))) throw new Error("invalid colors");
}

function buildTokenLayer(theme: ThemePayload): Record<string, TokenModes> {
  const result: Record<string, TokenModes> = { ...theme.appearance.tokens };
  const opacity = theme.appearance.glass.opacity;
  for (const [name, modes] of Object.entries(result)) {
    if (name.startsWith("--dsw-alias-bg-layer-") && opacity < 1) {
      result[name] = { light: alphaColor(modes.light, opacity), dark: alphaColor(modes.dark, opacity) };
    }
  }
  if (theme.appearance.backdrop.kind !== "solid") {
    result["--dsw-alias-bg-base"] = { light: "transparent", dark: "transparent" };
  }
  return result;
}

type RegionName = "sidebar" | "main";
type RegionTargets = Record<RegionName, HTMLElement> & { composite: HTMLElement; sidebarSurface: HTMLElement; sidebarFade?: HTMLElement };
type RegionDecoration = { element: HTMLDivElement; dispose(): void; rebind?(targets: RegionTargets): void };
type RegionLayer = { layer: HTMLDivElement; targets: HTMLElement[]; restore: () => void; rebind?(targets: RegionTargets): boolean; decorations?: RegionDecoration[] };
type RegionalBackdrop = { dispose(): void; connected(): boolean; rebind(): boolean; owns(node: Node): boolean };

/**
 * rc.6 capability-pinned discovery. The New Session and an opened
 * conversation use distinct, verified workspace anchors. The main surface is
 * intentionally derived from that anchor's split-layout ancestry, rather
 * than querying a generic div. Any layout drift fails before receipt.
 */
function discoverRegions(): RegionTargets {
  const sidebar = uniqueElement("div.pI_x6G_sidebarCol");
  // The hero row exists only on the New Session view. Opened conversations
  // expose the same rc.6 workspace through its unique root instead.
  const workspaceAnchor = uniqueElement("div.wSkVaW_heroWorkspaceRow") ?? uniqueElement("div.wSkVaW_root");
  const surface = sidebar && workspaceAnchor ? deriveMainSurface(sidebar, workspaceAnchor) : null;
  // The rc.6 sidebar ships one opaque content root inside the capability-pinned
  // column. It must be cleared together with its parent or it hides every
  // sidebar backdrop, including the single linked canvas.
  const sidebarSurface = sidebar ? uniqueWithin(sidebar, ":scope > div > div.hHd-Xa_root.hHd-Xa_quietBars") : null;
  // The rc.6 workspace browser also adds a 24px bottom fade that samples the
  // native sidebar fill. Leaving it enabled produces a black slab above the
  // settings action when a custom backdrop is active.
  // This element is mounted only when rc.6 has a workspace-list scroll body.
  // It is optional, but if the currently rendered tree contains more than one
  // such fade the capability is ambiguous and must still fail closed.
  const sidebarFade = sidebar ? optionalUniqueWithin(sidebar, ".qDHVXG_fade") : undefined;
  if (!sidebar || !surface || !sidebarSurface || sidebar === surface.main || surface.composite === sidebar || surface.composite === surface.main) {
    throw new Error("rc.6 regional DOM targets are unavailable or ambiguous");
  }
  return { sidebar, sidebarSurface, ...(sidebarFade ? { sidebarFade } : {}), ...surface };
}
function uniqueElement(selector: string): HTMLElement | null {
  const matches = [...document.querySelectorAll<HTMLElement>(selector)];
  return matches.length === 1 ? matches[0]! : null;
}
function uniqueWithin(root: HTMLElement, selector: string): HTMLElement | null {
  const matches = [...root.querySelectorAll<HTMLElement>(selector)];
  return matches.length === 1 ? matches[0]! : null;
}
function optionalUniqueWithin(root: HTMLElement, selector: string): HTMLElement | undefined {
  const matches = [...root.querySelectorAll<HTMLElement>(selector)];
  if (matches.length > 1) throw new Error("rc.6 optional regional DOM target is ambiguous");
  return matches[0];
}
function deriveMainSurface(sidebar: HTMLElement, workspaceAnchor: HTMLElement): Pick<RegionTargets, "main" | "composite"> | null {
  if (sidebar.contains(workspaceAnchor)) return null;
  let branch: HTMLElement = workspaceAnchor;
  while (branch.parentElement && branch.parentElement !== document.body) {
    const parent = branch.parentElement;
    // This is the first workspace branch immediately below the actual split
    // layout root which contains the separately verified sidebar column.
    if (parent.contains(sidebar)) {
      const mainBounds = branch.getBoundingClientRect();
      const sidebarBounds = sidebar.getBoundingClientRect();
      const compositeBounds = parent.getBoundingClientRect();
      const hasArea = mainBounds.width > 0 && mainBounds.height > 0 && sidebarBounds.width > 0 && sidebarBounds.height > 0 && compositeBounds.width > 0 && compositeBounds.height > 0;
      const spansBothRegions = compositeBounds.left - REGIONAL_GEOMETRY_TOLERANCE_PX <= Math.min(mainBounds.left, sidebarBounds.left)
        && compositeBounds.top - REGIONAL_GEOMETRY_TOLERANCE_PX <= Math.min(mainBounds.top, sidebarBounds.top)
        && compositeBounds.right + REGIONAL_GEOMETRY_TOLERANCE_PX >= Math.max(mainBounds.right, sidebarBounds.right)
        && compositeBounds.bottom + REGIONAL_GEOMETRY_TOLERANCE_PX >= Math.max(mainBounds.bottom, sidebarBounds.bottom);
      return hasArea && spansBothRegions ? { main: branch, composite: parent } : null;
    }
    branch = parent;
  }
  return null;
}

function installRegionalBackdrops(theme: ThemePayload, state: SkinState, parentOrigin: string | null, clientInstanceId: string): RegionalBackdrop {
  let targets = discoverRegions();
  // The persistent stylesheet is a page-load snapshot generated by the Host
  // from the active theme at index time. In preview mode the Controller can
  // PATCH the theme after load, so the snapshot's divider rules are stale:
  // skipping the DOM decoration just because the base exists would either
  // drop the divider entirely (snapshot had none) or double-paint it
  // (snapshot had one). Preview mode therefore always owns the divider in
  // the DOM and neutralizes the snapshot rule; stable mode keeps the
  // stylesheet-owned divider (the snapshot equals the applied theme there).
  const persistentOwnsDivider = persistentBaseActive() && state.mode !== "preview";
  let previewDividerNeutralizer: HTMLStyleElement | null = null;
  if (state.mode === "preview" && persistentBaseActive()) {
    previewDividerNeutralizer = document.createElement("style");
    previewDividerNeutralizer.dataset.dshSkinPreviewNeutralizer = "divider";
    previewDividerNeutralizer.textContent = "html body .pI_x6G_sidebarCol::after{content:none!important}";
    document.head.append(previewDividerNeutralizer);
  }
  // rc.6 mounts the settings portal inside the sidebar column.  The main
  // workspace composer is a sibling stacking context (z-index: 1), so a
  // fixed settings overlay with z-index: 1000 can still render underneath it
  // when the sidebar column remains at the default stacking level.  Promote
  // only the capability-pinned sidebar column; the backdrop remains below its
  // content and the style is restored on disposal/rebind.
  let restoreSidebarStacking = promoteSidebarStacking(targets.sidebar);
  const regions = theme.schemaVersion === 2 && theme.appearance.regions
    ? theme.appearance.regions
    : { linked: true, divider: false, sidebar: theme.appearance.backdrop, main: theme.appearance.backdrop };
  const sidebarOccluders = [targets.sidebarSurface, ...(targets.sidebarFade ? [targets.sidebarFade] : [])];
  // Linked mode is intentionally one physical layer on the rc.6 split-layout
  // root, rather than two identical `cover` layers. This keeps image sampling,
  // gradients, and resizing continuous across the sidebar/main boundary.
  const installed = regions.linked
    ? [installLinkedRegionLayer(targets, regions.main, regions.divider === true, persistentOwnsDivider)]
    : [
      ...(Object.keys({ sidebar: targets.sidebar, main: targets.main }) as RegionName[])
        .map((region) => installRegionLayer(targets[region], regions[region], region, region === "sidebar" ? sidebarOccluders : [], region === "sidebar" ? [targets.sidebarSurface] : [], targets.composite)),
      installSplitBoundary(targets, regions.sidebar, regions.main, regions.divider === true, persistentOwnsDivider)
    ];
  let conversationMask = installConversationMainMask(targets, regions, installed);
  let bridge = installRegionBridge({ sidebar: targets.sidebar, main: targets.main, composite: targets.composite }, state, parentOrigin, clientInstanceId, regions.linked);
  return {
    connected: () => conversationMask.connected()
      && targets.sidebar.isConnected
      && targets.main.isConnected
      && targets.composite.isConnected
      && targets.sidebarSurface.isConnected
      && (!targets.sidebarFade || targets.sidebarFade.isConnected)
      && installed.every(({ targets: layerTargets, layer, decorations }) => layerTargets.every((target) => target.isConnected) && layer.isConnected && (decorations?.every(({ element }) => element.isConnected) ?? true)),
    owns: (node) => [targets.sidebar, targets.main, targets.composite, targets.sidebarSurface, ...(targets.sidebarFade ? [targets.sidebarFade] : [])].includes(node as HTMLElement)
      || installed.some(({ layer, decorations }) => layer === node || (decorations?.some(({ element }) => element === node) ?? false)),
    rebind: () => {
      let next: RegionTargets;
      try { next = discoverRegions(); } catch { return false; }
      if (next.composite !== targets.composite || !installed.every((layer) => layer.rebind?.(next) ?? true)) return false;
      if (!conversationMask.rebind?.(next)) return false;
      bridge.dispose();
      bridge = installRegionBridge({ sidebar: next.sidebar, main: next.main, composite: next.composite }, state, parentOrigin, clientInstanceId, regions.linked);
      restoreSidebarStacking();
      restoreSidebarStacking = promoteSidebarStacking(next.sidebar);
      targets = next;
      return true;
    },
    dispose: () => { previewDividerNeutralizer?.remove(); bridge.dispose(); conversationMask.dispose(); installed.forEach(({ layer, restore, decorations }) => { decorations?.forEach(({ dispose }) => dispose()); layer.remove(); restore(); }); restoreSidebarStacking(); }
  };
}

/**
 * The real rc.6 ConversationRoot exposes its stable phase on the main surface:
 * `hero` is the New Session page and `active` is an opened conversation. Keep
 * the ThemeSpec immutable; this is a reversible runtime treatment of only the
 * main background, leaving the sidebar at its configured overlay strength.
 */
function installConversationMainMask(targets: RegionTargets, regions: { linked: boolean; sidebar: Backdrop; main: Backdrop }, installed: RegionLayer[]): { connected(): boolean; dispose(): void; rebind(next: RegionTargets): boolean } {
  let currentTargets = targets;
  const initialConversation = targets.main.matches("div.wSkVaW_root") ? targets.main : uniqueWithin(targets.main, "div.wSkVaW_root");
  if (!initialConversation) throw new Error("rc.6 ConversationRoot phase target is unavailable or ambiguous");
  let conversation: HTMLElement = initialConversation;
  let mainLayer = regions.linked ? undefined : installed.find(({ layer }) => layer.dataset.dshSkinStudioBackdrop === "main")?.layer;
  if (!regions.linked && !mainLayer) throw new Error("rc.6 main backdrop layer is unavailable for conversation masking");
  let priorMainBackgroundColor = saveProperties(targets.main, ["background-color"]);
  let priorMainMaskShadow = mainLayer ? saveProperties(mainLayer, ["box-shadow"]) : undefined;
  let priorMarker = conversation.getAttribute("data-dsh-skin-main-mask");
  let priorSurfaceMarker = targets.main.getAttribute("data-dsh-skin-main-mask-surface");
  let applied: boolean | undefined;
  const update = () => {
    const active = conversation.dataset.phase === "active";
    if (active === applied) return;
    applied = active;
    conversation.dataset.dshSkinMainMask = active ? "70" : "base";
    currentTargets.main.dataset.dshSkinMainMaskSurface = "1";
    // The persistent stylesheet owns the conversation mask (a live :has()
    // rule). Painting it inline here would block that rule with an
    // !important value captured during a stale route phase. Only fall back to
    // inline painting when the index seam is unavailable.
    if (persistentBaseActive()) return;
    if (regions.linked) {
      // A CSS background paints below the ConversationRoot's controls while
      // compositing over the shared canvas, so only the main region darkens.
      currentTargets.main.style.setProperty("background-color", active ? alphaColor(contextMaskColor(regions.main), .7) : "transparent", "important");
    } else if (mainLayer) {
      // Keep an independent image's background-image, position, and decoded
      // pixels intact while a conversation is opened. A zero-blur inset
      // shadow paints above this dedicated backdrop layer but beneath DSH's
      // foreground controls, so changing the phase only changes one simple
      // colour property instead of re-parsing and repainting the full image.
      mainLayer.style.setProperty("box-shadow", active ? `inset 0 0 0 9999px ${alphaColor(contextMaskColor(regions.main), .7)}` : "none", "important");
    }
  };
  update();
  let observer = new MutationObserver((records) => { if (records.some((record) => record.type === "attributes" && record.attributeName === "data-phase")) update(); });
  observer.observe(conversation, { attributes: true, attributeFilter: ["data-phase"] });
  return {
    connected: () => conversation.isConnected && currentTargets.main.isConnected && (mainLayer?.isConnected ?? true),
    rebind: (next: RegionTargets) => {
      const nextConversationCandidate = next.main.matches("div.wSkVaW_root") ? next.main : uniqueWithin(next.main, "div.wSkVaW_root");
      if (!nextConversationCandidate) return false;
      const nextConversation: HTMLElement = nextConversationCandidate;
      observer.disconnect();
      restoreProperties(currentTargets.main, priorMainBackgroundColor);
      if (priorMainMaskShadow && mainLayer) restoreProperties(mainLayer, priorMainMaskShadow);
      if (priorMarker === null) delete conversation.dataset.dshSkinMainMask;
      else conversation.setAttribute("data-dsh-skin-main-mask", priorMarker);
      if (priorSurfaceMarker === null) delete currentTargets.main.dataset.dshSkinMainMaskSurface;
      else currentTargets.main.setAttribute("data-dsh-skin-main-mask-surface", priorSurfaceMarker);
      currentTargets = next;
      conversation = nextConversation;
      mainLayer = regions.linked ? undefined : installed.find(({ layer }) => layer.dataset.dshSkinStudioBackdrop === "main")?.layer;
      if (!regions.linked && !mainLayer) return false;
      priorMainBackgroundColor = saveProperties(currentTargets.main, ["background-color"]);
      priorMainMaskShadow = mainLayer ? saveProperties(mainLayer, ["box-shadow"]) : undefined;
      priorMarker = conversation.getAttribute("data-dsh-skin-main-mask");
      priorSurfaceMarker = currentTargets.main.getAttribute("data-dsh-skin-main-mask-surface");
      applied = undefined;
      observer = new MutationObserver((records) => { if (records.some((record) => record.type === "attributes" && record.attributeName === "data-phase")) update(); });
      observer.observe(conversation, { attributes: true, attributeFilter: ["data-phase"] });
      update();
      return true;
    },
    dispose: () => {
      observer.disconnect();
      restoreProperties(currentTargets.main, priorMainBackgroundColor);
      if (priorMainMaskShadow) restoreProperties(mainLayer!, priorMainMaskShadow);
      if (priorMarker === null) delete conversation.dataset.dshSkinMainMask;
      else conversation.setAttribute("data-dsh-skin-main-mask", priorMarker);
      if (priorSurfaceMarker === null) delete currentTargets.main.dataset.dshSkinMainMaskSurface;
      else currentTargets.main.setAttribute("data-dsh-skin-main-mask-surface", priorSurfaceMarker);
    }
  };
}

function installRegionLayer(target: HTMLElement, backdrop: Backdrop, region: RegionName, occluders: HTMLElement[] = [], foregroundOccluders: HTMLElement[] = [], host: HTMLElement = target): RegionLayer {
  const layer = createBackdropLayer(backdrop, region);
  const affected = [...new Set([target, ...occluders])];
  const targetPriors = new Map<HTMLElement, Record<string, { value: string; priority: string }>>([[target, saveProperties(target, ["position", "isolation", "background"])] ]);
  const foreground = new Set(foregroundOccluders);
  const occluderPriors = occluders.map((element) => ({ element, prior: saveProperties(element, foreground.has(element) ? ["position", "z-index", "background"] : ["background"]) }));
  prepareBackdropTarget(target);
  for (const occluder of occluders) clearBackdropOccluder(occluder);
  for (const occluder of foregroundOccluders) prepareForegroundOccluder(occluder);
  host.prepend(layer);
  const updateGeometry = () => {
    const hostRect = host.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const blur = backdrop.blurPx;
    Object.assign(layer.style, {
      inset: "auto",
      left: `${targetRect.left - hostRect.left - blur * 2}px`,
      top: `${targetRect.top - hostRect.top - blur * 2}px`,
      width: `${targetRect.width + blur * 4}px`,
      height: `${targetRect.height + blur * 4}px`
    });
  };
  updateGeometry();
  const resizeObserver = new ResizeObserver(updateGeometry);
  resizeObserver.observe(host); resizeObserver.observe(target);
  addEventListener("resize", updateGeometry); addEventListener("scroll", updateGeometry, true);
  let currentTarget = target;
  return {
    layer,
    targets: affected,
    rebind: (next) => {
      const nextTarget = next[region];
      if (!nextTarget || next.composite !== host) return false;
      if (nextTarget !== currentTarget) {
        if (currentTarget.isConnected) restoreProperties(currentTarget, targetPriors.get(currentTarget)!);
        const prior = saveProperties(nextTarget, ["position", "isolation", "background"]);
        targetPriors.set(nextTarget, prior);
        prepareBackdropTarget(nextTarget);
        currentTarget = nextTarget;
      }
      updateGeometry();
      return true;
    },
    restore: () => { resizeObserver.disconnect(); removeEventListener("resize", updateGeometry); removeEventListener("scroll", updateGeometry, true); restoreProperties(currentTarget, targetPriors.get(currentTarget)!); targetPriors.forEach((prior, element) => { if (element !== currentTarget && element.isConnected) restoreProperties(element, prior); }); occluderPriors.forEach(({ element, prior }) => restoreProperties(element, prior)); }
  };
}

function installLinkedRegionLayer(targets: RegionTargets, backdrop: Backdrop, divider: boolean, persistentOwnsDivider: boolean): RegionLayer {
  const layer = createBackdropLayer(backdrop, "linked");
  // Store and restore every modified element. The composite root carries the
  // only layer; region panels are made transparent so their native backgrounds
  // cannot reintroduce a visible seam over that shared canvas.
  const canvasTargets = [targets.composite, targets.sidebar, targets.main];
  const occluders = [targets.sidebarSurface, targets.sidebarFade].filter((target): target is HTMLElement => Boolean(target));
  const affected = [...new Set([...canvasTargets, ...occluders])];
  const priors = new Map(canvasTargets.map((target) => [target, saveProperties(target, ["position", "isolation", "background"])] as const));
  const occluderPriors = occluders.map((target) => ({ target, prior: saveProperties(target, target === targets.sidebarSurface ? ["position", "z-index", "background"] : ["background"]) }));
  const sidebarBoundary = saveProperties(targets.sidebar, ["border-right-color"]);
  for (const target of canvasTargets) prepareBackdropTarget(target);
  for (const occluder of occluders) clearBackdropOccluder(occluder);
  prepareForegroundOccluder(targets.sidebarSurface);
  // The linked canvas owns the background. The optional divider is an
  // overlay-only visual affordance and therefore cannot split the canvas.
  targets.sidebar.style.setProperty("border-right-color", "transparent", "important");
  targets.composite.prepend(layer);
  // The persistent stylesheet owns the divider (a sidebar ::after rule) in
  // stable mode, so a route transition cannot detach it. Only paint the DOM
  // decoration when the stylesheet does not own it (no index seam, or a
  // preview whose snapshot rules are stale relative to the patched theme).
  const decoration = divider && !persistentOwnsDivider ? createBoundaryDecoration(targets, "divider", dividerBackground()) : undefined;
  let currentTargets = targets;
  return {
    layer,
    targets: affected,
    ...(decoration ? { decorations: [decoration] } : {}),
    rebind: (next) => {
      if (next.composite !== currentTargets.composite) return false;
      for (const target of [next.sidebar, next.main]) {
        if (target !== currentTargets.sidebar && target !== currentTargets.main) {
          priors.set(target, saveProperties(target, ["position", "isolation", "background"]));
          prepareBackdropTarget(target);
        }
      }
      if (next.sidebar !== currentTargets.sidebar) {
        priors.set(next.sidebar, priors.get(next.sidebar) ?? saveProperties(next.sidebar, ["position", "isolation", "background"]));
        next.sidebar.style.setProperty("border-right-color", "transparent", "important");
      }
      decoration?.rebind?.(next);
      currentTargets = next;
      return true;
    },
    restore: () => { priors.forEach((prior, target) => { if (target.isConnected) restoreProperties(target, prior); }); occluderPriors.forEach(({ target, prior }) => restoreProperties(target, prior)); restoreProperties(currentTargets.sidebar, sidebarBoundary); }
  };
}

/**
 * Split mode owns two physical backdrops. With the divider disabled, a
 * bounded soft transition layer blends their color edges instead of leaving a
 * hard native panel seam. With it enabled, the same boundary geometry draws a
 * crisp line. Neither branch accepts caller-supplied CSS.
 */
function installSplitBoundary(targets: RegionTargets, sidebar: Backdrop, main: Backdrop, divider: boolean, persistentOwnsDivider: boolean): RegionLayer {
  const compositePrior = saveProperties(targets.composite, ["position", "isolation"]);
  const sidebarBoundary = saveProperties(targets.sidebar, ["border-right-color"]);
  if (getComputedStyle(targets.composite).position === "static") targets.composite.style.setProperty("position", "relative");
  targets.composite.style.setProperty("isolation", "isolate");
  // Render one managed boundary layer in every split configuration. It avoids
  // a double native border and is fully restored when the mode changes.
  targets.sidebar.style.setProperty("border-right-color", "transparent", "important");
  // The persistent stylesheet owns the divider in stable mode; the DOM
  // decoration is kept only as a fallback there (or for the seamless blend,
  // which CSS cannot express). Preview mode always owns the boundary in the
  // DOM because the snapshot rules are stale after a PATCH.
  const decoration = (divider && persistentOwnsDivider) ? undefined : createBoundaryDecoration(targets, divider ? "divider" : "blend", divider ? dividerBackground() : splitBlendBackground(sidebar, main));
  if (!decoration) {
    const placeholder = document.createElement("div");
    placeholder.style.cssText = "position:absolute;width:0;height:0;pointer-events:none";
    targets.composite.append(placeholder);
    return { layer: placeholder, targets: [targets.composite, targets.sidebar, targets.main], rebind: () => true, restore: () => { placeholder.remove(); restoreProperties(targets.composite, compositePrior); restoreProperties(targets.sidebar, sidebarBoundary); } };
  }
  return {
    layer: decoration.element,
    targets: [targets.composite, targets.sidebar, targets.main],
    rebind: (next) => { if (next.composite !== targets.composite) return false; decoration.rebind?.(next); return true; },
    restore: () => { decoration.dispose(); restoreProperties(targets.composite, compositePrior); restoreProperties(targets.sidebar, sidebarBoundary); }
  };
}

function createBoundaryDecoration(targets: RegionTargets, kind: "divider" | "blend", background: string): RegionDecoration {
  const element = document.createElement("div");
  element.dataset.dshSkinStudioBoundary = kind;
  Object.assign(element.style, {
    position: "absolute",
    zIndex: kind === "divider" ? "2" : "1",
    pointerEvents: "none",
    background,
    ...(kind === "divider"
      ? { width: "1px", boxShadow: "0 0 9px rgb(89 192 255 / 36%)" }
      // A fully opaque cross-fade matches each physical region at its edge.
      // The old semi-transparent blur was additive over both layers and could
      // turn high-chroma colours into a bright, line-like glow.
      : { width: "72px", filter: "none", opacity: "1" })
  });
  let currentTargets = targets;
  const update = () => {
    const composite = currentTargets.composite.getBoundingClientRect();
    const sidebar = currentTargets.sidebar.getBoundingClientRect();
    const boundary = sidebar.right - composite.left;
    Object.assign(element.style, {
       left: `${kind === "divider" ? boundary - .5 : boundary - 36}px`,
      top: `${sidebar.top - composite.top}px`,
      height: `${sidebar.height}px`
    });
  };
  targets.composite.append(element); update();
  const observer = new ResizeObserver(update);
  observer.observe(targets.composite); observer.observe(targets.sidebar); observer.observe(targets.main);
  addEventListener("resize", update); addEventListener("scroll", update, true);
  return {
    element,
    rebind: (next) => { currentTargets = next; update(); },
    dispose: () => { observer.disconnect(); removeEventListener("resize", update); removeEventListener("scroll", update, true); element.remove(); }
  };
}

function dividerBackground(): string {
  return "linear-gradient(to bottom, transparent, rgb(230 248 255 / 62%) 10%, rgb(230 248 255 / 82%) 50%, rgb(230 248 255 / 62%) 90%, transparent)";
}

function splitBlendBackground(sidebar: Backdrop, main: Backdrop): string {
  // There is no reliable pixel sample for two independently cropped images.
  // Keep their no-divider edge visually neutral instead of inventing a bright
  // colour band; solid/gradient backdrops receive the real cross-fade below.
  if (sidebar.kind === "image" || main.kind === "image") return "transparent";
  const left = edgeColor(sidebar, "right"), right = edgeColor(main, "left");
  return `linear-gradient(90deg, ${left} 0%, color-mix(in srgb, ${left} 50%, ${right}) 50%, ${right} 100%)`;
}

function edgeColor(backdrop: Backdrop, edge: "left" | "right"): string {
  if (backdrop.kind === "image") return backdrop.overlay.color;
  if (backdrop.kind === "solid") return backdrop.colors[0]!;
  return edge === "left" ? backdrop.colors[0]! : backdrop.colors.at(-1)!;
}

function createBackdropLayer(backdrop: Backdrop, region: RegionName | "linked"): HTMLDivElement {
  const background = cssBackground(backdrop);
  const fit = backdrop.kind === "image" && backdrop.fit === "contain" ? "contain" : backdrop.kind === "image" && backdrop.fit === "fill" ? "100% 100%" : "cover";
  const repeat = "no-repeat";
  const x = clamp(backdrop.kind === "image" ? backdrop.position.xPercent : 50, 0, 100);
  const y = clamp(backdrop.kind === "image" ? backdrop.position.yPercent : 50, 0, 100);
  const blur = clamp(backdrop.blurPx, 0, 40);
  const opacity = clamp(backdrop.opacity, 0, 1);
  const layer = document.createElement("div");
  layer.dataset.dshSkinStudioBackdrop = region;
  Object.assign(layer.style, {
    position: "absolute",
    zIndex: "0",
    pointerEvents: "none",
    inset: `-${blur * 2}px`,
    background,
    backgroundPosition: `${x}% ${y}%`,
    backgroundSize: fit,
    backgroundRepeat: repeat,
    opacity: String(opacity),
    // Avoid a needless full-surface filter layer for the common zero-blur
    // image case. It otherwise makes route switches noticeably more costly
    // on integrated GPUs even though it has no visual effect.
    filter: blur > 0 ? `blur(${blur}px)` : "none",
    contain: "paint"
  });
  return layer;
}

function prepareBackdropTarget(target: HTMLElement): void {
  if (getComputedStyle(target).position === "static") target.style.setProperty("position", "relative");
  target.style.setProperty("isolation", "isolate");
  // The persistent stylesheet owns the panel transparency (and with it the
  // live :has() conversation mask). Painting an inline transparent here would
  // override the stylesheet with an !important value and block the mask.
  if (!persistentBaseActive()) target.style.setProperty("background", "transparent", "important");
}
function clearBackdropOccluder(target: HTMLElement): void {
  if (!persistentBaseActive()) target.style.setProperty("background", "transparent", "important");
}
function prepareForegroundOccluder(target: HTMLElement): void {
  // rc.6's sidebar content root holds all controls and labels. The backdrop
  // itself is an intentional z-index:0 paint layer, so this capability-pinned
  // content root must become the foreground stacking layer or an opaque image
  // will paint over the sidebar UI.
  if (getComputedStyle(target).position === "static") target.style.setProperty("position", "relative");
  target.style.setProperty("z-index", "1");
}

function promoteSidebarStacking(target: HTMLElement): () => void {
  const prior = saveProperties(target, ["z-index"]);
  target.style.setProperty("z-index", "2147483645");
  return () => restoreProperties(target, prior);
}

function cssBackground(backdrop: ThemePayload["appearance"]["backdrop"], contextMaskOpacity?: number): string {
  if (backdrop.kind === "image") {
    const overlay = COLOR.test(backdrop.overlay.color) ? backdrop.overlay.color : "#000000";
    const overlayAlpha = contextMaskOpacity === undefined ? clamp(backdrop.overlay.opacity, 0, 1) : clamp(contextMaskOpacity, 0, 1);
    return `linear-gradient(${alphaColor(overlay, overlayAlpha)}, ${alphaColor(overlay, overlayAlpha)}), url("/dsh-skin/assets/${backdrop.assetId}")`;
  }
  const base = backdrop.kind === "linear-gradient"
    ? `linear-gradient(${clamp(backdrop.angle, 0, 360)}deg, ${backdrop.colors.join(", ")})`
    : backdrop.kind === "radial-gradient" ? `radial-gradient(circle at center, ${backdrop.colors.join(", ")})` : backdrop.colors[0]!;
  return contextMaskOpacity === undefined ? base : `linear-gradient(${alphaColor(contextMaskColor(backdrop), clamp(contextMaskOpacity, 0, 1))}, ${alphaColor(contextMaskColor(backdrop), clamp(contextMaskOpacity, 0, 1))}), ${base}`;
}
function contextMaskColor(backdrop: Backdrop): string { return backdrop.kind === "image" && COLOR.test(backdrop.overlay.color) ? backdrop.overlay.color : "#000000"; }

function alphaColor(value: string, opacity: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) return value;
  const n = Number.parseInt(match[1]!, 16);
  return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${clamp(opacity, 0, 1)})`;
}
function finiteRange(value: unknown, min: number, max: number): value is number { return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max; }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, Number.isFinite(value) ? value : min)); }
function restoreProperty(element: HTMLElement, name: string, value: string, priority: string): void {
  if (value) element.style.setProperty(name, value, priority);
  else element.style.removeProperty(name);
}
function saveProperties(element: HTMLElement, names: string[]): Record<string, { value: string; priority: string }> {
  return Object.fromEntries(names.map((name) => [name, { value: element.style.getPropertyValue(name), priority: element.style.getPropertyPriority(name) }]));
}
function restoreProperties(element: HTMLElement, prior: Record<string, { value: string; priority: string }>): void {
  for (const [name, property] of Object.entries(prior)) restoreProperty(element, name, property.value, property.priority);
}

function installRegionBridge(targets: Record<RegionName, HTMLElement> & { composite: HTMLElement }, state: SkinState, parentOrigin: string | null, clientInstanceId: string, initiallyLinked: boolean): { dispose(): void } {
  // Bridge is available only to the embedded, loopback Studio preview. In a
  // normal DSH tab it creates neither overlays nor message channels.
  if (!parentOrigin || window.parent === window || state.mode !== "preview" || !state.sessionId || !state.generation) return { dispose() {} };
  let selected: RegionName | undefined;
  let selecting = false;
  // When selection is off, the overlay deliberately has pointer-events:none
  // so the designer can use the real DSH page.  A document-level observer
  // retains hover feedback in that state without ever becoming a click shield.
  let passiveHover: OverlayName | undefined;
  const cleanups: Array<() => void> = [];
  const emit = (type: "region-select" | "regions-linked", value: RegionName | boolean) => {
    window.parent.postMessage({
      type: "dsh-skin-region-bridge", event: type, value,
      sessionId: state.sessionId, generation: state.generation,
      designId: state.designId, revision: state.revision, hash: state.hash, clientInstanceId
    }, parentOrigin);
  };
  const decorate = (region: RegionName, active: boolean) => {
    const target = targets[region];
    target.classList.toggle("dsh-skin-region-hover", active);
    target.classList.toggle("dsh-skin-region-selected", selected === region);
  };
  // The DSH onboarding mask lives inside its own root and intentionally
  // intercepts the page. The bridge is an iframe-only, temporary document-body
  // layer above that root, so it can remain operable without changing or
  // dismissing the onboarding UI. It is pointer-inert until the user turns on
  // selection, leaving normal preview DSH interaction intact.
  type OverlayName = RegionName | "linked";
  type OverlaySpec = { name: OverlayName; target: HTMLElement; select: RegionName; affects: RegionName[]; label: string };
  const regionNames: RegionName[] = ["sidebar", "main"];
  // A linked backdrop is one canvas and one edit target. Present one complete
  // blue selection frame rather than two nearly adjacent outlines, which can
  // disappear against a unified background and incorrectly suggest a split.
  const specs: OverlaySpec[] = initiallyLinked
    ? [{ name: "linked", target: targets.composite, select: "main", affects: regionNames, label: "选择整合两区域皮肤" }]
    : regionNames.map((region) => ({ name: region, target: targets[region], select: region, affects: [region], label: `选择${region === "sidebar" ? "左侧栏" : "主工作区"}皮肤` }));
  const overlays = new Map<OverlayName, HTMLButtonElement>();
  const updateOverlayBounds = () => {
    for (const spec of specs) {
      const overlay = overlays.get(spec.name);
      if (!overlay) continue;
      const bounds = spec.target.getBoundingClientRect();
      Object.assign(overlay.style, { left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
    }
  };
  const setSelecting = (next: boolean) => {
    selecting = next;
    if (next) setPassiveHover(undefined);
    selectorButton.setAttribute("aria-pressed", String(next));
    selectorButton.textContent = next ? "结束选区" : "选择区域";
    for (const overlay of overlays.values()) { overlay.style.pointerEvents = next ? "auto" : "none"; overlay.tabIndex = next ? 0 : -1; }
    if (!next) for (const region of regionNames) decorate(region, false);
  };
  const setHoverPresentation = (spec: OverlaySpec, active: boolean) => {
    const overlay = overlays.get(spec.name);
    if (!overlay || selected === spec.select) return;
    overlay.style.borderStyle = "dashed";
    overlay.style.borderColor = active ? "#2494ff" : "transparent";
    overlay.style.background = active ? "rgb(36 148 255 / 7%)" : "transparent";
    overlay.style.boxShadow = active ? "inset 0 0 0 1px rgb(36 148 255 / 32%)" : "none";
    spec.affects.forEach((region) => decorate(region, active));
  };
  const setPassiveHover = (next: OverlayName | undefined) => {
    if (passiveHover === next) return;
    const prior = passiveHover ? specs.find((spec) => spec.name === passiveHover) : undefined;
    if (prior) setHoverPresentation(prior, false);
    passiveHover = next;
    const current = next ? specs.find((spec) => spec.name === next) : undefined;
    if (current) setHoverPresentation(current, true);
  };
  for (const spec of specs) {
    const overlay = document.createElement("button");
    overlay.type = "button"; overlay.tabIndex = -1; overlay.setAttribute("aria-label", spec.label);
    overlay.dataset.dshSkinRegionOverlay = spec.name;
    overlay.style.cssText = "position:fixed;z-index:2147483646;display:block;border:2px dashed transparent;background:transparent;box-shadow:none;outline:0;padding:0;margin:0;pointer-events:none;cursor:crosshair";
    const enter = () => setHoverPresentation(spec, true);
    const leave = () => setHoverPresentation(spec, false);
    const activate = () => { selected = spec.select; setPassiveHover(undefined); for (const name of regionNames) decorate(name, false); for (const [name, element] of overlays) { const active = name === spec.name; element.style.borderStyle = active ? "solid" : "dashed"; element.style.borderColor = active ? "#2494ff" : "transparent"; element.style.background = active ? "rgb(36 148 255 / 4%)" : "transparent"; element.style.boxShadow = active ? "inset 0 0 0 1px rgb(36 148 255 / 26%)" : "none"; } emit("region-select", spec.select); setSelecting(false); };
    overlay.addEventListener("pointerenter", enter); overlay.addEventListener("pointerleave", leave); overlay.addEventListener("click", activate);
    document.body.append(overlay); overlays.set(spec.name, overlay);
    cleanups.push(() => { overlay.removeEventListener("pointerenter", enter); overlay.removeEventListener("pointerleave", leave); overlay.removeEventListener("click", activate); overlay.remove(); spec.affects.forEach((region) => targets[region].classList.remove("dsh-skin-region-hover", "dsh-skin-region-selected")); });
  }
  const trackPassiveHover = (event: PointerEvent) => {
    // The active overlay owns its own pointer events.  In passive mode, use
    // coordinates only: this preserves all underlying DSH controls.
    if (selecting || selected) return;
    const match = specs.find((spec) => {
      const bounds = spec.target.getBoundingClientRect();
      return event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
    });
    setPassiveHover(match?.name);
  };
  document.addEventListener("pointermove", trackPassiveHover, true);
  const style = document.createElement("style");
  style.dataset.dshSkinRegionBridge = "1";
  style.textContent = ".dsh-skin-region-hover{outline:2px dashed #2494ff!important;outline-offset:-2px}.dsh-skin-region-selected{outline:2px solid #2494ff!important;outline-offset:-2px}";
  document.head.append(style);
  const toolbar = document.createElement("div");
  toolbar.dataset.dshSkinRegionToolbar = "1";
  toolbar.style.cssText = "position:fixed;top:13px;right:138px;z-index:2147483647;display:flex;align-items:center;gap:8px;padding:5px 9px;border:1px solid #397fb8;border-radius:6px;background:#11283ce8;color:#eaf6ff;font:12px sans-serif";
  const selectorButton = document.createElement("button");
  selectorButton.type = "button"; selectorButton.textContent = "选择区域"; selectorButton.setAttribute("aria-pressed", "false"); selectorButton.style.cssText = "border:1px solid #4c94cb;border-radius:4px;background:#173a56;color:#eaf6ff;padding:3px 6px;font:inherit;cursor:pointer";
  selectorButton.addEventListener("click", () => setSelecting(!selecting));
  const checkbox = document.createElement("label");
  checkbox.dataset.dshSkinRegionLink = "1";
  checkbox.style.cssText = "display:flex;align-items:center;gap:6px;cursor:pointer";
  const input = document.createElement("input"); input.type = "checkbox"; input.checked = initiallyLinked;
  checkbox.append(input, document.createTextNode("整合两区域")); toolbar.append(selectorButton, checkbox); document.body.append(toolbar); updateOverlayBounds();
  const resizeObserver = new ResizeObserver(updateOverlayBounds); for (const target of [targets.sidebar, targets.main, targets.composite]) resizeObserver.observe(target);
  addEventListener("resize", updateOverlayBounds); addEventListener("scroll", updateOverlayBounds, true);
  const changed = () => emit("regions-linked", input.checked);
  input.addEventListener("change", changed); cleanups.push(() => { input.removeEventListener("change", changed); document.removeEventListener("pointermove", trackPassiveHover, true); selectorButton.replaceWith(); resizeObserver.disconnect(); removeEventListener("resize", updateOverlayBounds); removeEventListener("scroll", updateOverlayBounds, true); toolbar.remove(); style.remove(); });
  // This is the Studio's disposable design surface: make the requested
  // hover-and-click region picker immediately available. The adjacent control
  // still lets a designer end selection and use the embedded DSH normally.
  setSelecting(true);
  return { dispose: () => cleanups.splice(0).forEach((cleanup) => cleanup()) };
}
function isRegionalLayoutNode(node: Node, owned?: RegionalBackdrop): boolean {
  if (!(node instanceof Element)) return false;
  if (owned?.owns(node)) return true;
  if (node.matches("[data-dsh-skin-studio-backdrop],[data-dsh-skin-studio-boundary]") || Boolean(node.querySelector("[data-dsh-skin-studio-backdrop],[data-dsh-skin-studio-boundary]"))) return true;
  return REGIONAL_LAYOUT_SELECTORS.some((selector) => node.matches(selector) || Boolean(node.querySelector(selector)));
}

/**
 * Shared balance state: one localStorage cache and one query helper so the
 * 额度查看 settings card paints the last known amount instantly and refreshes
 * in place. The API key never leaves the Host route.
 */
type BalanceValue = { currency: string; total: string; granted: string; toppedUp: string };
const BALANCE_STORAGE_KEY = "dsh-skin-balance:v1";
function readStoredBalance(): BalanceValue | null {
  try {
    const raw = localStorage.getItem(BALANCE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { value?: unknown };
    if (!parsed.value || typeof parsed.value !== "object") return null;
    const value = parsed.value as { currency?: unknown; total?: unknown; granted?: unknown; toppedUp?: unknown };
    if (typeof value.total !== "string") return null;
    return { currency: typeof value.currency === "string" ? value.currency : "CNY", total: value.total, granted: typeof value.granted === "string" ? value.granted : "0", toppedUp: typeof value.toppedUp === "string" ? value.toppedUp : "0" };
  } catch { return null; }
}
function writeStoredBalance(value: BalanceValue): void {
  try { localStorage.setItem(BALANCE_STORAGE_KEY, JSON.stringify({ value, at: Date.now() })); } catch { /* storage unavailable */ }
}
function balanceSymbol(currency: string): string { return currency === "CNY" ? "¥" : currency === "USD" ? "$" : `${currency} `; }
function formatBalance(value: string): string {
  const n = Number(value);
  return Number.isFinite(n) ? (Number.isInteger(n) ? String(n) : n.toFixed(2)) : value;
}
async function fetchBalanceValue(refresh: boolean, signal?: AbortSignal): Promise<BalanceValue | null> {
  try {
    const response = await fetch(`/dsh-skin/balance${refresh ? `?refresh=1&ts=${Date.now()}` : ""}`, { credentials: "same-origin", cache: "no-store", ...(signal ? { signal } : {}) });
    if (!response.ok) return null;
    const payload = await response.json() as { ok?: boolean; currency?: string; total?: string; granted?: string; toppedUp?: string };
    if (payload.ok !== true || typeof payload.total !== "string") return null;
    return { currency: typeof payload.currency === "string" ? payload.currency : "CNY", total: payload.total, granted: typeof payload.granted === "string" ? payload.granted : "0", toppedUp: typeof payload.toppedUp === "string" ? payload.toppedUp : "0" };
  } catch { return null; }
}
function persistentBaseActive(): boolean { return document.getElementById("dsh-skin-persistent") !== null; }

/**
 * Conversation-mask controller. The mask is entirely keyed on an explicit
 * client-held view state (`html[data-dsh-skin-view="conversation"]`), never
 * on the presence of the hero row — DSH can flash or rebuild the hero layout
 * during route transitions, which made any hero-row-based rule unreliable.
 * The view state is click-driven (conversation row opens a conversation, the
 * new-session/brand button returns to the hero) and pinned while a
 * conversation is opening, with a debounced hero-row observer as the
 * non-click fallback. Two injected rules make this authoritative: a baseline
 * "no mask" rule (higher specificity than the persistent stylesheet's
 * default) and a conversation rule (higher still) that carries the 70%
 * conversation mask. The active route phase is also part of the selector, so
 * a stale client-held view cannot darken the New Session hero after a switch.
 */
function installConversationMaskAccelerator(getMaskValue: () => { value: string; linked: boolean } | null): { dispose(): void } {
  if (!persistentBaseActive()) return { dispose() {} };
  const VIEW_ATTR = "data-dsh-skin-view";
  const DEBOUNCE_MS = 400;
  const ACTIVE_ROOT_SELECTOR = "div.wSkVaW_root[data-phase=active]";
  const HERO_SELECTOR = "div.wSkVaW_heroWorkspaceRow";
  const SESSION_SELECTOR = "div.YDXeBa_sessionRow, div.YDXeBa_projectRow";
  const NEW_SESSION_SELECTOR = "button.hHd-Xa_newSession, button.hHd-Xa_brand";
  let style: HTMLStyleElement | null = null;
  let observer: MutationObserver | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let pinned = false;
  let stopped = false;
  let view: "hero" | "conversation";
  const applyView = () => {
    if (stopped) return;
    if (view === "conversation") document.documentElement.setAttribute(VIEW_ATTR, "conversation");
    else document.documentElement.removeAttribute(VIEW_ATTR);
  };
  const setView = (next: "hero" | "conversation") => { if (view !== next) { view = next; applyView(); } };
  const clearDebounce = () => { if (debounceTimer !== undefined) { clearTimeout(debounceTimer); debounceTimer = undefined; } };
  const ensureStyle = () => {
    const mask = getMaskValue();
    if (!mask) return;
    const signature = `${mask.linked ? "linked" : "split"}:${mask.value}`;
    if (!style) {
      style = document.createElement("style");
      style.dataset.dshSkinView = "1";
      document.head.append(style);
    }
    if (style.dataset.dshSkinMask === signature) return;
    style.dataset.dshSkinMask = signature;
    style.textContent = mask.linked
      ? `html body #root .pI_x6G_centerCol{background-color:transparent!important}\nhtml[${VIEW_ATTR}="conversation"] body #root .pI_x6G_centerCol:has(${ACTIVE_ROOT_SELECTOR}){background-color:${mask.value}!important}`
      : `html body #root .pI_x6G_centerCol{box-shadow:none!important}\nhtml[${VIEW_ATTR}="conversation"] body #root .pI_x6G_centerCol:has(${ACTIVE_ROOT_SELECTOR}){box-shadow:inset 0 0 0 9999px ${mask.value}!important}\nhtml[${VIEW_ATTR}="conversation"] body #root:has(${ACTIVE_ROOT_SELECTOR}) [data-dsh-skin-studio-backdrop="main"]{box-shadow:inset 0 0 0 9999px ${mask.value}!important}`;
  };
  const activeConversationVisible = () => document.querySelector(ACTIVE_ROOT_SELECTOR) !== null;
  const heroVisible = () => document.querySelector(HERO_SELECTOR) !== null;
  const holdConversationUntilHeroSettles = () => {
    clearDebounce();
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      if (pinned && !activeConversationVisible() && heroVisible()) {
        pinned = false;
        setView("hero");
      }
    }, DEBOUNCE_MS);
  };
  const syncViewFromPhase = () => {
    if (stopped) return;
    if (activeConversationVisible()) {
      ensureStyle();
      clearDebounce();
      pinned = true;
      setView("conversation");
      return;
    }
    if (pinned) {
      holdConversationUntilHeroSettles();
      return;
    }
    setView(heroVisible() ? "hero" : "conversation");
  };
  // Use the route phase as the authoritative state. The active conversation
  // mask is applied before the conversation DOM paints, avoiding the brief
  // base-mask-to-dark-mask flash during a route switch.
  view = activeConversationVisible() || !heroVisible() ? "conversation" : "hero";
  applyView();
  const onNavigationIntent = (event: Event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest(SESSION_SELECTOR)) {
      ensureStyle();
      clearDebounce();
      pinned = true;
      setView("conversation");
      return;
    }
    if (target.closest(NEW_SESSION_SELECTOR)) {
      clearDebounce();
      pinned = false;
      setView("hero");
    }
  };
  // Observe both the phase and the route structure. Phase changes are handled
  // synchronously; structure churn is only used as a fallback and never
  // releases a pinned conversation view until the hero state is stable.
  observer = new MutationObserver((records) => {
    const phaseChanged = records.some((record) => record.type === "attributes" && record.attributeName === "data-phase");
    const layoutChanged = records.some((record) => record.type === "childList" && [...record.addedNodes, ...record.removedNodes].some((node) => node instanceof Element && (node.matches(HERO_SELECTOR) || node.matches("div.wSkVaW_root") || Boolean(node.querySelector(`${HERO_SELECTOR}, div.wSkVaW_root`)))));
    if (phaseChanged || layoutChanged) syncViewFromPhase();
  });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-phase"], childList: true, subtree: true });
  document.addEventListener("pointerdown", onNavigationIntent, true);
  document.addEventListener("click", onNavigationIntent, true);
  return {
    dispose: () => {
      stopped = true;
      observer?.disconnect();
      document.removeEventListener("pointerdown", onNavigationIntent, true);
      document.removeEventListener("click", onNavigationIntent, true);
      clearDebounce();
      document.documentElement.removeAttribute(VIEW_ATTR);
      style?.remove();
      style = null;
    }
  };
}

function installSkinSettingsCard(ctx: ClientContextLike): void {
  const slots = ctx.slots ?? ctx.get?.("slots") as SlotsLike | undefined;
  if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") return;
  let jsx: ReactJsxRuntimeLike;
  let react: { useState: <T>(init: T | (() => T)) => [T, (next: T) => void]; useEffect: (effect: () => void | (() => void), deps?: unknown[]) => void };
  try {
    // The rc.6 client-module wrapper supplies CommonJS `require` to this
    // self-contained factory. DSH's own settings plugins resolve these the
    // same way, so the lookup is reliable inside the loader.
    jsx = require("react/jsx-runtime") as ReactJsxRuntimeLike;
    react = require("react") as typeof react;
  } catch {
    return;
  }
  const card = (_props: unknown): unknown => {
    // Card must return a React element (the slots renderer mounts entries as
    // React children; a raw DOM node crashes with React error #31).
    const [version, setVersion] = ReactLikeState<string | VersionStatusPayload>("版本检测中…", react);
    const [updateError, setUpdateError] = ReactLikeState<string | null>(null, react);
    ReactLikeEffect(() => {
      let cancelled = false;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 15_000);
      fetch(`${location.origin}/dsh-skin/version`, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
        .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json() as Promise<VersionStatusPayload>; })
        .then((payload) => { if (cancelled) return; setVersion(describeVersion(payload)); })
        .catch(() => { if (!cancelled) setVersion("版本检查暂不可用"); })
        .finally(() => window.clearTimeout(timeout));
      return () => { cancelled = true; controller.abort(); };
    }, react);
    const openStudioStyle = { marginTop: "0", border: "0", borderRadius: "8px", padding: "7px 14px", display: "inline-block", color: "var(--dsw-alias-bg-layer-3)", background: "var(--dsw-alias-label-primary)", font: "inherit", cursor: "pointer", textDecoration: "none" };
    const cardStyle = { border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", borderRadius: "12px", listStyle: "none", padding: "16px" };
    const titleStyle = { color: "var(--dsw-alias-label-primary)", fontSize: "15px", fontWeight: 600, lineHeight: 1.4 };
    const descriptionStyle = { color: "var(--dsw-alias-label-tertiary)", fontSize: "13px", lineHeight: 1.5, marginTop: "4px" };
    const versionStyle = { display: "flex", alignItems: "center", gap: "10px", marginTop: "12px", color: "var(--dsw-alias-label-tertiary)", fontSize: "12px", lineHeight: 1.4 };
    const updateStyle = { marginTop: "0", border: "0", borderRadius: "8px", padding: "5px 12px", color: "#fff", background: "#b84e2c", font: "inherit", fontSize: "12px", fontWeight: "600", cursor: "pointer" };
    const needsUpdate = typeof version === "object" && version !== null && "latest" in version;
    const currentLabel = typeof version === "object" && version !== null ? `当前版本 v${(version as VersionStatusPayload).current ?? "?"}` : version;
    return jsx.jsxs("li", { style: cardStyle, "data-dsh-skin-settings-card": "1", children: [
      jsx.jsx("div", { style: titleStyle, children: "皮肤设置" }),
      jsx.jsx("div", { style: descriptionStyle, children: "打开本地 Skin Studio，实时设计并预览 DSH 皮肤。" }),
      jsx.jsx("div", { style: { display: "flex", gap: "10px", marginTop: "14px" }, children: [
        jsx.jsx("a", { href: "/dsh-skin/studio", target: "_blank", rel: "noopener noreferrer", style: openStudioStyle, children: "启动并打开 Skin Studio" })
      ] }),
      jsx.jsx("div", { style: versionStyle, "data-dsh-skin-version-row": "1", children: [
        jsx.jsx("span", { children: currentLabel }),
        needsUpdate ? jsx.jsx("button", { type: "button", style: updateStyle, onClick: () => { void runUpdateReact(setVersion, setUpdateError, react); }, children: updateError ?? "一键更新" }) : null
      ] })
    ] });
  };
  slots.inject("settings.plugin.item", () => slots.register({ name: "settings.plugin.item", id: "dsh-skin-studio", order: 30, label: "皮肤设置", registrant: "@dsh-skin/dsh-plugin" }, card));
}

interface QuotaDayView { date: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; reasoningTokens: number; cost: number; requests: number }
interface QuotaUsagePayload { ok?: boolean; month?: string; today?: QuotaDayView; monthTotal?: QuotaDayView; days?: QuotaDayView[]; estimated?: boolean; queriedAt?: string }
interface QuotaCell { date: string; day: number; usage: QuotaDayView | null; future: boolean }

function quotaTotalTokens(day: QuotaDayView | undefined): number {
  if (!day) return 0;
  return (day.inputTokens ?? 0) + (day.outputTokens ?? 0) + (day.cacheReadTokens ?? 0);
}
function quotaMonthKey(date?: Date): string {
  const value = date ?? new Date();
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}`;
}
function quotaDayKey(date?: Date): string {
  const value = date ?? new Date();
  return `${quotaMonthKey(value)}-${String(value.getDate()).padStart(2, "0")}`;
}
function quotaMonthLabel(key: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  return match ? `${match[1]}年${Number(match[2])}月` : key;
}
function quotaFormatTokens(value: number): string {
  const n = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  return n.toLocaleString("zh-CN");
}
function quotaFormatCost(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "¥0";
  if (value >= 100) return `¥${value.toFixed(2)}`;
  return `¥${value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
}
/** Monday-first calendar cells for one month; leading blanks align weekdays. */
function quotaMonthCells(month: string, days: QuotaDayView[] | undefined, todayKey: string): (QuotaCell | null)[] {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return [];
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return [];
  const leading = (new Date(year, monthIndex, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const byDate = new Map<string, QuotaDayView>();
  for (const day of days ?? []) if (day && typeof day.date === "string") byDate.set(day.date, day);
  const cells: (QuotaCell | null)[] = [];
  for (let i = 0; i < leading; i += 1) cells.push(null);
  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${month}-${String(day).padStart(2, "0")}`;
    cells.push({ date, day, usage: byDate.get(date) ?? null, future: date > todayKey });
  }
  return cells;
}

/**
 * 额度查看 settings card — the single balance/usage surface since the
 * composer chip and sidebar button were removed. Shows the current balance,
 * today's consumed quota (estimated ¥) and tokens, this month's tokens, and a
 * day grid (gray = no usage, blue = used; hover shows the day's quota/tokens).
 */
function installQuotaSettingsCard(ctx: ClientContextLike): void {
  const slots = ctx.slots ?? ctx.get?.("slots") as SlotsLike | undefined;
  if (!slots || typeof slots.inject !== "function" || typeof slots.register !== "function") return;
  let jsx: ReactJsxRuntimeLike;
  let react: {
    useState: <T>(init: T | (() => T)) => [T, (next: T | ((prev: T) => T)) => void];
    useEffect: (effect: () => void | (() => void), deps?: unknown[]) => void;
  };
  try {
    jsx = require("react/jsx-runtime") as ReactJsxRuntimeLike;
    react = require("react") as typeof react;
  } catch {
    return;
  }
  const card = (_props: unknown): unknown => {
    const [balance, setBalance] = react.useState<BalanceValue | null | undefined>(readStoredBalance());
    const [balanceFailed, setBalanceFailed] = react.useState(false);
    const [usage, setUsage] = react.useState<QuotaUsagePayload | null>(null);
    const [usageFailed, setUsageFailed] = react.useState(false);
    const [month, setMonth] = react.useState(quotaMonthKey());
    const [hover, setHover] = react.useState<{ x: number; y: number; cell: QuotaCell } | null>(null);
    const [refreshing, setRefreshing] = react.useState(false);
    const todayKey = quotaDayKey();
    const loadUsage = (targetMonth: string) => {
      setUsageFailed(false);
      fetch(`/dsh-skin/usage?month=${encodeURIComponent(targetMonth)}`, { credentials: "same-origin", cache: "no-store" })
        .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json() as Promise<QuotaUsagePayload>; })
        .then((payload) => { if (payload && payload.ok === true) setUsage(payload); else setUsageFailed(true); })
        .catch(() => setUsageFailed(true));
    };
    react.useEffect(() => {
      let cancelled = false;
      setUsage(null);
      setUsageFailed(false);
      fetch(`/dsh-skin/usage?month=${encodeURIComponent(month)}`, { credentials: "same-origin", cache: "no-store" })
        .then((response) => { if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json() as Promise<QuotaUsagePayload>; })
        .then((payload) => { if (cancelled) return; if (payload && payload.ok === true) setUsage(payload); else setUsageFailed(true); })
        .catch(() => { if (!cancelled) setUsageFailed(true); });
      return () => { cancelled = true; };
    }, [month]);
    react.useEffect(() => {
      let cancelled = false;
      fetchBalanceValue(false).then((value) => {
        if (cancelled) return;
        if (value) { setBalance(value); setBalanceFailed(false); writeStoredBalance(value); }
        else setBalanceFailed(true);
      });
      return () => { cancelled = true; };
    }, []);
    const refresh = () => {
      setRefreshing(true);
      fetchBalanceValue(true).then((value) => {
        if (value) { setBalance(value); setBalanceFailed(false); writeStoredBalance(value); }
        else setBalanceFailed(true);
      });
      loadUsage(month);
      window.setTimeout(() => setRefreshing(false), 600);
    };
    const changeMonth = (delta: number) => {
      setMonth((prev) => {
        const match = /^(\d{4})-(\d{2})$/.exec(prev);
        if (!match) return prev;
        const next = quotaMonthKey(new Date(Number(match[1]), Number(match[2]) - 1 + delta, 1));
        return next > quotaMonthKey() ? prev : next;
      });
    };
    const balanceValue = balance ?? null;
    const balanceText = balanceValue === null ? "查询失败" : `${balanceSymbol(balanceValue.currency)}${formatBalance(balanceValue.total)}`;
    const balanceDetail = balanceValue
      ? `已充值 ${balanceSymbol(balanceValue.currency)}${formatBalance(balanceValue.toppedUp)} · 赠送 ${balanceSymbol(balanceValue.currency)}${formatBalance(balanceValue.granted)}${balanceFailed ? " · 余额刷新失败" : ""}`
      : balanceFailed ? "余额查询失败，点击右上角刷新重试" : "正在查询余额…";
    const today = usage?.today;
    const monthTotal = usage?.monthTotal;
    const todayCost = today?.cost ?? 0;
    const todayTokens = quotaTotalTokens(today);
    const monthTokens = quotaTotalTokens(monthTotal);
    const cells = quotaMonthCells(month, usage?.days, todayKey);
    const monthHasUsage = (monthTotal?.requests ?? 0) > 0;
    const cardStyle = { border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-bg-layer-3)", borderRadius: "12px", listStyle: "none", padding: "16px" };
    const titleStyle = { color: "var(--dsw-alias-label-primary)", fontSize: "15px", fontWeight: 600, lineHeight: 1.4 };
    const descriptionStyle = { color: "var(--dsw-alias-label-tertiary)", fontSize: "13px", lineHeight: 1.5, marginTop: "4px" };
    const statBlock = (label: string, value: string) => jsx.jsxs("div", { style: { border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-bg-layer-2)", borderRadius: "10px", padding: "10px" }, children: [
      jsx.jsx("div", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "11px", lineHeight: 1.4 }, children: label }),
      jsx.jsx("div", { style: { color: "var(--dsw-alias-label-primary)", fontSize: "15px", fontWeight: 600, marginTop: "4px", fontVariantNumeric: "tabular-nums" }, children: value })
    ] });
    const monthNav = (label: string, delta: number) => jsx.jsx("button", {
      type: "button",
      onClick: () => changeMonth(delta),
      style: { border: "0", borderRadius: "6px", padding: "2px 8px", background: "transparent", color: "var(--dsw-alias-label-secondary)", font: "inherit", fontSize: "13px", lineHeight: 1.6, cursor: "pointer" },
      children: label
    });
    const legendItem = (color: string, label: string) => jsx.jsxs("span", { style: { display: "inline-flex", alignItems: "center", gap: "4px" }, children: [
      jsx.jsx("span", { style: { width: "10px", height: "10px", borderRadius: "3px", background: color, display: "inline-block" } }),
      jsx.jsx("span", { children: label })
    ] });
    return jsx.jsxs("li", { style: cardStyle, "data-dsh-skin-quota-card": "1", children: [
      jsx.jsxs("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between" }, children: [
        jsx.jsx("div", { style: titleStyle, children: "额度查看" }),
        jsx.jsx("button", { type: "button", onClick: refresh, style: { border: "0", borderRadius: "8px", padding: "5px 12px", color: "var(--dsw-alias-label-secondary)", background: "var(--dsw-alias-bg-layer-2)", font: "inherit", fontSize: "12px", cursor: "pointer" }, children: refreshing ? "刷新中…" : "刷新" })
      ] }),
      jsx.jsx("div", { style: { display: "flex", alignItems: "baseline", gap: "8px", marginTop: "12px" }, children: [
        jsx.jsx("span", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "12px" }, children: "当前余额" }),
        jsx.jsx("span", { style: { color: "var(--dsw-alias-label-primary)", fontSize: "22px", fontWeight: 700, fontVariantNumeric: "tabular-nums" }, children: balanceText })
      ] }),
      jsx.jsx("div", { style: descriptionStyle, children: balanceDetail }),
      jsx.jsxs("div", { style: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "8px", marginTop: "14px" }, children: [
        statBlock("今日消耗额度", quotaFormatCost(todayCost)),
        statBlock("今日消耗 Token", quotaFormatTokens(todayTokens)),
        statBlock("本月消耗 Token", quotaFormatTokens(monthTokens))
      ] }),
      jsx.jsxs("div", { style: { marginTop: "16px" }, children: [
        jsx.jsxs("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between" }, children: [
          jsx.jsx("div", { style: { color: "var(--dsw-alias-label-primary)", fontSize: "13px", fontWeight: 600 }, children: "本月消耗 Token" }),
          jsx.jsxs("div", { style: { display: "flex", alignItems: "center", gap: "2px" }, children: [
            monthNav("‹", -1),
            jsx.jsx("span", { style: { color: "var(--dsw-alias-label-secondary)", fontSize: "12px", minWidth: "78px", textAlign: "center", fontVariantNumeric: "tabular-nums" }, children: quotaMonthLabel(month) }),
            monthNav("›", 1)
          ] })
        ] }),
        jsx.jsxs("div", { style: { display: "flex", gap: "4px", marginTop: "10px" }, children: ["一", "二", "三", "四", "五", "六", "日"].map((weekday) => jsx.jsx("div", { style: { width: "26px", textAlign: "center", color: "var(--dsw-alias-label-caption)", fontSize: "11px", lineHeight: "20px" }, children: weekday })) }),
        usageFailed
          ? jsx.jsx("div", { style: { ...descriptionStyle, marginTop: "10px" }, children: "用量数据暂不可用（服务未就绪，可能需要重启 DSH）" })
          : usage === null
            ? jsx.jsx("div", { style: { ...descriptionStyle, marginTop: "10px" }, children: "正在加载用量数据…" })
            : jsx.jsxs("div", { style: { display: "flex", flexWrap: "wrap", gap: "4px", marginTop: "2px" }, children: cells.map((cell) => {
              if (!cell) return jsx.jsx("div", { style: { width: "26px", height: "26px" } });
              const used = cell.usage !== null;
              const cellStyle = used
                ? { background: "var(--dsw-alias-brand-primary, #2e7cf6)", color: "#fff" }
                : cell.future
                  ? { background: "transparent", color: "var(--dsw-alias-label-caption)", border: "1px dashed var(--dsw-alias-border-l1)" }
                  : { background: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,.18))", color: "var(--dsw-alias-label-tertiary)" };
              return jsx.jsx("div", {
                onMouseEnter: (event: { clientX: number; clientY: number }) => { if (!cell.future) setHover({ x: event.clientX, y: event.clientY, cell }); },
                onMouseMove: (event: { clientX: number; clientY: number }) => { if (hover && hover.cell.date === cell.date) setHover({ x: event.clientX, y: event.clientY, cell }); },
                onMouseLeave: () => setHover((prev) => (prev && prev.cell.date === cell.date ? null : prev)),
                style: { width: "26px", height: "26px", borderRadius: "7px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "11px", lineHeight: 1, cursor: cell.future ? "default" : "pointer", fontVariantNumeric: "tabular-nums", ...cellStyle },
                children: cell.day
              });
            }) }),
        monthHasUsage
          ? jsx.jsxs("div", { style: { display: "flex", alignItems: "center", gap: "10px", marginTop: "10px", color: "var(--dsw-alias-label-caption)", fontSize: "11px", lineHeight: 1.5 }, children: [
            legendItem("var(--dsw-alias-bg-layer-2, rgba(128,128,128,.18))", "无消耗"),
            legendItem("var(--dsw-alias-brand-primary, #2e7cf6)", "有消耗"),
            jsx.jsx("span", { children: "悬停查看当日详情 · 额度为按模型单价估算" })
          ] })
          : null
      ] }),
      hover ? jsx.jsx("div", {
        style: {
          position: "fixed",
          left: Math.max(8, Math.min(hover.x + 14, window.innerWidth - 260)),
          top: Math.max(8, Math.min(hover.y + 16, window.innerHeight - 130)),
          zIndex: 9999,
          pointerEvents: "none",
          background: "var(--dsw-alias-tooltip-bg, rgba(24,24,27,.95))",
          color: "var(--dsw-alias-label-primary)",
          borderRadius: "10px",
          padding: "8px 12px",
          fontSize: "12px",
          lineHeight: 1.6,
          boxShadow: "0 6px 24px rgba(0,0,0,.28)",
          whiteSpace: "nowrap"
        },
        children: [
          jsx.jsx("div", { style: { fontWeight: 600 }, children: `${quotaMonthLabel(hover.cell.date.slice(0, 7))}${Number(hover.cell.date.slice(8, 10))}日` }),
          hover.cell.usage
            ? jsx.jsxs("div", { children: [
                jsx.jsx("div", { children: `额度 ${quotaFormatCost(hover.cell.usage.cost)}` }),
                jsx.jsx("div", { children: `Token ${quotaFormatTokens(quotaTotalTokens(hover.cell.usage))}` }),
                jsx.jsx("div", { style: { color: "var(--dsw-alias-label-tertiary)", fontSize: "11px" }, children: `请求 ${hover.cell.usage.requests} 次 · 输入 ${quotaFormatTokens(hover.cell.usage.inputTokens)} / 输出 ${quotaFormatTokens(hover.cell.usage.outputTokens)}` })
              ] })
            : jsx.jsx("div", { children: "当日无消耗" })
        ]
      }) : null
    ] });
  };
  slots.inject("settings.plugin.item", () => slots.register({ name: "settings.plugin.item", id: "dsh-skin-quota", order: 20, label: "额度查看", registrant: "@dsh-skin/dsh-plugin" }, card));
}

function ReactLikeState<T>(initial: T, react: { useState: <S>(init: S | (() => S)) => [S, (next: S) => void] }): [T, (next: T) => void] {
  return react.useState(initial);
}
function ReactLikeEffect(effect: () => void | (() => void), react: { useEffect: (fn: () => void | (() => void), deps?: unknown[]) => void }): void {
  react.useEffect(effect, []);
}
function describeVersion(payload: VersionStatusPayload): string | VersionStatusPayload {
  if (payload.updateAvailable && payload.latest) return payload;
  return `当前版本 v${payload.current ?? "?"}${payload.error ? " · 版本检查暂不可用" : " · 已是最新"}`;
}
async function runUpdateReact(setVersion: (v: string | VersionStatusPayload) => void, setUpdateError: (e: string | null) => void, react: { useState: <S>(init: S | (() => S)) => [S, (next: S) => void] }): Promise<void> {
  void react;
  setUpdateError("正在下载更新…");
  try {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 180_000);
    let response: Response;
    try {
      response = await fetch(`${location.origin}/dsh-skin/update`, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "content-type": "application/json" }, body: "{}", signal: controller.signal });
    } finally {
      window.clearTimeout(timeout);
    }
    const payload = await response.json().catch(() => ({})) as { ok?: boolean; updatedTo?: string; error?: { code?: string; message?: string } };
    if (!response.ok || payload.ok !== true) {
      setUpdateError(`更新失败：${payload.error?.message ?? `HTTP ${response.status}`} · 点击重试`);
      return;
    }
    setVersion(`已更新到 v${payload.updatedTo ?? ""}；请重启 DSH 后生效`);
    setUpdateError(null);
  } catch (error) {
    setUpdateError(`更新失败：${error instanceof Error ? error.message : "网络错误"} · 点击重试`);
  }
}

interface VersionStatusPayload {
  ok?: boolean;
  current?: string;
  latest?: string;
  updateAvailable?: boolean;
  releaseUrl?: string;
  error?: { code?: string; message?: string };
}
function nextPaint(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}
function notifyParent(state: SkinState, clientInstanceId: string, parentOrigin: string | null): void {
  if (window.parent === window || !parentOrigin) return;
  window.parent.postMessage({ type: "dsh-skin-rendered", mode: state.mode, designId: state.designId, revision: state.revision, hash: state.hash, pluginInstanceId: state.pluginInstanceId, clientInstanceId, ...(state.sessionId ? { sessionId: state.sessionId, generation: state.generation } : {}) }, parentOrigin);
}
function trustedParentOrigin(): string | null {
  if (window.parent === window) return null;
  const ancestor = location.ancestorOrigins?.length ? location.ancestorOrigins[0] : undefined;
  return loopbackOrigin(ancestor) ?? loopbackOrigin(document.referrer);
}
function loopbackOrigin(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const target = new URL(value);
    if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(target.hostname)) return null;
    return target.origin;
  } catch { return null; }
}
