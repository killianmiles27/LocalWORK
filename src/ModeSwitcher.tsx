import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, ChevronDown, Loader2 } from "lucide-react";

type Mode = { id: string; plugin: string; label: string; description: string; group: string; config: string; context: number | null; found: boolean; active: boolean; engine?: string };
type Effort = { effort: string | null; config: string | null; override: string | null; options: string[] };

const k = (n: number) => (n >= 1024 ? Math.round(n / 1024) + "K" : String(n));

/** Composer dropdown: model modes from plugins (reload) and reasoning effort (instant, no reload). */
export default function ModeSwitcher({ ready, state, onKey, onError }: { ready: boolean; state: string; onKey: (key: string) => void; onError: (e: string) => void }) {
  const [modes, setModes] = useState<Mode[]>([]);
  const [effort, setEffort] = useState<Effort | null>(null);
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  const refresh = () => invoke<{ modes: Mode[]; effort: Effort }>("modes_list").then(r => { setModes(r.modes); setEffort(r.effort); }).catch(() => {});
  useEffect(() => { refresh(); }, [state]);
  useEffect(() => { if (open) refresh(); }, [open]);

  const active = modes.find(m => m.active);
  useEffect(() => { onKey(`${active?.id ?? "default"}|${effort?.effort ?? "default"}`); }, [active?.id, effort?.effort]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);

  async function pick(m: Mode) {
    if (m.active && ready) { setOpen(false); return; }
    setSwitching(m.id); setOpen(false);
    try { await invoke("mode_switch", { id: m.id }); await refresh(); }
    catch (e) { onError(String(e)); }
    finally { setSwitching(null); }
  }
  async function setLevel(level: string | null) {
    const before = effort;
    setEffort(e => e && { ...e, effort: level ?? e.config, override: level });
    try { setEffort(await invoke<Effort>("effort_set", { effort: level })); }
    catch (e) { setEffort(before); onError(String(e)); }
  }

  if (!modes.length && !effort) return null;
  const groups = Array.from(new Set(modes.map(m => m.group)));
  const busy = !!switching || state === "loading" || state === "starting";
  const label = switching ? modes.find(m => m.id === switching)?.label ?? "Switching" : active?.label ?? "Model";

  return (
    <div ref={box} className="relative">
      <button onClick={() => setOpen(o => !o)} aria-expanded={open} aria-haspopup="menu" data-testid="mode-switcher"
        title={active ? `${active.label}${active.context ? ` · ${k(active.context)} context` : ""}` : "Model and effort"}
        className="flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted hover:bg-panel hover:text-ink whitespace-nowrap">
        {busy && <Loader2 size={12} className="animate-spin" />}
        <span className="max-w-28 truncate">{label}</span>
        {effort?.effort && <span className="hidden @min-[34rem]:inline opacity-60">· {effort.effort}</span>}
        <ChevronDown size={12} />
      </button>
      {open && (
        <div role="menu" className="absolute bottom-full right-0 mb-2 w-72 rounded-xl border border-line bg-panel shadow-lg p-1.5 text-sm z-30">
          {groups.map(g => (
            <div key={g}>
              <div className="px-2.5 pt-1.5 pb-1 text-xs text-muted">{g}</div>
              {modes.filter(m => m.group === g).map(m => (
                <button key={m.id} role="menuitemradio" aria-checked={m.active} disabled={!m.found || busy} onClick={() => pick(m)}
                  title={m.found ? m.config : `Missing run config: ${m.config}`}
                  className="w-full flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-panel-2 disabled:opacity-40">
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2"><span>{m.label}</span>{m.context && <span className="text-xs text-muted">{k(m.context)}</span>}{m.engine === "PolyStrata" && <span className="text-[11px] text-muted">PolyStrata</span>}</span>
                    {m.description && <span className="block text-xs text-muted truncate">{m.description}</span>}
                  </span>
                  {m.active && <Check size={14} className="mt-0.5 text-accent shrink-0" />}
                </button>
              ))}
            </div>
          ))}
          {effort && (
            <div className={modes.length ? "mt-1 border-t border-line pt-2 px-2.5 pb-1.5" : "px-2.5 py-1.5"}>
              <div className="flex items-baseline justify-between text-xs text-muted mb-1.5">
                <span>Thinking effort</span>
                {effort.override && <button onClick={() => setLevel(null)} disabled={!ready} className="hover:text-ink">Reset to {effort.config ?? "default"}</button>}
              </div>
              <div className="grid grid-cols-4 gap-1 rounded-lg bg-panel-2 p-0.5" role="radiogroup" aria-label="Thinking effort">
                {effort.options.map(o => (
                  <button key={o} role="radio" aria-checked={effort.effort === o} disabled={!ready} onClick={() => setLevel(o)}
                    className={"rounded-md py-1 text-xs capitalize transition-colors disabled:opacity-40 " + (effort.effort === o ? "bg-card text-ink shadow-sm" : "text-muted hover:text-ink")}>{o}</button>
                ))}
              </div>
              <div className="mt-1.5 text-[11px] text-muted">Effort applies to the next reply. Switching mode reloads the model.</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
