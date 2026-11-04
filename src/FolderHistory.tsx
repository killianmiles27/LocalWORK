import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { History, RotateCcw, Trash2, X } from "lucide-react";
import { Button, Toggle } from "./settings-ui";

/** One folder snapshot taken before an automatic command. */
type Snapshot = {
  id: string;
  created: number;
  files: { path: string }[];
  skipped: { path: string; reason: string }[];
};

function when(ms: number): string {
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(ms).toLocaleString();
}

/**
 * Folder undo points for one chat. The host captured these before automatic shell commands; this
 * panel is the only place that restores them, so it stays a deliberate, confirmed action.
 */
export default function FolderHistory({ id, onClose, onRestored }: { id: string; onClose: () => void; onRestored: () => void }) {
  const [snaps, setSnaps] = useState<Snapshot[] | null>(null);
  const [exact, setExact] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState("");

  const load = () => invoke<Snapshot[]>("workspace_snapshots_list", { id })
    .then(rows => setSnaps([...rows].sort((a, b) => b.created - a.created)))
    .catch(e => { setSnaps([]); setError(String(e)); });
  useEffect(() => { void load(); }, [id]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const total = useMemo(() => snaps?.reduce((n, s) => n + s.files.length, 0) ?? 0, [snaps]);

  async function restore(snap: Snapshot) {
    const files = snap.files.length;
    const extra = exact ? ` Files created after it will be deleted.` : " Files created after it are kept.";
    if (!window.confirm(`Restore ${files} file${files === 1 ? "" : "s"} from ${when(snap.created)}?${extra}`)) return;
    setBusy(snap.id); setError(""); setResult("");
    try {
      const report = await invoke<{ restored: string[]; deleted: string[] }>("workspace_snapshot_restore", {
        id, snapshot: snap.id, exact,
      });
      setResult(`Restored ${report.restored.length} file${report.restored.length === 1 ? "" : "s"}` +
        (report.deleted.length ? `, deleted ${report.deleted.length} newer one${report.deleted.length === 1 ? "" : "s"}` : "") + ".");
      onRestored();
      await load();
    } catch (e) { setError(String(e)); }
    finally { setBusy(""); }
  }

  async function clean() {
    if (!window.confirm("Remove all stored undo points for this chat? The working folder is not changed.")) return;
    setBusy("clean"); setError(""); setResult("");
    try { await invoke("workspace_snapshots_cleanup", { id }); setResult("Undo points removed."); await load(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(""); }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Folder history" onClick={e => e.stopPropagation()}
        className="w-full max-w-xl max-h-[min(40rem,calc(100dvh-2rem))] flex flex-col overflow-hidden rounded-2xl bg-bg border border-line shadow-xl">
        <div className="flex items-center justify-between pl-5 pr-3 h-12 shrink-0">
          <h2 className="flex items-center gap-2 text-lg font-semibold"><History size={16} className="text-accent" />Folder history</h2>
          <button onClick={onClose} title="Close" aria-label="Close" className="p-1.5 rounded-lg text-muted hover:text-ink hover:bg-panel-2"><X size={17} /></button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-5 pb-5 space-y-3">
          <p className="text-xs text-muted">
            A snapshot is taken before each command Automatic mode runs in this folder. {total > 0 ? `${total} file${total === 1 ? "" : "s"} across ${snaps?.length} undo point${snaps?.length === 1 ? "" : "s"}.` : ""} Restoring is refused while a reply is running.
          </p>
          <label className="flex items-center justify-between gap-4 rounded-xl border border-line bg-card px-3.5 py-2.5 text-sm">
            <span className="min-w-0">
              <span className="block">Exact restore</span>
              <span className="block text-xs text-muted">Also delete files created after the snapshot. Unavailable when a snapshot skipped files.</span>
            </span>
            <Toggle label="Exact restore" checked={exact} onChange={setExact} />
          </label>
          {result && <p role="status" className="text-xs text-sage">{result}</p>}
          {error && <p role="alert" className="text-xs text-red-500 break-words">{error}</p>}
          {snaps === null && <p className="text-sm text-muted">Loading…</p>}
          {snaps?.length === 0 && <p className="rounded-xl border border-line bg-card px-3.5 py-3 text-sm text-muted">No undo points yet. Run a task in Automatic mode and one appears before the first command.</p>}
          {snaps?.map(s => (
            <div key={s.id} className="flex items-center gap-3 rounded-xl border border-line bg-card px-3.5 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="text-sm">{when(s.created)}</div>
                <div className="text-xs text-muted truncate" title={new Date(s.created).toLocaleString()}>
                  {s.files.length} file{s.files.length === 1 ? "" : "s"}
                  {s.skipped.length > 0 && ` · ${s.skipped.length} skipped`}
                  {s.files[0]?.path && ` · ${s.files[0].path}`}
                </div>
              </div>
              <Button small disabled={!!busy} onClick={() => restore(s)} title="Restore the folder to this snapshot">
                {busy === s.id ? "Restoring…" : <><RotateCcw size={13} className="inline mr-1" />Restore</>}
              </Button>
            </div>
          ))}
        </div>
        {!!snaps?.length && (
          <div className="shrink-0 border-t border-line px-5 py-3 flex justify-end">
            <Button variant="danger" small disabled={!!busy} onClick={clean} title="Delete the stored snapshots, not the folder">
              <Trash2 size={13} className="inline mr-1" />{busy === "clean" ? "Removing…" : "Remove undo points"}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
