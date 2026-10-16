import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowDown, ArrowUp, Check, ChevronRight, ChevronDown, FolderOpen, MessageSquare, Mic, PanelRight, Paperclip, Minus, Maximize2, SquarePen, Settings as Gear, ShieldAlert, Sparkles, Square, Trash2, Wrench, X } from "lucide-react";
import Settings from "./Settings";
import Wizard from "./Wizard";
import { useVoice } from "./voice";
import { richFor } from "./Rich";
import type { RichActions } from "./Rich";
import Workspace from "./Workspace";
import type { VisualItem } from "./Workspace";

type Conv = { id: string; title: string; workspace: string; updated: number };
type Msg = { id: number; role: string; body: any; ts: number };
type Status = { state: string; detail: string; port: number; model: string };
type Approval = { conv: string; call_id: string; tool: string; class: string; reason: string; description?: string; args: any; can_remember: boolean };

const dot: Record<string, [string, string]> = {
  ready: ["bg-green-500", "Model ready"],
  starting: ["bg-amber-400 animate-pulse", "Model starting…"],
  loading: ["bg-amber-400 animate-pulse", "Model loading…"],
  stopped: ["bg-stone-400", "Model stopped"],
  error: ["bg-red-500", "Model error"],
};

const text = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v, null, 1));
const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

export default function App() {
  const [convs, setConvs] = useState<Conv[]>([]);
  const [cur, setCur] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [live, setLive] = useState({ text: "", thinking: "", busy: false });
  const [status, setStatus] = useState<Status>({ state: "starting", detail: "", port: 0, model: "" });
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [input, setInput] = useState("");
  const [autoEdit, setAutoEdit] = useState(false);
  const [err, setErr] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceRefresh, setWorkspaceRefresh] = useState(0);
  const [workspaceRequest, setWorkspaceRequest] = useState<{ path?: string; visual?: string; nonce: number }>();
  const [wizard, setWizard] = useState(false);
  const [showTps, setShowTps] = useState(true);
  const [tps, setTps] = useState<number | null>(null);
  const [ctx, setCtx] = useState<{ used: number | null; window: number }>({ used: null, window: 32768 });
  const navigation = useRef(0);
  const createdHere = useRef<string | null>(null);
  const creating = useRef<Promise<string> | null>(null);
  const [projDir, setProjDir] = useState<string | undefined>();
  const [atBottom, setAtBottom] = useState(true);
  const stick = useRef(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const curRef = useRef<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  curRef.current = cur;
  const [tidying, setTidying] = useState(false);
  const voice = useVoice((t) => { setErr(""); setInput((i) => (i.trim() ? i.replace(/\s+$/, "") + " " : "") + t); taRef.current?.focus(); }, setErr);
  async function tidy() {
    setTidying(true); setErr("");
    try { setInput(await invoke<string>("voice_tidy", { text: input })); }
    catch (e) { setErr(String(e)); }
    finally { setTidying(false); }
  }

  const refreshCtx = (id: string) =>
    invoke<{ used: number | null; window: number }>("context_usage", { id }).then((c) => { if (curRef.current === id) setCtx(c); }).catch(() => {});
  const refreshConvs = () => invoke<Conv[]>("list_conversations").then(setConvs).catch((e) => setErr(String(e)));
  const reload = (id: string) =>
    invoke<Msg[]>("load_messages", { id }).then((m) => { if (curRef.current === id) setMsgs(m); }).catch((e) => setErr(String(e)));

  useEffect(() => {
    refreshConvs();
    invoke<string | null>("get_setting", { key: "show_tps" }).then(v => setShowTps(v !== "0")).catch(() => {});
    invoke<string | null>("get_setting", { key: "wizard_done" }).then((v) => { if (!v) setWizard(true); }).catch(() => {});
    invoke<string | null>("get_setting", { key: "projects_folder" }).then((v) => { if (v) setProjDir(v); }).catch(() => {});
    invoke<Status>("model_status").then(setStatus).catch(() => {});
    const subs = [
      listen<Status>("model-status", (e) => setStatus(e.payload)),
      listen<Approval>("approval-request", (e) => setApprovals((a) => [...a, e.payload])),
      listen<{ conv: string; ev: any }>("agent-event", (e) => {
        const { conv, ev } = e.payload;
        if (conv !== curRef.current) return;
        switch (ev.type) {
          case "text_delta": setLive((l) => ({ ...l, busy: true, text: l.text + text(ev.text) })); break;
          case "thinking": setLive((l) => ({ ...l, busy: true, thinking: l.thinking + text(ev.text) })); break;
          case "tool_request": case "tool_running": case "tool_result": case "tool_cancelled":
            setLive((l) => ({ ...l, busy: true, text: "", thinking: "" })); reload(conv); break;
          case "stream_end": case "error": case "agent_exit":
            setWorkspaceRefresh(n => n + 1);
            setLive({ text: "", thinking: "", busy: false }); reload(conv); refreshConvs(); refreshCtx(conv); break;
          case "info": setTimeout(() => refreshCtx(conv), 400); break;
          case "title": refreshConvs(); break;
        }
      }),
    ];
    return () => { subs.forEach((s) => { s.then((f) => f()); }); };
  }, []);

  useEffect(() => {
    if (cur && createdHere.current === cur) { createdHere.current = null; return; }
    setFiles([]);
    setInput("");
    setLive({ text: "", thinking: "", busy: false });
    setMsgs([]);
    setErr("");
    setWorkspaceRequest(undefined);
    setCtx((c) => ({ ...c, used: null }));
    if (cur) { reload(cur); refreshCtx(cur); }
  }, [cur]);

  useEffect(() => {
    if (!showTps || status.state !== "ready") { setTps(null); return; }
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function pull() {
      try { const value = await invoke<number | null>("model_telemetry"); if (active) setTps(value); }
      catch { if (active) setTps(null); }
      if (active) timer = setTimeout(pull, 1500);
    }
    pull();
    return () => { active = false; clearTimeout(timer); };
  }, [showTps, status.state]);

  // Keep links in chat out of the app's document. Rust also guards top-level navigation.
  useEffect(() => {
    const follow = (event: MouseEvent) => {
      const link = (event.target as Element)?.closest?.("a[href]");
      if (!link || event.defaultPrevented || (event.type === "auxclick" && event.button !== 1)) return;
      const href = link.getAttribute("href") || "";
      if (href.startsWith("#")) return;
      event.preventDefault();
      invoke("open_external", { url: href }).catch(e => setErr(String(e)));
    };
    document.addEventListener("click", follow, true);
    document.addEventListener("auxclick", follow, true);
    return () => { document.removeEventListener("click", follow, true); document.removeEventListener("auxclick", follow, true); };
  }, []);

  // Follow new output only while the reader is at the bottom; scrolling up stops it.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [msgs, live, approvals]);
  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stick.current = near;
    setAtBottom(near);
  }
  function jumpToLatest() {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = true;
    setAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }
  function toggleEdits() {
    const next = !autoEdit;
    setAutoEdit(next);
    if (cur) invoke("set_auto_edit", { id: cur, on: next }).catch(() => {});
  }

  useEffect(() => {
    const t = taRef.current;
    if (!t) return;
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight, 220) + "px";
  }, [input, cur]);

  async function attachPaths(paths: string[]) {
    if (!paths.length) return;
    const epoch = navigation.current;
    try { const id = await ensureConversation(); const rel = await invoke<string[]>("attach_paths", { id, paths }); if (epoch === navigation.current && id === curRef.current) setFiles((f) => [...f, ...rel]); }
    catch (e) { if (epoch === navigation.current) setErr(String(e)); }
  }
  async function pickFiles() {
    const r = await open({ multiple: true, title: "Attach files" });
    if (Array.isArray(r)) attachPaths(r); else if (typeof r === "string") attachPaths([r]);
  }
  async function onPaste(e: React.ClipboardEvent) {
    const list = Array.from(e.clipboardData.files);
    if (!list.length) return;
    e.preventDefault();
    const epoch = navigation.current;
    let id: string;
    try { id = await ensureConversation(); } catch (error) { if (epoch === navigation.current) setErr(String(error)); return; }
    for (const f of list) {
      if (epoch !== navigation.current || curRef.current !== id) break;
      const name = f.name && f.name !== "image.png" ? f.name : `pasted-${Date.now()}.${(f.type.split("/")[1] || "png")}`;
      try {
        const data = Array.from(new Uint8Array(await f.arrayBuffer()));
        const rel = await invoke<string>("attach_bytes", { id, name, data });
        if (epoch === navigation.current && curRef.current === id) setFiles((x) => [...x, rel]);
      } catch (er) { if (epoch === navigation.current) setErr(String(er)); }
    }
  }
  useEffect(() => {
    let off: (() => void) | undefined;
    getCurrentWebview().onDragDropEvent((ev) => {
      const p = ev.payload as any;
      if (p.type === "over" || p.type === "enter") setDragging(true);
      else if (p.type === "leave") setDragging(false);
      else if (p.type === "drop") { setDragging(false); attachPaths(p.paths ?? []); }
    }).then((u) => { off = u; });
    return () => off?.();
  }, []);

  async function ensureConversation(workspace?: string): Promise<string> {
    if (!workspace && curRef.current) return curRef.current;
    if (creating.current) return creating.current;
    const epoch = navigation.current;
    const request = (async () => {
      const id = await invoke<string>("create_conversation", { workspace: workspace ?? null });
      if (epoch !== navigation.current) throw Error("Chat changed before creation completed");
      createdHere.current = id;
      curRef.current = id;
      setCur(id);
      await refreshConvs();
      return id;
    })();
    creating.current = request;
    try { return await request; } finally { if (creating.current === request) creating.current = null; }
  }
  function selectConversation(id: string | null) {
    navigation.current += 1; creating.current = null;
    curRef.current = id; setCur(id);
  }
  function newConv() {
    if (live.busy) return;
    selectConversation(null); setMsgs([]); setFiles([]); setInput(""); setErr(""); setWorkspaceOpen(false);
    setWorkspaceRequest(undefined);
    taRef.current?.focus();
  }
  async function chooseFolder() {
    try {
      const dir = await open({ directory: true, title: "Start a chat in a folder", defaultPath: projDir });
      if (typeof dir !== "string") return;
      navigation.current += 1; creating.current = null;
      setFiles([]); setMsgs([]); setWorkspaceRequest(undefined);
      await ensureConversation(dir);
    } catch (e) { setErr(String(e)); }
  }
  async function send(override?: string) {
    const typed = (override ?? input).trim();
    if ((!typed && !files.length) || live.busy || !modelReady) return;
    if (typed === "/compact" && !files.length) { setInput(""); return compact(); }
    const body = files.length
      ? `${typed || "Please look at the attached file" + (files.length > 1 ? "s" : "") + "."}

Attached (read with read_attachment): ${files.join(", ")}`
      : typed;
    const epoch = navigation.current;
    setErr(""); stick.current = true;
    setLive({ text: "", thinking: "", busy: true });
    try {
      const id = await ensureConversation();
      if (epoch !== navigation.current) return;
      setFiles([]); setInput("");
      await invoke("agent_send", { id, text: body, autoEdit }); await reload(id); refreshConvs();
    } catch (e) { if (epoch === navigation.current) { setErr(String(e)); setLive({ text: "", thinking: "", busy: false }); } }
  }
  async function compact() {
    if (!cur || live.busy || !modelReady) return;
    if (!msgs.some((m) => m.role === "assistant")) { setErr("Nothing to compact yet."); return; }
    setErr(""); setLive({ text: "", thinking: "", busy: true });
    try { await invoke("agent_compact", { id: cur }); }
    catch (e) { setErr(String(e)); setLive({ text: "", thinking: "", busy: false }); }
  }
  function answer(a: Approval, allow: boolean, remember: boolean) {
    invoke("agent_answer", { id: a.conv, callId: a.call_id, allow, remember });
    setApprovals((x) => x.filter((y) => y.call_id !== a.call_id));
  }

  const [dotCls, label] = dot[status.state] ?? dot.error;
  const mine = approvals.filter((a) => a.conv === cur);
  const curConv = convs.find((c) => c.id === cur);
  const modelReady = status.state === "ready";
  const visuals: VisualItem[] = msgs.filter(m => m.role === "tool" && m.body?.status !== "error" && m.body?.status !== "cancelled")
    .flatMap(m => {
      const request = m.body?.request;
      if (!/(assemble_document|publish_artifact)$/.test(String(request?.name))) return [];
      const args = request?.args?.arguments ?? request?.args;
      return typeof args?.html === "string" ? [{ id: String(m.id), title: String(args.title ?? "Interactive visual"), html: args.html, designSystem: /assemble_document$/.test(String(request.name)) }] : [];
    });
  function draft(text: string) {
    setInput(current => current.trim() ? `${current}\n\n${text}` : text);
    taRef.current?.focus();
  }
  function openDocument(path: string) { setWorkspaceOpen(true); setWorkspaceRequest({ path, nonce: Date.now() }); }
  function openVisual(id: string) { setWorkspaceOpen(true); setWorkspaceRequest({ visual: id, nonce: Date.now() }); }

  // Only newly arrived show_document results open the panel. Reopening a chat must not replay its UI actions.
  const lastPresented = useRef<{ conv: string | null; message: number }>({ conv: null, message: 0 });
  useEffect(() => {
    if (!msgs.length) return;
    const newest = msgs[msgs.length - 1].id;
    if (lastPresented.current.conv !== cur) { lastPresented.current = { conv: cur, message: newest }; return; }
    const presented = msgs.filter(m => m.id > lastPresented.current.message && m.role === "tool" && m.body?.status !== "error" && m.body?.status !== "cancelled" && /show_document$/.test(String(m.body?.request?.name))).at(-1);
    lastPresented.current.message = newest;
    const args = presented?.body?.request?.args;
    const path = (args?.arguments ?? args)?.path;
    if (typeof path === "string") { openDocument(path); setWorkspaceRefresh(n => n + 1); }
  }, [msgs, cur]);

  return (
    <div className="flex h-full flex-col relative">
      <div className="absolute right-0 top-0 z-40 flex h-10 items-center select-none">
        <button title="Minimize" aria-label="Minimize" onClick={() => getCurrentWindow().minimize()} className="window-control"><Minus size={14} /></button>
        <button title="Maximize or restore" aria-label="Maximize or restore" onClick={() => getCurrentWindow().toggleMaximize()} className="window-control"><Maximize2 size={12} /></button>
        <button title="Close window" aria-label="Close window" onClick={() => getCurrentWindow().close()} className="window-control window-close"><X size={16} /></button>
      </div>
      <div className="flex flex-1 min-h-0">
      {dragging && <div className="fixed inset-0 z-50 grid place-items-center bg-accent/10 border-2 border-dashed border-accent pointer-events-none text-accent font-medium">Drop files to attach them</div>}
      <aside className={"w-[250px] shrink-0 bg-panel flex-col " + (workspaceOpen && cur ? "hidden xl:flex" : "flex")}>
        <div className="p-3">
          <button onClick={newConv} disabled={live.busy}
            className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium hover:bg-panel-2 transition-colors">
            <SquarePen size={18} className="text-muted" />
            New chat
          </button>
        </div>
        <div className="px-4 pb-1 text-xs font-medium text-muted">Recents</div>
        <div className="flex-1 overflow-auto px-2 pb-2">
          {convs.length === 0 && <div className="px-3 py-2 text-sm text-muted">No chats yet</div>}
          {convs.map((c) => (
            <div key={c.id} onClick={() => selectConversation(c.id)} title={c.workspace}
              className={"group flex items-center gap-2 rounded-lg px-3 py-2 cursor-pointer text-sm " + (c.id === cur ? "bg-panel-2" : "hover:bg-panel-2/60")}>
              <MessageSquare size={14} className="shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="truncate">{c.title}</div>
              </div>
              <button title="Delete" className="hidden group-hover:block text-muted hover:text-red-600"
                onClick={async (e) => {
                  e.stopPropagation();
                  if (!window.confirm("Delete this chat?")) return;
                  await invoke("delete_conversation", { id: c.id });
                  if (cur === c.id) selectConversation(null);
                  refreshConvs();
                }}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
        <div className="px-3 py-3 flex items-center gap-3 text-sm" title={status.detail || label}>
          <span className="grid place-items-center w-9 h-9 rounded-full bg-panel-2 shrink-0 relative">
            <span className="font-medium">L</span><span className={"absolute bottom-0 right-0 w-2.5 h-2.5 border-2 border-panel rounded-full " + dotCls} />
          </span>
          <div className="min-w-0 flex-1"><div className="truncate" title={status.model}>{status.model || "Local model"}</div><div className="text-xs text-muted">{label.replace("Model ", "")}</div></div>
          {(status.state === "stopped" || status.state === "error") && <button title="Start model" className="text-xs text-accent" onClick={() => invoke("model_start").catch(e => setErr(String(e)))}>Retry</button>}
          <button title="Settings" className="p-1 text-muted hover:text-ink" onClick={() => setShowSettings(true)}><Gear size={17} /></button>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0">
        <header data-tauri-drag-region className={"flex items-center gap-2 pl-6 h-12 text-sm shrink-0 " + (workspaceOpen && cur ? "pr-4" : "pr-36")} >
          <span className="truncate text-muted pointer-events-none">{curConv?.title}</span>
          {cur && <button onClick={() => setWorkspaceOpen(!workspaceOpen)} aria-label="Files & visuals" title="Files" aria-expanded={workspaceOpen} className="ml-auto shrink-0 inline-flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-muted hover:bg-panel"><PanelRight size={16} />Files</button>}
        </header>
        <div className={"flex flex-col flex-1 min-h-0 " + (!msgs.length && !live.busy ? "justify-center pb-[10vh]" : "")}>
            <div className={"relative min-h-0 " + (msgs.length || live.busy ? "flex-1" : "h-20 shrink-0")}>
            <div ref={scrollRef} onScroll={onScroll} className={"absolute inset-0 " + (msgs.length || live.busy ? "overflow-auto" : "overflow-hidden")}>
              <div className="mx-auto max-w-3xl px-6 py-6 space-y-5">
                {msgs.length === 0 && !live.busy && <h1 className="text-2xl text-center tracking-tight">What should we work on?</h1>}
                {group(msgs).map((g) => g.kind === "tools"
                  ? <ToolGroup key={g.items[0].id} items={g.items} />
                  : <Row key={g.m.id} m={g.m} actions={{ onDocument: openDocument, onVisual: () => openVisual(String(g.m.id)), onDraft: draft }} />)}
                {live.thinking && <div className="text-xs text-muted italic whitespace-pre-wrap max-h-24 overflow-auto">{live.thinking}</div>}
                {live.text && <Assistant>{live.text}</Assistant>}
                {live.busy && !live.text && mine.length === 0 && (
                  <div className="flex items-center gap-2 text-muted text-sm"><span className="w-2 h-2 rounded-full bg-accent animate-pulse" /> Working…</div>
                )}
                {mine.map((a) => <ApprovalCard key={a.call_id} a={a} answer={answer} />)}
                <div ref={endRef} />
              </div>
            </div>
            {!atBottom && (
              <button onClick={jumpToLatest} title="Jump to latest"
                className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5 rounded-full border border-line bg-card shadow-md px-3 py-1.5 text-xs hover:border-accent">
                <ArrowDown size={13} /> Jump to latest
              </button>
            )}
            </div>

            <div className="shrink-0 px-6 pb-4">
              <div className="mx-auto max-w-3xl">
                {err && <div className="mb-2 rounded-lg bg-red-50 text-red-800 text-sm px-3 py-2 dark:bg-red-950 dark:text-red-200">{err}</div>}
                <div className="rounded-2xl border border-line bg-card shadow-sm focus-within:border-accent transition-colors">
                  {files.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 px-3 pt-3">
                      {files.map((f) => (
                        <span key={f} className="flex items-center gap-1 rounded-lg bg-panel px-2 py-1 text-xs">
                          <Paperclip size={11} /> {baseName(f)}
                          <button title="Remove" onClick={() => setFiles((x) => x.filter((y) => y !== f))} className="text-muted hover:text-red-600"><X size={11} /></button>
                        </span>
                      ))}
                    </div>
                  )}
                  <textarea ref={taRef} value={input} onChange={(e) => setInput(e.target.value)} onPaste={onPaste} rows={1}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
                    placeholder="Ask for something…" aria-label="Message"
                    className="w-full min-h-16 resize-none bg-transparent px-4 pt-4 pb-2 outline-none placeholder:text-muted" />
                  <div className="flex items-center justify-between px-3 pb-2">
                    <div className="flex items-center gap-1 min-w-0">
                    <button onClick={pickFiles} title="Attach files" className="grid place-items-center w-8 h-8 rounded-lg text-muted hover:bg-panel"><Paperclip size={17} /></button>
                    <button onClick={chooseFolder} disabled={live.busy} title="Start a chat in a folder" aria-label="Start a chat in a folder" className="grid place-items-center w-8 h-8 rounded-lg text-muted hover:bg-panel disabled:opacity-30"><FolderOpen size={17} /></button>
                    {curConv && <button onClick={() => invoke("open_workspace", { id: cur }) .catch(e => setErr(String(e)))} title={curConv.workspace} className="text-xs text-muted truncate max-w-36 hover:text-ink">{baseName(curConv.workspace) === curConv.id ? "Outputs" : baseName(curConv.workspace)}</button>}
                    <button onClick={toggleEdits} title={autoEdit ? "Edits allowed in this folder" : "Ask before editing"} aria-label={autoEdit ? "Edits allowed in folder" : "Ask before editing"} aria-pressed={autoEdit} className={"p-2 rounded-lg hover:bg-panel " + (autoEdit ? "text-accent" : "text-muted")}>
                      {autoEdit ? <Check size={15} /> : <ShieldAlert size={15} />}
                    </button>
                    </div>
                    <div className="flex items-center gap-1.5">
                    {cur && ctx.used != null && <ContextRing used={ctx.used} window={ctx.window} busy={live.busy} onCompact={compact} />}
                    {showTps && <span data-testid="composer-tps" title="Generation speed · current or last reply" className="text-[11px] tabular-nums text-muted whitespace-nowrap">{tps == null ? "—" : tps.toFixed(1)} tok/s</span>}
                    {input.trim().length > 20 && !live.busy && (
                      <button onClick={tidy} disabled={tidying || !modelReady} title="Ask the model to turn this into a clear request"
                        className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-muted hover:bg-panel disabled:opacity-40">
                        <Sparkles size={14} className={tidying ? "animate-pulse" : ""} />
                      </button>
                    )}
                    <button onPointerDown={(e) => { e.preventDefault(); voice.press(); }} onPointerUp={voice.release} onPointerLeave={voice.release}
                      disabled={!voice.available || voice.busy}
                      title={!voice.available ? voice.detail || "Voice input is not set up" : voice.busy ? "Transcribing…" : "Hold to talk (Ctrl+Space)"}
                      className={"grid place-items-center w-8 h-8 rounded-lg transition-colors disabled:opacity-30 " +
                        (voice.recording ? "bg-red-500 text-white animate-pulse" : voice.busy ? "bg-panel text-muted animate-pulse" : "text-muted hover:bg-panel")}>
                      <Mic size={16} />
                    </button>
                    {live.busy ? (
                      <button onClick={() => invoke("agent_stop", { id: cur })} title="Stop"
                        className="grid place-items-center w-8 h-8 rounded-lg bg-ink text-bg"><Square size={12} fill="currentColor" /></button>
                    ) : (
                      <button onClick={() => send()} disabled={(!input.trim() && !files.length) || !modelReady} title={modelReady ? "Send" : "Waiting for the model"}
                        className="grid place-items-center w-8 h-8 rounded-lg bg-accent text-white disabled:opacity-30 hover:bg-accent-dark transition-colors"><ArrowUp size={16} /></button>
                    )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
        </div>
      </main>
    {cur && workspaceOpen && <Workspace key={cur} id={cur} refresh={workspaceRefresh} visuals={visuals} requested={workspaceRequest} onClose={() => setWorkspaceOpen(false)} onDraft={draft} />}
      </div>
    {wizard && <Wizard onDone={() => setWizard(false)} />}
    {showSettings && <Settings status={status} showTps={showTps} onShowTps={setShowTps} onClose={() => setShowSettings(false)} />}
    </div>
  );
}

const isPlainTool = (m: Msg) => {
  if (m.role !== "tool") return false;
  const b = m.body ?? {};
  const nm = String(b.request?.name ?? b.name ?? "");
  if (/memory_save/.test(nm) && /Saved memory #(\d+): (.*)/.test(String(b.output ?? ""))) return false;
  const declined = b.status === "cancelled";
  return declined || b.status === "error" || !richFor(nm, b.request?.args, undefined);
};
type Block = { kind: "row"; m: Msg } | { kind: "tools"; items: Msg[] };
function group(msgs: Msg[]): Block[] {
  const out: Block[] = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (isPlainTool(m)) { if (last?.kind === "tools") last.items.push(m); else out.push({ kind: "tools", items: [m] }); }
    else out.push({ kind: "row", m });
  }
  return out;
}

const toolLabel = (m: Msg) => text(m.body?.request?.name ?? m.body?.name).replace(/^.*[_.:]{1,2}(?=[^_.:]+$)/, "").replace(/[_-]+/g, " ");

function ToolGroup({ items }: { items: Msg[] }) {
  const [open, setOpen] = useState(false);
  const failed = items.filter((m) => m.body?.status === "error" || m.body?.status === "cancelled").length;
  const names = Array.from(new Set(items.map(toolLabel))).slice(0, 3).join(", ");
  return (
    <div className="ml-10 text-sm text-muted">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="inline-flex items-center gap-1.5 hover:text-ink">
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span>{items.length === 1 ? "Used a tool" : `Used ${items.length} tools`}{names && <span className="opacity-70"> · {names}{new Set(items.map(toolLabel)).size > 3 ? "…" : ""}</span>}{failed > 0 && <span className="text-red-600"> · {failed} not completed</span>}</span>
      </button>
      {open && (
        <div className="mt-1 ml-1.5 border-l border-line pl-3 space-y-0.5">
          {items.map((m) => {
            const b = m.body ?? {};
            const declined = b.status === "cancelled";
            return (
              <details key={m.id} className="group">
                <summary className="flex items-center gap-2 cursor-pointer list-none py-0.5 hover:text-ink">
                  {declined || b.status === "error" ? <X size={12} className="text-red-600" /> : <Wrench size={12} />}
                  <span className="truncate">{declined ? "Declined: " : ""}{toolLabel(m)}</span>
                </summary>
                <pre className="my-1 text-xs whitespace-pre-wrap max-h-60 overflow-auto rounded-lg bg-panel border border-line p-3">{text(b.request?.args ?? {})}{"\n---\n"}{text(b.output)}</pre>
              </details>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ContextRing({ used, window: win, busy, onCompact }: { used: number; window: number; busy: boolean; onCompact: () => void }) {
  const pct = Math.max(0, Math.min(1, used / win));
  const r = 7, c = 2 * Math.PI * r;
  const tone = pct >= 0.9 ? "text-red-500" : pct >= 0.7 ? "text-amber-500" : "text-accent";
  const k = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", away); document.removeEventListener("keydown", esc); };
  }, [open]);
  const bar = tone.replace("text-", "bg-");
  return (
    <div ref={box} className="relative">
      <button onClick={() => setOpen((o) => !o)} data-testid="context-ring"
        aria-label={`Context ${Math.round(pct * 100)} percent full. Show details`} aria-expanded={open}
        className="grid place-items-center w-7 h-7 rounded-lg hover:bg-panel">
        <svg width="18" height="18" viewBox="0 0 18 18" className="-rotate-90">
          <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" strokeWidth="2" className="text-line" />
          <circle cx="9" cy="9" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className={tone}
            strokeDasharray={c} strokeDashoffset={c * (1 - pct)} />
        </svg>
      </button>
      {open && (
        <div data-testid="context-popover" className="absolute bottom-full right-0 mb-2 w-72 rounded-xl border border-line bg-panel shadow-lg p-4 text-sm z-20">
          <div className="text-xs text-muted mb-2">This chat</div>
          <div className="flex items-baseline justify-between">
            <span className="font-medium">Context window</span>
            <span className="text-xs text-muted">{k(used)} of {k(win)} · {Math.round(pct * 100)}%</span>
          </div>
          <div className="relative mt-1.5 h-1.5 rounded-full bg-line overflow-hidden">
            <div className={`h-full rounded-full ${bar}`} style={{ width: `${pct * 100}%` }} />
          </div>
          <div className="relative mt-1 h-2">
            <div className="absolute top-0 h-2 w-px bg-muted" style={{ left: "80%" }} />
          </div>
          <p className="text-xs text-muted">Older messages are summarized automatically at about 80% (the tick).</p>
          <div className="my-3 border-t border-line" />
          <button onClick={() => { setOpen(false); onCompact(); }} disabled={busy}
            className="w-full rounded-lg border border-line px-3 py-1.5 text-left hover:bg-panel-2 disabled:opacity-50">
            Compact now
          </button>
        </div>
      )}
    </div>
  );
}

function Assistant({ children }: { children: string }) {
  return (
    <div className="flex gap-3">
      <div className="prose min-w-0 flex-1"><Markdown remarkPlugins={[remarkGfm]}>{children}</Markdown></div>
    </div>
  );
}

function Row({ m, actions }: { m: Msg; actions?: RichActions }) {
  const b = m.body ?? {};
  if (m.role === "user")
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl bg-panel-2 px-4 py-2.5 whitespace-pre-wrap break-words">{text(b.text)}</div>
      </div>
    );
  if (m.role === "assistant") return <Assistant>{text(b.text)}</Assistant>;
  if (m.role === "notice")
    return <div className="text-center text-xs text-muted">{text(b.text)}</div>;
  if (m.role === "error")
    return <div className="rounded-lg bg-red-50 text-red-800 text-sm px-3 py-2 dark:bg-red-950 dark:text-red-200">{text(typeof b === "string" ? b : b?.message ?? b)}</div>;
  if (m.role === "tool") {
    const declined = b.status === "cancelled";
    const nm = String(b.request?.name ?? b.name ?? "");
    const saved = /memory_save/.test(nm) && /Saved memory #(\d+): (.*)/.exec(String(b.output ?? ""));
    if (saved) return <MemoryChip id={Number(saved[1])} text={saved[2]} />;
    const rich = !declined && b.status !== "error" ? richFor(nm, b.request?.args, actions) : null;
    if (rich) return <>{rich}</>;
    return (
      <details className="group ml-10 text-sm">
        <summary className="inline-flex items-center gap-2 cursor-pointer list-none rounded-lg border border-line bg-card px-3 py-1.5 text-muted hover:text-ink">
          <ChevronRight size={14} className="transition-transform group-open:rotate-90" />
          {declined ? <X size={14} className="text-red-600" /> : <Wrench size={14} />}
          <span>{declined ? "Declined: " : ""}{text(b.request?.name ?? b.name)}</span>
        </summary>
        <pre className="mt-2 text-xs whitespace-pre-wrap max-h-60 overflow-auto rounded-lg bg-panel border border-line p-3">{text(b.request?.args ?? {})}{"\n---\n"}{text(b.output)}</pre>
      </details>
    );
  }
  return null;
}

function ApprovalCard({ a, answer }: { a: Approval; answer: (a: Approval, allow: boolean, remember: boolean) => void }) {
  return (
    <div className="ml-10 rounded-xl border border-amber-400/70 bg-amber-50 dark:bg-amber-950/40 p-4">
      <div className="flex items-center gap-2 font-medium"><ShieldAlert size={16} className="text-amber-600" /> {a.reason}</div>
      <div className="text-xs text-muted mt-1">{a.tool} · {a.class}</div>
      <pre className="text-xs bg-card border border-line rounded-lg p-2 mt-2 max-h-40 overflow-auto whitespace-pre-wrap">{text(a.args)}</pre>
      <div className="flex flex-wrap gap-2 mt-3 text-sm">
        <button onClick={() => answer(a, true, false)} className="rounded-lg bg-accent hover:bg-accent-dark text-white px-3 py-1.5">Allow once</button>
        {a.can_remember && <button onClick={() => answer(a, true, true)} className="rounded-lg border border-line bg-card px-3 py-1.5 hover:border-accent">Allow for this chat</button>}
        <button onClick={() => answer(a, false, false)} className="rounded-lg border border-line bg-card px-3 py-1.5 hover:border-red-500">Deny</button>
      </div>
    </div>
  );
}

function MemoryChip({ id, text }: { id: number; text: string }) {
  const [gone, setGone] = useState(false);
  return (
    <div className="ml-10 inline-flex items-center gap-2 rounded-lg border border-line bg-card px-3 py-1.5 text-sm text-muted">
      <Check size={14} className="text-accent" />
      <span>{gone ? "Forgotten" : <>Remembered: <span className="text-ink">{text}</span></>}</span>
      {!gone && <button className="underline hover:text-ink" onClick={() => invoke("memory_delete", { id }).then(() => setGone(true))}>Undo</button>}
    </div>
  );
}
