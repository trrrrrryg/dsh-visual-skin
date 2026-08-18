import type { SVGProps } from "react";

type Props = SVGProps<SVGSVGElement>;
const base = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };

export const UndoIcon = (props: Props) => <svg {...base} {...props}><path d="M9 7 4 12l5 5"/><path d="M4 12h9a7 7 0 0 1 7 7"/></svg>;
export const RedoIcon = (props: Props) => <svg {...base} {...props}><path d="m15 7 5 5-5 5"/><path d="M20 12h-9a7 7 0 0 0-7 7"/></svg>;
export const PlusIcon = (props: Props) => <svg {...base} {...props}><path d="M12 5v14M5 12h14"/></svg>;
export const SearchIcon = (props: Props) => <svg {...base} {...props}><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>;
export const ExternalIcon = (props: Props) => <svg {...base} {...props}><path d="M14 4h6v6M20 4l-9 9"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/></svg>;
export const RefreshIcon = (props: Props) => <svg {...base} {...props}><path d="M20 7v5h-5"/><path d="M19 12a7 7 0 1 0-2 5"/></svg>;
export const LayersIcon = (props: Props) => <svg {...base} {...props}><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 12 9 5 9-5M3 16l9 5 9-5"/></svg>;
export const SlidersIcon = (props: Props) => <svg {...base} {...props}><path d="M4 6h8M16 6h4M4 12h3M11 12h9M4 18h10M18 18h2"/><circle cx="14" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="16" cy="18" r="2"/></svg>;
export const MonitorIcon = (props: Props) => <svg {...base} {...props}><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>;
export const CheckIcon = (props: Props) => <svg {...base} {...props}><path d="m5 12 4 4L19 6"/></svg>;
export const WarningIcon = (props: Props) => <svg {...base} {...props}><path d="M10.3 3.7 2.5 18a2 2 0 0 0 1.8 3h15.4a2 2 0 0 0 1.8-3L13.7 3.7a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>;
export const MoreIcon = (props: Props) => <svg {...base} {...props}><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/></svg>;
export const CloseIcon = (props: Props) => <svg {...base} {...props}><path d="m6 6 12 12M18 6 6 18"/></svg>;
