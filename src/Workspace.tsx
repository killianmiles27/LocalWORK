import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import Md from "./Md";
import { ArrowDownToLine, Check, ExternalLink, FileText, FolderOpen, History, Maximize2, MessageSquarePlus, Minimize2, PanelRightClose, Pencil, RefreshCw, Send, Sparkles, X } from "lucide-react";
import SandboxedUi from "./SandboxedUi";
import BrowserLive from "./BrowserLive";
import OfficeFrame, { describeNode, type FrameSelection } from "./OfficeFrame";
import { assembleDocument, previewDocument } from "./intelligent-ui";

export type VisualItem = { id: string; title: string; html: string; designSystem: boolean };
/** The file the assistant is changing right now, if any. */
export type Activity = { path: string; busy: boolean; nonce: number };
type FileEntry = { path: string; name: string; kind: string; size: number; modified: number | null };
type Preview = { path: string; kind: string; format: "html" | "text" | "pdf"; content: string };
type Revision = { id: string; created: number; size: number };
type Note = { quote: string; where: string; comment: string };
type Picked = { text: string; where: string; top: number; left: number };
type Props = {
  id: string; refresh: number; visuals: VisualItem[]; requested?: { path?: string; visual?: string; browser?: boolean; nonce: number }; browserTick: number;
  activity?: Activity; canSend: boolean; relatedChanges: number; canCheckRelated: boolean; onCheckRelated: () => void;
  onClose: () => void; onDraft: (text: string) => void; onSend: (text: string) => void; onUserEdit: (path: string, change?: { node: string; before: string; after: string }) => void;
};

const OFFICE = new Set(["docx", "xlsx", "pptx"]), TEXT = new Set(["md", "txt", "csv", "json", "html"]);
const date = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
const bytes = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
const iconButton = "inline-flex shrink-0 items-center gap-1.5 rounded-lg p-1.5 text-muted hover:bg-panel hover:text-ink disabled:opacity-40";

/** The file an agent tool call changes: OfficeCLI write commands and Write/Edit calls. */
export function touchedFile(name: string, args: unknown): string | null {
  let a: any = args;
  if (typeof a === "string") { try { a = JSON.parse(a); } catch { return null; } }
  a = a?.arguments ?? a;
  if (/officecli$/i.test(name) && Array.isArray(a?.args)) {
    if (/^(view|get|query|validate|help|close|open|watch)$/i.test(String(a.args[0] ?? ""))) return null;
    return a.args.find((x: unknown) => typeof x === "string" && /\.(docx|xlsx|pptx)$/i.test(x)) ?? null;
  }
  if (/(write|edit)/i.test(name) && typeof a?.file_path === "string") return a.file_path;
  return null;
}

/** Markdown blocks split on blank lines, keeping fenced code together. */
function blocks(md: string): string[] {
  const out: string[] = []; let cur: string[] = [], fence = false;
  for (const line of md.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && !line.trim()) { if (cur.length) out.push(cur.join("\n")); cur = []; } else cur.push(line);
  }
  if (cur.length) out.push(cur.join("\n"));
  return out;
}

/** PDF bytes (base64) in the WebView's built-in viewer. No sandbox attribute: it disables that viewer. */
function PdfFrame({ data, title }: { data: string; title: string }) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const raw = atob(data), buf = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) buf[i] = raw.charCodeAt(i);
    const u = URL.createObjectURL(new Blob([buf], { type: "application/pdf" }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [data]);
  return url ? <iframe src={url} title={title} className="h-full min-h-[70vh] w-full rounded-lg border border-line bg-card" /> : null;
}

function notesMessage(file: string, notes: Note[]): string {
  return `Please make these changes to "${file}" (my notes from the file pane):\n` +
    notes.map((n, i) => `${i + 1}. At "${n.quote.length > 300 ? n.quote.slice(0, 300) + "…" : n.quote}"${n.where ? ` (${n.where})` : ""}: ${n.comment || "fix this"}`).join("\n") +
    "\nChange only these parts and keep everything else as it is.";
}

export default function Workspace({ id, refresh, visuals, requested, browserTick, activity, canSend, relatedChanges, canCheckRelated, onCheckRelated, onClose, onDraft, onSend, onUserEdit }: Props) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [{ selection, revision }, setChoice] = useState({ selection: "", revision: "" });
  const setSelection = (selection: string) => setChoice(current => current.selection === selection ? current : { selection, revision: "" });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [loading, setLoading] = useState(false);
  const [listing, setListing] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState(false);
  const [officeActive, setOfficeActive] = useState(false);
  const officeInteraction = useRef(false);
  const pendingOfficeEdits = useRef(0);
  const officeEditGeneration = useRef(0);
  const [zoom, setZoom] = useState(100);
  const changeZoom = (direction: number) => setZoom(z => direction === 0 ? 100 : Math.min(250, Math.max(25, z + direction * 10)));
  const [draftText, setDraftText] = useState<{ base: string; text: string } | null>(null);
  const [stale, setStale] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(0);
  const [width, setWidth] = useState(() => { try { return Number(localStorage.getItem("workspace-width")) || 0; } catch { return 0; } });
  const body = useRef<HTMLDivElement>(null);
  // What each file looked like at its last load, so a reload can highlight what changed.
  const seen = useRef(new Map<string, { texts?: Record<string, string>; text?: string; scroll?: number }>());
  const [previous, setPrevious] = useState<{ texts?: Record<string, string>; text?: string } | undefined>();
  const edits = useRef(Promise.resolve());
  const followed = useRef(0);
  const selectedFile = selection.startsWith("file:") ? selection.slice(5) : "";
  const visual = visuals.find(v => `visual:${v.id}` === selection);
  const file = files.find(f => f.path === selectedFile);
  const kind = (selectedFile.split(".").pop() ?? "").toLowerCase();
  const canEdit = !!selectedFile && !revision && (OFFICE.has(kind) || TEXT.has(kind));
  const agentHere = !!activity?.busy && !!selectedFile && matches(activity.path, selectedFile);

  function matches(abs: string, rel: string) {
    const a = abs.replaceAll("\\", "/").toLowerCase(), r = rel.toLowerCase();
    return a === r || a.endsWith("/" + r);
  }

  useEffect(() => {
    let active = true;
    setListing(true);
    const timer = setTimeout(() => {
      invoke<FileEntry[]>("documents_list", { id }).then(entries => {
        if (!active) return;
        setFiles(entries);
        setChoice(current => current.selection ? current : { selection: entries.length ? `file:${[...entries].sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0))[0].path}` : "", revision: "" });
      }).catch(e => { if (active) setError(String(e)); }).finally(() => { if (active) setListing(false); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [id, refresh, reload]);

  useEffect(() => {
    if (officeInteraction.current || pendingOfficeEdits.current) return;
    if (requested?.path) setSelection(`file:${requested.path.replaceAll("\\", "/")}`);
    if (requested?.visual) setSelection(`visual:${requested.visual}`);
    if (requested?.browser) setSelection("browser");
  }, [requested]);
  // Follow the file the assistant is working on, unless the user is in the middle of editing.
  useEffect(() => {
    if (!activity?.path || editing || officeInteraction.current || pendingOfficeEdits.current || followed.current === activity.nonce) return;
    const hit = files.find(f => matches(activity.path, f.path));
    if (hit) { followed.current = activity.nonce; setSelection(`file:${hit.path}`); }
  }, [activity?.nonce, files]);
  useEffect(() => { setRevisions([]); setNotice(""); officeInteraction.current = false; setOfficeActive(false); setEditing(false); setDraftText(null); setStale(false); setPicked(null); setNotes([]); }, [selection]);

  useEffect(() => {
    if (!selectedFile) { setPreview(null); setLoading(false); setError(""); return; }
    // Never pull the page out from under the user's own edits; offer a reload instead.
    if (preview?.path === selectedFile && !revision && (editing || officeInteraction.current || pendingOfficeEdits.current)) { setStale(true); return; }
    let active = true;
    setError(""); setLoading(true); setStale(false);
    setPreview(current => current?.path === selectedFile && !revision ? current : null);
    const requestGeneration = officeEditGeneration.current;
    invoke<Preview>("document_preview", { id, path: selectedFile, revision: revision || null }).then(result => {
      if (!active) return;
      if (!revision && (officeInteraction.current || pendingOfficeEdits.current || officeEditGeneration.current !== requestGeneration)) { setStale(true); return; }
      const last = seen.current.get(selectedFile);
      setPrevious(revision ? undefined : last);
      if (result.format === "text") seen.current.set(selectedFile, { ...last, text: result.content });
      setPreview(result);
    }).catch(e => { if (active) setError(String(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id, selectedFile, revision, refresh, reload]);
  useEffect(() => {
    if (!selectedFile) return;
    let active = true;
    invoke<Revision[]>("document_revisions", { id, path: selectedFile }).then(result => { if (active) setRevisions(result); })
      .catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [id, selectedFile, refresh, reload, saving]);

  async function action(run: () => Promise<unknown>, success?: string) {
    setWorking(true); setError(""); setNotice("");
    try { const result = await run(); if (success && result !== false) setNotice(success); }
    catch (e) { setError(String(e)); }
    finally { setWorking(false); }
  }
  async function exportCopy() {
    const name = selectedFile.split("/").pop() ?? "visual.html";
    const ext = name.split(".").pop() ?? "html";
    const filename = visual ? `${visual.title.replace(/[^\p{L}\p{N} _-]/gu, "_").slice(0, 80) || "visual"}.html`
      : name.replace(new RegExp(`\\.${ext}$`, "i"), `${revision ? "-previous" : "-copy"}.${ext}`);
    const destination = await save({ title: "Save a copy", defaultPath: filename, filters: [{ name: visual ? "Interactive HTML" : ext.toUpperCase(), extensions: [visual ? "html" : ext] }] });
    if (!destination) return false;
    if (visual) {
      await invoke("document_save_visual", { destination, html: visual.designSystem ? assembleDocument(visual.html) : previewDocument(visual.html) });
    } else {
      await invoke("document_export", { id, path: selectedFile, destination, revision: revision || null });
    }
    return true;
  }

  function startEdit() {
    setPicked(null);
    if (TEXT.has(kind) && preview) setDraftText({ base: preview.content, text: preview.content });
    setEditing(true);
  }
  function stopEdit() { setEditing(false); setDraftText(null); setReload(n => n + 1); }
  async function saveText() {
    if (!draftText) return;
    if (draftText.text === draftText.base) return stopEdit();
    setWorking(true); setError("");
    try {
      await invoke("document_save", { id, path: selectedFile, content: draftText.text, expected: draftText.base });
      onUserEdit(selectedFile); setSaving(n => n + 1); setNotice("Saved. The previous version is in history."); stopEdit();
    } catch (e) { setError(String(e)); } finally { setWorking(false); }
  }
  // In-place Office edits run one at a time, in the order the user made them.
  function officeEdit(node: string, before: string, after: string) {
    const path = selectedFile;
    officeEditGeneration.current += 1;
    pendingOfficeEdits.current += 1;
    edits.current = edits.current.then(() => invoke("document_office_edit", { id, path, node, before, after }))
      .then(() => {
        const texts = seen.current.get(path)?.texts;
        if (texts) texts[node] = after;
        onUserEdit(path, { node, before, after }); setNotice("Saved.");
      })
      .catch(e => setError(`Could not save that change. Your visible edit is unsaved; copy it before reloading. ${e}`))
      .finally(() => { pendingOfficeEdits.current -= 1; setSaving(n => n + 1); });
  }

  function pickText() {
    if (editing) return;
    const s = window.getSelection(), text = s ? String(s).replace(/\s+/g, " ").trim() : "";
    if (!s || !text || !s.rangeCount || !body.current?.contains(s.anchorNode)) { setPicked(null); return; }
    const r = s.getRangeAt(0).getBoundingClientRect();
    place({ text: text.slice(0, 1000), where: "", top: r.bottom, left: r.left });
  }
  function place(p: Picked) {
    const box = body.current?.getBoundingClientRect();
    if (!box) return;
    setComment("");
    setPicked({ ...p, top: Math.min(Math.max(p.top - box.top + body.current!.scrollTop + 6, 8), box.height + body.current!.scrollTop - 120), left: Math.min(Math.max(p.left - box.left, 8), Math.max(8, box.width - 296)) });
  }
  function frameSelect(s: FrameSelection | null) {
    if (!s) { setPicked(null); return; }
    const where = describeNode(s.node);
    place({ text: s.text, where: s.node ? `${where ? where + ", " : ""}element ${s.node}` : "", top: s.rect.bottom, left: s.rect.left });
  }
  function addNote() {
    if (!picked) return;
    setNotes(n => [...n, { quote: picked.text, where: picked.where, comment: comment.trim() }].slice(-20));
    setPicked(null); setComment(""); window.getSelection()?.removeAllRanges();
  }
  function sendNotes(direct: boolean) {
    const text = notesMessage(selectedFile || visual?.title || "this file", notes);
    if (direct && canSend) onSend(text); else onDraft(text);
    setNotes([]);
  }

  const title = selection === "browser" ? "Live browser" : visual?.title || selectedFile.split("/").pop() || "Files";
  const hasSelection = !!selectedFile || !!visual;
  const officeView = preview?.path === selectedFile && preview?.format === "html" && OFFICE.has(preview.kind);
  const fresh = previous?.text !== undefined && preview?.format === "text" ? new Set(previous.text.split(/\r?\n/)) : null;
  const freshBlocks = previous?.text !== undefined && preview?.kind === "md" ? new Set(blocks(previous.text)) : null;
  const status = agentHere ? <span className="inline-flex items-center gap-1.5 rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />Assistant editing</span>
    : editing ? <span className="rounded-full bg-panel px-2 py-0.5 text-xs text-muted">Editing</span>
    : revision ? <span className="rounded-full bg-panel px-2 py-0.5 text-xs text-muted">Earlier version</span> : null;

  // Drag the left edge to resize; the width is kept for next time. The chat keeps at least 420px.
  const clampWidth = (w: number) => Math.round(Math.min(Math.max(w, 320), Math.max(320, innerWidth - 420)));
  function startResize(e: React.PointerEvent) {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    let last = width;
    const move = (ev: PointerEvent) => { last = clampWidth(innerWidth - ev.clientX); setWidth(last); };
    const up = () => {
      handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", up);
      try { localStorage.setItem("workspace-width", String(last)); } catch { /* ignore */ }
    };
    handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", up);
  }
  function resizeKey(e: React.KeyboardEvent) {
    const step = e.key === "ArrowLeft" ? 40 : e.key === "ArrowRight" ? -40 : 0;
    if (!step) return;
    e.preventDefault();
    const next = clampWidth((width || (e.currentTarget.parentElement?.offsetWidth ?? 600)) + step);
    setWidth(next); try { localStorage.setItem("workspace-width", String(next)); } catch { /* ignore */ }
  }

  return (
    <aside aria-label="Document and visual workspace" style={!expanded && width ? { width: clampWidth(width), maxWidth: "none" } : undefined} className={expanded
      ? "fixed inset-4 top-12 z-40 flex flex-col bg-bg border border-line rounded-2xl shadow-2xl overflow-hidden"
      : "workspace-panel relative flex flex-col bg-bg border-l border-line shrink-0 min-h-0"}>
      {!expanded && <div role="separator" aria-orientation="vertical" aria-label="Resize file pane" tabIndex={0} title="Drag to resize"
        onPointerDown={startResize} onKeyDown={resizeKey} onDoubleClick={() => { setWidth(0); try { localStorage.removeItem("workspace-width"); } catch { /* ignore */ } }}
        className="pane-resizer" />}
      <header data-tauri-drag-region className={"flex items-center gap-2 pl-2 h-12 shrink-0 border-b border-line " + (expanded ? "pr-3" : "pr-36")}>
        <button title="Hide file pane" aria-label="Hide file pane" onClick={onClose} className={iconButton}><PanelRightClose size={16} /></button>
        <FileText size={16} className="shrink-0 text-accent" />
        <h2 className="min-w-0 truncate text-sm font-medium" title={selectedFile || title}>{title}</h2>
        {status}
        <span className="flex-1" />
        {canEdit && TEXT.has(kind) && (editing
          ? <button onClick={draftText ? saveText : stopEdit} disabled={working} className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-accent px-2.5 py-1 text-xs text-accent-fg hover:bg-accent-dark disabled:opacity-40"><Check size={13} />{draftText ? "Save" : "Done"}</button>
          : <button onClick={startEdit} disabled={!preview || loading} title="Edit this file yourself" className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-line px-2.5 py-1 text-xs hover:border-accent disabled:opacity-40"><Pencil size={12} />Edit</button>)}
        {editing && draftText && <button onClick={stopEdit} className="shrink-0 text-xs text-muted hover:text-ink">Cancel</button>}
        <button title="Refresh files and preview" aria-label="Refresh files and preview" onClick={() => setReload(n => n + 1)} disabled={loading || listing || editing || officeActive || pendingOfficeEdits.current > 0} className={iconButton}><RefreshCw size={15} className={loading ? "animate-spin" : ""} /></button>
        <button title={expanded ? "Exit expanded view" : "Expand"} aria-label={expanded ? "Exit expanded view" : "Expand workspace"} onClick={() => setExpanded(!expanded)} className={iconButton}>{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
      </header>
      <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-1.5 shrink-0">
        <select aria-label="File or visual" value={selection} onChange={e => setSelection(e.target.value)} disabled={editing} className="min-w-0 flex-1 basis-40 rounded-lg border border-line bg-card px-2 py-1 text-xs">
          <option value="">{listing ? "Updating files…" : `Choose from ${files.length} files · ${visuals.length} visuals…`}</option>
          {!!files.length && <optgroup label="Workspace files">{files.map(f => <option key={f.path} value={`file:${f.path}`}>{f.path}</option>)}</optgroup>}
          {selectedFile && !file && <option value={selection}>{selectedFile}</option>}
          <option value="browser">Live browser</option>
          {!!visuals.length && <optgroup label="Conversation visuals">{visuals.map(v => <option key={v.id} value={`visual:${v.id}`}>{v.title}</option>)}</optgroup>}
        </select>
        {hasSelection && <>
          {selectedFile && <label title="Version history" className="flex min-w-0 items-center gap-1 text-xs text-muted"><History size={13} className="shrink-0" /><select aria-label="Document revision" value={revision} disabled={editing} onChange={e => setChoice(current => ({ ...current, revision: e.target.value }))} className="min-w-0 max-w-40 rounded-lg border border-line bg-card px-1.5 py-1">
            <option value="">Current{file ? ` · ${bytes(file.size)}` : ""}</option>
            {revisions.map(r => <option key={r.id} value={r.id}>Before edit · {date(r.created)} · {bytes(r.size)}</option>)}
          </select></label>}
          <button title="Save a copy" aria-label="Save a copy" className={iconButton} disabled={working} onClick={() => action(exportCopy, "Copy saved.")}><ArrowDownToLine size={15} /></button>
          {selectedFile && <button title="Open in its app" aria-label="Open in its app" className={iconButton} disabled={working || !!revision} onClick={() => action(() => invoke("document_open", { id, path: selectedFile, reveal: false }))}><ExternalLink size={15} /></button>}
          {selectedFile && <button title="Show in folder" aria-label="Show in folder" className={iconButton} disabled={working} onClick={() => action(() => invoke("document_open", { id, path: selectedFile, reveal: true }))}><FolderOpen size={15} /></button>}
          <button title="Ask the assistant for changes" className={iconButton + " text-xs"} onClick={() => onDraft(selectedFile ? `Revise "${selectedFile}". Preserve unaffected content and formatting. My changes: ` : `Revise the interactive visual "${title}". Keep its existing data and working controls. My changes: `)}><Sparkles size={14} />Ask</button>
        </>}
      </div>
      {officeView && <div className="flex items-center justify-end gap-2 border-b border-line px-3 py-1 text-xs">
        <button aria-label="Zoom out" title="Zoom out (Ctrl+-)" className={iconButton} disabled={zoom <= 25} onClick={() => changeZoom(-1)}>-</button>
        <button aria-label="Reset document zoom" title="Reset zoom (Ctrl+0)" className={iconButton} onClick={() => changeZoom(0)}>{zoom}%</button>
        <input aria-label="Document zoom" type="range" min="25" max="250" step="5" value={zoom} onChange={e => setZoom(Number(e.target.value))} className="w-24 accent-accent" />
        <button aria-label="Zoom in" title="Zoom in (Ctrl++)" className={iconButton} disabled={zoom >= 250} onClick={() => changeZoom(1)}>+</button>
      </div>}
      {error && <div role="alert" className="m-3 mb-0 p-3 rounded-lg bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200 text-sm break-words">{error}<button onClick={() => { setError(""); setReload(n => n + 1); }} className="block mt-1 underline">Reload</button></div>}
      {stale && <div role="status" className="mx-3 mt-2 rounded-lg bg-panel px-3 py-2 text-xs text-muted">The file changed while you were editing. {draftText ? "Saving will be refused; copy your text first." : "Finish typing, then refresh to see the latest version."}</div>}
      {officeView && !revision && <div className="mx-3 mt-2 text-xs text-muted">Click text to edit; click away to save. Select text to leave an AI note. Esc undoes the current edit.</div>}
      {notice && !editing && <div role="status" className="px-4 pt-2 text-xs text-green-600">{notice}</div>}
      <div ref={body} onMouseUp={officeView ? undefined : pickText} className="relative flex-1 min-h-0 overflow-auto p-3">
        {selection === "browser" ? <BrowserLive id={id} tick={browserTick + refresh + reload} />
          : !preview && loading ? <div role="status" className="text-sm text-muted p-6">Preparing preview…</div>
          : visual ? <SandboxedUi html={visual.html} title={title} designSystem={visual.designSystem} expanded onDraft={onDraft} />
          : draftText ? <textarea aria-label={`Edit ${title}`} value={draftText.text} onChange={e => setDraftText({ ...draftText, text: e.target.value })} spellCheck={kind === "md" || kind === "txt"}
              className="h-full w-full resize-none rounded-lg border border-line bg-card p-4 font-mono text-sm outline-none focus:border-accent" />
          : officeView ? <OfficeFrame key={`${selectedFile}:${revision}`} html={preview!.content} title={title} editing={!revision} zoom={zoom} onZoom={changeZoom}
              onActive={active => { officeInteraction.current = active; setOfficeActive(active); }} previous={previous?.texts} scroll={seen.current.get(selectedFile)?.scroll}
              onTexts={texts => seen.current.set(selectedFile, { ...seen.current.get(selectedFile), texts })}
              onScroll={y => seen.current.set(selectedFile, { ...seen.current.get(selectedFile), scroll: y })}
              onSelect={frameSelect} onEdit={officeEdit} />
          : preview?.format === "html" ? <SandboxedUi html={preview.content} title={title} expanded />
          : preview?.format === "pdf" ? <PdfFrame data={preview.content} title={title} />
          : preview?.kind === "md" ? <article className="prose bg-card rounded-lg p-6">{blocks(preview.content).map((b, i) =>
              <div key={i} className={freshBlocks && !freshBlocks.has(b) ? "lw-changed" : undefined}><Md components={{ img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : "[Image]"}</span>, a: ({ children }) => <span className="text-accent">{children}</span> }}>{b}</Md></div>)}</article>
          : preview ? <pre className="text-sm whitespace-pre-wrap break-words rounded-lg bg-card p-4">{preview.content.split(/\r?\n/).map((line, i) =>
              <span key={i} className={fresh && line.trim() && !fresh.has(line) ? "lw-changed" : undefined}>{line}{"\n"}</span>)}</pre>
          : !error && <div className="p-8 text-center text-muted"><FileText size={30} className="mx-auto mb-3" /><p className="text-sm">Your documents, slides and interactive visuals live here.</p><p className="text-xs mt-2">Ask the assistant to create a file, or choose one from this folder.</p></div>}
        {picked && (
          <div role="dialog" aria-label="Comment for the assistant" style={{ top: picked.top, left: picked.left }} onMouseUp={e => e.stopPropagation()}
            className="absolute z-10 w-72 rounded-xl border border-line bg-card p-2 text-sm shadow-lg animate-[rise_.15s_ease-out]">
            <p className="mb-1.5 line-clamp-2 border-l-2 border-accent pl-2 text-xs text-muted">{picked.text}</p>
            <form onSubmit={e => { e.preventDefault(); addNote(); }} className="flex items-center gap-1.5">
              <input autoFocus value={comment} onChange={e => setComment(e.target.value)} onKeyDown={e => { if (e.key === "Escape") setPicked(null); }} placeholder="What should change here?"
                className="min-w-0 flex-1 rounded-lg border border-line bg-transparent px-2 py-1 text-sm outline-none focus:border-accent" />
              <button type="submit" title="Add note" aria-label="Add note" className="rounded-lg bg-accent p-1.5 text-accent-fg hover:bg-accent-dark"><MessageSquarePlus size={14} /></button>
            </form>
          </div>
        )}
      </div>
      {relatedChanges > 0 && <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-line px-3 py-2 text-xs">
        <span className="text-muted">{relatedChanges} saved {relatedChanges === 1 ? "change" : "changes"} · AI check is optional</span>
        <button onClick={async () => { await edits.current; onCheckRelated(); }} disabled={!canCheckRelated || working || editing || officeActive || pendingOfficeEdits.current > 0}
          title={officeActive || pendingOfficeEdits.current > 0 ? "Click away from the document to finish saving first" : "Ask the assistant to check related project files when you are ready"}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 hover:border-accent disabled:opacity-40"><Sparkles size={13} />Check related files</button>
      </div>}
      {notes.length > 0 && (
        <footer className="shrink-0 border-t border-line bg-panel/40 px-3 py-2 text-sm">
          <div className="mb-1.5 flex items-center gap-2 text-xs text-muted"><MessageSquarePlus size={13} /><span className="flex-1">{notes.length} {notes.length === 1 ? "note" : "notes"} for the assistant</span><button onClick={() => setNotes([])} className="hover:text-ink">Clear</button></div>
          <ol className="max-h-32 space-y-1 overflow-auto">
            {notes.map((n, i) => (
              <li key={i} className="flex items-start gap-2 rounded-lg bg-card px-2 py-1">
                <span className="min-w-0 flex-1"><span className="line-clamp-1 text-xs text-muted">"{n.quote}"</span><span className="line-clamp-2">{n.comment || <span className="text-muted">Fix this</span>}</span></span>
                <button onClick={() => setNotes(x => x.filter((_, j) => j !== i))} aria-label="Remove note" className="mt-0.5 text-muted hover:text-ink"><X size={13} /></button>
              </li>
            ))}
          </ol>
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            <button onClick={() => sendNotes(false)} className="rounded-lg px-2.5 py-1 text-xs text-muted hover:bg-panel hover:text-ink">Add to message</button>
            <button onClick={() => sendNotes(true)} disabled={!canSend} title={canSend ? undefined : "Available when the assistant finishes"} className="inline-flex items-center gap-1 rounded-lg bg-accent px-2.5 py-1 text-xs text-accent-fg hover:bg-accent-dark disabled:opacity-40"><Send size={12} />Send to assistant</button>
          </div>
        </footer>
      )}
      {!notes.length && !editing && hasSelection && selectedFile && preview && !revision && <footer className="shrink-0 px-4 py-1.5 text-[11px] text-muted">Select text to leave a note for the assistant{canEdit && !officeView ? " · Edit to change it yourself" : ""}</footer>}
      {revision && <footer className="px-4 py-2 border-t border-line text-xs text-muted">Earlier version · Save a copy to recover it</footer>}
    </aside>
  );
}
