import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Check, ChevronDown, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { cloudChanged, cloudChoices, type CloudConfig } from "./cloud-ui";
import { groupLocalModels, type Mode } from "./modelPicker";
type Effort = { effort: string | null; config: string | null; override: string | null; options: string[] };
type Route = { routing: string; model: string | null; locked: boolean; offline?: boolean };
type Position = { left: number; top: number; width: number; maxHeight: number };
const skin = "fixed z-[80] rounded-xl border border-line bg-panel shadow-xl text-sm overflow-hidden flex flex-col";
export default function ModeSwitcher({ ready, state, onKey, onError, conv, ensureConversation, running }: {
  ready: boolean; state: string; onKey: (key: string) => void; onError: (e: string) => void; conv: string | null; ensureConversation: () => Promise<string>; running: boolean;
}) {
  const [modes, setModes] = useState<Mode[]>([]), [effort, setEffort] = useState<Effort | null>(null);
  const [config, setConfig] = useState<CloudConfig | null>(null), [route, setRoute] = useState<Route | null>(null);
  const [open, setOpen] = useState(false), [selected, setSelected] = useState<string | null>(null), [switching, setSwitching] = useState(false);
  const [pos, setPos] = useState<Position | null>(null), [subPos, setSubPos] = useState<Position | null>(null);
  const [sent, setSent] = useState<unknown>(), [reason, setReason] = useState("");
  const trigger = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null), submenu = useRef<HTMLDivElement>(null), row = useRef<HTMLButtonElement | null>(null);
  const generation = useRef(0);
  async function refresh() {
    const seq = ++generation.current;
    const [m, c, r] = await Promise.all([invoke<{ modes: Mode[]; effort: Effort }>("modes_list"), invoke<CloudConfig>("cloud_get"), invoke<Route>("chat_route_get", { conv: conv ?? "" })]);
    if (seq === generation.current) { setModes(m.modes); setEffort(m.effort); setConfig(c); setRoute(r); }
  }
  useEffect(() => {
    const changed = () => { refresh().catch(e => onError(String(e))); };
    changed(); window.addEventListener("cloud-changed", changed); window.addEventListener("offline-changed", changed);
    const sub = listen<{ conv: string; reason: string }>("route", e => { if (e.payload.conv === conv) { setReason(e.payload.reason); changed(); } });
    return () => { generation.current++; window.removeEventListener("cloud-changed", changed); window.removeEventListener("offline-changed", changed); sub.then(f => f()); };
  }, [conv, state]);
  useEffect(() => { setReason(""); setSent(undefined); }, [conv]);
  const models = groupLocalModels(modes), active = modes.find(m => m.active), model = models.find(m => m.profiles.some(p => p.active));
  const profileModel = models.find(m => m.id === selected), clouds = config ? cloudChoices(config) : [];
  const forced = config?.routing === "local" || route?.offline || route?.locked;
  const cloudChosen = !forced && route?.model?.startsWith("cloud:");
  const label = route?.offline ? "Local · offline" : route?.locked ? "Local · private" : cloudChosen ? `Cloud · ${clouds.find(c => c.value === route?.model)?.label ?? route?.model?.split(":").slice(2).join(":")}` : `${config?.routing === "auto" && !route?.model ? "Auto" : "Local"} · ${model?.label ?? active?.modelLabel ?? "Model"}${active?.context ? ` · ${Math.round(active.context / 1024)}K` : ""}`;
  const busy = switching || running || state === "loading" || state === "starting";
  const inlineProfiles = !!selected && !!pos && pos.left < 240 && pos.left + pos.width + 232 > innerWidth - 8;
  useEffect(() => { onKey(`${route?.model || active?.id || "default"}|${effort?.effort ?? "default"}`); }, [active?.id, route?.model, effort?.effort]);
  function place() {
    const a = trigger.current?.getBoundingClientRect(); if (!a) return;
    const width = Math.min(292, innerWidth - 16), above = a.top - 16, below = innerHeight - a.bottom - 16;
    const up = above >= Math.min(380, below), maxHeight = Math.max(80, Math.min(460, up ? above : below));
    const height = Math.min(menu.current?.scrollHeight ?? 380, maxHeight), left = Math.max(8, Math.min(a.right - width, innerWidth - width - 8));
    setPos({ left, top: up ? Math.max(8, a.top - height - 8) : Math.min(innerHeight - height - 8, a.bottom + 8), width, maxHeight });
    if (selected && row.current) {
      const right = left + width + 4, subLeft = right + 228 <= innerWidth - 8 ? right : left - 232;
      const height = Math.min(submenu.current?.scrollHeight ?? 160, innerHeight - 16);
      const rowTop = row.current.isConnected ? row.current.getBoundingClientRect().top : (up ? Math.max(8, a.top - Math.min(menu.current?.scrollHeight ?? 380, maxHeight) - 8) : a.bottom + 8) + 40;
      setSubPos(subLeft >= 8 ? { left: subLeft, top: Math.max(8, Math.min(rowTop, innerHeight - height - 8)), width: 228, maxHeight: innerHeight - 16 } : null);
    } else setSubPos(null);
  }
  useLayoutEffect(() => { if (open) place(); }, [open, selected, modes, config, effort]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (![trigger.current, menu.current, submenu.current].some(el => el?.contains(e.target as Node))) { setOpen(false); setSelected(null); } };
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true); document.addEventListener("mousedown", away);
    const observer = new ResizeObserver(place); if (menu.current) observer.observe(menu.current);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); document.removeEventListener("mousedown", away); observer.disconnect(); };
  }, [open, selected]);
  function close() { setOpen(false); setSelected(null); trigger.current?.focus(); }
  function keys(e: React.KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    if (e.key === "ArrowLeft" && selected) { e.preventDefault(); setSelected(null); row.current?.focus(); }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button[role^="menuitem"]:not(:disabled)'));
      if (items.length) { e.preventDefault(); const index = items.indexOf(document.activeElement as HTMLButtonElement); items[(index + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus(); }
    }
  }
  async function choose(value: string | null, local?: Mode) {
    setSwitching(true);
    try {
      if (local) await invoke("mode_switch", { id: local.id });
      if (conv || value?.startsWith("cloud:")) await invoke("chat_route_set", { conv: conv ?? await ensureConversation(), model: value });
      cloudChanged(); await refresh(); close();
    } catch (e) { onError(String(e)); } finally { setSwitching(false); }
  }
  const profiles = profileModel && <><div className="px-3 py-2 text-xs text-muted border-b border-line">{profileModel.label} · Local</div><div className="overflow-auto p-1.5">{profileModel.profiles.map(m => <button key={m.id} role="menuitemradio" aria-checked={!cloudChosen && m.active} disabled={busy || !m.found} onClick={() => choose("local", m)} title={m.description || m.label} className="w-full flex gap-2 items-center rounded-lg px-2.5 py-2 text-left hover:bg-panel-2 disabled:opacity-40"><span className="flex-1 min-w-0 truncate">{m.profileLabel || m.label}</span>{m.active && !cloudChosen && <Check size={14} className="text-accent" />}</button>)}</div></>;
  return <>
    <button ref={trigger} onClick={() => { if (open) close(); else { setOpen(true); refresh().catch(e => onError(String(e))); } }} aria-expanded={open} aria-haspopup="menu" data-testid="mode-switcher" title={label} className="flex items-center gap-1 min-w-0 max-w-64 rounded-lg px-2 py-1 text-xs text-muted hover:bg-panel hover:text-ink">{switching && <Loader2 size={12} className="animate-spin shrink-0" />}<span className="truncate">{label}</span><ChevronDown size={12} className="shrink-0" /></button>
    {open && createPortal(<>
      <div ref={menu} role="menu" aria-label="Choose model" onKeyDown={keys} className={skin} style={pos ?? { visibility: "hidden", width: 292 }}>
        {inlineProfiles ? <><button className="px-3 py-2 flex gap-1 items-center text-xs text-muted" onClick={() => setSelected(null)}><ChevronLeft size={13} />Models</button>{profiles}</> : <>
          <div className="min-h-0 overflow-y-auto p-1.5">
            <div className="px-2.5 py-1.5 text-xs text-muted">Local models</div>
            {models.map(m => <button key={m.id} role="menuitem" aria-haspopup="menu" aria-expanded={selected === m.id} onMouseEnter={e => { row.current = e.currentTarget; setSelected(m.id); }} onKeyDown={e => { if (e.key === "ArrowRight") { e.preventDefault(); row.current = e.currentTarget; setSelected(m.id); requestAnimationFrame(() => submenu.current?.querySelector<HTMLButtonElement>("button")?.focus()); } }} onClick={e => { row.current = e.currentTarget; setSelected(m.id); }} className={`w-full flex gap-2 items-center rounded-lg px-2.5 py-2 text-left hover:bg-panel-2 ${selected === m.id ? "bg-panel-2" : ""}`}><span className="flex-1 min-w-0 truncate">{m.label}</span>{m.profiles.some(p => p.active) && !cloudChosen && <Check size={14} className="text-accent" />}<ChevronRight size={13} className="text-muted shrink-0" /></button>)}
            {!models.length && <p className="px-2.5 py-2 text-xs text-muted">Choose profiles in Settings → Model.</p>}
            {config?.routing === "auto" && <button role="menuitemradio" aria-checked={!route?.model} disabled={busy} onMouseEnter={() => setSelected(null)} onClick={() => choose(null)} className="w-full px-2.5 py-2 text-left rounded-lg hover:bg-panel-2">Automatic · local first</button>}
            <div className="px-2.5 pt-3 pb-1 text-xs text-muted">Cloud models</div>
            {clouds.map(c => <button key={c.value} role="menuitemradio" aria-checked={!forced && route?.model === c.value} disabled={busy || !!forced} onMouseEnter={() => setSelected(null)} onClick={() => choose(c.value)} className="w-full flex gap-2 items-center px-2.5 py-2 rounded-lg text-left hover:bg-panel-2 disabled:opacity-40"><span className="flex-1 min-w-0"><span className="block truncate">{c.label}</span><span className="block text-[11px] text-muted truncate">{c.provider} · Cloud</span></span>{route?.model === c.value && !forced && <Check size={14} className="text-accent" />}</button>)}
            {!clouds.length && <p className="px-2.5 py-1 text-xs text-muted">Choose cloud models in Settings → Cloud.</p>}
            {forced && <p className="px-2.5 py-1.5 text-[11px] text-muted">{route?.offline ? "Offline: this chat stays local." : route?.locked ? "Sensitive chat: kept local." : "Local only is on in Settings → Cloud."}</p>}
            {config?.routing === "local" && !route?.offline && !route?.locked && clouds.length > 0 && <button role="menuitem" disabled={busy} className="px-2.5 py-1 text-xs text-accent" onClick={async () => { try { await invoke("route_mode_set", { mode: "manual" }); cloudChanged(); await refresh(); } catch (e) { onError(String(e)); } }}>Enable cloud choices</button>}
            {route?.locked && <button role="menuitem" disabled={busy} className="px-2.5 py-1 text-xs text-accent" onClick={async () => { if (!conv || !confirm("Allow this chat to be considered for cloud routing again? The privacy filter still checks future requests.")) return; try { await invoke("chat_unlock", { conv }); await refresh(); cloudChanged(); } catch (e) { onError(String(e)); } }}>Unlock chat</button>}
          </div>
          {effort && <div className="border-t border-line p-2.5 shrink-0"><div className="text-xs text-muted mb-1.5">Local thinking effort</div><div className="flex gap-1 bg-panel-2 rounded-lg p-0.5" role="radiogroup" aria-label="Thinking effort">{effort.options.map(o => <button key={o} role="radio" aria-checked={effort.effort === o} disabled={!ready || busy} onClick={async () => { try { setEffort(await invoke("effort_set", { effort: o })); } catch (e) { onError(String(e)); } }} className={`flex-1 min-w-0 rounded-md py-1 text-xs capitalize disabled:opacity-40 ${effort.effort === o ? "bg-card text-ink" : "text-muted hover:text-ink"}`}>{o}</button>)}</div>{effort.override && <button disabled={!ready || busy} className="text-xs text-muted mt-1" onClick={async () => { try { setEffort(await invoke("effort_set", { effort: null })); } catch (e) { onError(String(e)); } }}>Reset to {effort.config || "default"}</button>}</div>}
          {reason && <p className="px-3 py-2 border-t border-line text-[11px] text-muted break-words">{reason}</p>}
          {conv && <button className="shrink-0 px-3 py-2 text-left border-t border-line text-xs text-accent" onClick={async () => { try { setSent(await invoke("route_last_sent", { conv })); } catch (e) { onError(String(e)); } }}>View last cloud request</button>}
        </>}
      </div>
      {selected && subPos && <div ref={submenu} role="menu" aria-label={`${profileModel?.label} profiles`} onKeyDown={keys} className={skin} style={subPos}>{profiles}</div>}
    </>, document.body)}
    {sent !== undefined && createPortal(<div className="fixed inset-0 z-[90] bg-black/40 p-4 grid place-items-center" onClick={() => setSent(undefined)}><div role="dialog" aria-label="Last cloud request" className="w-full max-w-2xl max-h-[80vh] flex flex-col rounded-xl bg-panel border border-line p-4" onClick={e => e.stopPropagation()}><div className="flex justify-between gap-4 mb-3"><span>Last cloud request</span><button onClick={() => setSent(undefined)}>Close</button></div><pre className="min-h-0 overflow-auto whitespace-pre-wrap break-all select-text text-xs">{JSON.stringify(sent, null, 2)}</pre></div></div>, document.body)}
  </>;
}
