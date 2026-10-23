import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Check, AlertTriangle } from "lucide-react";
import ModelLibrary from "./ModelLibrary";

type Hw = {
  ram_gib: number; disk_free_gib: number | null; gpu: { name: string; vram_gib: number | null; driver: string } | null;
  strata_root: string; strata_found: boolean; model_config_found: boolean; model_source?: string; server_port?: string; engine?: string;
};
type Path = "strata" | "server" | "setup";

const g = (n: number | null | undefined) => (typeof n === "number" ? n.toFixed(1) + " GiB" : "unknown");

function Line({ ok, label, value }: { ok: boolean; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 py-1.5 text-sm">
      {ok ? <Check size={16} className="text-green-600 shrink-0" /> : <AlertTriangle size={16} className="text-amber-500 shrink-0" />}
      <span className="text-muted w-28 shrink-0">{label}</span>
      <span className="flex-1 break-all">{value}</span>
    </div>
  );
}


function Choice({ on, title, text, onClick }: { on: boolean; title: string; text: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`w-full text-left rounded-xl border px-3 py-2.5 mb-2 ${on ? "border-accent bg-panel-2" : "border-line hover:border-accent"}`}>
      <div className="text-sm font-medium">{title}</div>
      <div className="text-xs text-muted">{text}</div>
    </button>
  );
}

export default function Wizard({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [hw, setHw] = useState<Hw | null>(null);
  const [path, setPath] = useState<Path | null>(null);
  const [err, setErr] = useState("");
  const [note, setNote] = useState("");
  const [web, setWeb] = useState(true);
  const [proj, setProj] = useState("");
  const [port, setPort] = useState("");
  const [key, setKey] = useState("");
  const [ctx, setCtx] = useState("32768");
  const [server, setServer] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);

  const check = () => invoke<Hw>("hardware_check").then(h => { setHw(h); return h; }).catch(e => { setErr(String(e)); return null; });
  useEffect(() => {
    check().then(h => { if (h?.strata_found) setPath("strata"); else if (h?.model_source === "server") setPath("server"); });
  }, []);

  const ready = path === "server" ? !!server : !!(hw?.strata_found && hw.model_config_found);

  async function pickStrata() {
    setErr(""); setNote("");
    const d = await open({ directory: true, title: "Choose your Strata or PolyStrata folder" });
    if (!d || Array.isArray(d)) return;
    try {
      const r = await invoke<{ modelConfig?: string | null }>("set_strata_root", { path: d });
      setChanged(true);
      if (r.modelConfig) setNote(`Using the model set up there: ${r.modelConfig.split(/[\\/]/).pop()}`);
      await check();
    } catch (e) { setErr(String(e)); }
  }
  async function pickModelConfig() {
    setErr("");
    const file = await open({ multiple: false, directory: false, title: "Choose a Strata model configuration", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!file || Array.isArray(file)) return;
    try { await invoke("set_model_config", { path: file }); setChanged(true); await check(); } catch (e) { setErr(String(e)); }
  }
  async function findServer() {
    setErr(""); setServer(null);
    const p = port.trim() ? Number(port) : undefined;
    const r = await invoke<{ ok: boolean; port?: number; model?: string; error?: string }>("probe_model_server", { port: p, key: key || null });
    if (!r.ok) { setErr(r.error || "No server found."); return; }
    setPort(String(r.port));
    try {
      const s = await invoke<{ model: string }>("set_model_server", { port: r.port, key: key || null, context: Number(ctx) || null });
      setServer(s.model);
      setChanged(true);
    } catch (e) { setErr(String(e)); }
  }
  async function pickProjects() {
    const d = await open({ directory: true, title: "Choose where your projects live" });
    if (d && !Array.isArray(d)) setProj(d);
  }
  async function finish() {
    try {
      await invoke("set_web_access", { on: web });
      if (proj) await invoke("set_setting", { key: "projects_folder", value: proj });
      await invoke("set_setting", { key: "wizard_done", value: "1" });
      // Run again from Settings with a model already loaded: reload only if the choice changed.
      if (ready && changed) await invoke("model_stop");
      if (ready) await invoke("model_start");
      onDone();
    } catch (error) { setErr(String(error)); }
  }
  const go = (n: number) => { setErr(""); setNote(""); setStep(n); };

  const btn = "rounded-lg bg-accent text-accent-fg px-4 py-1.5 text-sm disabled:opacity-40";
  const small = "rounded-lg border border-line px-3 py-1 text-sm hover:border-accent inline-flex items-center gap-1.5";
  const inp = "rounded-lg border border-line bg-bg px-2 py-1 text-sm";

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/50 p-4">
      <div className={`w-full ${step === 2 && path === "setup" ? "max-w-3xl" : "max-w-lg"} max-h-[92vh] overflow-y-auto rounded-2xl bg-bg border border-line shadow-xl p-6`}>
        <div className="text-xs text-muted mb-1">Step {step + 1} of 4</div>
        {step === 0 && (
          <>
            <h2 className="text-lg font-medium mb-1">Welcome to LocalWORK</h2>
            <p className="text-sm text-muted mb-3">LocalWORK is a work assistant that runs on an AI model on your own computer. Nothing you write is sent to a cloud AI. First, a look at this PC:</p>
            <Line ok={!!hw?.gpu} label="Graphics card" value={hw ? (hw.gpu ? `${hw.gpu.name} · ${g(hw.gpu.vram_gib)} video memory` : "No NVIDIA card detected (AMD cards may still work)") : "checking…"} />
            <Line ok={!!hw?.gpu && Number(hw.gpu.driver.split(".")[0]) >= 580} label="Driver" value={hw?.gpu ? `${hw.gpu.driver}${Number(hw.gpu.driver.split(".")[0]) < 580 ? " (Strata needs 580 or newer)" : ""}` : hw ? "not found" : "checking…"} />
            <Line ok={(hw?.ram_gib ?? 0) >= 30} label="Memory" value={hw ? g(hw.ram_gib) + ((hw.ram_gib ?? 0) < 30 ? " (Strata needs 32 GB)" : "") : "checking…"} />
            <Line ok={(hw?.disk_free_gib ?? 0) >= 80} label="Free disk" value={hw ? g(hw.disk_free_gib) : "checking…"} />
            <p className="text-xs text-muted mt-2">These are Strata's requirements. If you already run a model another way, they do not apply.</p>
          </>
        )}
        {step === 1 && (
          <>
            <h2 className="text-lg font-medium mb-1">Do you already have an AI model?</h2>
            <p className="text-sm text-muted mb-3">LocalWORK needs a model to talk to. Pick what fits you.</p>
            <Choice on={path === "strata"} onClick={() => setPath("strata")} title="Yes, Strata or PolyStrata is installed" text="LocalWORK starts and stops it for you. Recommended." />
            <Choice on={path === "server"} onClick={() => setPath("server")} title="Yes, I run my own model server" text="Strata, LM Studio, Ollama, llama.cpp, vLLM or any OpenAI-compatible server on this PC. You start it yourself." />
            <Choice on={path === "setup"} onClick={() => setPath("setup")} title="No, help me set one up" text="Install PolyStrata from GitHub and choose a model for this PC. You confirm each download." />
          </>
        )}
        {step === 2 && path === "strata" && (
          <>
            <h2 className="text-lg font-medium mb-1">Connect Strata or PolyStrata</h2>
            <p className="text-sm text-muted mb-3">Choose the Strata or PolyStrata folder (the one with START-HERE.bat or its Linux setup script). The model you set up there is picked automatically. With several models, switch between them later from the model menu.</p>
            <Line ok={!!hw?.strata_found} label={hw?.engine ?? "Strata"} value={hw?.strata_found ? hw.strata_root : `Not found at ${hw?.strata_root ?? "…"}`} />
            <Line ok={!!hw?.model_config_found} label="Model" value={hw?.model_config_found ? "Selected" : "Not selected yet"} />
            <div className="flex flex-wrap gap-2 mt-2">
              <button onClick={pickStrata} className={small}>Choose Strata folder…</button>
              {hw?.strata_found && <button onClick={pickModelConfig} className={small}>Choose model file…</button>}
            </div>
            {hw?.strata_found && !hw.model_config_found && <p className="text-xs text-muted mt-3">Choose the strata-&lt;model&gt;.json file in the Strata folder. If there is none, run its setup there first (START-HERE.bat on Windows).</p>}
          </>
        )}
        {step === 2 && path === "server" && (
          <>
            <h2 className="text-lg font-medium mb-1">Connect your model server</h2>
            <p className="text-sm text-muted mb-3">Start your server first. Leave the port empty to look on the usual ones (Strata or llama.cpp 8080, LM Studio 1234, Ollama 11434, vLLM 8000, SGLang 30000). Only this computer is contacted.</p>
            <div className="grid grid-cols-[7rem_1fr] items-center gap-2 text-sm">
              <span className="text-muted">Port</span><input className={inp} value={port} onChange={e => setPort(e.target.value.replace(/\D/g, ""))} placeholder="auto" />
              <span className="text-muted">API key</span><input className={inp} value={key} onChange={e => setKey(e.target.value)} placeholder="only if your server needs one" type="password" />
              <span className="text-muted">Context size</span>
              <select className={inp} value={ctx} onChange={e => setCtx(e.target.value)}>
                {["8192", "16384", "32768", "65536", "131072", "262144"].map(n => <option key={n} value={n}>{Number(n) / 1024}K tokens</option>)}
              </select>
            </div>
            <p className="text-xs text-muted mt-1">Use the context size your server is set to; LocalWORK compacts the chat before it is full.</p>
            <button onClick={findServer} className={small + " mt-3"}>Test and connect</button>
            {server && <Line ok label="Connected" value={`${server} on port ${port}`} />}
          </>
        )}
        {step === 2 && path === "setup" && (
          <>
            <h2 className="text-lg font-medium mb-1">Set up a local model</h2>
            <p className="text-sm text-muted mb-3">PolyStrata runs Strata and additional model families. Install it, then choose a download or add model files you already have. LocalWORK starts and stops the model for you.</p>
            <ModelLibrary onChanged={() => { setChanged(true); check(); }} />
            <p className="text-xs text-muted mt-3">You can finish setup now and return to the model library in Settings → Model.</p>
          </>
        )}
        {step === 2 && !path && <p className="text-sm text-muted">Go back and choose an option.</p>}
        {step === 3 && (
          <>
            <h2 className="text-lg font-medium mb-1">Projects and web access</h2>
            <p className="text-sm text-muted mb-3">New chats save their files in Documents/LocalWORK. You can choose another location here, or work in a specific folder from the chat.</p>
            <div className="flex items-center gap-2 text-sm">
              <span className="flex-1 truncate rounded-lg border border-line px-2 py-1 text-muted">{proj || "Documents/LocalWORK"}</span>
              <button onClick={pickProjects} className="rounded-lg border border-line px-3 py-1 hover:border-accent">Choose…</button>
            </div>
            <label className="flex items-start gap-2 text-sm mt-4">
              <input type="checkbox" className="mt-1" checked={web} onChange={(e) => setWeb(e.target.checked)} />
              <span>Let the assistant search and read the web<br /><span className="text-xs text-muted">Search words and page requests leave this computer. This disables built-in web tools, not networking from commands, updates or SSH. You can change this in Settings.</span></span>
            </label>
            <p className="text-xs text-muted mt-3">Extras such as the CPU/GPU bar and the electricity cost per task are plugins. Add them in Settings &gt; Plugins.</p>
            {ready && path !== "server" && (
              <p className="text-xs text-muted mt-4 rounded-lg border border-line p-2.5">
                Tip: once the model is running, ask it <b>"tune yourself for this PC"</b>. It measures your hardware and writes faster settings (more context, more tokens per second) as modes you can switch between. Calibration takes measurements; results depend on the hardware and model.
              </p>
            )}
            {!ready && <p className="text-xs text-amber-600 mt-4">No model is connected yet. You can finish now and connect one later in Settings &gt; Model.</p>}
          </>
        )}
        {note && <div className="text-xs text-muted mt-2 break-all">{note}</div>}
        {err && <div className="text-xs text-red-600 mt-2 break-all">{err}</div>}
        <div className="flex justify-between mt-6">
          <button className="text-sm text-muted underline disabled:opacity-0" disabled={step === 0} onClick={() => go(step - 1)}>Back</button>
          {step < 3
            ? <button className={btn} disabled={step === 1 && !path} onClick={() => go(step + 1)}>Next</button>
            : <button className={btn} onClick={finish}>Finish</button>}
        </div>
      </div>
    </div>
  );
}
