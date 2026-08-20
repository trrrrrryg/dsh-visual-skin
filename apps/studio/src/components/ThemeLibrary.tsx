import { useEffect, useState, type CSSProperties } from "react";
import { backgroundCssForBackdrop, type DesignSession } from "../model";
import { MoreIcon, PlusIcon, SearchIcon } from "./Icons";

interface Props {
  designs: DesignSession[];
  currentId?: string;
  drawerOpen: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDuplicate: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}

export function ThemeLibrary({ designs, currentId, drawerOpen, onClose, onSelect, onCreate, onDuplicate, onRename, onDelete }: Props) {
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const filtered = designs.filter((design) => `${design.name} ${design.theme.name}`.toLowerCase().includes(query.toLowerCase()));
  // Close the row menu when the user clicks anywhere else on the page.
  useEffect(() => {
    if (!menu) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target && (target.closest(".row-menu") || target.closest(".row-menu-button"))) return;
      setMenu(null);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [menu]);
  const commitRename = (design: DesignSession) => {
    const next = renameDraft.trim();
    if (next && next !== design.name) onRename(design.id, next);
    setRenamingId(null);
  };
  return <aside id="theme-library" tabIndex={-1} className={`panel theme-library ${drawerOpen ? "is-open" : ""}`} aria-label="主题库">
    <div className="panel-heading">
      <div><span className="eyebrow">COLLECTION</span><h2>主题库</h2></div>
      <button className="icon-button" type="button" aria-label="新建主题" title="新建主题" onClick={onCreate}><PlusIcon /></button>
    </div>
    <label className="search-field">
      <SearchIcon />
      <span className="sr-only">搜索主题</span>
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索主题" />
    </label>
    <div className="theme-list">
      {filtered.map((design) => {
        const backdrop = design.theme.appearance.backdrop;
        const thumbStyle = ((): CSSProperties => {
          if (backdrop.kind === "image") {
            // Mirror the DSH main-surface crop (cover at the configured
            // position) but without the dark overlay, so the thumbnail reads
            // as the source photo rather than a near-black slab.
            return { backgroundImage: `url("/api/v1/assets/${backdrop.assetId}")`, backgroundColor: "#151716", backgroundSize: "cover", backgroundPosition: `${backdrop.position.xPercent}% ${backdrop.position.yPercent}%`, backgroundRepeat: "no-repeat" };
          }
          return { backgroundImage: backgroundCssForBackdrop(backdrop), backgroundColor: backdrop.kind === "solid" ? backdrop.colors[0] : undefined };
        })();
        return <article className={`theme-row ${currentId === design.id ? "is-selected" : ""}`} key={design.id}>
          <button className="theme-select" type="button" onClick={() => { onSelect(design.id); onClose(); }}>
            <span className="theme-thumb" style={thumbStyle} aria-hidden="true">
              <i className="thumb-sidebar" />
              <i className="thumb-chat" />
              <i className="thumb-composer" />
            </span>
            <span className="theme-copy">
              {renamingId === design.id
                ? <input className="theme-rename-input" autoFocus value={renameDraft} aria-label={`重命名 ${design.name}`} onChange={(event) => setRenameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") commitRename(design); else if (event.key === "Escape") setRenamingId(null); }} onBlur={() => commitRename(design)} />
                : <strong>{design.name}</strong>}
              <small>r{design.revision} · {relativeTime(design.updatedAt)}</small><em>{currentId === design.id ? "正在编辑" : "草稿"}</em>
            </span>
          </button>
          <button className="icon-button row-menu-button" type="button" aria-label={`${design.name} 更多操作`} onClick={() => setMenu(menu === design.id ? null : design.id)}><MoreIcon /></button>
          {menu === design.id && <div className="row-menu" role="menu">
            <button role="menuitem" onClick={() => { setRenamingId(design.id); setRenameDraft(design.name); setMenu(null); }}>重命名主题</button>
            <button role="menuitem" onClick={() => { onDuplicate(design.id); setMenu(null); }}>复制主题</button>
            <button role="menuitem" disabled={designs.length < 2} onClick={() => { if (window.confirm(`确认删除“${design.name}”？此操作仅在主题未被应用或恢复流程引用时执行。`)) onDelete(design.id); setMenu(null); }}>删除主题</button>
          </div>}
        </article>;
      })}
      {filtered.length === 0 && <div className="empty-state"><strong>没有匹配的皮肤</strong><span>换个关键词，或新建一个主题。</span></div>}
    </div>
  </aside>;
}

function relativeTime(value: string) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  return `${Math.round(minutes / 60)} 小时前`;
}
