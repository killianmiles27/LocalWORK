import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/** A plugin's composer status item. Values are dotted paths into the source's JSON. */
type Item = {
  id: string; plugin: string; label: string; source: string; value: string; unit?: string; prefix?: string; decimals?: number;
  secondary?: string; secondaryUnit?: string; pct?: string; warn?: number; secondaryWarn?: number; tooltip?: string; settings?: Record<string, unknown>;
};

const at = (o: any, path?: string): number | null => {
  if (!path) return null;
  const v = path.split(".").reduce((x, k) => (x == null ? x : x[k]), o);
  return typeof v === "number" && isFinite(v) ? v : null;
};
const fmt = (n: number | null, unit = "", prefix = "", decimals?: number) =>
  n == null ? "—" : prefix + (decimals != null ? n.toFixed(decimals) : Math.abs(n) >= 100 || unit === "%" || unit === "°C" ? Math.round(n) : n.toFixed(1)) + unit;

// Host commands a status item may read. Plugins are declarative, so they cannot name arbitrary commands.
// Each source receives the plugin's own settings.
const HOST_SOURCES = new Set(["host:system_stats", "host:power_stats"]);
const key = (it: Item) => `${it.plugin}|${it.source}`;

/** Polls only while the window is visible; sources are host commands (`host:<command>`). */
export default function StatusItems() {
  const [items, setItems] = useState<Item[]>([]);
  const [data, setData] = useState<Record<string, any>>({});

  useEffect(() => {
    const load = () => invoke<Item[]>("status_items").then(setItems).catch(() => {});
    load();
    // Settings > Plugins announces changes so turning a plugin on or off shows here at once.
    window.addEventListener("plugins-changed", load);
    return () => window.removeEventListener("plugins-changed", load);
  }, []);

  useEffect(() => {
    const sources = new Map<string, Item>();
    for (const it of items) if (HOST_SOURCES.has(it.source) && !sources.has(key(it))) sources.set(key(it), it);
    if (!sources.size) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function pull() {
      if (document.visibilityState === "visible") {
        const next: Record<string, any> = {};
        await Promise.all([...sources].map(([k, it]) => invoke(it.source.slice(5), { settings: it.settings ?? {} }).then(v => { next[k] = v; }).catch(() => {})));
        if (active) setData(next);
      }
      if (active) timer = setTimeout(pull, 2000);
    }
    pull();
    return () => { active = false; clearTimeout(timer); };
  }, [items]);

  if (!items.length) return null;
  return (
    <div data-testid="status-items" className="hidden @min-[46rem]:flex items-center gap-2 text-[11px] tabular-nums text-muted whitespace-nowrap">
      {items.map(it => {
        const d = data[key(it)];
        const v = at(d, it.value), s = at(d, it.secondary), p = at(d, it.pct);
        if (d && v == null && s == null) return null;
        const hot = (it.warn != null && (p ?? v ?? 0) >= it.warn) || (it.secondaryWarn != null && (s ?? 0) >= it.secondaryWarn);
        const main = p != null ? `${Math.round(p)}%` : fmt(v, it.unit, it.prefix, it.decimals);
        const tip = it.tooltip
          ? it.tooltip.replace(/\$\{([\w.]+)\}/g, (_, path) => { const n = at(d, path); return n == null ? "—" : (it.prefix ?? "") + String(n); })
          : `${it.label}: ${fmt(v, it.unit, it.prefix, it.decimals)}${p != null ? ` (${Math.round(p)}%)` : ""}${it.secondary ? ` · ${fmt(s, it.secondaryUnit)}` : ""}`;
        return (
          <span key={`${it.plugin}/${it.id}`} title={tip} className={hot ? "text-red-500" : ""}>
            <span className="opacity-60">{it.label}</span> {main}{it.secondary && s != null && <span className="opacity-70"> {fmt(s, it.secondaryUnit)}</span>}
          </span>
        );
      })}
    </div>
  );
}
