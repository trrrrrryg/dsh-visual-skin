import { useEffect, useState } from "react";
import type { AppearanceMode, DesignSession, DshStatus, PreviewState } from "../model";
import { RedoIcon, UndoIcon } from "./Icons";

interface Props {
  design: DesignSession | null;
  status: DshStatus | null;
  mode: AppearanceMode;
  saving: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canApply: boolean;
  preview: PreviewState;
  onMode: (mode: AppearanceMode) => void;
  onRename: (name: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  onApply: () => void;
}

export function TopBar({ design, status, mode, saving, canUndo, canRedo, canApply, preview, onMode, onRename, onUndo, onRedo, onApply }: Props) {
  const [name, setName] = useState("");
  useEffect(() => setName(design?.name ?? ""), [design?.id, design?.name]);
  return <header className="topbar">
    <div className="brand-lockup">
      <span className="brand-mark" aria-hidden="true">DS</span>
      <div className="brand-copy">
        <strong>DSH Skin Studio</strong>
        <input
          className="theme-name-input"
          aria-label="当前主题名称"
          value={name}
          disabled={!design}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => onRename(name)}
          onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
        />
      </div>
      <span className={`save-state ${saving ? "is-saving" : ""}`}>{saving ? "正在保存…" : "已保存"}</span>
    </div>

    <div className="topbar-center">
      <div className="segmented" aria-label="外观模式">
        {(["light", "dark", "system"] as const).map((value) => <button
          type="button"
          key={value}
          aria-pressed={mode === value}
          onClick={() => onMode(value)}
        >{{ light: "浅色", dark: "深色", system: "跟随系统" }[value]}</button>)}
      </div>
      <div className="history-actions" aria-label="设计历史">
        <button className="icon-button" type="button" aria-label="撤销" title="撤销 (Ctrl+Z)" disabled={!canUndo} onClick={onUndo}><UndoIcon /></button>
        <button className="icon-button" type="button" aria-label="重做" title="重做 (Ctrl+Shift+Z)" disabled={!canRedo} onClick={onRedo}><RedoIcon /></button>
      </div>
    </div>

    <div className="topbar-actions">
      <div className="runtime-copy">
        <span className={`status-dot ${status?.dsh.detected ? "ok" : "warning"}`} aria-hidden="true" />
        <span>{preview === "live" ? "隔离预览已确认" : preview === "updating" ? "温预览更新中" : "温预览连接中"}</span>
        <small>{design ? `r${design.revision} · ${canApply ? "可安全确认" : "尚不可写入"}` : "等待草稿"}</small>
      </div>
      <button className="button button-impact" type="button" disabled={!design || saving || !canApply} aria-describedby={!canApply ? "persist-requires-preview" : undefined} onClick={onApply}>写入我的 DSH</button>
      {!canApply && <span id="persist-requires-preview" className="sr-only">请先等待当前草稿的隔离实时预览完成验证。</span>}
    </div>
  </header>;
}
