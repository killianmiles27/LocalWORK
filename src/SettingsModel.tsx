import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Button, Message, Row, Section, Toggle, input } from "./settings-ui";

type Mode = { id: string; label: string; group: string; config: string; context: number | null; found: boolean; active: boolean };
type Cfg = Record<string, any> & { args: string[] };
type Field = { key: string; label: string; type?: "number" | "text" | "boolean"; default?: unknown; help?: string };
type StoreItem = { id: string; dir: string; name: string; version: string; description: string; author?: string; state: "new" | "installed" | "update"; installedVersion?: string; runsPrograms: boolean };
type StoreList = { source: string; branch: string; official: boolean; plugins: StoreItem[] };
type PluginRow = { id: string; name: string; version: string; description: string; enabled: boolean; source: string; dir: string; contributes: string[]; error?: string; settingsSchema?: Field[]; settings?: Record<string, unknown>; author?: string; homepage?: string };

/** The official plugin repository. Each folder there is one plugin; the store in Settings installs from it. */
export const PLUGIN_GALLERY = "https://github.com/killianmiles27/LocalWORK-plugins";

const inp = input + " !w-52";
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

/** A file path shown by name, with a button to pick another. */
function PathPick({ path, onPick }: { path: string | null; onPick: () => void }) {
  return (
    <span className="flex items-center justify-end gap-2 w-52">
      <span className="flex-1 truncate text-muted text-left" title={path ?? ""}>{base(path)}</span>
      <Button small onClick={onPick}>Change</Button>
    </span>
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
  if (!modes.length) return <Section title="Profiles"><div className="px-3.5 py-3 text-sm text-muted">No model profiles found. Choose a Strata folder and configuration on the Model page.</div>{msg && <div className="px-3.5 pb-2"><Message error>{msg}</Message></div>}</Section>;

  const args = cfg?.args ?? [];
  const arg = (f: string) => getArg(args, f);
  const put = (f: string, v: string | null) => setCfg(c => c && { ...c, args: setArg(c.args, f, v) });
  const putKey = (key: string, v: any) => setCfg(c => { if (!c) return c; const n = { ...c }; if (v === "" || v == null) delete n[key]; else n[key] = v; return n; });
  const putSampling = (key: string, v: string) => setCfg(c => { if (!c) return c; const s = { ...(c.sampling ?? {}) }; if (v === "") delete s[key]; else s[key] = Number(v); return { ...c, sampling: s }; });
  const ctx = Number(arg("--max-context") ?? 0);
  const changed = dirty || raw != null;

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

  async function saveConfig(reload: boolean) {
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
      else setMsg(newName ? "Saved as a new profile. Pick it from the model menu in the composer." : mode?.active ? "Saved. Reload the model to apply it." : "Saved.");
      if (saved.toLowerCase() !== path.toLowerCase()) setPath(saved); else { setOrig(body); setCfg(body); setRaw(null); }
      setNewName(null);
    } catch (e) { setMsg(String(e)); }
    finally { setBusy(false); }
  }

  return <>
    <Section title="Profile" note="Saving writes to the profile file and keeps a backup of the old one next to it."
      action={cfg && <>
        <Button variant="ghost" small disabled={busy} onClick={() => setNewName(`${mode?.label ?? "Profile"} copy`)}>Duplicate</Button>
        <Button variant="ghost" small onClick={() => setRaw(r => (r == null ? JSON.stringify(cfg, null, 2) : null))}>{raw == null ? "Edit JSON" : "Back to form"}</Button>
      </>}>
      <Row label="Editing" hint={mode?.active ? "In use now" : "Not in use"}>
        <select className={inp} value={path} onChange={e => setPath(e.target.value)}>
          {Array.from(new Set(modes.map(m => m.group))).map(g => (
            <optgroup key={g} label={g}>{modes.filter(m => m.group === g).map(m => <option key={m.id} value={m.config} disabled={!m.found}>{m.label}{m.context ? ` · ${k(m.context)}` : ""}{m.active ? " (in use)" : ""}</option>)}</optgroup>
          ))}
        </select>
      </Row>
      {newName != null && (
        <div className="flex items-center gap-2 px-3.5 py-2.5">
          <input autoFocus className={input} value={newName} onChange={e => setNewName(e.target.value)} onKeyDown={e => e.key === "Enter" && saveConfig(false)} aria-label="New profile name" />
          <Button variant="primary" small disabled={busy || !newName.trim()} onClick={() => saveConfig(false)}>Create</Button>
          <Button variant="ghost" small onClick={() => setNewName(null)}>Cancel</Button>
        </div>
      )}
    </Section>

    {cfg && raw != null && <textarea aria-label="Run config JSON" spellCheck={false} value={raw} onChange={e => setRaw(e.target.value)} className={input + " font-mono text-xs h-80"} />}

    {cfg && raw == null && <>
      <Section title="Model and memory">
        <Row label="Model weights" hint={`Quantization ${quantOf(arg("--native"))}`}><PathPick path={arg("--native")} onPick={pickWeights} /></Row>
        {arg("--pack") != null && <Row label="Model pack"><PathPick path={arg("--pack")} onPick={pickPack} /></Row>}
        <Row label="Context window" hint="How much text the model can hold. Longer uses more memory.">
          <select className={inp} value={CONTEXTS.includes(ctx) ? ctx : "custom"} onChange={e => e.target.value !== "custom" && put("--max-context", e.target.value)}>
            {CONTEXTS.map(c => <option key={c} value={c}>{k(c)} tokens</option>)}
            {!CONTEXTS.includes(ctx) && <option value="custom">{ctx ? `${ctx.toLocaleString()} tokens` : "Not set"}</option>}
          </select>
        </Row>
        <Row label="KV cache" hint="int8 uses half the memory of fp16.">
          <select className={inp} value={arg("--kv") ?? ""} onChange={e => put("--kv", e.target.value || null)}>
            <option value="">Engine default</option><option value="int8">int8</option><option value="fp16">fp16</option>
          </select>
        </Row>
        <Row label="VRAM reserve" hint="MiB kept free for other apps.">
          <input type="number" min={0} step={256} className={inp} value={arg("--vram-reserve-mib") ?? ""} placeholder="Engine default" onChange={e => put("--vram-reserve-mib", e.target.value || null)} />
        </Row>
        {arg("--resident-budget-gib") != null && <Row label="Resident experts" hint="GiB of experts kept in system memory.">
          <input type="number" min={0} className={inp} value={arg("--resident-budget-gib") ?? ""} onChange={e => put("--resident-budget-gib", e.target.value || null)} />
        </Row>}
        <Row label="Unload when idle" hint="Minutes. Leave empty to keep the model loaded.">
          <input type="number" min={0} className={inp} value={cfg.idle_unload_s ? Math.round(cfg.idle_unload_s / 60) : ""} placeholder="Never" onChange={e => putKey("idle_unload_s", e.target.value ? Number(e.target.value) * 60 : null)} />
        </Row>
      </Section>

      <Section title="Generation">
        <Row label="Default effort" hint="How long the model thinks before answering.">
          <select className={inp} value={cfg.reasoning_effort ?? ""} onChange={e => putKey("reasoning_effort", e.target.value)}>
            <option value="">Model default</option>{["none", "low", "medium", "high"].map(o => <option key={o} value={o}>{o[0].toUpperCase() + o.slice(1)}</option>)}
          </select>
        </Row>
        <Row label="Draft tokens" hint="Speculative decoding. Usually faster, same output.">
          <select className={inp} value={arg("--spec") ?? ""} onChange={e => put("--spec", e.target.value || null)}>
            <option value="">Off</option>{[1, 2, 3, 4].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </Row>
        <Row label="Temperature" hint="Higher is more varied, lower is more focused.">
          <input aria-label="Temperature" type="number" step={0.05} min={0} max={2} className={inp} placeholder="Model default" value={cfg.sampling?.temperature ?? ""} onChange={e => putSampling("temperature", e.target.value)} />
        </Row>
        <Row label="Top-p">
          <input aria-label="Top-p" type="number" step={0.01} min={0} max={1} className={inp} placeholder="Model default" value={cfg.sampling?.top_p ?? ""} onChange={e => putSampling("top_p", e.target.value)} />
        </Row>
        <Row label="Top-k">
          <input aria-label="Top-k" type="number" step={1} min={0} className={inp} placeholder="Model default" value={cfg.sampling?.top_k ?? ""} onChange={e => putSampling("top_k", e.target.value)} />
        </Row>
      </Section>
    </>}

    {(changed || msg) && newName == null && (
      <div className="sticky bottom-0 -mx-6 -mb-6 px-6 py-3 border-t border-line bg-bg/95 backdrop-blur flex items-center gap-2">
        <span className="text-xs text-muted flex-1 min-w-0 break-words" role="status">{msg || "Unsaved changes"}</span>
        {changed && <>
          <Button variant="ghost" small onClick={() => { setCfg(orig); setRaw(null); setMsg(""); }}>Discard</Button>
          <Button small={!mode?.active} variant={mode?.active ? "default" : "primary"} disabled={busy} onClick={() => saveConfig(false)}>Save</Button>
          {mode?.active && <Button variant="primary" disabled={busy} onClick={() => saveConfig(true)}>Save and reload</Button>}
        </>}
      </div>
    )}
  </>;
}

export function Plugins() {
  const [view, setView] = useState<"installed" | "store">("installed");
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
        ? `Installed ${r.name}. It starts programs on this computer, so it stays off until you turn it on. Only do that if you trust where it came from.`
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
  const seg = (v: typeof view, label: string) => (
    <button onClick={() => setView(v)} aria-pressed={view === v}
      className={"rounded-md px-3 py-1 text-sm transition-colors " + (view === v ? "bg-card text-ink shadow-sm" : "text-muted hover:text-ink")}>{label}</button>
  );
  return <>
    <div className="inline-flex rounded-lg bg-panel-2 p-0.5">{seg("installed", "Installed")}{seg("store", "Get plugins")}</div>
    {view === "store" ? <PluginStore onInstalled={changed} /> : (
      <Section title="Installed plugins" note="Modes and composer items update right away. Skills, prompt text and tools apply to new chats."
        action={<>
          <Button variant="ghost" small onClick={() => importFrom(false)}>Import .zip</Button>
          <Button variant="ghost" small onClick={() => importFrom(true)}>Import folder</Button>
          <Button variant="ghost" small onClick={() => run(() => invoke("plugins_folder"))}>Open folder</Button>
        </>}>
        {list.length === 0 && <div className="px-3.5 py-3 text-sm text-muted">No plugins installed.</div>}
        {list.map(p => (
          <div key={p.id} className="px-3.5 py-3 text-sm">
            <div className="flex items-start gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="font-medium">{p.name || p.id}</span>
                  <span className="text-xs text-muted">{[p.version, p.author, p.source === "user" ? null : "built in"].filter(Boolean).join(" · ")}</span>
                  {p.contributes.includes("mcpServers") && <span className="rounded-md bg-panel-2 px-1.5 py-px text-[11px] text-muted">Runs programs</span>}
                </div>
                {p.description && <div className="text-xs text-muted mt-0.5">{p.description}</div>}
                {p.error && <div className="text-xs text-red-500 break-words mt-0.5">Not loaded: {p.error}</div>}
                <div className="mt-1.5 -ml-2 flex flex-wrap items-center gap-0.5">
                  {!p.error && (p.settingsSchema?.length ?? 0) > 0 && <Button variant="ghost" small onClick={() => setOpen(open_ === p.id ? null : p.id)}>{open_ === p.id ? "Hide options" : "Options"}</Button>}
                  {!p.error && <Button variant="ghost" small onClick={() => exportOne(p)}>Export</Button>}
                  {p.source === "user" && <Button variant="danger" small onClick={() => removeOne(p)}>Remove</Button>}
                </div>
              </div>
              <span className="mt-0.5"><Toggle label={`Enable ${p.name || p.id}`} checked={p.enabled} disabled={!!p.error} onChange={on => toggle(p, on)} /></span>
            </div>
            {open_ === p.id && <PluginSettings p={p} onSaved={changed} />}
          </div>
        ))}
      </Section>
    )}
    <Message>{msg}</Message>
    <Message error>{err}</Message>
  </>;
}

const short = (u: string) => u.replace(/^https:\/\/github\.com\//, "");

/** Browse GitHub repositories of plugins and install from them. The official repository is listed first. */
function PluginStore({ onInstalled }: { onInstalled: () => void }) {
  const [sources, setSources] = useState<string[]>([]);
  const [lists, setLists] = useState<Record<string, StoreList | string>>({});
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");

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
      setNote(r.runsPrograms ? `Installed ${r.name}. It starts programs on this computer, so it stays off until you turn it on under Installed.` : `Installed ${r.name}.`);
      onInstalled(); await fetchOne(src);
    } catch (e) { setNote(String(e)); }
    finally { setBusy(null); }
  }

  return <>
    {sources.map(src => {
      const l = lists[src];
      return (
        <Section key={src} title={short(src)}
          action={<>
            {typeof l === "object" && l.official && <span className="rounded-md bg-accent/15 text-accent px-1.5 py-px text-[11px] mr-1">Official</span>}
            <Button variant="ghost" small onClick={() => invoke("open_external", { url: src })}>Open on GitHub</Button>
            {!(typeof l === "object" && l.official) && <Button variant="danger" small onClick={() => saveSources(sources.filter(x => x !== src))}>Remove</Button>}
          </>}>
          {typeof l === "string" && <div className={"px-3.5 py-3 text-sm " + (l === "Loading…" ? "text-muted" : "text-red-500 break-words")}>{l}</div>}
          {typeof l === "object" && l.plugins.length === 0 && <div className="px-3.5 py-3 text-sm text-muted">No plugins found in this repository.</div>}
          {typeof l === "object" && l.plugins.map(it => (
            <Row key={it.dir}
              label={<span className="flex items-baseline gap-2 flex-wrap"><span className="font-medium">{it.name || it.id}</span><span className="text-xs text-muted">{[it.version, it.author].filter(Boolean).join(" · ")}</span>{it.runsPrograms && <span className="rounded-md bg-panel-2 px-1.5 py-px text-[11px] text-muted">Runs programs</span>}</span>}
              hint={it.description}>
              {it.state === "installed"
                ? <span className="text-xs text-muted">Installed</span>
                : <Button variant={it.state === "update" ? "primary" : "default"} small disabled={busy != null} onClick={() => install(src, it)}>{busy === it.dir ? "Installing…" : it.state === "update" ? "Update" : "Install"}</Button>}
            </Row>
          ))}
        </Section>
      );
    })}
    <Section title="Add a source" note="Any public GitHub repository of LocalWORK plugins. Every folder with a plugin.json shows up.">
      <div className="flex gap-2 px-3.5 py-2.5">
        <input className={input} placeholder="github.com/owner/repo" value={adding} onChange={e => setAdding(e.target.value)} onKeyDown={e => e.key === "Enter" && adding.trim() && add()} aria-label="Plugin repository link" />
        <Button disabled={!adding.trim()} onClick={add}>Add</Button>
        <Button variant="ghost" onClick={() => refresh(sources)}>Refresh</Button>
      </div>
    </Section>
    <Message>{note}</Message>
  </>;
}

function PluginSettings({ p, onSaved }: { p: PluginRow; onSaved: () => void }) {
  const [vals, setVals] = useState<Record<string, unknown>>(p.settings ?? {});
  const [note, setNote] = useState("");
  async function saveAll() {
    try { setVals(await invoke("plugin_settings_set", { id: p.id, values: vals })); setNote("Saved."); onSaved(); } catch (e) { setNote(String(e)); }
  }
  return (
    <div className="mt-2.5 rounded-lg bg-panel divide-y divide-line">
      {(p.settingsSchema ?? []).map(f => (
        <Row key={f.key} label={f.label} hint={f.help}>
          {f.type === "boolean"
            ? <Toggle label={f.label} checked={!!vals[f.key]} onChange={on => setVals(v => ({ ...v, [f.key]: on }))} />
            : <input className={inp} type={f.type === "number" ? "number" : "text"} step="any" value={String(vals[f.key] ?? "")}
                onChange={e => setVals(v => ({ ...v, [f.key]: f.type === "number" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value }))} />}
        </Row>
      ))}
      <div className="flex items-center gap-2 px-3.5 py-2.5"><Button variant="primary" small onClick={saveAll}>Save</Button>{note && <span className="text-xs text-muted">{note}</span>}</div>
    </div>
  );
}
