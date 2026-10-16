import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";

type Info = { cpu?: { name: string; load: number; server_ram_gib: number | null }; model: string; quant: string; file: string; context: string | null; kv: string | null; status: any; live: any };
type St = { state: string; detail: string; port: number; model: string };

const num = (v: unknown, d = 1) => (typeof v === "number" && isFinite(v) ? v.toFixed(d) : "–");
const dur = (s?: number) => (typeof s !== "number" ? "–" : s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : s >= 60 ? `${Math.floor(s / 60)} min` : `${s} s`);

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-6 py-1.5 text-sm">
      <span className="text-muted">{k}</span>
      <span className="text-right break-all">{v}</span>
    </div>
  );
}

type Host = { host: string; user: string; port: number; read_ok: boolean };

function SshHosts() {
  const [hosts, setHosts] = useState<Record<string, Host>>({});
  const [pub, setPub] = useState("");
  const [f, setF] = useState({ name: "", host: "", user: "", port: "22", read_ok: true });
  const [scan, setScan] = useState<{ keys: string; fingerprint: string } | null>(null);
  const [msg, setMsg] = useState("");
  const load = () => invoke<Record<string, Host>>("ssh_hosts").then(setHosts).catch(() => {});
  useEffect(() => { load(); }, []);
  const inp = "rounded-lg border border-line bg-panel px-2 py-1 text-sm min-w-0";
  async function check() {
    setMsg("");
    try { setScan(await invoke("ssh_scan", { host: f.host, port: Number(f.port) || 22 })); } catch (e) { setMsg(String(e)); }
  }
  async function save(pin: boolean) {
    try {
      if (pin && scan) await invoke("ssh_pin", { keys: scan.keys });
      await invoke("ssh_save_host", { name: f.name, host: f.host, user: f.user, port: Number(f.port) || 22, readOk: f.read_ok });
      setScan(null); setF({ name: "", host: "", user: "", port: "22", read_ok: true }); load();
    } catch (e) { setMsg(String(e)); }
  }
  return (
    <section>
      <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-1">SSH hosts</h3>
      {Object.keys(hosts).length === 0 && <div className="text-sm text-muted py-1">No servers yet. Add one so the assistant can look into it for you.</div>}
      {Object.entries(hosts).map(([n, h]) => (
        <div key={n} className="flex items-center gap-2 py-1 text-sm">
          <span className="flex-1">{n} <span className="text-muted">{h.user}@{h.host}:{h.port}{h.read_ok ? " · reads allowed" : ""}</span></span>
          <button className="text-muted hover:text-red-600 text-xs underline" onClick={() => invoke("ssh_delete_host", { name: n }).then(load)}>remove</button>
        </div>
      ))}
      <div className="grid grid-cols-2 gap-2 mt-2">
        <input className={inp} placeholder="Name (e.g. web1)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <input className={inp} placeholder="Host or IP" value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} />
        <input className={inp} placeholder="User" value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })} />
        <input className={inp} placeholder="Port" value={f.port} onChange={(e) => setF({ ...f, port: e.target.value })} />
      </div>
      <label className="flex items-center gap-2 text-sm mt-2"><input type="checkbox" checked={f.read_ok} onChange={(e) => setF({ ...f, read_ok: e.target.checked })} /> Let the assistant run read-only commands without asking</label>
      {!scan && <button disabled={!f.name || !f.host || !f.user} onClick={check} className="mt-2 rounded-lg bg-accent text-accent-fg px-3 py-1 text-sm disabled:opacity-40">Check server</button>}
      {scan && (
        <div className="mt-2 rounded-lg border border-line p-2 text-xs">
          <div className="mb-1">Does this fingerprint match your server?</div>
          <div className="font-mono break-all mb-2">{scan.fingerprint}</div>
          <button onClick={() => save(true)} className="rounded-lg bg-accent text-accent-fg px-3 py-1 text-sm mr-2">Yes, trust and save</button>
          <button onClick={() => setScan(null)} className="text-muted underline">Cancel</button>
        </div>
      )}
      {msg && <div className="text-xs text-red-600 mt-1 break-all">{msg}</div>}
      <div className="mt-2 text-xs text-muted">
        Add this key to the server's <span className="font-mono">~/.ssh/authorized_keys</span>:
        {pub ? <div className="font-mono break-all select-all mt-1 p-2 rounded-lg bg-panel text-ink">{pub}</div>
          : <button className="ml-1 underline" onClick={() => invoke<string>("ssh_public_key").then(setPub).catch((e) => setMsg(String(e)))}>show key</button>}
      </div>
    </section>
  );
}

export default function Settings({ status, onClose, showTps, onShowTps, scenic, onScenic }: { status: St; onClose: () => void; showTps: boolean; onShowTps: (on: boolean) => void; scenic: boolean; onScenic: (on: boolean) => void }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [dir, setDir] = useState("");
  const [mem, setMem] = useState<{ id: number; text: string }[]>([]);
  const loadMem = () => invoke<{ id: number; text: string }[]>("memories_list").then(setMem).catch(() => {});

  useEffect(() => {
    let alive = true;
    const pull = () => invoke<Info>("model_info").then((i) => { if (alive) setInfo(i); }).catch(() => {});
    pull();
    loadMem();
    invoke<string>("data_dir").then(setDir).catch(() => {});
    const t = setInterval(pull, 2000);
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => { alive = false; clearInterval(t); window.removeEventListener("keydown", esc); };
  }, []);

  const st = info?.status ?? null;
  const gpu = st?.machine?.gpu;
  const ram = st?.machine?.ram;
  const last = st?.last_timings;
  const live = info?.live;
  const generating = typeof live?.tokens_per_s === "number";
  const tps = generating ? live.tokens_per_s : last?.predicted_per_second;
  const pre = last?.prompt_per_second;
  const ctx = info?.context ? Number(info.context).toLocaleString() + " tokens" : "–";

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-lg max-h-full overflow-auto rounded-2xl bg-bg border border-line shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 h-12 border-b border-line">
          <h2 className="font-medium">Settings</h2>
          <button onClick={onClose} title="Close" className="text-muted hover:text-ink"><X size={18} /></button>
        </div>
        <div className="px-5 py-4 space-y-5">
          <section>
            <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-1">Model</h3>
            <Row k="Name" v={info?.model || status.model || "–"} />
            <Row k="Quantization" v={info?.quant || "–"} />
            <Row k="Context window" v={ctx} />
            <Row k="KV cache" v={info?.kv || "–"} />
            <Row k="Engine" v={st?.engine ? String(st.engine) : "–"} />
            <Row k="Status" v={status.state + (status.state === "ready" ? ` · up ${dur(st?.uptime_s)}` : "")} />
            <button className="mt-2 rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-panel" onClick={() => invoke(status.state === "stopped" || status.state === "error" ? "model_start" : "model_stop").catch(error => window.alert(String(error)))}>{status.state === "stopped" || status.state === "error" ? "Start model" : "Stop model"}</button>
          </section>
          <section>
            <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-1">Speed</h3>
            <label className="flex items-center justify-between gap-4 py-2 text-sm">Scenic look (mountain background, frosted text)<input type="checkbox" checked={scenic} onChange={e => onScenic(e.target.checked)} /></label>
            <label className="flex items-center justify-between gap-4 py-2 text-sm">Show tokens per second in composer<input type="checkbox" checked={showTps} onChange={async e => { const on = e.target.checked; onShowTps(on); try { await invoke("set_setting", { key: "show_tps", value: on ? "1" : "0" }); } catch (error) { onShowTps(!on); window.alert(String(error)); } }} /></label>
            <Row k={generating ? "Generating now" : "Last reply"} v={tps != null ? `${num(tps)} tokens/s` : "–"} />
            <Row k="Prompt reading" v={pre != null ? `${num(pre, 0)} tokens/s` : "–"} />
            {generating && <Row k="Average this reply" v={`${num(live.tokens_per_s_mean)} tokens/s`} />}
          </section>
          <section>
            <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-1">This computer</h3>
            <Row k="GPU" v={gpu?.name ?? "–"} />
            <Row k="GPU memory" v={gpu ? `${num((gpu.used_mib ?? 0) / 1024)} / ${num((gpu.total_mib ?? 0) / 1024)} GiB` : "–"} />
            <Row k="GPU load" v={gpu ? `${gpu.util_pct ?? "–"}%${gpu.temp_c != null ? ` · ${gpu.temp_c}°C` : ""}${gpu.power_w != null ? ` · ${num(gpu.power_w, 0)} W` : ""}` : "–"} />
            <Row k="CPU" v={info?.cpu?.name || "–"} />
            <Row k="CPU load" v={info?.cpu ? `${num(info.cpu.load, 0)}%` : "–"} />
            <Row k="System memory" v={ram ? `${num(ram.used_gib)} / ${num(ram.total_gib)} GiB` : "–"} />
            {info?.cpu?.server_ram_gib != null && <Row k="Model server memory" v={`${num(info.cpu.server_ram_gib)} GiB`} />}
          </section>
          <section>
            <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-1">Memory</h3>
            {mem.length === 0 && <div className="text-sm text-muted py-1">Nothing saved yet. Tell the assistant "remember that ..." and it will show up here.</div>}
            <ul className="max-h-40 overflow-auto">
              {mem.map((m) => (
                <li key={m.id} className="flex items-start gap-2 py-1 text-sm">
                  <span className="flex-1">{m.text}</span>
                  <button className="text-muted hover:text-red-600 text-xs underline" onClick={() => invoke("memory_delete", { id: m.id }).then(loadMem)}>forget</button>
                </li>
              ))}
            </ul>
          </section>
          <StrataUpdate />
          <SshHosts />
          <Rollback />
          <section>
            <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-1">App</h3>
            <Row k="Data folder" v={dir || "–"} />
            <Row k="Everything runs" v="on this computer, offline" />
          </section>
        </div>
      </div>
    </div>
  );
}

function Rollback() {
  const [vs, setVs] = useState<{ version: string; current: boolean }[]>([]);
  const [err, setErr] = useState("");
  useEffect(() => { invoke<{ version: string; current: boolean }[]>("rollback_list").then(setVs).catch(() => {}); }, []);
  return (
    <section>
      <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-1">Versions</h3>
      <div className="text-sm text-muted mb-1">Each version is saved when it first runs, and your chats are backed up before an update. Roll back if an update misbehaves.</div>
      {vs.map((v) => (
        <div key={v.version} className="flex items-center gap-2 py-1 text-sm">
          <span className="flex-1">{v.version}{v.current ? " (running)" : ""}</span>
          {!v.current && (
            <button className="rounded-lg border border-line px-2 py-1 hover:border-accent" onClick={() => { if (confirm(`Roll back to version ${v.version}? The app will restart.`)) invoke("rollback_to", { version: v.version }).catch((e) => setErr(String(e))); }}>
              Roll back to version
            </button>
          )}
        </div>
      ))}
      {err && <div className="text-xs text-red-600">{err}</div>}
    </section>
  );
}

type Chk = { git: boolean; message?: string; head?: string; behind?: number; changes?: string[] };
type Applied = { ok: boolean; before: string; after: string; restart: string | null; log_tail: string };

function StrataUpdate() {
  const [chk, setChk] = useState<Chk | null>(null);
  const [res, setRes] = useState<Applied | null>(null);
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");
  async function check() {
    setBusy("Checking…"); setErr(""); setRes(null);
    try { setChk(await invoke<Chk>("strata_update_check")); } catch (e) { setErr(String(e)); }
    setBusy("");
  }
  async function apply() {
    if (!confirm("Update Strata now? The model stops, updates, and restarts. Open chats are interrupted.")) return;
    setBusy("Updating… this can take a few minutes"); setErr("");
    try { setRes(await invoke<Applied>("strata_update_apply")); setChk(null); } catch (e) { setErr(String(e)); }
    setBusy("");
  }
  return (
    <section>
      <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-1">Model engine</h3>
      <div className="text-sm text-muted mb-1">Strata runs the model. Checking looks only; nothing changes until you confirm.</div>
      <button disabled={!!busy} onClick={check} className="rounded-lg border border-line px-3 py-1 text-sm hover:border-accent disabled:opacity-40">Check for Strata update</button>
      {busy && <span className="ml-2 text-xs text-muted">{busy}</span>}
      {chk && !chk.git && <div className="text-sm mt-2">{chk.message}</div>}
      {chk?.git && chk.behind === 0 && <div className="text-sm mt-2">Strata is up to date ({chk.head}).</div>}
      {chk?.git && !!chk.behind && (
        <div className="mt-2 text-sm">
          {chk.behind} new change{chk.behind > 1 ? "s" : ""} available:
          <ul className="list-disc ml-5 text-xs text-muted my-1">{chk.changes?.map((c, i) => <li key={i}>{c}</li>)}</ul>
          <button onClick={apply} className="rounded-lg bg-accent text-accent-fg px-3 py-1 text-sm">Update and restart the model</button>
        </div>
      )}
      {res && (
        <div className="mt-2 text-sm">
          {res.ok ? `Updated (${res.before} to ${res.after}). The model is restarting; if it does not reach "ready", tell your coding agent.` : "The update did not finish cleanly."}
          {!res.ok && <pre className="text-xs text-muted whitespace-pre-wrap mt-1">{[res.restart, res.log_tail].filter(Boolean).join(String.fromCharCode(10))}</pre>}
        </div>
      )}
      {err && <div className="text-xs text-red-600 mt-1 break-all">{err}</div>}
    </section>
  );
}
