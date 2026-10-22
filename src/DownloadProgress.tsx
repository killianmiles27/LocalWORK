export type DownloadState = { id: string; done?: number; total?: number | null; rate?: number; state?: string; stage?: string; message?: string };

const bytes = (n: number) => n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : `${(n / 1048576).toFixed(1)} MB`;
export default function DownloadProgress({ label, progress, percent: supplied }: { label: string; progress?: DownloadState | null; percent?: number | null }) {
  const known = typeof progress?.total === "number" && progress.total > 0;
  const percent = supplied != null ? Math.min(100, Math.max(0, supplied)) : known ? Math.min(100, Math.max(0, ((progress?.done ?? 0) / progress!.total!) * 100)) : null;
  return <div role="status" className="min-w-0 space-y-1.5 text-xs" aria-live="polite">
    <div className="flex justify-between gap-3"><span className="min-w-0 break-words">{progress?.message || label}</span>{percent !== null && <span className="shrink-0 tabular-nums">{Math.floor(percent)}%</span>}</div>
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent === null ? undefined : Math.floor(percent)} className="h-1.5 rounded-full bg-panel-2 overflow-hidden">
      <div className={`h-full rounded-full bg-accent ${percent === null ? "w-1/3 animate-pulse" : ""}`} style={percent === null ? undefined : { width: `${percent}%` }} />
    </div>
    {typeof progress?.done === "number" && <div className="text-muted tabular-nums">{bytes(progress.done)}{known ? ` / ${bytes(progress.total!)}` : " downloaded"}{progress.rate ? ` · ${bytes(progress.rate)}/s` : ""}</div>}
  </div>;
}
