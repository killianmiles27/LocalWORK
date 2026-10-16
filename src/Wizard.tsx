import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Check, AlertTriangle } from "lucide-react";

type Hw = { ram_gib: number; disk_free_gib: number | null; gpu: { name: string; vram_gib: number | null; driver: string } | null; strata_root: string; strata_found: boolean; model_config_found: boolean };

const g = (n: number | null | undefined) => (typeof n === "number" ? n.toFixed(1) + " GiB" : "unknown");

function Line({ ok, label, value }: { ok: boolean; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 py-1.5 text-sm">
      {ok ? <Check size={16} className="text-green-600" /> : <AlertTriangle size={16} className="text-amber-500" />}
      <span className="text-muted w-28">{label}</span>
      <span className="flex-1 break-all">{value}</span>
    </div>
  );
}

export default function Wizard({ onDone }: { onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [hw, setHw] = useState<Hw | null>(null);
  const [err, setErr] = useState("");
  const [web, setWeb] = useState(true);
  const [proj, setProj] = useState("");

  const check = () => invoke<Hw>("hardware_check").then(setHw).catch((e) => setErr(String(e)));
  useEffect(() => { check(); }, []);

  async function pickStrata() {
    setErr("");
    const d = await open({ directory: true, title: "Choose your Strata folder" });
    if (!d || Array.isArray(d)) return;
    try { await invoke("set_strata_root", { path: d }); await check(); } catch (e) { setErr(String(e)); }
  }
  async function pickProjects() {
    const d = await open({ directory: true, title: "Choose where your projects live" });
    if (d && !Array.isArray(d)) setProj(d);
  }
  async function finish() {
    await invoke("set_web_access", { on: web });
    if (proj) await invoke("set_setting", { key: "projects_folder", value: proj });
    await invoke("set_setting", { key: "wizard_done", value: "1" });
    if (hw?.strata_found) invoke("model_start").catch(() => {});
    onDone();
  }

  const gpuOk = !!hw?.gpu && (hw.gpu.vram_gib ?? 0) >= 6;
  const ramOk = (hw?.ram_gib ?? 0) >= 16;
  const diskOk = (hw?.disk_free_gib ?? 0) >= 5;
  const btn = "rounded-lg bg-accent text-white px-4 py-1.5 text-sm disabled:opacity-40";

  return (
    <div className="fixed inset-0 z-[60] grid place-items-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-2xl bg-bg border border-line shadow-xl p-6">
        <div className="text-xs text-muted mb-1">Step {step + 1} of 3</div>
        {step === 0 && (
          <>
            <h2 className="text-lg font-medium mb-1">Welcome to LocalWORK</h2>
            <p className="text-sm text-muted mb-3">Everything runs on this computer. First, a quick look at whether it can run the model.</p>
            <Line ok={gpuOk} label="Graphics card" value={hw ? (hw.gpu ? `${hw.gpu.name} · ${g(hw.gpu.vram_gib)} video memory` : "No NVIDIA card found (it will be slow)") : "checking…"} />
            <Line ok={!!hw?.gpu} label="Driver" value={hw?.gpu ? hw.gpu.driver : hw ? "not found" : "checking…"} />
            <Line ok={ramOk} label="Memory" value={hw ? g(hw.ram_gib) : "checking…"} />
            <Line ok={diskOk} label="Free disk" value={hw ? g(hw.disk_free_gib) : "checking…"} />
            {hw && (!gpuOk || !ramOk || !diskOk) && <p className="text-xs text-amber-600 mt-2">Some checks look low. The app still works, but the model may be slow or fail to load.</p>}
          </>
        )}
        {step === 1 && (
          <>
            <h2 className="text-lg font-medium mb-1">The model engine</h2>
            <p className="text-sm text-muted mb-3">LocalWORK uses Strata to run the model. Point it at the Strata folder on this computer.</p>
            <Line ok={!!hw?.strata_found} label="Strata" value={hw?.strata_found ? `Found at ${hw.strata_root}` : `Not found at ${hw?.strata_root ?? "…"}`} />
            <Line ok={!!hw?.model_config_found} label="Model" value={hw?.model_config_found ? "A model is selected" : "No model selected yet"} />
            <button onClick={pickStrata} className="mt-2 rounded-lg border border-line px-3 py-1 text-sm hover:border-accent">Choose a different folder…</button>
            {!hw?.strata_found && <p className="text-xs text-muted mt-3">No Strata yet? Install it from github.com/Niko1221/Strata (run SETUP.bat there, it downloads the model once), then choose its folder here. You can also finish this later in Settings.</p>}
            {err && <div className="text-xs text-red-600 mt-2 break-all">{err}</div>}
          </>
        )}
        {step === 2 && (
          <>
            <h2 className="text-lg font-medium mb-1">Projects and web access</h2>
            <p className="text-sm text-muted mb-3">Each chat works inside one folder. You choose it per chat; this is just where the picker starts.</p>
            <div className="flex items-center gap-2 text-sm">
              <span className="flex-1 truncate rounded-lg border border-line px-2 py-1 text-muted">{proj || "No default (ask every time)"}</span>
              <button onClick={pickProjects} className="rounded-lg border border-line px-3 py-1 hover:border-accent">Choose…</button>
            </div>
            <label className="flex items-start gap-2 text-sm mt-4">
              <input type="checkbox" className="mt-1" checked={web} onChange={(e) => setWeb(e.target.checked)} />
              <span>Let the assistant search and read the web<br /><span className="text-xs text-muted">Search words and page requests leave this computer. Turn it off for fully offline work. You can change this later.</span></span>
            </label>
          </>
        )}
        <div className="flex justify-between mt-6">
          <button className="text-sm text-muted underline disabled:opacity-0" disabled={step === 0} onClick={() => setStep(step - 1)}>Back</button>
          {step < 2 ? <button className={btn} onClick={() => setStep(step + 1)}>Next</button> : <button className={btn} onClick={finish}>Finish</button>}
        </div>
      </div>
    </div>
  );
}
