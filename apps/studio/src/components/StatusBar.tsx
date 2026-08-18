import type { DesignSession, DshStatus, PreviewState, UiNotice } from "../model";
import { CheckIcon, LayersIcon, MonitorIcon, SlidersIcon, WarningIcon } from "./Icons";

interface Props {
  status: DshStatus | null;
  design: DesignSession | null;
  preview: PreviewState;
  notice: UiNotice;
  mobileTab: "themes" | "preview" | "inspector";
  onMobileTab: (tab: "themes" | "preview" | "inspector") => void;
}

export function StatusBar({ status, design, preview, notice, mobileTab, onMobileTab }: Props) {
  const pluginInstalled = status?.dsh.pluginInstalled;
  return <>
    <footer className="statusbar" role="status" aria-live="polite">
      <div className="service-statuses">
        <span><i className="status-dot ok" />Controller</span>
        <span><i className={`status-dot ${pluginInstalled ? "ok" : "warning"}`} />DSH Plugin</span>
        <span><i className={`status-dot ${preview === "live" ? "ok" : preview === "expired" || preview === "error" ? "danger" : "warning"}`} />隔离预览</span>
      </div>
      <div className={`notice tone-${notice.tone}`}>{notice.tone === "success" ? <CheckIcon /> : notice.tone === "warning" || notice.tone === "danger" ? <WarningIcon /> : null}<span>{notice.message}</span></div>
      <div className="status-tail"><span>{design ? `r${design.revision}` : "—"}</span><span>{status?.capabilities.compatible ? `Schema v${design?.theme.schemaVersion ?? "—"}` : "离线模式"}</span></div>
    </footer>
    <nav className="mobile-tabs" aria-label="工作区导航">
      <button aria-current={mobileTab === "themes" ? "page" : undefined} onClick={() => onMobileTab("themes")}><LayersIcon />主题</button>
      <button aria-current={mobileTab === "preview" ? "page" : undefined} onClick={() => onMobileTab("preview")}><MonitorIcon />预览</button>
      <button aria-current={mobileTab === "inspector" ? "page" : undefined} onClick={() => onMobileTab("inspector")}><SlidersIcon />属性</button>
    </nav>
  </>;
}
