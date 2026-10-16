import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowDownToLine, FileText, FolderOpen, History, Maximize2, Minimize2, RefreshCw, Sparkles, X } from "lucide-react";
import SandboxedUi from "./SandboxedUi";
import { assembleDocument, previewDocument } from "./intelligent-ui";

export type VisualItem = { id: string; title: string; html: string; designSystem: boolean };
type FileEntry = { path: string; name: string; kind: string; size: number; modified: number | null };
type Preview = { path: string; kind: string; format: "html" | "text" | "external"; content: string };
type Revision = { id: string; created: number; size: number };
type Props = {
  id: string; refresh: number; visuals: VisualItem[]; requested?: { path?: string; visual?: string; nonce: number };
  onClose: () => void; onDraft: (text: string) => void;
};

const date = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
const bytes = (n: number) => n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
const button = "inline-flex items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs hover:border-accent disabled:opacity-40";

export default function Workspace({ id, refresh, visuals, requested, onClose, onDraft }: Props) {
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
  const selectedFile = selection.startsWith("file:") ? selection.slice(5) : "";
  const visual = visuals.find(v => `visual:${v.id}` === selection);

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
    if (requested?.path) setSelection(`file:${requested.path.replaceAll("\\", "/")}`);
    if (requested?.visual) setSelection(`visual:${requested.visual}`);
  }, [requested]);
  useEffect(() => { setRevisions([]); setNotice(""); }, [selection]);
  useEffect(() => {
    if (!selectedFile) { setPreview(null); setLoading(false); setError(""); return; }
    let active = true;
    setPreview(null); setError(""); setLoading(true);
    invoke<Preview>("document_preview", { id, path: selectedFile, revision: revision || null }).then(result => {
      if (active) setPreview(result);
    }).catch(e => { if (active) setError(String(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [id, selectedFile, revision, refresh, reload]);
  useEffect(() => {
    if (!selectedFile) return;
    let active = true;
    invoke<Revision[]>("document_revisions", { id, path: selectedFile }).then(result => { if (active) setRevisions(result); })
      .catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, [id, selectedFile, refresh, reload]);

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
  const file = files.find(f => f.path === selectedFile);
  const title = visual?.title || selectedFile.split("/").pop() || "Your workspace";
  const hasSelection = !!selectedFile || !!visual;
  return (
    <aside aria-label="Document and visual workspace" className={expanded
      ? "fixed inset-4 top-12 z-40 flex flex-col bg-bg border border-line rounded-2xl shadow-2xl overflow-hidden"
      : "workspace-panel flex flex-col bg-bg border-l border-line shrink-0 min-h-0"}>
      <header data-tauri-drag-region className="flex items-center gap-2 pl-4 pr-36 h-12 shrink-0 border-b border-line">
        <FolderOpen size={16} className="text-accent" /><h2 className="font-medium text-sm flex-1">Files</h2>
        <button title="Refresh files and preview" aria-label="Refresh files and preview" onClick={() => setReload(n => n + 1)} disabled={loading || listing} className="p-1.5 text-muted hover:text-ink disabled:opacity-40"><RefreshCw size={15} /></button>
        <button title={expanded ? "Exit expanded view" : "Expand workspace"} aria-label={expanded ? "Exit expanded view" : "Expand workspace"} onClick={() => setExpanded(!expanded)} className="p-1.5 text-muted hover:text-ink">{expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>
        <button title="Close workspace" aria-label="Close workspace" onClick={onClose} className="p-1.5 text-muted hover:text-ink"><X size={17} /></button>
      </header>
      <div className="p-3 border-b border-line space-y-2 shrink-0">
        <label className="block text-xs text-muted" htmlFor="workspace-file">{listing ? "Updating files…" : `${files.length} files · ${visuals.length} visuals`}</label>
        <select id="workspace-file" value={selection} onChange={e => setSelection(e.target.value)} className="w-full rounded-lg border border-line bg-card p-2 text-sm">
          <option value="">Choose a file or visual…</option>
          {!!files.length && <optgroup label="Workspace files">{files.map(f => <option key={f.path} value={`file:${f.path}`}>{f.path}</option>)}</optgroup>}
          {selectedFile && !file && <option value={selection}>{selectedFile}</option>}
          {!!visuals.length && <optgroup label="Conversation visuals">{visuals.map(v => <option key={v.id} value={`visual:${v.id}`}>{v.title}</option>)}</optgroup>}
        </select>
        {hasSelection && <>
          <div className="flex flex-wrap gap-2">
            <button className={button} disabled={working} onClick={() => action(exportCopy, "Copy saved.")}><ArrowDownToLine size={13} />Save copy</button>
            {selectedFile && <button className={button} disabled={working || !!revision} onClick={() => action(() => invoke("document_open", { id, path: selectedFile, reveal: false }))}><FileText size={13} />Open</button>}
            {selectedFile && <button className={button} disabled={working} onClick={() => action(() => invoke("document_open", { id, path: selectedFile, reveal: true }))}><FolderOpen size={13} />Show in folder</button>}
            <button className={button} onClick={() => onDraft(selectedFile ? `Revise the current file "${selectedFile}". Preserve unaffected content and formatting. My changes: ` : `Revise the interactive visual "${title}". Keep its existing data and working controls. My changes: `)}><Sparkles size={13} />Ask for changes</button>
          </div>
          {selectedFile && <label className="flex items-center gap-2 text-xs text-muted"><History size={13} /><select aria-label="Document revision" value={revision} onChange={e => setChoice(current => ({ ...current, revision: e.target.value }))} className="min-w-0 flex-1 bg-card rounded border border-line p-1.5">
            <option value="">Current file{file ? ` · ${bytes(file.size)}` : ""}</option>
            {revisions.map(r => <option key={r.id} value={r.id}>Before edit · {date(r.created)} · {bytes(r.size)}</option>)}
          </select></label>}
        </>}
      </div>
      {error && <div role="alert" className="m-3 p-3 rounded-lg bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200 text-sm break-words">{error}<button onClick={() => setReload(n => n + 1)} className="block mt-1 underline">Try again</button></div>}
      {notice && <div role="status" className="px-4 py-2 text-xs text-green-600">{notice}</div>}
      <div className="flex-1 min-h-0 overflow-auto p-3">
        {loading ? <div role="status" className="text-sm text-muted p-6">Preparing preview…</div>
          : visual ? <SandboxedUi html={visual.html} title={title} designSystem={visual.designSystem} expanded onDraft={onDraft} />
          : preview?.format === "html" ? <SandboxedUi html={preview.content} title={title} expanded />
          : preview?.format === "external" ? <p className="text-sm text-muted p-6">{preview.content} Use Open above.</p>
          : preview?.kind === "md" ? <article className="prose bg-card rounded-lg p-6"><Markdown remarkPlugins={[remarkGfm]} components={{ img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : "[Image]"}</span>, a: ({ children }) => <span className="text-accent">{children}</span> }}>{preview.content}</Markdown></article>
          : preview ? <pre className="text-sm whitespace-pre-wrap break-words rounded-lg bg-card p-4">{preview.content}</pre>
          : !error && <div className="p-8 text-center text-muted"><FileText size={30} className="mx-auto mb-3" /><p className="text-sm">Your documents, slides and interactive visuals live here.</p><p className="text-xs mt-2">Ask the assistant to create a file, or choose one from this folder.</p></div>}
      </div>
      {revision && <footer className="px-4 py-2 border-t border-line text-xs text-muted">Previous version · Save copy to recover</footer>}
    </aside>
  );
}
