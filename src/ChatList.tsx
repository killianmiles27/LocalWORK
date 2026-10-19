import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Download, MessageSquare, Pencil, Pin, PinOff, Search, Trash2, X } from "lucide-react";
import { groupChats } from "./chatDates";

export type Conv = { id: string; title: string; workspace: string; updated: number; pinned: boolean };

type Props = {
  convs: Conv[];
  cur: string | null;
  searchRef: React.RefObject<HTMLInputElement | null>;
  onSelect: (id: string) => void;
  onExport: (id: string) => void;
  onDelete: (id: string) => void;
  onChanged: () => void;
  onError: (e: string) => void;
};

/** Sidebar chat list: search, date groups, pin, rename, export and delete. */
export default function ChatList({ convs, cur, searchRef, onSelect, onExport, onDelete, onChanged, onError }: Props) {
  const [q, setQ] = useState("");
  // Chats whose messages match; titles are matched instantly here, message text by the backend.
  const [hits, setHits] = useState<{ q: string; ids: Set<string> }>({ q: "", ids: new Set() });
  const [renaming, setRenaming] = useState<{ id: string; title: string } | null>(null);
  const editing = useRef(renaming);
  editing.current = renaming;
  const query = q.trim().toLowerCase();

  useEffect(() => {
    if (!query) return;
    const t = setTimeout(() => {
      invoke<string[]>("search_conversations", { q: query }).then(ids => setHits({ q: query, ids: new Set(ids) })).catch(() => {});
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  async function saveName() {
    // Enter saves and unmounts the field, which then blurs; the ref stops a second save.
    const r = editing.current;
    if (!r) return;
    editing.current = null;
    const { id, title } = r;
    setRenaming(null);
    const old = convs.find(c => c.id === id)?.title;
    if (!title.trim() || title.trim() === old) return;
    try { await invoke("conversation_rename", { id, title }); onChanged(); } catch (e) { onError(String(e)); }
  }

  const pin = (c: Conv) => invoke("conversation_pin", { id: c.id, on: !c.pinned }).then(onChanged).catch(e => onError(String(e)));

  const shown = query ? convs.filter(c => c.title.toLowerCase().includes(query) || (hits.q === query && hits.ids.has(c.id))) : convs;
  const groups = query ? [{ label: shown.length ? "Results" : "", items: shown }] : groupChats(convs);
  let i = 0;

  return (
    <>
      <div className="px-2 pb-1">
        <label className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-muted focus-within:bg-panel-2 hover:bg-panel-2/60">
          <Search size={14} className="shrink-0" />
          <input ref={searchRef} value={q} onChange={e => setQ(e.target.value)} placeholder="Search chats" aria-label="Search chats"
            onKeyDown={e => { if (e.key === "Escape") { setQ(""); e.currentTarget.blur(); } }}
            className="min-w-0 flex-1 bg-transparent outline-none text-ink placeholder:text-muted" />
          {q && <button title="Clear search" aria-label="Clear search" onClick={() => setQ("")} className="hover:text-ink"><X size={13} /></button>}
        </label>
      </div>
      <div className="flex-1 overflow-auto px-2 pb-2">
        {convs.length === 0 && <div className="px-3 py-2 text-sm text-muted">No chats yet</div>}
        {query && !shown.length && <div className="px-3 py-2 text-sm text-muted">No chats match</div>}
        {groups.map(g => (
          <div key={g.label || "results"}>
            {g.label && <div className="px-3 pt-2 pb-1 text-xs font-medium text-muted select-none">{g.label}</div>}
            {g.items.map(c => (
              <div key={c.id} onClick={() => renaming?.id !== c.id && onSelect(c.id)} title={c.workspace} aria-current={c.id === cur}
                style={{ "--i": Math.min(i++, 14) } as React.CSSProperties}
                className={"chat-row group flex items-center gap-2 rounded-lg px-3 py-1.5 cursor-pointer " + (c.id === cur ? "bg-panel-2" : "hover:bg-panel-2/60")}>
                <MessageSquare size={14} className="shrink-0 text-muted" />
                {renaming?.id === c.id ? (
                  <input autoFocus value={renaming.title} aria-label="Chat name" maxLength={120}
                    onChange={e => setRenaming({ id: c.id, title: e.target.value })}
                    onFocus={e => e.currentTarget.select()}
                    onKeyDown={e => { if (e.key === "Enter") saveName(); else if (e.key === "Escape") setRenaming(null); }}
                    onBlur={saveName} onClick={e => e.stopPropagation()}
                    className="min-w-0 flex-1 rounded bg-card px-1 -mx-1 outline outline-1 outline-accent" />
                ) : (
                  <div className="min-w-0 flex-1 truncate" onDoubleClick={e => { e.stopPropagation(); setRenaming({ id: c.id, title: c.title }); }}>{c.title}</div>
                )}
                {renaming?.id !== c.id && (
                  <div className="hidden group-hover:flex items-center gap-1.5 text-muted">
                    <button title={c.pinned ? "Unpin" : "Pin"} aria-label={c.pinned ? "Unpin" : "Pin"} className="hover:text-ink"
                      onClick={e => { e.stopPropagation(); pin(c); }}>{c.pinned ? <PinOff size={14} /> : <Pin size={14} />}</button>
                    <button title="Rename" aria-label="Rename" className="hover:text-ink"
                      onClick={e => { e.stopPropagation(); setRenaming({ id: c.id, title: c.title }); }}><Pencil size={13} /></button>
                    <button title="Export as Markdown" aria-label="Export as Markdown" className="hover:text-ink"
                      onClick={e => { e.stopPropagation(); onExport(c.id); }}><Download size={14} /></button>
                    <button title="Delete" aria-label="Delete" className="hover:text-red-600"
                      onClick={e => { e.stopPropagation(); onDelete(c.id); }}><Trash2 size={14} /></button>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
