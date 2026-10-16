import { useMemo, useState } from "react";
import { Check, Circle, Loader2 } from "lucide-react";
import SandboxedUi from "./SandboxedUi";

export type RichActions = { onDocument?: (path: string) => void; onVisual?: () => void; onDraft?: (text: string) => void };

const PALETTE = ["#2563eb", "#0d9488", "#d97706", "#7c3aed", "#db2777", "#16a34a", "#dc2626", "#0891b2"];
const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : Number(v) || 0);

function Frame({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <div className="ml-10 rounded-xl border border-line bg-card p-3 max-w-[640px]">
      {title && <div className="text-sm font-medium mb-2">{title}</div>}
      {children}
    </div>
  );
}

export function Chart({ a }: { a: any }) {
  const labels: string[] = (a.labels ?? []).map(String);
  const series: { name?: string; values: number[] }[] = (a.series ?? []).map((s: any) => ({ name: s.name, values: (s.values ?? []).map(num) }));
  const W = 560, H = 260, L = 44, B = 36, T = 10, R = 10;
  const all = series.flatMap((s) => s.values);
  const max = Math.max(1e-9, ...all, 0), min = Math.min(0, ...all);
  const y = (v: number) => T + (H - T - B) * (1 - (v - min) / (max - min || 1));
  const n = Math.max(labels.length, 1);
  const step = (W - L - R) / n;
  const ticks = [0, 1, 2, 3, 4].map((i) => min + ((max - min) * i) / 4);
  const fmt = (v: number) => (Math.abs(v) >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : String(Math.round(v * 100) / 100));
  let body: React.ReactNode;
  if (a.type === "pie") {
    const vals = (series[0]?.values ?? []).map((v) => Math.max(0, v));
    const total = vals.reduce((x, y2) => x + y2, 0) || 1;
    let ang = -Math.PI / 2;
    const cx = 120, cy = 120, r = 100;
    body = (
      <div className="flex flex-wrap items-center gap-4">
        <svg viewBox="0 0 240 240" className="w-48 h-48">
          {vals.map((v, i) => {
            const a2 = (v / total) * Math.PI * 2;
            const x1 = cx + r * Math.cos(ang), y1 = cy + r * Math.sin(ang);
            ang += a2;
            const x2 = cx + r * Math.cos(ang), y2 = cy + r * Math.sin(ang);
            return vals.length === 1 ? <circle key={i} cx={cx} cy={cy} r={r} fill={PALETTE[0]} /> : <path key={i} d={`M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${a2 > Math.PI ? 1 : 0} 1 ${x2},${y2} Z`} fill={PALETTE[i % 8]} stroke="white" strokeWidth="1" />;
          })}
        </svg>
        <ul className="text-sm space-y-1">
          {vals.map((v, i) => (
            <li key={i} className="flex items-center gap-2"><span className="inline-block w-3 h-3 rounded-sm" style={{ background: PALETTE[i % 8] }} />{labels[i] ?? i + 1}: {fmt(v)} ({Math.round((v / total) * 100)}%)</li>
          ))}
        </ul>
      </div>
    );
  } else {
    body = (
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={L} x2={W - R} y1={y(t)} y2={y(t)} stroke="currentColor" opacity="0.12" />
            <text x={L - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="currentColor" opacity="0.6">{fmt(t)}</text>
          </g>
        ))}
        {labels.map((l, i) => (
          <text key={i} x={L + step * (i + 0.5)} y={H - B + 16} textAnchor="middle" fontSize="11" fill="currentColor" opacity="0.7">{l.length > 12 ? l.slice(0, 11) + "…" : l}</text>
        ))}
        {a.type === "line"
          ? series.map((s, si) => {
              const pts = s.values.map((v, i) => `${L + step * (i + 0.5)},${y(v)}`);
              return (
                <g key={si}>
                  <polyline points={pts.join(" ")} fill="none" stroke={PALETTE[si % 8]} strokeWidth="2" />
                  {s.values.map((v, i) => <circle key={i} cx={L + step * (i + 0.5)} cy={y(v)} r="3" fill={PALETTE[si % 8]}><title>{`${s.name ?? ""} ${labels[i] ?? ""}: ${v}`}</title></circle>)}
                </g>
              );
            })
          : series.map((s, si) => {
              const bw = Math.min(40, (step * 0.8) / series.length);
              return s.values.map((v, i) => {
                const x = L + step * (i + 0.5) - (bw * series.length) / 2 + bw * si;
                return <rect key={`${si}-${i}`} x={x} y={Math.min(y(v), y(0))} width={bw} height={Math.abs(y(v) - y(0))} fill={PALETTE[si % 8]} rx="2"><title>{`${s.name ?? ""} ${labels[i] ?? ""}: ${v}`}</title></rect>;
              });
            })}
      </svg>
    );
  }
  return (
    <Frame title={a.title}>
      {body}
      {a.type !== "pie" && series.length > 1 && (
        <div className="flex flex-wrap gap-3 text-xs mt-1">
          {series.map((s, i) => <span key={i} className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm" style={{ background: PALETTE[i % 8] }} />{s.name ?? `Series ${i + 1}`}</span>)}
        </div>
      )}
    </Frame>
  );
}

export function Table({ a }: { a: any }) {
  const cols: string[] = (a.columns ?? []).map(String);
  const rows: any[][] = a.rows ?? [];
  const [sort, setSort] = useState<[number, number] | null>(null);
  const view = useMemo(() => {
    if (!sort) return rows;
    const [c, d] = sort;
    return [...rows].sort((x, y) => {
      const p = x[c], q = y[c];
      const r = typeof p === "number" && typeof q === "number" ? p - q : String(p ?? "").localeCompare(String(q ?? ""), undefined, { numeric: true });
      return r * d;
    });
  }, [rows, sort]);
  return (
    <Frame title={a.title}>
      <div className="overflow-auto max-h-96">
        <table className="text-sm w-full border-collapse">
          <thead>
            <tr>
              {cols.map((c, i) => (
                <th key={i} onClick={() => setSort(sort && sort[0] === i ? [i, -sort[1]] : [i, 1])} className="text-left font-medium border-b border-line px-2 py-1.5 cursor-pointer select-none hover:text-accent whitespace-nowrap">
                  {c}{sort?.[0] === i ? (sort[1] > 0 ? " ▲" : " ▼") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.map((r, i) => (
              <tr key={i} className="odd:bg-panel/50">
                {cols.map((_, j) => <td key={j} className="px-2 py-1 border-b border-line/50 align-top">{r[j] == null ? "" : String(r[j])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="text-xs text-muted mt-1">{rows.length} rows</div>
    </Frame>
  );
}

export function Diagram({ a }: { a: any }) {
  const nodes: { id: string; label?: string }[] = a.nodes ?? [];
  const edges: { from: string; to: string; label?: string }[] = a.edges ?? [];
  const lr = a.direction !== "TD";
  // layered layout: depth = longest path from a root (cycles are cut by iteration cap)
  const depth: Record<string, number> = {};
  nodes.forEach((n) => (depth[n.id] = 0));
  for (let k = 0; k < nodes.length; k++) edges.forEach((e) => { if (e.from in depth && e.to in depth && depth[e.to] < depth[e.from] + 1 && depth[e.from] < nodes.length) depth[e.to] = depth[e.from] + 1; });
  const layers: string[][] = [];
  nodes.forEach((n) => (layers[depth[n.id]] ??= []).push(n.id));
  const NW = 130, NH = 44, GX = 70, GY = 28;
  const pos: Record<string, [number, number]> = {};
  layers.forEach((ids, li) => (ids ?? []).forEach((id, i) => { pos[id] = lr ? [li * (NW + GX), i * (NH + GY)] : [i * (NW + GX), li * (NH + GY + 20)]; }));
  const maxX = Math.max(0, ...Object.values(pos).map((p) => p[0])) + NW;
  const maxY = Math.max(0, ...Object.values(pos).map((p) => p[1])) + NH;
  const lab = (id: string) => nodes.find((n) => n.id === id)?.label ?? id;
  return (
    <Frame title={a.title}>
      <div className="overflow-auto">
        <svg viewBox={`-6 -6 ${maxX + 12} ${maxY + 12}`} style={{ width: Math.min(maxX + 12, 600), minWidth: 200 }} className="text-ink">
          <defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="currentColor" opacity="0.6" /></marker></defs>
          {edges.map((e, i) => {
            const p = pos[e.from], q = pos[e.to];
            if (!p || !q) return null;
            const [x1, y1, x2, y2] = lr ? [p[0] + NW, p[1] + NH / 2, q[0], q[1] + NH / 2] : [p[0] + NW / 2, p[1] + NH, q[0] + NW / 2, q[1]];
            const back = lr ? x2 <= x1 : y2 <= y1;
            return (
              <g key={i}>
                <path d={back ? `M${x1},${y1} C${x1 + 40},${y1 - 50} ${x2 - 40},${y2 - 50} ${x2},${y2}` : `M${x1},${y1} L${x2},${y2}`} stroke="currentColor" opacity="0.5" fill="none" markerEnd="url(#ah)" />
                {e.label && <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 4} fontSize="10" textAnchor="middle" fill="currentColor" opacity="0.7">{e.label}</text>}
              </g>
            );
          })}
          {nodes.map((n) => {
            const p = pos[n.id];
            const l = lab(n.id);
            return (
              <g key={n.id}>
                <rect x={p[0]} y={p[1]} width={NW} height={NH} rx="8" fill="#dbeafe" stroke="#2563eb" />
                <text x={p[0] + NW / 2} y={p[1] + NH / 2 + 4} textAnchor="middle" fontSize="12" fill="#1e3a8a">{l.length > 20 ? l.slice(0, 19) + "…" : l}</text>
              </g>
            );
          })}
        </svg>
      </div>
    </Frame>
  );
}

export function Artifact({ a, designSystem = false, actions }: { a: any; designSystem?: boolean; actions?: RichActions }) {
  const html = String(a.html ?? "");
  return (
    <Frame title={a.title}>
      {a.description && <p className="text-xs text-muted mb-2">{String(a.description)}</p>}
      <SandboxedUi title={String(a.title ?? "Interactive visual")} html={html} designSystem={designSystem} onDraft={actions?.onDraft} />
      {actions?.onVisual && <button onClick={actions.onVisual} className="mt-2 text-xs text-accent hover:underline">Open in workspace</button>}
    </Frame>
  );
}

export function Plan({ a }: { a: any }) {
  const steps: { text: string; status?: string }[] = a.steps ?? [];
  const done = steps.filter((s) => s.status === "done").length;
  return (
    <Frame title={`Plan (${done}/${steps.length})`}>
      <ul className="space-y-1 text-sm">
        {steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2">
            {s.status === "done" ? <Check size={15} className="mt-0.5 text-green-600" /> : s.status === "doing" ? <Loader2 size={15} className="mt-0.5 animate-spin text-accent" /> : <Circle size={15} className="mt-0.5 text-muted" />}
            <span className={s.status === "done" ? "text-muted line-through" : ""}>{s.text}</span>
          </li>
        ))}
      </ul>
    </Frame>
  );
}

export function richFor(name: string, args: any, actions?: RichActions): React.ReactNode | null {
  const a = args && typeof args === "object" ? (args.arguments ?? args) : null;
  if (!a) return null;
  if (/show_chart$/.test(name)) return <Chart a={a} />;
  if (/show_table$/.test(name)) return <Table a={a} />;
  if (/show_diagram$/.test(name)) return <Diagram a={a} />;
  if (/assemble_document$/.test(name)) return <Artifact a={a} designSystem actions={actions} />;
  if (/publish_artifact$/.test(name)) return <Artifact a={a} actions={actions} />;
  if (/show_document$/.test(name)) return <Frame title={String(a.title ?? "Document ready")}><button onClick={() => actions?.onDocument?.(String(a.path))} className="text-sm text-accent hover:underline break-all">{String(a.path)} · Preview & revise</button></Frame>;
  if (/update_plan$/.test(name)) return <Plan a={a} />;
  return null;
}
