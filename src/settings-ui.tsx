import type { ReactNode } from "react";

/** Shared building blocks for the Settings window, so every tab looks and behaves the same. */

export const input = "rounded-lg border border-line bg-panel px-2 py-1 text-sm min-w-0 w-full focus:border-accent outline-none";

const buttonStyles = {
  primary: "bg-accent text-accent-fg hover:bg-accent-dark border border-transparent",
  default: "border border-line bg-card hover:bg-panel-2",
  ghost: "text-muted hover:text-ink hover:bg-panel-2 border border-transparent",
  danger: "text-muted hover:text-red-500 hover:bg-panel-2 border border-transparent",
};

export function Button({ variant = "default", small, className = "", ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof buttonStyles; small?: boolean }) {
  return <button type="button" {...rest} className={`rounded-lg ${small ? "px-2 py-0.5 text-xs" : "px-3 py-1 text-sm"} transition-colors disabled:opacity-40 disabled:pointer-events-none ${buttonStyles[variant]} ${className}`} />;
}

/** A titled group of rows on one card. `action` sits to the right of the title. */
export function Section({ title, action, note, children, plain }: { title: string; action?: ReactNode; note?: ReactNode; children: ReactNode; plain?: boolean }) {
  return (
    <section>
      <div className="flex items-center justify-between gap-3 mb-1.5 min-h-6">
        <h3 className="text-sm font-semibold">{title}</h3>
        {action && <div className="flex items-center gap-1">{action}</div>}
      </div>
      {plain ? children : <div className="rounded-xl border border-line bg-card divide-y divide-line">{children}</div>}
      {note && <p className="text-xs text-muted mt-1.5 px-1">{note}</p>}
    </section>
  );
}

/** One line on a card: label (with an optional hint under it) on the left, value or control on the right. */
export function Row({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 px-3.5 py-2.5 text-sm min-h-10">
      <div className="min-w-0">
        <div>{label}</div>
        {hint && <div className="text-xs text-muted mt-0.5">{hint}</div>}
      </div>
      {children != null && <div className="min-w-0 shrink-0 max-w-[60%] text-right">{children}</div>}
    </div>
  );
}

/** A read-only value, shown muted so it reads as information rather than a control. */
export const Value = ({ children }: { children: ReactNode }) => <span className="text-muted break-all">{children}</span>;

export function Toggle({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  return <input type="checkbox" className="switch" aria-label={label} checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />;
}

/** A switch row: the label is the switch's accessible name. */
export function ToggleRow({ label, hint, checked, disabled, onChange }: { label: string; hint?: ReactNode; checked: boolean; disabled?: boolean; onChange: (on: boolean) => void }) {
  return <Row label={label} hint={hint}><Toggle label={label} checked={checked} disabled={disabled} onChange={onChange} /></Row>;
}

/** A thin usage bar with the numbers beside it. */
export function Meter({ used, total, text }: { used: number; total: number; text: string }) {
  const pct = total > 0 ? Math.min(100, Math.max(0, (used / total) * 100)) : 0;
  return (
    <span className="flex items-center justify-end gap-2.5">
      <span className="text-muted tabular-nums">{text}</span>
      <span className="w-20 h-1.5 rounded-full bg-panel-2 overflow-hidden"><span className={`block h-full rounded-full ${pct > 90 ? "bg-ember" : "bg-accent"}`} style={{ width: `${pct}%` }} /></span>
    </span>
  );
}

export function Message({ children, error }: { children: ReactNode; error?: boolean }) {
  if (!children) return null;
  return <p role={error ? "alert" : "status"} className={`text-xs mt-1.5 px-1 break-words ${error ? "text-red-500" : "text-muted"}`}>{children}</p>;
}
