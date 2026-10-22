import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import DownloadProgress, { type DownloadState } from "./DownloadProgress";
import { getVersion } from "@tauri-apps/api/app";
import { open } from "@tauri-apps/plugin-dialog";
import { AppWindow, Cloud, Cpu, Globe, Puzzle, SlidersHorizontal, X } from "lucide-react";
import CloudSettings from "./CloudSettings";
import ModelLibrary from "./ModelLibrary";
import LocalPickerSettings from "./LocalPickerSettings";
import { ModelEditor, Plugins } from "./SettingsModel";
import { Button, Message, Meter, Row, Section, ToggleRow, Value, input } from "./settings-ui";

const TABS = [
  { id: "Model", icon: Cpu },
  { id: "Tuning", icon: SlidersHorizontal },
  { id: "Cloud", icon: Cloud },
  { id: "Plugins", icon: Puzzle },
  { id: "Connections", icon: Globe },
  { id: "App", icon: AppWindow },
] as const;
type Tab = (typeof TABS)[number]["id"];

type Info = { cpu?: { name: string; load: number; server_ram_gib: number | null }; model: string; quant: string; file: string; context: string | null; kv: string | null; status: any; live: any };
type St = { state: string; detail: string; port: number; model: string };

const num = (v: unknown, d = 1) => (typeof v === "number" && isFinite(v) ? v.toFixed(d) : "–");
const dur = (s?: number) => (typeof s !== "number" ? "" : s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : s >= 60 ? `${Math.floor(s / 60)} min` : `${s} s`);
const STATE_DOT: Record<string, string> = { ready: "bg-sage", stopped: "bg-muted", error: "bg-red-500" };
const STATE_TEXT: Record<string, string> = { ready: "Ready", stopped: "Stopped", error: "Error", starting: "Starting", loading: "Loading" };

export default function Settings({ status, onClose, showTps, onShowTps }: { status: St; onClose: () => void; showTps: boolean; onShowTps: (on: boolean) => void }) {
  const [tab, setTab] = useState<Tab>(() => {
    const saved = sessionStorage.getItem("settings-tab");
    return TABS.some(t => t.id === saved) ? saved as Tab : "Model";
  });
  useEffect(() => { try { sessionStorage.setItem("settings-tab", tab); } catch { /* ignore */ } }, [tab]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, []);

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div role="dialog" aria-label="Settings" className="w-full max-w-3xl h-[min(46rem,calc(100dvh-2rem))] flex max-[640px]:flex-col overflow-hidden rounded-2xl bg-bg border border-line shadow-xl" onClick={(e) => e.stopPropagation()}>
        <nav aria-label="Settings sections" className="w-44 max-[640px]:w-full shrink-0 border-r max-[640px]:border-r-0 max-[640px]:border-b border-line bg-panel p-2 flex flex-col max-[640px]:flex-row max-[640px]:overflow-x-auto gap-0.5">
          <h2 className="px-2.5 pt-1.5 pb-3 text-base font-semibold max-[640px]:hidden">Settings</h2>
          {TABS.map(({ id, icon: Icon }) => (
            <button key={id} aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)}
              className={"flex items-center gap-2.5 w-full max-[640px]:w-auto max-[640px]:shrink-0 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors " + (tab === id ? "bg-panel-2 text-ink" : "text-muted hover:bg-panel-2 hover:text-ink")}>
              <Icon size={15} strokeWidth={1.8} className={tab === id ? "text-accent" : ""} />{id}
            </button>
          ))}
        </nav>
        <div className="min-w-0 min-h-0 flex-1 flex flex-col">
          <div className="flex items-center justify-between pl-6 pr-3 h-12 shrink-0">
            <h2 className="text-base font-semibold">{tab}</h2>
            <button onClick={onClose} title="Close" aria-label="Close" className="p-1.5 rounded-lg text-muted hover:text-ink hover:bg-panel-2"><X size={17} /></button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto px-3 sm:px-6 pb-6 space-y-6">
            {tab === "Model" && <ModelTab status={status} showTps={showTps} onShowTps={onShowTps} />}
            {tab === "Tuning" && <ModelEditor state={status.state} />}
            {tab === "Cloud" && <CloudSettings />}
            {tab === "Plugins" && <Plugins />}
            {tab === "Connections" && <ConnectionsTab />}
            {tab === "App" && <AppTab />}
          </div>
        </div>
      </div>
    </div>
  );
}

function ModelTab({ status, showTps, onShowTps }: { status: St; showTps: boolean; onShowTps: (on: boolean) => void }) {
  const [info, setInfo] = useState<Info | null>(null);
  useEffect(() => {
    let alive = true;
    const pull = () => invoke<Info>("model_info").then((i) => { if (alive) setInfo(i); }).catch(() => {});
    pull();
    const t = setInterval(pull, 2000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const st = info?.status ?? null;
  const gpu = st?.machine?.gpu;
  const ram = st?.machine?.ram;
  const last = st?.last_timings;
  const live = info?.live;
  const generating = typeof live?.tokens_per_s === "number";
  const tps = generating ? live.tokens_per_s : last?.predicted_per_second;
  const pre = last?.prompt_per_second;
  const stopped = status.state === "stopped" || status.state === "error";
  const gpuStats = gpu ? [gpu.util_pct != null && `${gpu.util_pct}% load`, gpu.temp_c != null && `${gpu.temp_c}°C`, gpu.power_w != null && `${num(gpu.power_w, 0)} W`].filter(Boolean).join(" · ") : "";

  return <>
    <Section title="Current model">
      <div className="flex items-center gap-4 px-3.5 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="font-semibold truncate">{info?.model || status.model || "No model"}</span>
            {info?.quant && <span className="shrink-0 rounded-md bg-panel-2 px-1.5 py-px text-[11px] text-muted">{info.quant}</span>}
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted mt-0.5">
            <span className={`size-1.5 rounded-full ${STATE_DOT[status.state] ?? "bg-gold"}`} />
            {STATE_TEXT[status.state] ?? status.state}{status.state === "ready" && st?.uptime_s != null ? ` for ${dur(st.uptime_s)}` : ""}
          </div>
        </div>
        <Button variant={stopped ? "primary" : "default"} onClick={() => invoke(stopped ? "model_start" : "model_stop").catch(error => window.alert(String(error)))}>{stopped ? "Start model" : "Stop model"}</Button>
      </div>
      <Row label="Context window"><Value>{info?.context ? `${Number(info.context).toLocaleString()} tokens` : "–"}</Value></Row>
      <Row label="KV cache"><Value>{info?.kv || "–"}</Value></Row>
      <Row label="Engine version"><Value>{st?.engine ? String(st.engine) : "–"}</Value></Row>
    </Section>

    <Section title="Speed">
      <Row label={generating ? "Generating now" : "Last reply"} hint={generating ? `Average this reply: ${num(live.tokens_per_s_mean)} tokens/s` : undefined}><Value>{tps != null ? `${num(tps)} tokens/s` : "–"}</Value></Row>
      <Row label="Reading the prompt"><Value>{pre != null ? `${num(pre, 0)} tokens/s` : "–"}</Value></Row>
      <ToggleRow label="Show tokens per second in composer" checked={showTps} onChange={async on => { onShowTps(on); try { await invoke("set_setting", { key: "show_tps", value: on ? "1" : "0" }); } catch (error) { onShowTps(!on); window.alert(String(error)); } }} />
    </Section>

    <Section title="Hardware">
      <Row label="Graphics card" hint={[gpu?.name, gpuStats].filter(Boolean).join(" · ") || undefined}>
        {gpu ? <Meter used={gpu.used_mib ?? 0} total={gpu.total_mib ?? 0} text={`${num((gpu.used_mib ?? 0) / 1024)} / ${num((gpu.total_mib ?? 0) / 1024)} GiB`} /> : <Value>–</Value>}
      </Row>
      <Row label="Memory" hint={info?.cpu?.server_ram_gib != null ? `Model server uses ${num(info.cpu.server_ram_gib)} GiB` : undefined}>
        {ram ? <Meter used={ram.used_gib} total={ram.total_gib} text={`${num(ram.used_gib)} / ${num(ram.total_gib)} GiB`} /> : <Value>–</Value>}
      </Row>
      <Row label="Processor" hint={info?.cpu?.name}><Value>{info?.cpu ? `${num(info.cpu.load, 0)}% load` : "–"}</Value></Row>
    </Section>

    <LocalPickerSettings />
    <EngineSetup />
    <ModelLibrary onChanged={() => window.dispatchEvent(new Event("cloud-changed"))} />
  </>;
}

type Chk = { git: boolean; message?: string; head?: string; behind?: number; changes?: string[] };
type Applied = { ok: boolean; before: string; after: string; restart: string | null; log_tail: string };

/** Where Strata lives, which configuration it starts, and engine updates. */
function EngineSetup() {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");
  const [chk, setChk] = useState<Chk | null>(null);
  const [res, setRes] = useState<Applied | null>(null);
  const [err, setErr] = useState("");

  async function choose(config: boolean) {
    setMessage(""); setErr("");
    try {
      const path = await open(config
        ? { title: "Choose your Strata model configuration", filters: [{ name: "JSON", extensions: ["json"] }] }
        : { title: "Choose your Strata or PolyStrata folder", directory: true });
      if (typeof path === "string") {
        await invoke(config ? "set_model_config" : "set_strata_root", { path });
        setMessage("Saved. Stop and start the model to use it.");
      }
    } catch (error) { setErr(String(error)); }
  }
  async function check() {
    setBusy("Checking…"); setErr(""); setRes(null); setMessage("");
    try { setChk(await invoke<Chk>("strata_update_check")); } catch (e) { setErr(String(e)); }
    setBusy("");
  }
  async function apply() {
    if (!confirm("Update the model engine now? The model stops, updates and restarts. Open chats are interrupted.")) return;
    setBusy("Updating… this can take a few minutes"); setErr("");
    try { setRes(await invoke<Applied>("strata_update_apply")); setChk(null); } catch (e) { setErr(String(e)); }
    setBusy("");
  }

  return (
    <Section title="Engine and setup">
      <Row label="Engine folder" hint="Strata or PolyStrata. PolyStrata adds GLM, DeepSeek, Gemma and more.">
        <Button small onClick={() => choose(false)}>Choose Strata folder</Button>
      </Row>
      <Row label="Model configuration" hint="Picks the model files and launch options.">
        <Button small onClick={() => choose(true)}>Choose model configuration</Button>
      </Row>
      <Row label="Engine updates" hint={busy || (chk?.git && chk.behind === 0 ? `Up to date (${chk.head})` : chk && !chk.git ? chk.message : "Checking changes nothing until you confirm.")}>
        <Button small disabled={!!busy} onClick={check}>Check for updates</Button>
      </Row>
      {chk?.git && !!chk.behind && (
        <div className="px-3.5 py-2.5 text-sm">
          {chk.behind} new change{chk.behind > 1 ? "s" : ""}:
          <ul className="list-disc ml-5 text-xs text-muted my-1.5 space-y-0.5">{chk.changes?.map((c, i) => <li key={i}>{c}</li>)}</ul>
          <Button variant="primary" small onClick={apply}>Update and restart the model</Button>
        </div>
      )}
      {res && (
        <div className="px-3.5 py-2.5 text-sm">
          {res.ok ? `Updated (${res.before} → ${res.after}). The model is restarting.` : "The update did not finish cleanly."}
          {!res.ok && <pre className="text-xs text-muted whitespace-pre-wrap mt-1">{[res.restart, res.log_tail].filter(Boolean).join("\n")}</pre>}
        </div>
      )}
      <Row label="Setup wizard" hint="Also connects LM Studio, Ollama, or a server you run yourself.">
        <Button small onClick={() => window.dispatchEvent(new Event("open-wizard"))}>Run setup again</Button>
      </Row>
      {(message || err) && <div className="px-3.5 py-2"><Message error={!!err}>{err || message}</Message></div>}
    </Section>
  );
}

function ConnectionsTab() {
  const [web, setWeb] = useState<boolean | null>(null);
  const [offline, setOffline] = useState<boolean | null>(null);
  const [webBusy, setWebBusy] = useState(false);
  useEffect(() => {
    invoke<string | null>("get_setting", { key: "web_access" }).then(value => setWeb(value !== "off")).catch(() => {});
    invoke<boolean>("offline_get").then(setOffline).catch(() => {});
  }, []);
  return <>
    <Section title="Internet" note="Commands you approve and programs started by plugins are not blocked by either switch.">
      <ToggleRow label="Offline mode" hint="Turns off cloud models, web tools, SSH, the plugin store and update checks. Chats used offline ask before going online later."
        checked={offline ?? false} disabled={offline === null}
        onChange={async on => { setOffline(on); try { await invoke("set_offline", { on }); window.dispatchEvent(new Event("offline-changed")); } catch (error) { setOffline(!on); window.alert(String(error)); } }} />
      <ToggleRow label="Enable web search and browsing" hint="Lets the assistant search and open web pages."
        checked={web ?? false} disabled={web === null || webBusy}
        onChange={async on => { const previous = web; setWeb(on); setWebBusy(true); try { await invoke("set_web_access", { on }); } catch (error) { setWeb(previous); window.alert(String(error)); } finally { setWebBusy(false); } }} />
    </Section>
    <SshHosts />
  </>;
}

type Host = { host: string; user: string; port: number; read_ok: boolean };
const EMPTY_HOST = { name: "", host: "", user: "", port: "22", read_ok: true };

function SshHosts() {
  const [hosts, setHosts] = useState<Record<string, Host>>({});
  const [pub, setPub] = useState("");
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState(EMPTY_HOST);
  const [scan, setScan] = useState<{ keys: string; fingerprint: string } | null>(null);
  const [msg, setMsg] = useState("");
  const load = () => invoke<Record<string, Host>>("ssh_hosts").then(setHosts).catch(() => {});
  useEffect(() => { load(); }, []);
  async function check() {
    setMsg("");
    try { setScan(await invoke("ssh_scan", { host: f.host, port: Number(f.port) || 22 })); } catch (e) { setMsg(String(e)); }
  }
  async function save() {
    try {
      if (scan) await invoke("ssh_pin", { keys: scan.keys });
      await invoke("ssh_save_host", { name: f.name, host: f.host, user: f.user, port: Number(f.port) || 22, readOk: f.read_ok });
      setScan(null); setF(EMPTY_HOST); setAdding(false); load();
    } catch (e) { setMsg(String(e)); }
  }
  const names = Object.keys(hosts);
  return (
    <Section title="SSH servers" action={!adding && <Button small onClick={() => setAdding(true)}>Add server</Button>}>
      {names.length === 0 && !adding && <div className="px-3.5 py-3 text-sm text-muted">No servers yet. Add one so the assistant can look into it for you.</div>}
      {Object.entries(hosts).map(([n, h]) => (
        <Row key={n} label={n} hint={`${h.user}@${h.host}:${h.port}${h.read_ok ? " · read-only commands run without asking" : ""}`}>
          <Button variant="danger" small onClick={() => invoke("ssh_delete_host", { name: n }).then(load)}>Remove</Button>
        </Row>
      ))}
      {adding && (
        <div className="px-3.5 py-3 space-y-2.5">
          <div className="grid grid-cols-2 gap-2">
            <input className={input} placeholder="Name (e.g. web1)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            <input className={input} placeholder="Host or IP" value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} />
            <input className={input} placeholder="User" value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })} />
            <input className={input} placeholder="Port" value={f.port} onChange={(e) => setF({ ...f, port: e.target.value })} />
          </div>
          <label className="flex items-center gap-2.5 text-sm">
            <input type="checkbox" className="switch" checked={f.read_ok} onChange={(e) => setF({ ...f, read_ok: e.target.checked })} />
            Run read-only commands without asking
          </label>
          {scan ? (
            <div className="rounded-lg border border-line bg-panel p-2.5 text-xs space-y-2">
              <div>Does this fingerprint match your server?</div>
              <div className="font-mono break-all select-text">{scan.fingerprint}</div>
              <div className="flex gap-1.5"><Button variant="primary" small onClick={save}>Trust and save</Button><Button variant="ghost" small onClick={() => setScan(null)}>Back</Button></div>
            </div>
          ) : (
            <div className="flex gap-1.5">
              <Button variant="primary" small disabled={!f.name || !f.host || !f.user} onClick={check}>Check server</Button>
              <Button variant="ghost" small onClick={() => { setAdding(false); setF(EMPTY_HOST); setMsg(""); }}>Cancel</Button>
            </div>
          )}
          <div className="text-xs text-muted">
            Add this computer's key to the server's <span className="font-mono">~/.ssh/authorized_keys</span>.{" "}
            {pub ? <div className="font-mono break-all select-all mt-1.5 p-2 rounded-lg bg-panel text-ink">{pub}</div>
              : <button className="text-accent hover:underline" onClick={() => invoke<string>("ssh_public_key").then(setPub).catch((e) => setMsg(String(e)))}>Show key</button>}
          </div>
          <Message error>{msg}</Message>
        </div>
      )}
    </Section>
  );
}

function AppTab() {
  const [dir, setDir] = useState("");
  const [mem, setMem] = useState<{ id: number; text: string }[]>([]);
  const loadMem = () => invoke<{ id: number; text: string }[]>("memories_list").then(setMem).catch(() => {});
  useEffect(() => {
    loadMem();
    invoke<string>("data_dir").then(setDir).catch(() => {});
  }, []);
  return <>
    <AppUpdates />
    <Rollback />
    <Section title="Storage" note="Chats, browser profiles and generated files are saved on this computer. Cloud models receive conversation data only when cloud routing is enabled.">
      <Row label="Data folder"><span className="text-xs text-muted break-all select-text">{dir || "–"}</span></Row>
    </Section>
    {mem.length > 0 && (
      <Section title="Saved memories" note="Cross-chat memory is off. These are left over from older versions.">
        {mem.map((m) => (
          <Row key={m.id} label={<span className="text-muted">{m.text}</span>}>
            <Button variant="danger" small onClick={() => invoke("memory_delete", { id: m.id }).then(loadMem)}>Forget</Button>
          </Row>
        ))}
      </Section>
    )}
  </>;
}

function AppUpdates() {
  const [version, setVersion] = useState("");
  const [auto, setAuto] = useState<boolean | null>(null);
  const [found, setFound] = useState<{ available: boolean; current: string; version?: string; notes?: string } | null>(null);
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const [progress, setProgress] = useState<DownloadState | null>(null);
  useEffect(() => {
    invoke<boolean>("auto_update_get").then(setAuto).catch(() => {});
    getVersion().then(setVersion).catch(() => {});
    const sub = listen<DownloadState>("download-progress", e => { if (e.payload.id === "app-update") setProgress(e.payload); });
    const state = listen<{ state: string; error?: string }>("app-update", e => { if (e.payload.state === "failed") { setProgress(null); setMsg(e.payload.error || "The app update failed."); } });
    return () => { sub.then(f => f()); state.then(f => f()); };
  }, []);
  async function check() {
    setBusy("Checking…"); setMsg("");
    try { const r = await invoke<typeof found>("app_update_check"); setFound(r); if (r && !r.available) setMsg("You have the newest version."); }
    catch (e) { setMsg(String(e)); } finally { setBusy(""); }
  }
  async function install() {
    setBusy("Downloading. LocalWORK restarts when it is installed…"); setMsg(""); setProgress(null);
    try { await invoke("app_update_install"); } catch (e) { setMsg(String(e)); setBusy(""); setProgress(null); }
  }
  return (
    <Section title="Updates">
      <Row label={`LocalWORK ${version || found?.current || ""}`.trim()} hint={busy || msg || (found?.available ? `Version ${found.version} is available.` : undefined)}>
        {found?.available
          ? <Button variant="primary" small disabled={!!busy} onClick={install}>Install {found.version}</Button>
          : <Button small disabled={!!busy} onClick={check}>Check for updates</Button>}
      </Row>
      {found?.available && found.notes && <div className="px-3.5 py-2.5 text-xs text-muted whitespace-pre-wrap">{found.notes.slice(0, 300)}</div>}
      {(progress || busy.startsWith("Downloading")) && <div className="px-3.5 py-3"><DownloadProgress label="Updating LocalWORK" progress={progress} /></div>}
      <ToggleRow label="Update automatically when LocalWORK opens" hint="Installs signed releases from GitHub and restarts. Chats and settings are kept."
        checked={auto ?? false} disabled={auto === null}
        onChange={async on => { setAuto(on); try { await invoke("auto_update_set", { on }); } catch (error) { setAuto(!on); setMsg(String(error)); } }} />
    </Section>
  );
}

function Rollback() {
  const [vs, setVs] = useState<{ version: string; current: boolean }[]>([]);
  const [err, setErr] = useState("");
  useEffect(() => { invoke<{ version: string; current: boolean }[]>("rollback_list").then(setVs).catch(() => {}); }, []);
  const older = vs.filter(v => !v.current);
  if (!older.length) return null;
  return (
    <Section title="Previous versions" note="Your chats are backed up before every update. Roll back if an update misbehaves.">
      {older.map((v) => (
        <Row key={v.version} label={v.version}>
          <Button small onClick={() => { if (confirm(`Roll back to version ${v.version}? The app will restart.`)) invoke("rollback_to", { version: v.version }).catch((e) => setErr(String(e))); }}>Roll back</Button>
        </Row>
      ))}
      {err && <div className="px-3.5 py-2"><Message error>{err}</Message></div>}
    </Section>
  );
}
