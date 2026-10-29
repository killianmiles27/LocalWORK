import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { invoke } from "@tauri-apps/api/core";
import OfficeFrame from "./OfficeFrame";
import SandboxedUi from "./SandboxedUi";
import { applyDocumentChange, lineDiff, linePreview, type LineDiff } from "./documentChanges";

type Preview = { path: string; kind: string; format: "html" | "text" | "pdf"; content: string };
type Props = {
  id: string; path: string; revision: string; refresh: number; onSaved: (path: string) => void;
  Pdf: ComponentType<{ data: string; title: string }>;
};
const TEXT = new Set(["md", "txt", "csv", "json", "log"]);
const OFFICE = new Set(["docx", "xlsx", "pptx"]);
const button = "rounded-lg border border-line px-2.5 py-1 text-xs hover:border-accent disabled:opacity-40";
const noop = () => {};
const range = (start: number, end: number) => start === end ? `at line ${start + 1}` : start + 1 === end ? `line ${end}` : `lines ${start + 1}–${end}`;

export default function DocumentChanges({ id, path, revision, refresh, onSaved, Pdf }: Props) {
  const [pair, setPair] = useState<{ current: Preview; old: Preview } | null>(null);
  const [texts, setTexts] = useState<{ current?: Record<string, string>; old?: Record<string, string> }>({});
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const mutating = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(""); setConfirming(false);
    Promise.all([
      invoke<Preview>("document_preview", { id, path, revision: null }),
      invoke<Preview>("document_preview", { id, path, revision }),
    ]).then(([current, old]) => {
      if (active) setPair({ current, old });
    }).catch(e => { if (active) setError(String(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id, path, revision, refresh, reload]);

  const textFile = !!pair && TEXT.has(pair.current.kind) && pair.current.format === "text" && pair.old.format === "text";
  const office = !!pair && OFFICE.has(pair.current.kind);
  const diff = useMemo(() => {
    if (textFile && pair) return lineDiff(pair.old.content, pair.current.content);
    if (office && texts.old && texts.current && [...Object.values(texts.old), ...Object.values(texts.current)].some(value => value.trim()))
      return lineDiff(Object.values(texts.old).join("\n"), Object.values(texts.current).join("\n"));
    return null;
  }, [pair, textFile, office, texts]);

  function change(hunk?: number) {
    if (!pair || mutating.current || loading) return;
    setNotice(""); setConfirming(false);
    const request = hunk === undefined ? { id, path, revision } : { id, path, diff: diff!, hunk };
    return applyDocumentChange(invoke, request, {
      busy: value => { mutating.current = value; setWorking(value); }, error: setError,
      saved: () => { setNotice(hunk === undefined ? "Version restored. The pre-restore file is saved in history." : "Change undone. The previous file is saved in history."); onSaved(path); },
    });
  }
  function surface(preview: Preview, side: "current" | "old") {
    const title = side === "current" ? `Current: ${path}` : `Earlier version: ${path}`;
    if (textFile && diff) return <SandboxedUi html={linePreview(diff, side === "current" ? "after" : "before")} title={title} expanded />;
    if (OFFICE.has(preview.kind)) return <OfficeFrame html={preview.content} title={title} editing={false} zoom={100}
      comparison={side === "current" ? texts.old : texts.current} onZoom={noop} onActive={noop} onScroll={noop} onEdit={noop} onSelect={noop}
      onTexts={value => setTexts(t => ({ ...t, [side]: value }))} />;
    if (preview.format === "html") return <SandboxedUi html={preview.content} title={title} expanded />;
    if (preview.format === "pdf") return <Pdf data={preview.content} title={title} />;
    return <SandboxedUi html={linePreview(lineDiff(preview.content, preview.content), "after")} title={title} expanded />;
  }
  return <section aria-label="Document changes" className="flex h-full min-h-0 flex-col gap-3">
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
      <span>Current on the left · Selected revision on the right · Read-only previews</span>
      <button className={button} disabled={!pair || loading || working} onClick={() => setConfirming(true)}>Restore this version</button>
    </div>
    {error && <div role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">{error}<button className="ml-2 underline" onClick={() => setReload(n => n + 1)} disabled={working}>Reload comparison</button></div>}
    {notice && <p role="status" className="text-xs text-green-600">{notice}</p>}
    {confirming && <div role="alertdialog" aria-label="Restore document version" className="rounded-lg border border-line bg-panel p-3 text-sm">
      <p>Replace the entire current file with this revision? Your current file will be saved in history first. Stop the assistant and finish edits in other apps before restoring.</p>
      <div className="mt-2 flex justify-end gap-2"><button autoFocus className={button} onClick={() => setConfirming(false)}>Cancel</button><button className={button} disabled={working || loading} onClick={() => change()}>Confirm restore</button></div>
    </div>}
    {loading && <p role="status" className="text-sm text-muted">Preparing comparison…</p>}
    {pair && <>
      <div className="min-h-64 flex-1 overflow-x-auto" aria-busy={loading || working}>
        <div className="grid h-full min-w-[560px] grid-cols-2 gap-3">
          {(["current", "old"] as const).map(side => <div key={side} className="flex min-h-0 flex-col overflow-hidden rounded-lg border border-line bg-card">
            <h3 className="shrink-0 border-b border-line px-3 py-2 text-xs font-medium">{side === "current" ? "Current" : "Selected revision"}</h3>
            <div className="min-h-0 flex-1">{surface(pair[side], side)}</div>
          </div>)}
        </div>
      </div>
      <div className="max-h-64 shrink-0 space-y-2 overflow-auto text-xs">
        {!textFile && <p className="text-muted">{office
          ? "Office changes cannot safely be undone per region: text edits could corrupt formatting, formulas or document structure. Restore the entire version instead. Highlights and summaries cover extracted preview text only, not layout or all content."
          : "Only a visual comparison is available: visible text cannot be extracted reliably from this preview. Restore the entire version instead."}</p>}
        {office && !diff && <p className="text-muted">Only a visual comparison is available until both previews supply extractable text.</p>}
        {diff && <Hunks diff={diff} textFile={textFile} disabled={working || loading} onUndo={index => change(index)} />}
      </div>
    </>}
  </section>;
}

function Hunks({ diff, textFile, disabled, onUndo }: { diff: LineDiff; textFile: boolean; disabled: boolean; onUndo: (index: number) => void }) {
  return <>
    <p className="text-muted">{diff.hunks.length ? `${diff.hunks.length} changed ${diff.hunks.length === 1 ? "region" : "regions"}` : textFile ? "No line changes in this revision." : "No extracted text changes; formatting and other visual changes may still differ."}{diff.coarse ? " · Large comparison: nearby changes are grouped into one region." : ""}</p>
    {diff.hunks.slice(0, 100).map((h, i) => <div key={i} className="rounded-lg border border-line bg-card p-2">
      <div className="flex flex-wrap items-center justify-between gap-2"><span>Current {range(h.newStart, h.newEnd)} · Earlier {range(h.oldStart, h.oldEnd)} · +{h.newEnd - h.newStart} / −{h.oldEnd - h.oldStart}</span>
        {textFile && <button className={button} disabled={disabled} onClick={() => onUndo(i)}>Undo this change</button>}</div>
      {!textFile && <div className="mt-1 whitespace-pre-wrap break-words">
        <p className="text-red-700 dark:text-red-300">− {diff.before.slice(h.oldStart, h.oldEnd).join("").slice(0, 600) || "(no earlier text)"}</p>
        <p className="text-green-700 dark:text-green-300">+ {diff.after.slice(h.newStart, h.newEnd).join("").slice(0, 600) || "(no current text)"}</p>
      </div>}
    </div>)}
    {diff.hunks.length > 100 && <p className="text-muted">Showing the first 100 regions. Undo and refresh to review remaining changes.</p>}
  </>;
}
