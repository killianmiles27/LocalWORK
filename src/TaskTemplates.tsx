import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { BookmarkPlus, Pencil, Trash2, X } from "lucide-react";

export type AppliedTemplate = { id: string; prompt: string; workspace: string; files: string[] };
type TaskTemplate = { id: string; name: string; prompt: string; workspace: string; document: string | null };
type Draft = { name: string; prompt: string; workspace: string; document: string };
const button = "rounded-lg border border-line px-2.5 py-1 text-xs hover:bg-panel-2 disabled:opacity-40";
const field = "w-full rounded-lg border border-line bg-card px-3 py-2 text-sm outline-none focus:border-accent";

export default function TaskTemplates({ prompt, workspace, attachments, disabled, onApply }: {
  prompt: string; workspace?: string; attachments: string[]; disabled: boolean; onApply: (id: string) => Promise<void>;
}) {
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [rename, setRename] = useState<{ id: string; name: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const refresh = () => invoke<TaskTemplate[]>("task_templates_list").then(setTemplates);
  useEffect(() => { refresh().catch(e => setError(String(e))); }, []);
  useEffect(() => { if (draft || rename) dialog.current?.showModal(); }, [!!draft, !!rename]);
  function close() { if (!working.current) { setDraft(null); setRename(null); setError(""); } }
  async function action(run: () => Promise<unknown>) {
    if (working.current) return;
    working.current = true; setBusy(true); setError("");
    try { await run(); }
    catch (e) { setError(String(e)); }
    finally { working.current = false; setBusy(false); }
  }
  function startSave() {
    setError("");
    const attached = attachments.find(p => /\.(docx|xlsx|pptx)$/i.test(p));
    setDraft({ name: "", prompt, workspace: workspace ?? "", document: attached && workspace ? `${workspace}/${attached}` : "" });
  }
  async function pick(folder: boolean) {
    const picked = await open(folder ? { directory: true, title: "Task working folder", defaultPath: draft?.workspace || undefined }
      : { title: "Document template file", multiple: false });
    if (typeof picked === "string") setDraft(d => d && { ...d, [folder ? "workspace" : "document"]: picked });
  }
  async function save() {
    if (draft) {
      await invoke("task_template_save", { ...draft, document: draft.document || null });
    } else if (rename) {
      await invoke("task_template_rename", { id: rename.id, title: rename.name });
    }
    await refresh(); setDraft(null); setRename(null);
  }

  return <section aria-label="Task templates" className="mb-2 space-y-1.5">
    <div className="flex flex-wrap items-center gap-1.5">
      <button onClick={startSave} disabled={disabled || busy || !prompt.trim()} className={button + " inline-flex items-center gap-1.5 text-muted"}>
        <BookmarkPlus size={13} />Save as task template
      </button>
      {templates.length > 0 && <span className="text-xs text-muted">Saved tasks</span>}
    </div>
    {templates.length > 0 && <div className="flex max-h-24 flex-wrap gap-1.5 overflow-auto">
      {templates.map(t => <div key={t.id} className="inline-flex max-w-full items-center rounded-lg border border-line bg-card text-xs">
        <button disabled={disabled || busy} title={`${t.prompt}\nWorking folder: ${t.workspace}${t.document ? `\nTemplate file: ${t.document}` : ""}`}
          onClick={() => action(() => onApply(t.id))} className="min-w-0 truncate rounded-l-lg px-2.5 py-1.5 hover:bg-panel-2 disabled:opacity-40">{t.name}</button>
        <button disabled={busy} onClick={() => { setError(""); setRename({ id: t.id, name: t.name }); }} aria-label={`Rename task template ${t.name}`} title="Rename" className="p-1.5 text-muted hover:text-ink"><Pencil size={12} /></button>
        <button disabled={busy} onClick={() => { if (window.confirm(`Delete task template “${t.name}”?`)) action(async () => { await invoke("task_template_delete", { id: t.id }); await refresh(); }); }}
          aria-label={`Delete task template ${t.name}`} title="Delete" className="p-1.5 text-muted hover:text-red-600"><Trash2 size={12} /></button>
      </div>)}
    </div>}
    {error && !draft && !rename && <p role="alert" className="text-xs text-red-600 whitespace-pre-wrap break-words">{error}</p>}
    {(draft || rename) && <dialog ref={dialog} onCancel={e => { e.preventDefault(); close(); }}
      className="m-auto w-[min(30rem,calc(100vw-2rem))] rounded-xl border border-line bg-panel p-5 text-ink shadow-xl backdrop:bg-black/40"
      aria-labelledby="task-template-title">
      <form onSubmit={e => { e.preventDefault(); action(save); }}>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 id="task-template-title" className="font-medium">{draft ? "Save as task template" : "Rename task template"}</h2>
          <button type="button" disabled={busy} onClick={close} aria-label="Close task template dialog" className="text-muted hover:text-ink"><X size={16} /></button>
        </div>
        <fieldset disabled={busy} className="space-y-3">
          <label className="block space-y-1 text-xs">Name
            <input autoFocus required maxLength={120} value={draft?.name ?? rename?.name ?? ""} className={field}
              onChange={e => draft ? setDraft({ ...draft, name: e.target.value }) : rename && setRename({ ...rename, name: e.target.value })} />
          </label>
          {draft && <>
            <p className="line-clamp-3 whitespace-pre-wrap text-xs text-muted">{draft.prompt}</p>
            <div className="space-y-1 text-xs">
              <div>Working folder</div>
              <div className="flex items-center gap-2"><span className="min-w-0 flex-1 break-all select-text">{draft.workspace || "Choose a folder for this task"}</span>
                <button type="button" onClick={() => action(() => pick(true))} className={button}>Choose folder</button></div>
            </div>
            <div className="space-y-1 text-xs">
              <div>Document template file (optional)</div>
              <div className="flex flex-wrap items-center gap-2"><span className="min-w-0 flex-1 break-all select-text">{draft.document || "None"}</span>
                <button type="button" onClick={() => action(() => pick(false))} className={button}>Choose file</button>
                {draft.document && <button type="button" onClick={() => setDraft({ ...draft, document: "" })} className="text-muted hover:text-ink">Remove</button>}
              </div>
              {attachments.length > 0 && workspace && <select aria-label="Use a current attachment as template" value={attachments.some(p => `${workspace}/${p}` === draft.document) ? draft.document : ""}
                onChange={e => { if (e.target.value) setDraft({ ...draft, document: e.target.value }); }} className={field}>
                <option value="">Use a current attachment…</option>
                {attachments.map(p => <option key={p} value={`${workspace}/${p}`}>{p}</option>)}
              </select>}
              <p className="text-muted">Each use copies this file into the working folder's attachments. The original stays unchanged. Keep it at this location.</p>
            </div>
          </>}
          {error && <p role="alert" className="text-xs text-red-600 whitespace-pre-wrap break-words">{error}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={close} className={button}>Cancel</button>
            <button type="submit" disabled={!(draft?.name ?? rename?.name)?.trim() || (!!draft && !draft.workspace)} className="rounded-lg bg-accent px-3 py-1.5 text-xs text-accent-fg disabled:opacity-40">Save</button>
          </div>
        </fieldset>
      </form>
    </dialog>}
  </section>;
}
