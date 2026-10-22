import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { ChevronDown, Cpu, Download, ExternalLink, FolderOpen, Loader2, Search, Wrench, X } from "lucide-react";
import { Button, input } from "./settings-ui";
import { FIT_LABEL, FIT_STYLE, fitOf, normalizeCatalog, STATIC_MODELS, type CatalogModel, type Hw } from "./modelCatalog";

type Status = { installed: boolean; root: string; engine: string; version: string | null; python_ok: boolean; latest_tag: string | null; offline: boolean };
type Mode = { id: string; label: string; config: string; found: boolean; active: boolean; engine?: string };
type Msg = { t: string; err?: boolean };
type HfFile = { file: string; size: number | null; download_files: { file: string; size: number | null }[]; total_bytes: number | null };
type HfList = { repo: string; revision: string; files: HfFile[] };
type HfDownload = { files: string[]; folder: string; total_bytes: number | null };

const card = "rounded-xl border border-line bg-panel p-3";
const gb = (n?: number) => (n == null ? "?" : n < 10 ? n.toFixed(1) : String(Math.round(n)));
const gbBytes = (n?: number | null) => n == null ? "size unknown" : `${(n / 1_000_000_000).toFixed(1)} GB`;
const k = (n: number) => (n >= 1024 ? Math.round(n / 1024) + "K" : String(n));
const same = (a?: string, b?: string) => !!a && !!b && a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();

/** Settings -> Models: install PolyStrata, pick a model that suits this PC, add your own GGUF, tune. `onChanged` runs after anything changes. */
export default function ModelLibrary({ onChanged }: { onChanged?: () => void }) {
  const [hw, setHw] = useState<Hw | null>(null);
  const [st, setSt] = useState<Status | null>(null);
  const [models, setModels] = useState<CatalogModel[]>(STATIC_MODELS);
  const [modes, setModes] = useState<Mode[]>([]);
  const [job, setJob] = useState<string | null>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [showLog, setShowLog] = useState(false);
  const [ask, setAsk] = useState<string | null>(null);
  const [msg, setMsg] = useState<Msg | null>(null);
  const [repo, setRepo] = useState("");
  const [hfOut, setHfOut] = useState("");
  const [hfList, setHfList] = useState<HfList | null>(null);
  const [hfSelected, setHfSelected] = useState("");
  const [hfDownload, setHfDownload] = useState<HfDownload | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [ctx, setCtx] = useState<Record<string, number>>({});

  const refresh = useCallback(async (check = false) => {
    invoke<Hw>("engine_hw").then(setHw).catch(() => {});
    const s = await invoke<Status>("engine_status", { check }).catch(() => null);
    setSt(s);
    invoke<{ modes: Mode[] }>("modes_list").then(r => setModes(r.modes)).catch(() => {});
    if (s?.installed) {
      invoke<{ families: unknown }>("engine_catalog").then(c => { const m = normalizeCatalog(c.families); if (m.length) setModels(m); }).catch(() => {});
    }
  }, []);

  useEffect(() => {
    refresh(true);
    const subs = [
      listen<{ line: string }>("engine-log", e => {
        setLines(p => [...p.slice(-400), e.payload.line]);
        const m = e.payload.line.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
        if (m) setPct(Math.min(100, Number(m[1])));
      }),
      listen<{ id: string; done: number; total: number | null }>("download-progress", e => {
        if (e.payload.id === "engine-install" && e.payload.total) setPct(Math.min(100, (e.payload.done / e.payload.total) * 100));
        if (e.payload.id === "hf-model-download" && e.payload.total) setPct(Math.min(100, (e.payload.done / e.payload.total) * 100));
      }),
    ];
    return () => { subs.forEach(s => s.then(f => f())); };
  }, [refresh]);

  /** Run one engine job at a time, with the log and progress bar wired to it. */
  async function go<T>(id: string, fn: () => Promise<T>, done: (r: T) => string | void) {
    setJob(id); setPct(null); setLines([]); setMsg(null); setAsk(null); setFresh(null);
    try {
      const t = done(await fn());
      if (t) setMsg({ t });
      await refresh();
      onChanged?.();
    } catch (e) {
      setMsg({ t: String(e), err: true });
    } finally { setJob(null); setPct(null); }
  }

  const install = () => go("engine", () => invoke("engine_install", { dir: null, installPython: !st?.python_ok }),
    (r: any) => `PolyStrata ${r.tag} is ready.${r.old_root ? " The old folder was kept." : ""}`);
  const addModel = (m: CatalogModel) => go(`${m.family}/${m.id}`, () => invoke<{ active: string }>("engine_add_model", { family: m.family, model: m.id, context: ctx[`${m.family}/${m.id}`] ?? m.context, dataDir: null }),
    r => { setFresh(r.active); return `${m.familyTitle} ${m.label} is set up and selected.`; });
  const addGguf = async () => {
    const f = await open({ title: "Choose a GGUF model", filters: [{ name: "GGUF", extensions: ["gguf"] }] });
    if (typeof f === "string") go("gguf", () => invoke<{ name: string; path: string; verdict: string }>("engine_add_gguf", { ggufPath: f, context: null }),
      r => { setFresh(r.path); return `Added ${r.name}. ${r.verdict}`; });
  };
  const inspect = () => go("hf", () => invoke<{ output: string }>("engine_inspect_hf", { repo: repo.trim(), variant: null }), r => { setHfOut(r.output); });
  const listHf = () => go("hf-list", () => invoke<HfList>("engine_hf_files", { repo: repo.trim() }), r => {
    setHfList(r); setHfSelected(r.files[0]?.file ?? ""); setHfDownload(null); setHfOut("");
    return r.files.length ? `${r.files.length} GGUF file choices found.` : "This repository has no GGUF files.";
  });
  const downloadHf = async () => {
    const selected = hfList?.files.find(f => f.file === hfSelected);
    if (!hfList || !selected) return;
    const folder = await open({ title: "Choose where to save the model files", directory: true });
    if (typeof folder !== "string") return;
    go("hf-download", () => invoke<HfDownload>("engine_hf_download", {
      repo: hfList.repo, revision: hfList.revision, file: selected.file, destination: folder,
    }), r => { setHfDownload(r); return `Downloaded ${r.files.length} file${r.files.length === 1 ? "" : "s"} to ${r.folder}.`; });
  };
  const useDownloaded = () => {
    const gguf = hfDownload?.files[0];
    if (!gguf) return;
    go("hf-add", () => invoke<{ name: string; path: string; verdict: string }>("engine_add_gguf", { ggufPath: gguf, context: null }),
      r => { setFresh(r.path); return `Added ${r.name}. ${r.verdict}`; });
  };
  const tune = (m: Mode) => go(`tune:${m.id}`, () => invoke<{ message: string }>("engine_tune", { config: m.config }), r => r.message);
  const switchNow = async () => {
    const m = modes.find(x => same(x.config, fresh ?? undefined));
    if (!m) return setMsg({ t: "Pick it from the model menu.", err: true });
    try { await invoke("mode_switch", { id: m.id, reload: true }); setFresh(null); setMsg({ t: `Switched to ${m.label}.` }); onChanged?.(); refresh(); }
    catch (e) { setMsg({ t: String(e), err: true }); }
  };
  const open_ = (url: string) => invoke("open_external", { url }).catch(() => {});

  const busy = job !== null;
  const offline = !!st?.offline;
  const gpu = hw?.gpu;
  const updatable = !!st?.installed && !!st.latest_tag && st.latest_tag !== st.version;
  const bar = (id: string) => job === id && (
    <div className="mt-2">
      <div className="h-1.5 rounded-full bg-panel-2 overflow-hidden"><div className={`h-full bg-accent transition-all ${pct == null ? "w-1/3 animate-pulse" : ""}`} style={pct == null ? undefined : { width: `${pct}%` }} /></div>
      <div className="mt-1 flex items-center justify-between text-xs text-muted"><span className="truncate">{lines[lines.length - 1] ?? "Starting..."}</span>
        <button onClick={() => invoke("engine_cancel")} className="inline-flex items-center gap-1 hover:text-ink shrink-0 ml-2"><X size={12} />Cancel</button></div>
    </div>
  );
  const confirm = (id: string, text: string, run: () => void) => ask === id && (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-panel-2 px-2 py-1.5 text-xs">
      <span className="flex-1 min-w-40">{text}</span>
      <Button small variant="primary" onClick={run}>Download</Button><Button small variant="ghost" onClick={() => setAsk(null)}>Not now</Button>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className={`${card} flex items-center gap-3`}>
        <Cpu size={18} className="text-accent shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">Model library</div>
          <div className="text-xs text-muted truncate">
            {hw ? `${gpu?.name ?? "No NVIDIA GPU found"}${gpu?.vram_gib ? ` (${gb(gpu.vram_gib)} GB VRAM)` : ""} · ${gb(hw.ram_gib)} GB RAM · ${gb(hw.disk_free_gib)} GB free disk` : "Checking this PC..."}
          </div>
        </div>
      </div>

      <div className={card}>
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold">Engine</div>
            <div className="text-xs text-muted">
              {!st ? "Checking..." : st.installed ? `${st.engine} ${st.version ?? ""} installed at ${st.root}` : st.python_ok ? "PolyStrata is not installed. It runs the models below on this PC." : "PolyStrata is not installed, and Python 3.10+ was not found (the installer can add it)."}
              {updatable && ` Newer version: ${st!.latest_tag}.`}
            </div>
          </div>
          {st && (!st.installed || updatable) && <Button small variant="primary" disabled={busy || offline} onClick={() => setAsk("engine")}><Download size={12} className="inline mr-1" />{st.installed ? "Update" : "Install"}</Button>}
          <Button small variant="ghost" disabled={busy || offline} onClick={() => refresh(true)}>Check for updates</Button>
        </div>
        {confirm("engine", st?.installed
          ? `Downloads a fresh PolyStrata engine and its Python packages. The current folder is kept. Installed models are set up again; if their files cannot be reused, this may download tens or hundreds of GB per model.`
          : `Downloads the PolyStrata source from GitHub and its Python packages from PyPI${st?.python_ok ? "" : ", and installs Python 3.12 for you with winget"}. Model weights are downloaded only after you choose a model.`, install)}
        {bar("engine")}
        {offline && <p className="mt-2 text-xs text-muted">Offline mode is on, so downloads are off. Turn it off in Settings to install or add models.</p>}
      </div>

      <section>
        <h3 className="text-sm font-semibold mb-1.5">Suggested for this PC{st?.installed ? "" : " (install the engine first)"}</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          {models.map(m => {
            const id = `${m.family}/${m.id}`, fit = fitOf(m, hw);
            return (
              <div key={id} className={card}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0"><div className="text-sm font-medium truncate">{m.familyTitle} <span className="text-muted">{m.label}</span></div>
                    <div className="text-xs text-muted">{gb(m.sizeGb)} GB download · {gb(m.ramGb)} GB RAM · {k(ctx[id] ?? m.context)} context</div></div>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] ${FIT_STYLE[fit]}`}>{FIT_LABEL[fit]}</span>
                </div>
                {m.preview && <div className="mt-1 text-[11px] font-medium text-amber-600">Experimental family</div>}
                {m.about && <p className="mt-1 text-xs text-muted line-clamp-2">{m.about}</p>}
                <div className="mt-2 flex items-center gap-2">
                  <Button small variant="primary" disabled={busy || offline || !st?.installed} onClick={() => setAsk(id)}>Download &amp; set up</Button>
                  <select aria-label="Context length" className="rounded-lg border border-line bg-panel px-1 py-0.5 text-xs" value={ctx[id] ?? m.context} onChange={e => setCtx({ ...ctx, [id]: Number(e.target.value) })}>
                    {[8192, 32768, 65536, 131072].map(c => <option key={c} value={c}>{k(c)}</option>)}
                  </select>
                  {m.hf && <button onClick={() => open_(`https://huggingface.co/${m.hf}`)} className="ml-auto inline-flex items-center gap-1 text-xs text-muted hover:text-ink"><ExternalLink size={12} />{m.hf.split("/")[0]}</button>}
                </div>
                {confirm(id, `Downloads about ${gb(m.sizeGb)} GB from Hugging Face. ${fit === "big" ? "This looks too big for this PC. " : ""}Continue?`, () => addModel(m))}
                {bar(id)}
              </div>
            );
          })}
        </div>
        {!st?.installed && st && <p className="text-xs text-muted mt-1.5 px-1">This is the built-in list; the engine adds its full list once installed.</p>}
      </section>

      <section>
        <h3 className="text-sm font-semibold mb-1.5">Add your own</h3>
        <div className={`${card} space-y-2`}>
          <div className="flex flex-wrap items-center gap-2">
            <Button small disabled={busy || !st?.installed} onClick={addGguf}><FolderOpen size={12} className="inline mr-1" />Use a GGUF on this PC...</Button>
            <span className="text-xs text-muted">Needs one model set up first (it builds the engine).</span>
          </div>
          <div className="flex items-center gap-2">
            <input className={input} placeholder="Hugging Face repository, e.g. owner/repository" value={repo} onChange={e => { setRepo(e.target.value); setHfList(null); setHfDownload(null); setHfSelected(""); }} onKeyDown={e => e.key === "Enter" && repo.trim() && !busy && listHf()} />
            <Button small disabled={busy || offline || !repo.trim()} onClick={listHf}><Search size={12} className="inline mr-1" />Find GGUF files</Button>
          </div>
          {hfList && hfList.files.length > 0 && <div className="space-y-2 rounded-lg bg-panel-2 p-2">
            <label className="block text-xs font-medium" htmlFor="hf-gguf-file">GGUF file</label>
            <select id="hf-gguf-file" className={`${input} w-full`} value={hfSelected} onChange={e => { setHfSelected(e.target.value); setHfDownload(null); }}>
              {hfList.files.map(f => <option key={f.file} value={f.file}>{f.file} · {gbBytes(f.size)}</option>)}
            </select>
            {(() => {
              const selected = hfList.files.find(f => f.file === hfSelected);
              if (!selected) return null;
              const count = selected.download_files.length;
              return <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <span className="flex-1">{count > 1 ? `Downloads all ${count} shards together · ${gbBytes(selected.total_bytes)} total.` : `Download size: ${gbBytes(selected.total_bytes)}.`} Files are saved under the owner/repository folder.</span>
                <Button small variant="primary" disabled={busy || offline} onClick={downloadHf}><Download size={12} className="inline mr-1" />Choose folder &amp; download</Button>
                {st?.installed && <Button small variant="ghost" disabled={busy} onClick={inspect}>Check compatibility</Button>}
              </div>;
            })()}
          </div>}
          {hfList && hfList.files.length === 0 && <p className="text-xs text-muted">No GGUF files were listed for this repository.</p>}
          {bar("gguf")}{bar("hf")}{bar("hf-list")}{bar("hf-download")}{bar("hf-add")}
          {hfOut && <pre className="max-h-48 overflow-auto rounded-lg bg-panel-2 p-2 text-xs whitespace-pre-wrap">{hfOut}</pre>}
          {hfDownload && <div role="status" className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span className="flex-1">Saved to {hfDownload.folder}</span>
            <Button small disabled={busy || !st?.installed} onClick={useDownloaded}>Use in LocalWORK</Button>
            {!st?.installed && <span>Install PolyStrata to set this file up.</span>}
          </div>}
        </div>
      </section>

      {modes.some(m => m.found) && (
        <section>
          <h3 className="text-sm font-semibold mb-1.5">Tune for this PC</h3>
          <div className="rounded-xl border border-line bg-card divide-y divide-line">
            {modes.filter(m => m.found).map(m => (
              <div key={m.id} className="px-3 py-2">
                <div className="flex items-center gap-2"><span className="flex-1 truncate text-sm">{m.label}{m.active && <span className="text-accent text-xs ml-2">current</span>}</span>
                  <Button small disabled={busy} onClick={() => tune(m)}><Wrench size={12} className="inline mr-1" />Tune</Button></div>
                {bar(`tune:${m.id}`)}
              </div>
            ))}
          </div>
        </section>
      )}

      {msg && <p role={msg.err ? "alert" : "status"} className={`text-xs px-1 break-words whitespace-pre-wrap ${msg.err ? "text-red-500" : "text-muted"}`}>{msg.t}</p>}
      {fresh && <div className="flex items-center gap-2 text-xs px-1"><span>It is selected for next start.</span><Button small variant="primary" onClick={switchNow}>Switch to it now</Button></div>}
      {lines.length > 0 && (
        <div>
          <button onClick={() => setShowLog(!showLog)} className="inline-flex items-center gap-1 text-xs text-muted hover:text-ink">
            {busy ? <Loader2 size={12} className="animate-spin" /> : <ChevronDown size={12} className={showLog ? "" : "-rotate-90"} />}Live log
          </button>
          {showLog && <pre className="mt-1 max-h-56 overflow-auto rounded-lg bg-panel-2 p-2 text-[11px] whitespace-pre-wrap">{lines.join("\n")}</pre>}
        </div>
      )}
    </div>
  );
}
