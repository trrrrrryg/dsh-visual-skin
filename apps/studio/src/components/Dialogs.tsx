import { useEffect, useRef, useState } from "react";
import type { ApplyPlan, DesignSession, DshStatus, OperationRecord, ThemeSpec } from "../model";
import { CheckIcon, CloseIcon, WarningIcon } from "./Icons";

interface ApplyProps {
  open: boolean;
  action: "apply" | "restore";
  design: DesignSession | null;
  status: DshStatus | null;
  plan: ApplyPlan | null;
  planLoading: boolean;
  operation: OperationRecord | null;
  busy: boolean;
  result: "idle" | "pending" | "success" | "failed";
  previewReady: boolean;
  error?: string;
  onClose: () => void;
  onRetryPlan: () => void;
  onConfirm: (acknowledged: boolean) => void;
}

const steps = ["校验设计", "创建备份", "安装/更新插件", "应用皮肤", "等待重启", "验证真实界面"];

export function ApplyDialog({ open, action, design, status, plan, planLoading, operation, busy, result, previewReady, error, onClose, onRetryPlan, onConfirm }: ApplyProps) {
  const [ack, setAck] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => { if (open) { setAck(false); queueMicrotask(() => closeRef.current?.focus()); } }, [open]);
  useDialogFocus(open, dialogRef, onClose, busy);
  if (!open || !design) return null;
  const pluginNeedsInstall = !status?.dsh.pluginInstalled;
  const completedSteps = result === "success" ? steps.length : operation?.state === "pending-verification" ? 5 : operation?.state === "pending-restart" ? 4 : busy ? 1 : 0;
  const runningStep = result === "success" || result === "failed" ? -1 : operation?.state === "pending-verification" ? 5 : operation?.state === "pending-restart" ? 4 : busy ? 0 : -1;
  return <div className="modal-layer" role="presentation" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="modal apply-dialog" role="dialog" aria-modal="true" aria-labelledby="apply-title">
      <header><div><span className="eyebrow">{action === "apply" ? "PERSISTENT WRITE" : "RECOVERY PLAN"}</span><h2 id="apply-title">{action === "apply" ? "确认并写入我的 DSH" : "恢复上一稳定外观"}</h2></div><button ref={closeRef} className="icon-button" aria-label="关闭" disabled={busy} onClick={onClose}><CloseIcon /></button></header>
      {result === "success" ? <div className="result-panel success"><CheckIcon /><div><strong>{action === "apply" ? "真实 DSH 已确认新皮肤" : "真实 DSH 已确认恢复结果"}</strong><p>插件健康、运行实例和目标 revision/hash 均已验证。</p></div></div> : result === "failed" ? <div className="result-panel danger" role="alert"><WarningIcon /><div><strong>操作未完成，已停止继续写入</strong><p>{error ?? "请查看本地操作日志后重试。"}</p></div></div> : <>
        {planLoading && <div className="result-panel"><span className="spinner" /><div><strong>正在生成不可变操作计划</strong><p>校验目标、插件状态、恢复点和真实差异…</p></div></div>}
        {!planLoading && error && <div className="result-panel danger" role="alert"><WarningIcon /><div><strong>无法生成安全计划</strong><p>{error}</p></div></div>}
        {result === "pending" && <div className="result-panel warning" role="status"><WarningIcon /><div><strong>文件事务已提交，等待 DSH 重启验证</strong><p>当前 operation 为 {operation?.state ?? "pending-restart"}；尚未标记成功。</p></div></div>}
        <div className="diff-summary">
          <div><small>目标</small><strong>DeepSeek Harness {status?.capabilities.detectedVersion ?? "未发现"}</strong></div>
          <div><small>草稿</small><strong>{design.name} · r{design.revision}</strong></div>
          <div><small>{action === "apply" ? "插件" : "恢复目标"}</small><strong>{action === "apply" ? pluginNeedsInstall ? "需要首次安装" : "已安装，将更新插件和主题" : plan?.restores === "official" ? "官方外观 / 无插件" : plan?.restores === "managed" ? "上一托管主题" : "正在读取恢复点"}</strong></div>
          <div><small>写入前校验</small><strong>{previewReady ? plan ? `${plan.diff.length} 项已审阅` : "正在生成计划" : "当前隔离预览凭据无效"}</strong></div>
        </div>
        {!previewReady && !planLoading && error && <div className="result-panel danger" role="alert"><WarningIcon /><div><strong>写入计划已失效</strong><p>当前草稿尚未具备对应的隔离实时渲染凭据。请关闭此窗口，等待实时预览恢复后重新确认。</p></div></div>}
        {plan && <div className="diff-detail" aria-label="结构化差异明细"><div className="section-heading"><h3>结构化差异明细</h3></div><ul>{plan.diff.map((item) => <li key={item.path}><strong>{describeDiff(item.path)}</strong><div><span>{formatDiffValue(item.before)}</span><b aria-hidden="true">→</b><span>{formatDiffValue(item.after)}</span></div></li>)}</ul>{plan.diff.length === 0 && <p>当前主题与目标状态没有结构化差异。</p>}</div>}
        <ol className="operation-steps">{steps.map((step, index) => <li key={step} aria-current={index === runningStep ? "step" : undefined} className={index === runningStep ? "running" : index < completedSteps ? "done" : ""}><span>{index < completedSteps ? "✓" : index + 1}</span><strong>{step}</strong></li>)}</ol>
        {result === "idle" && <label className="acknowledgement"><input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} disabled={busy || planLoading || !plan || !previewReady} /><span>我已核对以上计划，并确认将其写入我的 DSH；重启验证前不会显示“成功”。</span></label>}
      </>}
      <footer><button className="button" type="button" disabled={busy} onClick={onClose}>{result === "idle" ? "返回继续设计" : "关闭"}</button>{result === "idle" && error && !planLoading && <button className="button" type="button" disabled={busy || !previewReady} onClick={onRetryPlan}>重新生成安全计划</button>}{result === "idle" && <button className={action === "apply" ? "button button-impact" : "button button-recovery"} type="button" disabled={busy || planLoading || !plan || Boolean(error) || !ack || !previewReady || !status?.capabilities.compatible} aria-describedby={!status?.capabilities.compatible || !previewReady ? "apply-disabled" : undefined} onClick={() => onConfirm(ack)}>{busy ? "正在执行安全事务…" : action === "apply" ? "确认并写入我的 DSH" : "确认恢复"}</button>}</footer>
      {(!status?.capabilities.compatible || !previewReady) && <p id="apply-disabled" className="disabled-reason">{!previewReady ? "隔离实时预览尚未确认当前草稿，写入被安全阻止。" : "未发现受支持的 DSH 0.1.0-rc.6，注入被安全阻止。"}</p>}
    </section>
  </div>;
}

interface ConflictProps {
  mine: ThemeSpec | null;
  latest: DesignSession | null;
  onReplay: () => void;
  onLatest: () => void;
  onClose: () => void;
}

export function ConflictDialog({ mine, latest, onReplay, onLatest, onClose }: ConflictProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  useDialogFocus(Boolean(mine && latest), dialogRef, onClose, false);
  useEffect(() => { if (mine && latest) queueMicrotask(() => closeRef.current?.focus()); }, [mine, latest]);
  if (!mine || !latest) return null;
  return <div className="modal-layer"><section ref={dialogRef} className="modal conflict-dialog" role="alertdialog" aria-modal="true" aria-labelledby="conflict-title">
    <header><div><span className="eyebrow">REVISION CONFLICT</span><h2 id="conflict-title">发现新的设计版本</h2></div><button ref={closeRef} className="icon-button" aria-label="关闭" onClick={onClose}><CloseIcon /></button></header>
    <p>当前草稿已经更新到 r{latest.revision}。你的修改不会被自动覆盖。</p>
    <div className="conflict-compare"><div><small>我的背景</small><code>{mine.appearance.backdrop.kind}</code></div><div><small>最新背景</small><code>{latest.theme.appearance.backdrop.kind}</code></div></div>
    <footer><button className="button" onClick={onLatest}>保留最新版本</button><button className="button button-preview" onClick={onReplay}>读取最新并重放我的修改</button></footer>
  </section></div>;
}

function useDialogFocus(open: boolean, dialogRef: React.RefObject<HTMLElement | null>, onClose: () => void, closeBlocked: boolean) {
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !closeBlocked) { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex='-1'])") ?? [])]
        .filter((element) => !element.hidden && element.getClientRects().length > 0);
      if (!focusable.length) { event.preventDefault(); dialogRef.current?.focus(); return; }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => { document.removeEventListener("keydown", onKeyDown, true); previous?.focus(); };
  }, [open, dialogRef, onClose, closeBlocked]);
}

function formatDiffValue(value: unknown): string {
  if (value === null || value === undefined) return "∅";
  if (typeof value === "string") return redactTechnicalValue(value);
  try { return redactTechnicalValue(JSON.stringify(value)); } catch { return "已更新"; }
}

function describeDiff(path: string): string {
  if (path.includes("backdrop")) return "背景与叠层";
  if (path.includes("tokens")) return "界面配色";
  if (path.includes("glass")) return "透明与圆角";
  if (path.includes("appearance")) return "外观设置";
  return "主题设置";
}

function redactTechnicalValue(value: string): string {
  if (/sha256-[0-9a-f]{64}|\b[0-9a-f]{64}\b/i.test(value)) return "已绑定的资源或渲染凭据";
  if (/[A-Za-z]:\\|\/Users\/|\/home\//.test(value)) return "本地目标已隐藏";
  return value.length > 160 ? "已更新的主题设置" : value;
}
