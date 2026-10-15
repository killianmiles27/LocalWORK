import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { X } from "lucide-react";

type Info = { model: string; quant: string; file: string; context: string | null; kv: string | null; status: any; live: any };
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

export default function Settings({ status, onClose }: { status: St; onClose: () => void }) {
  const [info, setInfo] = useState<Info | null>(null);
  const [dir, setDir] = useState("");

  useEffect(() => {
    let alive = true;
    const pull = () => invoke<Info>("model_info").then((i) => { if (alive) setInfo(i); }).catch(() => {});
    pull();
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
          </section>
          <section>
            <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-1">Speed</h3>
            <Row k={generating ? "Generating now" : "Last reply"} v={tps != null ? `${num(tps)} tokens/s` : "–"} />
            <Row k="Prompt reading" v={pre != null ? `${num(pre, 0)} tokens/s` : "–"} />
            {generating && <Row k="Average this reply" v={`${num(live.tokens_per_s_mean)} tokens/s`} />}
          </section>
          <section>
            <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-1">This computer</h3>
            <Row k="GPU" v={gpu?.name ?? "–"} />
            <Row k="GPU memory" v={gpu ? `${num((gpu.used_mib ?? 0) / 1024)} / ${num((gpu.total_mib ?? 0) / 1024)} GiB` : "–"} />
            <Row k="GPU load" v={gpu ? `${gpu.util_pct ?? "–"}%${gpu.temp_c != null ? ` · ${gpu.temp_c}°C` : ""}${gpu.power_w != null ? ` · ${num(gpu.power_w, 0)} W` : ""}` : "–"} />
            <Row k="System memory" v={ram ? `${num(ram.used_gib)} / ${num(ram.total_gib)} GiB` : "–"} />
          </section>
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
