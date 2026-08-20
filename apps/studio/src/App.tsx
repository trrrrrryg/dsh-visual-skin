import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";
import type { AppearanceMode, ApplyPlan, BackgroundRegion, DesignSession, DshStatus, OperationRecord, PreviewReceiptBinding, PreviewSession, PreviewState, StudioEvent, ThemeSpec, UiNotice } from "./model";
import { cloneTheme, setRegionBackdrop, setRegionsDivider, setRegionsLinked } from "./model";
import { TopBar } from "./components/TopBar";
import { ThemeLibrary } from "./components/ThemeLibrary";
import { PreviewWorkbench } from "./components/PreviewWorkbench";
import { Inspector, type ThemeChangePhase } from "./components/Inspector";
import { StatusBar } from "./components/StatusBar";
import { ApplyDialog, ConflictDialog } from "./components/Dialogs";
import { LayersIcon, SlidersIcon } from "./components/Icons";

type ApplyAction = "apply" | "restore";
type PersistJob = { designId: string; theme: ThemeSpec; label: string; draftVersion: number };
const PREVIEW_DEBOUNCE_MS = 220;
const PERSIST_DEBOUNCE_MS = 220;
// Do not expose a persistent-write affordance while the warm preview is in
// its automatic renewal window. The old receipt may still look live in React
// for one event-loop turn, but the Controller can already be preparing its
// replacement generation.
const PREVIEW_RENEWAL_LEAD_MS = 30_000;

export function App() {
  const [status, setStatus] = useState<DshStatus | null>(null);
  const [designs, setDesigns] = useState<DesignSession[]>([]);
  const [design, setDesign] = useState<DesignSession | null>(null);
  const [mode, setMode] = useState<AppearanceMode>("system");
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<PreviewState>("staging");
  const [previewSession, setPreviewSession] = useState<PreviewSession | null>(null);
  const [verifiedPreview, setVerifiedPreview] = useState<PreviewSession | null>(null);
  const [notice, setNotice] = useState<UiNotice>({ tone: "neutral", message: "正在连接温隔离预览…" });
  const [history, setHistory] = useState<ThemeSpec[]>([]);
  const [future, setFuture] = useState<ThemeSpec[]>([]);
  const [conflictMine, setConflictMine] = useState<ThemeSpec | null>(null);
  const [conflictLatest, setConflictLatest] = useState<DesignSession | null>(null);
  const [applyAction, setApplyAction] = useState<ApplyAction | null>(null);
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyResult, setApplyResult] = useState<"idle" | "pending" | "success" | "failed">("idle");
  const [applyError, setApplyError] = useState<string>();
  const [applyPlan, setApplyPlan] = useState<ApplyPlan | null>(null);
  const [applyPlanLoading, setApplyPlanLoading] = useState(false);
  const [activeOperation, setActiveOperation] = useState<OperationRecord | null>(null);
  const [themeDrawer, setThemeDrawer] = useState(false);
  const [inspectorDrawer, setInspectorDrawer] = useState(false);
  const [mobileTab, setMobileTab] = useState<"themes" | "preview" | "inspector">("preview");
  const [selectedRegion, setSelectedRegion] = useState<BackgroundRegion>("main");
  const serverRef = useRef<DesignSession | null>(null);
  const draftRef = useRef<ThemeSpec | null>(null);
  const saveChain = useRef(Promise.resolve());
  const persistTimer = useRef<number | undefined>();
  const pendingPersist = useRef<PersistJob | null>(null);
  const persistInFlight = useRef(0);
  const draftVersion = useRef(0);
  const continuousEdit = useRef(false);
  const previewRefreshPending = useRef(false);
  const pendingPatchIds = useRef(new Set<string>());
  const previewRequest = useRef(0);
  const previewTimer = useRef<number | undefined>();
  const previewRenewalTimer = useRef<number | undefined>();
  const queuedPreview = useRef<DesignSession | null>(null);
  const previewInFlight = useRef(false);
  const activePreviewRef = useRef<PreviewSession | null>(null);
  const verifiedPreviewRef = useRef<PreviewSession | null>(null);
  const activeOperationId = useRef<string | null>(null);
  const applyActionRef = useRef<ApplyAction | null>(null);
  const applyPlanRef = useRef<ApplyPlan | null>(null);

  const invalidatePlan = useCallback((reason = "隔离预览已更新，当前写入计划已失效。请等待新的实时预览完成后重新确认。") => {
    // Once a visible plan has been returned, keep it on screen while the
    // EventSource catches up. The confirm path performs the authoritative
    // receipt comparison and will refresh the plan if a genuinely newer
    // generation arrives; clearing it here creates the false red state seen
    // when a duplicate live acknowledgement follows a successful 200.
    if (applyActionRef.current !== null && applyPlanRef.current !== null) return;
    applyPlanRef.current = null;
    setApplyPlan(null);
    // A late `awaiting-render`/`live` event can arrive while the first plan
    // request is still in flight.  It is part of the same preview handshake,
    // not evidence that the plan POST failed; avoid leaving a stale red error
    // behind a successful 200 response.
    if (applyAction && applyResult === "idle" && !applyPlanLoading && applyPlan !== null) setApplyError(reason);
  }, [applyAction, applyPlan, applyPlanLoading, applyResult]);
  const replaceDesign = useCallback((next: DesignSession) => {
    if (previewTimer.current !== undefined) {
      clearTimeout(previewTimer.current);
      previewTimer.current = undefined;
    }
    if (previewRenewalTimer.current !== undefined) {
      clearTimeout(previewRenewalTimer.current);
      previewRenewalTimer.current = undefined;
    }
    if (persistTimer.current !== undefined) {
      clearTimeout(persistTimer.current);
      persistTimer.current = undefined;
    }
    pendingPersist.current = null;
    continuousEdit.current = false;
    previewRefreshPending.current = false;
    queuedPreview.current = null;
    previewRequest.current += 1;
    serverRef.current = next; draftRef.current = cloneTheme(next.theme); setDesign(next);
    setDesigns((items) => (items.some((item) => item.id === next.id) ? items.map((item) => item.id === next.id ? next : item) : [next, ...items]).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)));
    localStorage.setItem("dsh-skin-current-design", next.id);
  }, []);
  const discardPreview = useCallback((session: PreviewSession | null | undefined) => { if (session) void api.deletePreviewSession(session.sessionId).catch(() => undefined); }, []);
  const safePreviewUrl = useCallback((url: string) => {
    try { const parsed = new URL(url); return parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost"); }
    catch { return false; }
  }, []);
  const exactEvidence = useCallback((session: PreviewSession | null, current = serverRef.current) => Boolean(
    session && current && session.isolated === true && session.persistentTargetTouched === false && session.state === "live" &&
    session.designId === current.id && session.revision === current.revision && /^[0-9a-f]{64}$/i.test(session.themeHash) &&
    /^[0-9a-f]{64}$/i.test(session.renderReceiptHash ?? "") && Boolean(session.previewUrl) && safePreviewUrl(session.previewUrl!)
  ), [safePreviewUrl]);

  const acceptSession = useCallback((next: PreviewSession) => {
    const active = activePreviewRef.current;
    const current = serverRef.current;
    if (!active || !current || !samePreviewIdentity(active, next) || next.generation < active.generation) return;
    if (next.isolated !== true || next.persistentTargetTouched !== false || (next.previewUrl && !safePreviewUrl(next.previewUrl)) || (next.state === "live" && !next.previewUrl)) {
      setPreview("error"); setNotice({ tone: "danger", message: "Controller 返回的预览不是隔离保护的本地地址，已拒绝加载。" }); return;
    }
    if (next.designId !== current.id || next.revision !== current.revision || !/^[0-9a-f]{64}$/i.test(next.themeHash)) return;
    // EventSource may resend the same live receipt (for example after a
    // reconnect). Only a material evidence change may invalidate a plan the
    // user is already reviewing; treating a duplicate as new made the dialog
    // incorrectly report that a freshly-rendered preview was stale.
    const evidenceChanged = active.generation !== next.generation || active.state !== next.state || active.designId !== next.designId || active.revision !== next.revision || active.themeHash !== next.themeHash || active.renderReceiptHash !== next.renderReceiptHash;
    const planForEvent = applyPlanRef.current;
    const planStillBound = Boolean(planForEvent?.preview && planForEvent.preview.previewSessionId === next.sessionId && planForEvent.preview.previewGeneration === next.generation && planForEvent.preview.renderReceiptHash === next.renderReceiptHash);
    activePreviewRef.current = next; setPreviewSession(next);
    if (evidenceChanged && !planStillBound) invalidatePlan();
    if (exactEvidence(next)) {
      const prior = verifiedPreviewRef.current;
      verifiedPreviewRef.current = next; setVerifiedPreview(next); setPreview("live");
      setNotice({ tone: "success", message: `温隔离预览已确认草稿 r${next.revision}；尚未写入我的 DSH。` });
      if (prior && !samePreviewIdentity(prior, next)) discardPreview(prior);
      return;
    }
    if (next.state === "staging" || next.state === "updating") {
      setPreview(next.state);
      setNotice({ tone: "neutral", message: next.state === "updating" ? "正在复用温隔离预览；继续保留上一帧已确认画面。" : "正在准备温隔离预览；不会写入我的 DSH。" });
    } else {
      setPreview(next.state === "expired" ? "expired" : "error");
      setNotice({ tone: next.state === "expired" ? "warning" : "danger", message: next.state === "expired" ? "隔离预览已过期，请重新连接。" : "隔离预览未完成，上一帧已确认预览保持不变。" });
    }
  }, [applyPlan, discardPreview, exactEvidence, invalidatePlan, safePreviewUrl]);

  const startPreview = useCallback(async (requested?: DesignSession) => {
    const current = requested ?? serverRef.current;
    if (!current) return;
    if (previewInFlight.current) {
      queuedPreview.current = current;
      return;
    }
    previewInFlight.current = true;
    const request = ++previewRequest.current;
    const prior = activePreviewRef.current;
    setPreview(verifiedPreviewRef.current ? "updating" : "staging");
    setNotice({ tone: "neutral", message: `正在复用温隔离预览来渲染草稿 r${current.revision}；不会写入我的 DSH。` });
    // Opening the confirmation dialog can itself trigger a just-in-time
    // receipt renewal. That internal refresh must not paint the dialog red
    // before its first plan request has completed.
    if (applyActionRef.current === null) invalidatePlan();
    try {
      const created = await api.createPreviewSession(current);
      if (request !== previewRequest.current) return;
      if (created.isolated !== true || created.persistentTargetTouched !== false || (created.previewUrl && !safePreviewUrl(created.previewUrl)) || created.designId !== current.id || created.revision !== current.revision || !Number.isInteger(created.generation) || !/^[0-9a-f]{64}$/i.test(created.themeHash)) {
        discardPreview(created); throw new Error("Controller 返回的隔离预览凭据与当前草稿不一致");
      }
      activePreviewRef.current = created; setPreviewSession(created);
      if (prior && !samePreviewIdentity(prior, created) && !samePreviewIdentity(prior, verifiedPreviewRef.current)) discardPreview(prior);
      acceptSession(created);
    } catch (error) {
      if (request !== previewRequest.current) return;
      setPreview("error");
      setNotice({ tone: error instanceof ApiError && error.code === "CAPABILITY_UNAVAILABLE" ? "warning" : "danger", message: error instanceof Error ? error.message : "无法创建隔离预览" });
    } finally {
      previewInFlight.current = false;
      const queued = queuedPreview.current;
      queuedPreview.current = null;
      if (queued && (queued.id !== current.id || queued.revision !== current.revision)) window.setTimeout(() => void startPreview(queued), 0);
    }
  }, [acceptSession, discardPreview, invalidatePlan, safePreviewUrl]);

  const schedulePreview = useCallback((requested?: DesignSession, delay = PREVIEW_DEBOUNCE_MS) => {
    const current = requested ?? serverRef.current;
    if (!current) return;
    queuedPreview.current = current;
    if (previewTimer.current !== undefined) clearTimeout(previewTimer.current);
    setPreview(verifiedPreviewRef.current ? "updating" : "staging");
    setNotice({ tone: "neutral", message: `草稿即时画布已更新；${delay ? "正在合并温隔离预览刷新" : "正在刷新温隔离预览"}。` });
    invalidatePlan();
    previewTimer.current = window.setTimeout(() => {
      previewTimer.current = undefined;
      const latest = queuedPreview.current;
      queuedPreview.current = null;
      if (latest) void startPreview(latest);
    }, delay);
  }, [invalidatePlan, startPreview]);

  const resyncSelectedDesign = useCallback(async (source: "event" | "focus") => {
    const current = serverRef.current;
    if (!current) return;
    const designId = current.id;
    try {
      const latest = await api.design(designId);
      if (serverRef.current?.id !== designId) return;
      if (latest.revision > current.revision) {
        const hasLocalDraft = Boolean(
          persistInFlight.current || pendingPersist.current || persistTimer.current !== undefined ||
          (draftRef.current && !sameTheme(draftRef.current, current.theme))
        );
        if (hasLocalDraft) {
          if (persistTimer.current !== undefined) clearTimeout(persistTimer.current);
          persistTimer.current = undefined;
          pendingPersist.current = null;
          previewRefreshPending.current = false;
          continuousEdit.current = false;
          const mine = cloneTheme(draftRef.current ?? current.theme);
          serverRef.current = latest;
          setSaving(Boolean(persistInFlight.current));
          setDesigns((items) => items.map((item) => item.id === latest.id ? latest : item));
          setDesign((shown) => shown?.id === latest.id ? { ...latest, theme: mine } : shown);
          setConflictMine(mine);
          setConflictLatest(latest);
          invalidatePlan("设计已在其他位置更新，当前写入计划已失效。");
          setNotice({ tone: "warning", message: `检测到更高版本 r${latest.revision}；本地未提交修改已保留，等待你选择处理方式。` });
        } else {
          replaceDesign(latest);
          invalidatePlan("设计已在其他位置更新，当前写入计划已失效。请等待新的隔离预览完成。");
          setNotice({ tone: "success", message: `${source === "event" ? "其他操作" : "页面恢复"}已同步草稿 r${latest.revision}；正在刷新隔离预览。` });
          schedulePreview(latest, 0);
        }
      }
      const knownSessions = [...new Map([activePreviewRef.current, verifiedPreviewRef.current].filter(Boolean).map((session) => [session!.sessionId, session!])).values()];
      await Promise.all(knownSessions.map(async (session) => {
        const refreshed = await api.previewSession(session.sessionId).catch(() => null);
        if (refreshed && serverRef.current?.id === designId && refreshed.generation >= session.generation) acceptSession(refreshed);
      }));
    } catch {
      // The existing preview remains safe to inspect while the local service reconnects.
    }
  }, [acceptSession, invalidatePlan, replaceDesign, schedulePreview]);

  const bootstrap = useCallback(async () => {
    try {
      setPreview("staging"); const nextStatus = await api.status(); setStatus(nextStatus);
      let library: DesignSession[] = [];
      try { library = await api.designs(); } catch (error) { if (!(error instanceof ApiError) || error.status !== 404) throw error; }
      const remembered = localStorage.getItem("dsh-skin-current-design");
      let selected = library.find((item) => item.id === remembered) ?? library[0];
      if (!selected && remembered) { try { selected = await api.design(remembered); } catch { /* stale local selection */ } }
      selected ??= await api.createDesign("数字装帧 · 初始主题");
      setDesigns(library.length ? library : [selected]); replaceDesign(selected); schedulePreview(selected, 0);
    } catch (error) { setPreview("error"); setNotice({ tone: "danger", message: error instanceof Error ? error.message : "Controller 连接失败" }); }
  }, [replaceDesign, schedulePreview]);

  useEffect(() => { void bootstrap(); }, [bootstrap]);
  useEffect(() => () => {
    previewRequest.current += 1;
    if (previewTimer.current !== undefined) clearTimeout(previewTimer.current);
    previewTimer.current = undefined;
    if (previewRenewalTimer.current !== undefined) clearTimeout(previewRenewalTimer.current);
    previewRenewalTimer.current = undefined;
    queuedPreview.current = null;
    discardPreview(activePreviewRef.current);
    if (!sameSession(verifiedPreviewRef.current, activePreviewRef.current)) discardPreview(verifiedPreviewRef.current);
  }, [discardPreview]);
  useEffect(() => {
    if (!previewSession || previewSession.state === "expired" || previewSession.state === "error" || applyAction !== null) return;
    const renewIn = Math.max(1_000, Date.parse(previewSession.expiresAt) - Date.now() - PREVIEW_RENEWAL_LEAD_MS);
    const timer = window.setTimeout(() => {
      if (previewRenewalTimer.current === timer) previewRenewalTimer.current = undefined;
      if (applyActionRef.current !== null) return;
      schedulePreview(serverRef.current ?? undefined, 0);
    }, renewIn);
    previewRenewalTimer.current = timer;
    return () => {
      clearTimeout(timer);
      if (previewRenewalTimer.current === timer) previewRenewalTimer.current = undefined;
    };
  }, [applyAction, previewSession, schedulePreview]);
  useEffect(() => api.events((event) => {
    if (event.detail === "EVENT_STREAM_CONNECTED") { void resyncSelectedDesign("event"); return; }
    if (event.detail === "EVENT_STREAM_DISCONNECTED") { setNotice({ tone: "warning", message: "Controller 事件连接已断开；最后确认的隔离预览仍在显示。" }); return; }
    const changed = previewFromEvent(event, activePreviewRef.current);
    if (changed) { acceptSession(changed); return; }
    if (event.patchId && pendingPatchIds.current.has(event.patchId)) return;
    if (event.id) {
      setActiveOperation((current) => event.id === current?.id ? event as OperationRecord : current);
      if (event.id === activeOperationId.current) {
        if (event.state === "succeeded") setApplyResult("success");
        else if (event.state === "failed" || event.state === "failed-safe") { setApplyResult("failed"); setApplyError(event.error?.message ?? "事务验证失败"); }
      }
    }
    if (event.type === "design.changed" && event.designId === serverRef.current?.id && (event.revision ?? 0) > (serverRef.current?.revision ?? 0)) {
      void resyncSelectedDesign("event");
    }
    if (event.state === "failed") setNotice({ tone: "danger", message: event.error?.message ?? "本地操作失败" });
  }), [acceptSession, resyncSelectedDesign]);
  useEffect(() => {
    const resync = () => void resyncSelectedDesign("focus");
    const onVisibility = () => { if (document.visibilityState === "visible") resync(); };
    addEventListener("focus", resync);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      removeEventListener("focus", resync);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [resyncSelectedDesign]);
  useEffect(() => { document.documentElement.dataset.theme = mode === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : mode; }, [mode]);

  const syncSaving = useCallback(() => {
    setSaving(Boolean(persistInFlight.current || pendingPersist.current || persistTimer.current !== undefined));
  }, []);
  const flushPersistence = useCallback((): Promise<void> => {
    if (persistTimer.current !== undefined) {
      clearTimeout(persistTimer.current);
      persistTimer.current = undefined;
    }
    const job = pendingPersist.current;
    pendingPersist.current = null;
    if (!job) {
      syncSaving();
      return saveChain.current;
    }
    persistInFlight.current += 1;
    syncSaving();
    saveChain.current = saveChain.current.then(async () => {
      const base = serverRef.current;
      if (!base || base.id !== job.designId) return;
      const patchId = crypto.randomUUID();
      pendingPatchIds.current.add(patchId);
      try {
        const updated = await api.patchDesign(base.id, base.revision, job.theme, "human", patchId);
        // The user may have selected another design or continued dragging
        // while this request was in flight.  A stale response must update
        // only its server snapshot, never repaint a newer local draft.
        if (serverRef.current?.id !== job.designId) return;
        serverRef.current = updated;
        const localDraft = draftRef.current;
        setDesign((current) => current?.id === updated.id ? { ...updated, theme: localDraft ?? updated.theme } : current);
        setDesigns((items) => items.map((item) => item.id === updated.id ? { ...updated, theme: localDraft ?? updated.theme } : item));
        if (job.draftVersion === draftVersion.current) setNotice({ tone: "success", message: `${job.label}已保存；正在刷新温隔离预览。` });
      } catch (error) {
        if (error instanceof ApiError && error.code === "REVISION_CONFLICT") {
          const latest = await api.design(job.designId).catch(() => null);
          if (!latest || serverRef.current?.id !== job.designId) return;
          const mine = cloneTheme(draftRef.current ?? job.theme);
          serverRef.current = latest;
          pendingPersist.current = null;
          previewRefreshPending.current = false;
          setDesigns((items) => items.map((item) => item.id === latest.id ? latest : item));
          setDesign((current) => current?.id === latest.id ? { ...latest, theme: mine } : current);
          setConflictMine(mine);
          setConflictLatest(latest);
          invalidatePlan("设计版本已变化，当前写入计划已失效。");
          setNotice({ tone: "warning", message: `发现更新的 r${latest.revision}；本地草稿已保留，等待你选择处理方式。` });
        } else if (serverRef.current?.id === job.designId && job.draftVersion === draftVersion.current) {
          const stable = serverRef.current;
          draftRef.current = cloneTheme(stable.theme);
          setDesign(stable);
          setDesigns((items) => items.map((item) => item.id === stable.id ? stable : item));
          setNotice({ tone: "danger", message: `${error instanceof Error ? error.message : "保存失败"}；已恢复服务器中的稳定草稿` });
        }
      } finally {
        pendingPatchIds.current.delete(patchId);
      }
    }).finally(() => {
      persistInFlight.current -= 1;
      const settled = persistInFlight.current === 0 && pendingPersist.current === null && persistTimer.current === undefined;
      syncSaving();
      if (settled && previewRefreshPending.current && serverRef.current) {
        previewRefreshPending.current = false;
        schedulePreview(serverRef.current);
      }
    });
    return saveChain.current;
  }, [invalidatePlan, schedulePreview, syncSaving]);
  const queuePersistence = useCallback((theme: ThemeSpec, label: string, phase: ThemeChangePhase) => {
    const current = serverRef.current;
    if (!current) return;
    pendingPersist.current = { designId: current.id, theme: cloneTheme(theme), label, draftVersion: draftVersion.current };
    previewRefreshPending.current = true;
    if (persistTimer.current !== undefined) clearTimeout(persistTimer.current);
    if (phase === "continuous") {
      persistTimer.current = window.setTimeout(() => {
        persistTimer.current = undefined;
        void flushPersistence();
      }, PERSIST_DEBOUNCE_MS);
    } else {
      persistTimer.current = undefined;
      void flushPersistence();
    }
    syncSaving();
  }, [flushPersistence, syncSaving]);
  const enqueueTheme = useCallback((next: ThemeSpec, label: string, phase: ThemeChangePhase = "immediate", remember = true) => {
    const draft = draftRef.current;
    if (!serverRef.current || !draft) return;
    const shouldRemember = remember && (phase !== "continuous" || !continuousEdit.current);
    if (shouldRemember) { setHistory((items) => [...items.slice(-29), cloneTheme(draft)]); setFuture([]); }
    continuousEdit.current = phase === "continuous" ? true : false;
    draftVersion.current += 1;
    draftRef.current = cloneTheme(next);
    setDesign((current) => current ? { ...current, theme: next } : current);
    invalidatePlan("草稿已修改，当前写入计划已失效。草稿画布已即时更新，正在合并温隔离预览刷新。");
    queuePersistence(next, label, phase);
  }, [invalidatePlan, queuePersistence]);

  const selectDesign = async (id: string) => { if (id === design?.id) return; const next = await api.design(id); setHistory([]); setFuture([]); replaceDesign(next); invalidatePlan("已切换设计，当前写入计划已失效。"); setNotice({ tone: "neutral", message: `已切换到 ${next.name} · r${next.revision}；正在连接温隔离预览。` }); schedulePreview(next, 0); };
  const createDesign = async () => { const next = await api.createDesign(`未命名皮肤 ${designs.length + 1}`); replaceDesign(next); schedulePreview(next, 0); };
  const duplicateDesign = async (id: string) => { const next = await api.duplicateDesign(id); replaceDesign(next); schedulePreview(next, 0); };
  const deleteDesign = async (id: string) => { if (designs.length < 2) return; await api.deleteDesign(id); const nextItems = designs.filter((item) => item.id !== id); setDesigns(nextItems); if (design?.id === id) { replaceDesign(nextItems[0]!); schedulePreview(nextItems[0]!, 0); } };
  const renameDesign = async (name: string) => { const base = serverRef.current; if (!base || !name.trim() || name.trim() === base.name) return; try { replaceDesign(await api.renameDesign(base.id, name.trim(), base.revision)); invalidatePlan("设计名称已更新，当前写入计划已失效。"); } catch (error) { setNotice({ tone: "danger", message: error instanceof Error ? error.message : "重命名失败" }); } };
  const renameDesignById = async (id: string, name: string) => { const target = designs.find((item) => item.id === id); if (!target || !name.trim() || name.trim() === target.name) return; try { const updated = await api.renameDesign(id, name.trim(), target.revision); setDesigns((items) => items.map((item) => item.id === id ? updated : item)); if (design?.id === id) replaceDesign(updated); invalidatePlan("设计名称已更新，当前写入计划已失效。"); } catch (error) { setNotice({ tone: "danger", message: error instanceof Error ? error.message : "重命名失败" }); } };
  const undo = () => { const previous = history.at(-1); const current = draftRef.current; if (!previous || !current) return; setHistory((items) => items.slice(0, -1)); setFuture((items) => [...items, cloneTheme(current)]); enqueueTheme(previous, "撤销", "immediate", false); };
  const redo = () => { const next = future.at(-1); const current = draftRef.current; if (!next || !current) return; setFuture((items) => items.slice(0, -1)); setHistory((items) => [...items, cloneTheme(current)]); enqueueTheme(next, "重做", "immediate", false); };
  const upload = async (file: File, region: BackgroundRegion) => {
    if (!draftRef.current) return;
    if (file.size > 4 * 1024 * 1024) throw new Error("图片文件超过 4MB 上限；请压缩后重试。");
    const asset = await api.upload(file);
    const backdrop = { kind: "image" as const, assetId: asset.assetId, fit: "cover" as const, position: { xPercent: 50, yPercent: 50 }, opacity: 1, blurPx: 0, overlay: { color: "#000000", opacity: .18 } };
    enqueueTheme(setRegionBackdrop(draftRef.current, region, backdrop), `已导入${draftRef.current.appearance.regions.linked ? "整合区域" : region === "sidebar" ? "左侧栏" : "主工作区"}背景图片`);
  };
  const changeRegionsLinked = useCallback((linked: boolean) => {
    const current = draftRef.current;
    if (!current || current.appearance.regions.linked === linked) return;
    enqueueTheme(setRegionsLinked(current, linked), linked ? "已整合两区域" : "已启用分别调整");
    setNotice({ tone: "success", message: linked ? "已整合两区域；接下来的背景修改会同时作用于两处。" : "已取消整合；现在可分别调整左侧栏和主工作区。" });
  }, [enqueueTheme]);
  const changeRegionsDivider = useCallback((divider: boolean) => {
    const current = draftRef.current;
    if (!current || current.appearance.regions.divider === divider) return;
    enqueueTheme(setRegionsDivider(current, divider), divider ? "已增加区域分隔线" : current.appearance.regions.linked ? "已移除分隔线；背景保持一体" : "已移除分隔线；两区域边缘将柔和过渡");
    setNotice({ tone: "success", message: divider ? "已增加区域分隔线。" : current.appearance.regions.linked ? "已移除分隔线；背景保持一体。" : "已移除分隔线；两区域背景会在边界柔和过渡。" });
  }, [enqueueTheme]);
  const refreshPreview = async () => { await flushPersistence(); await saveChain.current; schedulePreview(serverRef.current ?? undefined, 0); };
  const previewHasApplyGrace = (session: PreviewSession | null | undefined) => Boolean(session && Date.parse(session.expiresAt) - Date.now() > PREVIEW_RENEWAL_LEAD_MS);
  const previewWorkPending = previewTimer.current !== undefined || previewInFlight.current || queuedPreview.current !== null;
  const canApply = Boolean(design && status?.capabilities.compatible && preview === "live" && previewHasApplyGrace(verifiedPreview) && !previewWorkPending && exactEvidence(verifiedPreview, design) && sameSession(verifiedPreview, previewSession) && !saving);
  const previewReadyNow = () => {
    const current = serverRef.current;
    const verified = verifiedPreviewRef.current;
    return Boolean(current && !saving && previewHasApplyGrace(verified) && previewTimer.current === undefined && !previewInFlight.current && queuedPreview.current === null && exactEvidence(verified, current) && sameSession(verified, activePreviewRef.current));
  };
  const ensureApplyReceipt = async (current: DesignSession): Promise<PreviewReceiptBinding> => {
    const valid = () => {
      const verified = verifiedPreviewRef.current;
      return Boolean(previewHasApplyGrace(verified) && exactEvidence(verified, current) && sameSession(verified, activePreviewRef.current));
    };
    if (!valid()) await startPreview(current);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const active = activePreviewRef.current;
      if (active) {
        try {
          const latest = await api.previewSession(active.sessionId);
          if (latest.generation >= active.generation) acceptSession(latest);
        } catch { /* the next create/retry below is the safe recovery path */ }
      }
      if (valid()) {
        const receipt = currentReceipt(verifiedPreviewRef.current, activePreviewRef.current, current);
        if (receipt) return receipt;
      }
      const latest = activePreviewRef.current;
      if (!latest || latest.state === "expired" || latest.state === "error" || Date.parse(latest.expiresAt) <= Date.now()) await startPreview(current);
      await new Promise((resolve) => window.setTimeout(resolve, 220));
    }
    throw new Error("隔离预览尚未恢复，无法生成安全计划；请等待状态显示“隔离预览已确认”。");
  };
  const openApply = (action: ApplyAction) => {
    if (action === "apply" && (!canApply || !previewReadyNow())) { setNotice({ tone: "warning", message: "当前隔离预览仍在刷新；请等状态显示“隔离预览已确认”后再写入。" }); return; }
    applyActionRef.current = action;
    if (previewRenewalTimer.current !== undefined) {
      clearTimeout(previewRenewalTimer.current);
      previewRenewalTimer.current = undefined;
    }
    activeOperationId.current = null; applyPlanRef.current = null; setApplyAction(action); setApplyResult("idle"); setApplyError(undefined); setApplyPlan(null); setActiveOperation(null); setApplyPlanLoading(true);
    void (async () => {
      try {
        await flushPersistence();
        await saveChain.current;
        const current = serverRef.current;
        if (!current) throw new Error("当前设计尚未载入");
        if (action === "apply" && !previewReadyNow()) throw new Error("隔离预览刚刚更新，安全计划尚未稳定；请等待实时预览确认后重试。");
        await api.validate(current.theme);
        if (action === "apply") {
          const receipt = await ensureApplyReceipt(current);
          // Every visible persistent apply stages the current managed plugin
          // package as well as the theme. This is required for safe rc.6
          // compatibility updates after an earlier install.
          let nextPlan: ApplyPlan;
          let expectedReceipt = receipt;
          try {
            nextPlan = await api.applyPlan(current, true, receipt);
          } catch (error) {
            // A five-minute warm runner can expire between the preflight and
            // the POST. Refresh the same isolated runner (or create a new one
            // if it was reaped) and retry once so the first visible click does
            // not strand the user behind a manual “重新生成计划” step.
            if (!(error instanceof ApiError) || error.status !== 409) throw error;
            const freshReceipt = await ensureApplyReceipt(current);
            expectedReceipt = freshReceipt;
            nextPlan = await api.applyPlan(current, true, freshReceipt);
          }
          if (!sameReceipt(nextPlan.preview, expectedReceipt)) throw new Error("Controller 返回的计划没有绑定当前隔离预览，已拒绝写入。");
          // A preview lifecycle event may have arrived while the POST was in
          // flight and populated a stale loading error. The 200 plan response
          // is authoritative for this receipt; clear only that transient
          // message after validating the echoed binding.
          setApplyError(undefined);
          applyPlanRef.current = nextPlan;
          setApplyPlan(nextPlan);
        } else {
          const restorePlan = await api.restorePlan(current);
          applyPlanRef.current = restorePlan;
          setApplyPlan(restorePlan);
        }
      } catch (error) { setApplyError(error instanceof Error ? error.message : "无法生成安全操作计划"); }
      finally { setApplyPlanLoading(false); }
    })();
  };
  const runApply = async () => {
    if (!design || !applyAction) return; setApplyBusy(true);
    try {
      await flushPersistence();
      await saveChain.current;
      const current = serverRef.current;
      if (!current) throw new Error("当前设计尚未载入");
      await api.validate(current.theme);
      if (!applyPlan || applyPlan.designId !== current.id || applyPlan.revision !== current.revision) throw new Error("操作计划已过期，请关闭后重新打开确认窗口");
      const receipt = applyAction === "apply" ? await ensureApplyReceipt(current) : null;
      if (applyAction === "apply" && (!receipt || !sameReceipt(applyPlan.preview, receipt))) {
        const refreshedPlan = await api.applyPlan(current, true, receipt!);
        applyPlanRef.current = refreshedPlan;
        setApplyPlan(refreshedPlan);
        setApplyResult("idle");
        setApplyError("隔离预览刚刚续期，安全计划已自动刷新；请再次确认最新计划。");
        return;
      }
      const response = applyAction === "apply" ? await api.confirmAndApply(current, true, applyPlan.planHash, receipt!) : await api.confirmAndRestore(current, applyPlan.planHash);
      activeOperationId.current = response.operation.id; setActiveOperation(response.operation); setApplyResult(response.operation.state === "succeeded" ? "success" : "pending");
      setNotice({ tone: "warning", message: applyAction === "apply" ? "已写入 DSH 的待验证事务；请按界面提示重启 DSH。" : "已写入恢复事务；请按界面提示重启 DSH。" });
    }
    catch (error) { setApplyResult("failed"); setApplyError(error instanceof Error ? error.message : "操作失败"); setNotice({ tone: "danger", message: "操作没有完成；系统已停止继续写入" }); }
    finally { setApplyBusy(false); }
  };

  useEffect(() => { const onKey = (event: KeyboardEvent) => { const input = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement; if (event.altKey && event.key === "1") { event.preventDefault(); setThemeDrawer(true); document.getElementById("theme-library")?.focus(); } if (event.altKey && event.key === "2") { event.preventDefault(); document.getElementById("preview-workbench")?.focus(); } if (event.altKey && event.key === "3") { event.preventDefault(); setInspectorDrawer(true); document.getElementById("inspector")?.focus(); } if (!input && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); event.shiftKey ? redo() : undo(); } if (event.key === "Escape") { setThemeDrawer(false); setInspectorDrawer(false); if (!applyBusy) { applyActionRef.current = null; setApplyAction(null); } } }; addEventListener("keydown", onKey); return () => removeEventListener("keydown", onKey); });

  const assetUrls = design ? (Object.fromEntries((["sidebar", "main"] as const).flatMap((region) => { const backdrop = design.theme.appearance.regions[region]; return backdrop.kind === "image" ? [[region, api.assetUrl(backdrop.assetId)]] : []; })) as Partial<Record<BackgroundRegion, string>>) : undefined;
  return <div className={`app-shell mobile-${mobileTab}`}>
    <TopBar design={design} status={status} mode={mode} saving={saving} canUndo={history.length > 0} canRedo={future.length > 0} canApply={canApply} preview={preview} onMode={setMode} onRename={renameDesign} onUndo={undo} onRedo={redo} onApply={() => openApply("apply")} />
    <div className="drawer-shortcuts"><button className="button" onClick={() => { setThemeDrawer(!themeDrawer); setInspectorDrawer(false); }}><LayersIcon />主题</button><button className="button" onClick={() => { setInspectorDrawer(!inspectorDrawer); setThemeDrawer(false); }}><SlidersIcon />属性</button></div>
    <div className="workspace">
      <ThemeLibrary designs={designs} {...(design?.id ? { currentId: design.id } : {})} drawerOpen={themeDrawer || mobileTab === "themes"} onClose={() => setThemeDrawer(false)} onSelect={(id) => void selectDesign(id)} onCreate={() => void createDesign()} onDuplicate={(id) => void duplicateDesign(id)} onRename={(id, name) => void renameDesignById(id, name)} onDelete={(id) => void deleteDesign(id)} />
      <PreviewWorkbench design={design} preview={preview} verifiedSession={verifiedPreview} candidateSession={previewSession} selectedRegion={selectedRegion} {...(assetUrls ? { assetUrls } : {})} onPreview={() => void refreshPreview()} onRegionSelect={(region) => { setSelectedRegion(region); setInspectorDrawer(true); setMobileTab("inspector"); window.setTimeout(() => document.getElementById("inspector")?.focus(), 0); }} onLinkedChange={changeRegionsLinked} onDividerChange={changeRegionsDivider} />
      <Inspector theme={design?.theme ?? null} mode={mode} region={selectedRegion} drawerOpen={inspectorDrawer || mobileTab === "inspector"} onClose={() => setInspectorDrawer(false)} onRegionChange={setSelectedRegion} onChange={enqueueTheme} onUpload={upload} onRestore={() => openApply("restore")} />
    </div>
    <StatusBar status={status} design={design} preview={preview} notice={notice} mobileTab={mobileTab} onMobileTab={setMobileTab} />
    <ApplyDialog open={applyAction !== null} action={applyAction ?? "apply"} design={design} status={status} plan={applyPlan} planLoading={applyPlanLoading} operation={activeOperation} busy={applyBusy} result={applyResult} previewReady={applyAction === "restore" ? Boolean(status?.capabilities.compatible) : canApply} {...(applyError ? { error: applyError } : {})} onClose={() => { applyActionRef.current = null; setApplyAction(null); }} onRetryPlan={() => openApply(applyAction ?? "apply")} onConfirm={() => void runApply()} />
    <ConflictDialog mine={conflictMine} latest={conflictLatest} onClose={() => { setConflictMine(null); setConflictLatest(null); }} onLatest={() => { if (conflictLatest) { replaceDesign(conflictLatest); schedulePreview(conflictLatest, 0); } setConflictMine(null); setConflictLatest(null); }} onReplay={() => { if (conflictMine) enqueueTheme(conflictMine, "冲突重放", "immediate", false); setConflictMine(null); setConflictLatest(null); }} />
  </div>;
}

function samePreviewIdentity(left: PreviewSession | null | undefined, right: PreviewSession | null | undefined): boolean { return Boolean(left && right && left.sessionId === right.sessionId); }
function sameSession(left: PreviewSession | null | undefined, right: PreviewSession | null | undefined): boolean { return Boolean(samePreviewIdentity(left, right) && left!.generation === right!.generation); }
function sameTheme(left: ThemeSpec, right: ThemeSpec): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function currentReceipt(verified: PreviewSession | null, active: PreviewSession | null, design: DesignSession): PreviewReceiptBinding | null {
  if (!verified || !sameSession(verified, active) || verified.state !== "live" || verified.designId !== design.id || verified.revision !== design.revision || !/^[0-9a-f]{64}$/i.test(verified.renderReceiptHash ?? "")) return null;
  return { previewSessionId: verified.sessionId, previewGeneration: verified.generation, renderReceiptHash: verified.renderReceiptHash! };
}
function sameReceipt(left: PreviewReceiptBinding | undefined, right: PreviewReceiptBinding): boolean { return Boolean(left && left.previewSessionId === right.previewSessionId && left.previewGeneration === right.previewGeneration && left.renderReceiptHash === right.renderReceiptHash); }
function previewFromEvent(event: StudioEvent, active: PreviewSession | null): PreviewSession | null {
  if (event.type !== "preview.session.changed") return null;
  if (event.previewSession) return event.previewSession;
  if (event.session) return event.session;
  if (!active || event.sessionId !== active.sessionId || (event.generation !== undefined && event.generation < active.generation)) return null;
  return { ...active, ...(event.state ? { state: event.state as PreviewState } : {}), ...(event.designId ? { designId: event.designId } : {}), ...(event.revision !== undefined ? { revision: event.revision } : {}), ...(event.themeHash ? { themeHash: event.themeHash } : {}), ...(event.renderReceiptHash ? { renderReceiptHash: event.renderReceiptHash } : {}), ...(event.previewUrl ? { previewUrl: event.previewUrl } : {}), ...(event.isolated !== undefined ? { isolated: event.isolated as true } : {}), ...(event.persistentTargetTouched !== undefined ? { persistentTargetTouched: event.persistentTargetTouched as false } : {}), ...(event.expiresAt ? { expiresAt: event.expiresAt } : {}) };
}
