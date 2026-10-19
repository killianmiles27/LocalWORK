import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";

type Mode = { id: string; label: string; group: string; config: string; context: number | null; found: boolean; active: boolean };
type Cfg = Record<string, any> & { args: string[] };
type Field = { key: string; label: string; type?: "number" | "text" | "boolean"; default?: unknown; help?: string };
type StoreItem = { id: string; dir: string; name: string; version: string; description: string; author?: string; state: "new" | "installed" | "update"; installedVersion?: string; runsPrograms: boolean };
type StoreList = { source: string; branch: string; official: boolean; plugins: StoreItem[] };
type PluginRow = { id: string; name: string; version: string; description: string; enabled: boolean; source: string; dir: string; contributes: string[]; error?: string; settingsSchema?: Field[]; settings?: Record<string, unknown>; author?: string; homepage?: string };

/** The official plugin repository. Each folder there is one plugin; the store in Settings installs from it. */
export const PLUGIN_GALLERY = "https://github.com/killianmiles27/LocalWORK-plugins";

const h3 = "text-xs font-medium text-muted uppercase tracking-wide mb-1";
const inp = "rounded-lg border border-line bg-panel px-2 py-1 text-sm min-w-0 w-full";
const CONTEXTS = [16384, 32768, 65536, 131072, 262144];
const k = (n: number) => (n >= 1024 ? Math.round(n / 1024) + "K" : String(n));

const getArg = (a: string[], flag: string) => { const i = a.indexOf(flag); return i >= 0 && i + 1 < a.length && !a[i + 1].startsWith("--") ? a[i + 1] : null; };
function setArg(a: string[], flag: string, v: string | null): string[] {
  const out = [...a];
  const i = out.indexOf(flag);
  const hasValue = i >= 0 && i + 1 < out.length && !out[i + 1].startsWith("--");
  if (v == null) { if (i >= 0) out.splice(i, hasValue ? 2 : 1); return out; }
  if (i < 0) out.push(flag, v); else if (hasValue) out[i + 1] = v; else out.splice(i + 1, 0, v);
  return out;
}
const quantOf = (file: string | null) => file?.match(/(IQ\d_[A-Z]+|Q\d_[A-Z0-9_]+|Q\d_\d|BF16|F16|FP8)/i)?.[1]?.toUpperCase() ?? "–";
const base = (p: string | null) => (p ? p.split(/[\\/]/).pop() : "–");

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="grid grid-cols-[10rem_1fr] items-center gap-3 py-1 text-sm">
      <span><span>{label}</span>{hint && <span className="block text-[11px] text-muted leading-tight">{hint}</span>}</span>
      <span className="min-w-0">{children}</span>
    </label>
  );
}

/** Edit a Strata run config: context, KV cache, weights, speculation, sampling and effort. */
export function ModelEditor({ state }: { state: string }) {
  const [modes, setModes] = useState<Mode[]>([]);
  const [path, setPath] = useState("");
  const [orig, setOrig] = useState<Cfg | null>(null);
  const [cfg, setCfg] = useState<Cfg | null>(null);
  const [raw, setRaw] = useState<string | null>(null);
  const [newName, setNewName] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const loadModes = () => invoke<{ modes: Mode[] }>("modes_list").then(r => { setModes(r.modes); setPath(p => p || r.modes.find(m => m.active)?.config || r.modes[0]?.config || ""); }).catch(e => setMsg(String(e)));
  useEffect(() => { loadModes(); }, [state]);
  useEffect(() => {
    if (!path) return;
    setMsg(""); setRaw(null); setNewName(null);
    invoke<Cfg>("run_config_read", { path }).then(c => { setOrig(c); setCfg(c); }).catch(e => { setOrig(null); setCfg(null); setMsg(String(e)); });
  }, [path]);

  const mode = modes.find(m => m.config === path);
  const dirty = useMemo(() => JSON.stringify(cfg) !== JSON.stringify(orig), [cfg, orig]);
  if (!modes.length) return <section><h3 className={h3}>Model configuration</h3><p className="text-sm text-muted">No run configs found. Choose a Strata folder and configuration under Setup below.</p>{msg && <p className="text-xs text-red-600">{msg}</p>}</section>;

  const args = cfg?.args ?? [];
  const arg = (f: string) => getArg(args, f);
  const put = (f: string, v: string | null) => setCfg(c => c && { ...c, args: setArg(c.args, f, v) });
  const putKey = (key: string, v: any) => setCfg(c => { if (!c) return c; const n = { ...c }; if (v === "" || v == null) delete n[key]; else n[key] = v; return n; });
  const putSampling = (key: string, v: string) => setCfg(c => { if (!c) return c; const s = { ...(c.sampling ?? {}) }; if (v === "") delete s[key]; else s[key] = Number(v); return { ...c, sampling: s }; });
  const ctx = Number(arg("--max-context") ?? 0);

  async function pickWeights() {
    const f = await open({ title: "Choose model weights (GGUF)", filters: [{ name: "GGUF", extensions: ["gguf"] }] });
    if (typeof f !== "string" || !cfg) return;
    const was = arg("--native");
    let a = setArg(cfg.args, "--native", f);
    if (was && getArg(a, "--ple-gguf") === was) a = setArg(a, "--ple-gguf", f);
    setCfg({ ...cfg, args: a });
  }
  async function pickPack() {
    const d = await open({ title: "Choose the model pack folder", directory: true });
    if (typeof d === "string") put("--pack", d);
  }

  async function save(reload: boolean) {
    if (!cfg) return;
    let body: Cfg = cfg;
    if (raw != null) { try { body = JSON.parse(raw); } catch (e) { setMsg("JSON: " + String(e)); return; } }
    setBusy(true); setMsg("");
    try {
      const saved = await invoke<string>("run_config_save", { path, config: body, newName: newName?.trim() || null });
      const r = await invoke<{ modes: Mode[] }>("modes_list");
      setModes(r.modes);
      const m = r.modes.find(x => x.config.toLowerCase() === saved.toLowerCase());
      if (reload && m) { await invoke("mode_switch", { id: m.id, reload: true }); setMsg("Saved. The model is reloading with the new settings."); }
      else setMsg(newName ? `Saved as a new profile. Pick it from the model menu in the composer.` : mode?.active ? "Saved. Reload the model to apply it." : "Saved.");
      if (saved.toLowerCase() !== path.toLowerCase()) setPath(saved); else { setOrig(body); setCfg(body); setRaw(null); }
      setNewName(null);
    } catch (e) { setMsg(String(e)); }
    finally { setBusy(false); }
  }

  return (
    <section>
      <h3 className={h3}>Model configuration</h3>
      <Field label="Profile">
        <select className={inp} value={path} onChange={e => setPath(e.target.value)}>
          {Array.from(new Set(modes.map(m => m.group))).map(g => (
            <optgroup key={g} label={g}>{modes.filter(m => m.group === g).map(m => <option key={m.id} value={m.config} disabled={!m.found}>{m.label}{m.context ? ` · ${k(m.context)}` : ""}{m.active ? " (in use)" : ""}</option>)}</optgroup>
          ))}
        </select>
      </Field>
      {cfg && raw == null && <>
        <Field label="Model weights" hint={`Quant ${quantOf(arg("--native"))}`}>
          <span className="flex gap-2"><span className="flex-1 truncate text-muted py-1" title={arg("--native") ?? ""}>{base(arg("--native"))}</span><button type="button" onClick={pickWeights} className="rounded-lg border border-line px-2 py-0.5 text-xs hover:border-accent">Change…</button></span>
        </Field>
        {arg("--pack") != null && <Field label="Model pack">
          <span className="flex gap-2"><span className="flex-1 truncate text-muted py-1" title={arg("--pack") ?? ""}>{base(arg("--pack"))}</span><button type="button" onClick={pickPack} className="rounded-lg border border-line px-2 py-0.5 text-xs hover:border-accent">Change…</button></span>
        </Field>}
        <Field label="Context window" hint="Longer uses more memory">
          <select className={inp} value={CONTEXTS.includes(ctx) ? ctx : "custom"} onChange={e => e.target.value !== "custom" && put("--max-context", e.target.value)}>
            {CONTEXTS.map(c => <option key={c} value={c}>{k(c)} tokens</option>)}
            {!CONTEXTS.includes(ctx) && <option value="custom">{ctx ? `${ctx.toLocaleString()} tokens` : "Not set"}</option>}
          </select>
        </Field>
        <Field label="KV cache" hint="int8 halves cache memory">
          <select className={inp} value={arg("--kv") ?? ""} onChange={e => put("--kv", e.target.value || null)}>
            <option value="">Engine default</option><option value="int8">int8</option><option value="fp16">fp16</option>
          </select>
        </Field>
        <Field label="Draft tokens" hint="Speculative decoding depth">
          <select className={inp} value={arg("--spec") ?? ""} onChange={e => put("--spec", e.target.value || null)}>
            <option value="">Off</option>{[1, 2, 3, 4].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </Field>
        {arg("--resident-budget-gib") != null && <Field label="Resident experts" hint="GiB kept in RAM">
          <input type="number" min={0} className={inp} value={arg("--resident-budget-gib") ?? ""} onChange={e => put("--resident-budget-gib", e.target.value || null)} />
        </Field>}
        <Field label="VRAM reserve" hint="MiB left free for other apps">
          <input type="number" min={0} step={256} className={inp} value={arg("--vram-reserve-mib") ?? ""} placeholder="Engine default" onChange={e => put("--vram-reserve-mib", e.target.value || null)} />
        </Field>
        <Field label="Default effort">
          <select className={inp} value={cfg.reasoning_effort ?? ""} onChange={e => putKey("reasoning_effort", e.target.value)}>
            <option value="">Model default</option>{["none", "low", "medium", "high"].map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </Field>
        <Field label="Sampling" hint="Temperature · top-p · top-k">
          <span className="grid grid-cols-3 gap-2">
            <input aria-label="Temperature" type="number" step={0.05} min={0} max={2} className={inp} value={cfg.sampling?.temperature ?? ""} onChange={e => putSampling("temperature", e.target.value)} />
            <input aria-label="Top-p" type="number" step={0.01} min={0} max={1} className={inp} value={cfg.sampling?.top_p ?? ""} onChange={e => putSampling("top_p", e.target.value)} />
            <input aria-label="Top-k" type="number" step={1} min={0} className={inp} value={cfg.sampling?.top_k ?? ""} onChange={e => putSampling("top_k", e.target.value)} />
          </span>
        </Field>
        <Field label="Unload when idle" hint="Minutes; empty keeps it loaded">
          <input type="number" min={0} className={inp} value={cfg.idle_unload_s ? Math.round(cfg.idle_unload_s / 60) : ""} onChange={e => putKey("idle_unload_s", e.target.value ? Number(e.target.value) * 60 : null)} />
        </Field>
      </>}
      {raw != null && <textarea aria-label="Run config JSON" spellCheck={false} value={raw} onChange={e => setRaw(e.target.value)} className={inp + " font-mono text-xs h-64 mt-1"} />}
      {cfg && <div className="flex flex-wrap items-center gap-2 mt-2">
        {newName == null
          ? <>
              {mode?.active && <button disabled={busy || (!dirty && raw == null)} onClick={() => save(true)} className="rounded-lg bg-accent text-accent-fg px-3 py-1 text-sm disabled:opacity-40">Save and reload</button>}
              <button disabled={busy || (!dirty && raw == null)} onClick={() => save(false)} className="rounded-lg border border-line px-3 py-1 text-sm hover:border-accent disabled:opacity-40">Save</button>
              <button disabled={busy} onClick={() => setNewName(`${mode?.label ?? "Profile"} copy`)} className="rounded-lg border border-line px-3 py-1 text-sm hover:border-accent disabled:opacity-40">Save as new…</button>
              {dirty && <button onClick={() => { setCfg(orig); setRaw(null); }} className="text-xs text-muted underline">Discard</button>}
              <button onClick={() => setRaw(r => (r == null ? JSON.stringify(cfg, null, 2) : null))} className="ml-auto text-xs text-muted underline">{raw == null ? "Edit JSON" : "Back to form"}</button>
            </>
          : <>
              <input autoFocus className={inp + " !w-48"} value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === "Enter" && save(false)} aria-label="New profile name" />
              <button disabled={busy || !newName.trim()} onClick={() => save(false)} className="rounded-lg bg-accent text-accent-fg px-3 py-1 text-sm disabled:opacity-40">Create</button>
              <button onClick={() => setNewName(null)} className="text-xs text-muted underline">Cancel</button>
            </>}
      </div>}
      <p className="text-xs text-muted mt-2">Changes save to the profile file (the old one is backed up next to it). The executable, environment and library folders are not editable here.</p>
      {msg && <p role="status" className="text-sm mt-1 break-all">{msg}</p>}
    </section>
  );
}

export function Plugins() {
  const [list, setList] = useState<PluginRow[]>([]);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [open_, setOpen] = useState<string | null>(null);
  const load = () => invoke<PluginRow[]>("plugins_list").then(setList).catch(e => setErr(String(e)));
  useEffect(() => { load(); }, []);
  const changed = () => { load(); window.dispatchEvent(new Event("plugins-changed")); };
  async function run(f: () => Promise<unknown>) {
    setErr(""); setMsg("");
    try { await f(); } catch (e) { setErr(String(e)); }
    changed();
  }
  const toggle = (p: PluginRow, on: boolean) => {
    setList(l => l.map(x => (x.id === p.id ? { ...x, enabled: on } : x)));
    return run(() => invoke("plugin_set_enabled", { id: p.id, on }));
  };
  async function importFrom(directory: boolean) {
    const path = await open(directory ? { directory: true, title: "Choose a plugin folder" } : { filters: [{ name: "Plugin", extensions: ["zip"] }], title: "Choose a plugin .zip" });
    if (typeof path !== "string") return;
    run(async () => {
      const r = await invoke<{ name: string; runsPrograms: boolean }>("plugin_import", { path });
      setMsg(r.runsPrograms
        ? `Installed ${r.name}. It starts programs on this computer, so it is off until you turn it on. Only do that if you trust where it came from.`
        : `Installed ${r.name}.`);
    });
  }
  async function exportOne(p: PluginRow) {
    const dest = await save({ defaultPath: `${p.id}-${p.version || "plugin"}.zip`, filters: [{ name: "Plugin", extensions: ["zip"] }] });
    if (dest) run(async () => { await invoke("plugin_export", { id: p.id, dest }); setMsg(`Saved ${p.name || p.id} to ${dest}.`); });
  }
  function removeOne(p: PluginRow) {
    if (confirm(`Remove ${p.name || p.id}? Its folder is deleted from the plugins folder.`)) run(() => invoke("plugin_remove", { id: p.id }));
  }
  const btn = "rounded-lg border border-line px-2.5 py-1 text-xs hover:bg-panel-2";
  return (
    <section>
      <h3 className={h3}>Plugins</h3>
      <div className="flex flex-wrap gap-1.5 mb-2">
        <button className={btn} onClick={() => importFrom(false)}>Import .zip…</button>
        <button className={btn} onClick={() => importFrom(true)}>Import folder…</button>
        <button className={btn} onClick={() => run(() => invoke("plugins_folder"))}>Open plugins folder</button>
        <button className={btn} onClick={() => invoke("open_external", { url: PLUGIN_GALLERY }).catch(e => setErr(String(e)))}>Browse shared plugins</button>
      </div>
      {list.length === 0 && <p className="text-sm text-muted py-1">No plugins installed.</p>}
      {list.map(p => (
        <div key={p.id} className="py-2 text-sm border-b border-line last:border-0">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 flex-wrap"><span className="font-medium">{p.name || p.id}</span><span className="text-xs text-muted">{p.version}{p.author ? ` · ${p.author}` : ""} · {p.source === "user" ? "installed" : "built in"}</span></div>
              {p.description && <div className="text-xs text-muted">{p.description}</div>}
              {p.error && <div className="text-xs text-red-600 break-words">Not loaded: {p.error} <span className="text-muted">({p.dir})</span></div>}
              <div className="mt-1 flex flex-wrap items-center gap-1">
                {p.contributes.map(c => <span key={c} className="rounded bg-panel-2 px-1.5 py-0.5 text-[11px] text-muted">{c === "mcpServers" ? "runs programs" : c}</span>)}
                {!p.error && (p.settingsSchema?.length ?? 0) > 0 && <button className="text-[11px] text-muted underline" onClick={() => setOpen(open_ === p.id ? null : p.id)}>{open_ === p.id ? "Hide settings" : "Settings"}</button>}
                {!p.error && <button className="text-[11px] text-muted underline" onClick={() => exportOne(p)}>Export</button>}
                {p.source === "user" && !p.error && <button className="text-[11px] text-muted underline hover:text-red-600" onClick={() => removeOne(p)}>Remove</button>}
              </div>
            </div>
            <input type="checkbox" aria-label={`Enable ${p.name || p.id}`} checked={p.enabled} disabled={!!p.error} onChange={e => toggle(p, e.target.checked)} className="mt-1" />
          </div>
          {open_ === p.id && <PluginSettings p={p} onSaved={changed} />}
        </div>
      ))}
      <p className="text-xs text-muted mt-2">A plugin is a folder with a plugin.json; share it as a .zip. Modes and composer items update right away; skills, prompt text and tools apply to chats started afterwards.</p>
      {msg && <p role="status" className="text-xs mt-1 break-all">{msg}</p>}
      {err && <p className="text-xs text-red-600">{err}</p>}
      <PluginStore onInstalled={changed} />
    </section>
  );
}

const short = (u: string) => u.replace(/^https:\/\/github\.com\//, "");

/** Browse GitHub repositories of plugins and install from them. The official repository is listed first. */
function PluginStore({ onInstalled }: { onInstalled: () => void }) {
  const [sources, setSources] = useState<string[]>([]);
  const [lists, setLists] = useState<Record<string, StoreList | string>>({});
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const btn = "rounded-lg border border-line px-2.5 py-1 text-xs hover:bg-panel-2 disabled:opacity-40";

  const fetchOne = (src: string) => {
    setLists(l => ({ ...l, [src]: "Loading…" }));
    return invoke<StoreList>("store_list", { source: src }).then(r => setLists(l => ({ ...l, [src]: r }))).catch(e => setLists(l => ({ ...l, [src]: String(e) })));
  };
  const refresh = (list: string[]) => list.forEach(fetchOne);
  useEffect(() => { invoke<string[]>("store_sources").then(s => { setSources(s); refresh(s); }).catch(e => setNote(String(e))); }, []);

  async function saveSources(next: string[]) {
    try { const s = await invoke<string[]>("store_sources_set", { list: next }); setSources(s); return s; } catch (e) { setNote(String(e)); return null; }
  }
  async function add() {
    setNote("");
    const s = await saveSources([...sources, adding.trim()]);
    if (s) { setAdding(""); s.filter(x => !(x in lists)).forEach(fetchOne); }
  }
  async function install(src: string, it: StoreItem) {
    setBusy(it.dir); setNote("");
    try {
      const r = await invoke<{ name: string; runsPrograms: boolean }>("store_install", { source: src, dir: it.dir });
      setNote(r.runsPrograms ? `Installed ${r.name}. It starts programs on this computer, so it is off until you turn it on above.` : `Installed ${r.name}.`);
      onInstalled(); await fetchOne(src);
    } catch (e) { setNote(String(e)); }
    finally { setBusy(null); }
  }

  return (
    <div className="mt-4">
      <h3 className={h3}>Get plugins</h3>
      <p className="text-xs text-muted mb-2">Add any public GitHub repository of LocalWORK plugins. Every folder in it with a plugin.json shows up here.</p>
      <div className="flex gap-1.5 mb-2">
        <input className={inp} placeholder="github.com/owner/repo" value={adding} onChange={e => setAdding(e.target.value)} onKeyDown={e => e.key === "Enter" && adding.trim() && add()} aria-label="Plugin repository link" />
        <button className={btn} disabled={!adding.trim()} onClick={add}>Add</button>
        <button className={btn} onClick={() => refresh(sources)}>Refresh</button>
      </div>
      {sources.map(src => {
        const l = lists[src];
        return (
          <div key={src} className="rounded-lg border border-line p-2.5 mb-2">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium truncate">{short(src)}</span>
              {typeof l === "object" && l.official && <span className="rounded bg-accent/15 text-accent px-1.5 py-0.5 text-[11px]">Official</span>}
              <button className="ml-auto text-[11px] text-muted underline" onClick={() => invoke("open_external", { url: src })}>Open</button>
              <button className="text-[11px] text-muted underline hover:text-red-600" onClick={() => saveSources(sources.filter(x => x !== src))}>Remove</button>
            </div>
            {typeof l === "string" && <p className={"text-xs mt-1 " + (l === "Loading…" ? "text-muted" : "text-red-600 break-words")}>{l}</p>}
            {typeof l === "object" && l.plugins.length === 0 && <p className="text-xs text-muted mt-1">No plugins found in this repository.</p>}
            {typeof l === "object" && l.plugins.map(it => (
              <div key={it.dir} className="flex items-start gap-3 py-1.5 border-b border-line last:border-0 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 flex-wrap"><span>{it.name || it.id}</span><span className="text-xs text-muted">{it.version}{it.author ? ` · ${it.author}` : ""}</span>{it.runsPrograms && <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[11px] text-muted">runs programs</span>}</div>
                  {it.description && <div className="text-xs text-muted">{it.description}</div>}
                </div>
                {it.state === "installed"
                  ? <span className="text-xs text-muted py-1">Installed</span>
                  : <button className={btn} disabled={busy != null} onClick={() => install(src, it)}>{busy === it.dir ? "Installing…" : it.state === "update" ? `Update from ${it.installedVersion || "older"}` : "Install"}</button>}
              </div>
            ))}
          </div>
        );
      })}
      {note && <p role="status" className="text-xs mt-1 break-all">{note}</p>}
    </div>
  );
}

function PluginSettings({ p, onSaved }: { p: PluginRow; onSaved: () => void }) {
  const [vals, setVals] = useState<Record<string, unknown>>(p.settings ?? {});
  const [note, setNote] = useState("");
  async function saveAll() {
    try { setVals(await invoke("plugin_settings_set", { id: p.id, values: vals })); setNote("Saved."); onSaved(); } catch (e) { setNote(String(e)); }
  }
  return (
    <div className="mt-2 ml-1 grid gap-2 rounded-lg border border-line p-2.5">
      {(p.settingsSchema ?? []).map(f => (
        <label key={f.key} className="grid gap-0.5 text-xs">
          <span className="text-muted">{f.label}</span>
          {f.type === "boolean"
            ? <input type="checkbox" checked={!!vals[f.key]} onChange={e => setVals(v => ({ ...v, [f.key]: e.target.checked }))} />
            : <input className={inp + " !w-48"} type={f.type === "number" ? "number" : "text"} step="any" value={String(vals[f.key] ?? "")}
                onChange={e => setVals(v => ({ ...v, [f.key]: f.type === "number" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value }))} />}
          {f.help && <span className="text-muted">{f.help}</span>}
        </label>
      ))}
      <div className="flex items-center gap-2"><button onClick={saveAll} className="rounded-lg bg-accent text-accent-fg px-3 py-1 text-xs">Save</button>{note && <span className="text-xs text-muted">{note}</span>}</div>
    </div>
  );
}
