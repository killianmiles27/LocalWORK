import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ArrowDown, ArrowUp, Check, ChevronRight, FolderOpen, MessageSquare, Mic, Plus, Settings as Gear, ShieldAlert, Sparkles, Square, Trash2, Wrench, X } from "lucide-react";
import Settings from "./Settings";
import { useVoice } from "./voice";

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

const suggestions = [
  "List the files in this folder and summarize what they are",
  "Write a one-page Word memo about our project status",
  "Make a spreadsheet that tracks weekly expenses",
];

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
  const [showSettings, setShowSettings] = useState(false);
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

  const refreshConvs = () => invoke<Conv[]>("list_conversations").then(setConvs).catch((e) => setErr(String(e)));
  const reload = (id: string) =>
    invoke<Msg[]>("load_messages", { id }).then((m) => { if (curRef.current === id) setMsgs(m); }).catch((e) => setErr(String(e)));

  useEffect(() => {
    refreshConvs();
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
            setLive({ text: "", thinking: "", busy: false }); reload(conv); refreshConvs(); break;
        }
      }),
    ];
    return () => { subs.forEach((s) => { s.then((f) => f()); }); };
  }, []);

  useEffect(() => {
    setLive({ text: "", thinking: "", busy: false });
    setMsgs([]);
    setErr("");
    if (cur) reload(cur);
  }, [cur]);

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

  async function newConv() {
    const dir = await open({ directory: true, title: "Choose a workspace folder" });
    if (typeof dir !== "string") return;
    try { const id = await invoke<string>("create_conversation", { workspace: dir }); await refreshConvs(); setCur(id); }
    catch (e) { setErr(String(e)); }
  }
  async function send(override?: string) {
    const body = (override ?? input).trim();
    if (!cur || !body || live.busy) return;
    setInput(""); setErr(""); stick.current = true;
    setLive({ text: "", thinking: "", busy: true });
    try { await invoke("agent_send", { id: cur, text: body, autoEdit }); await reload(cur); refreshConvs(); }
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

  return (
    <div className="flex h-full">
      <aside className="w-[260px] shrink-0 bg-panel border-r border-line flex flex-col">
        <div className="p-3">
          <button onClick={newConv}
            className="w-full flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium hover:bg-panel-2 transition-colors">
            <span className="grid place-items-center w-6 h-6 rounded-full bg-accent text-white"><Plus size={14} /></span>
            New chat
          </button>
        </div>
        <div className="px-4 pb-1 text-xs font-medium text-muted">Recents</div>
        <div className="flex-1 overflow-auto px-2 pb-2">
          {convs.length === 0 && <div className="px-3 py-2 text-sm text-muted">No chats yet</div>}
          {convs.map((c) => (
            <div key={c.id} onClick={() => setCur(c.id)} title={c.workspace}
              className={"group flex items-center gap-2 rounded-lg px-3 py-2 cursor-pointer text-sm " + (c.id === cur ? "bg-panel-2" : "hover:bg-panel-2/60")}>
              <MessageSquare size={14} className="shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="truncate">{c.title}</div>
                <div className="truncate text-xs text-muted">{baseName(c.workspace)}</div>
              </div>
              <button title="Delete" className="hidden group-hover:block text-muted hover:text-red-600"
                onClick={async (e) => {
                  e.stopPropagation();
                  if (!window.confirm("Delete this chat?")) return;
                  await invoke("delete_conversation", { id: c.id });
                  if (cur === c.id) setCur(null);
                  refreshConvs();
                }}><Trash2 size={14} /></button>
            </div>
          ))}
        </div>
        <div className="border-t border-line px-4 py-3 flex items-center gap-2 text-xs text-muted" title={status.detail}>
          <span className={"w-2 h-2 rounded-full " + dotCls} />
          <span className="flex-1">{label}</span>
          {modelReady && <button className="hover:text-ink underline" onClick={() => invoke("model_stop")}>stop</button>}
          {(status.state === "stopped" || status.state === "error") &&
            <button className="text-accent underline" onClick={() => invoke("model_start").catch((e) => setErr(String(e)))}>start</button>}
          <button title="Settings" className="hover:text-ink" onClick={() => setShowSettings(true)}><Gear size={15} /></button>
        </div>
      </aside>

      <main className="flex-1 flex flex-col min-w-0">
        {!cur ? (
          <div className="flex-1 grid place-items-center px-6">
            <div className="text-center max-w-md">
              <div className="mx-auto mb-5 grid place-items-center w-12 h-12 rounded-2xl bg-accent text-white text-xl">L</div>
              <h1 className="text-3xl mb-2">What are we working on?</h1>
              <p className="text-muted mb-6">Pick a folder and I'll work on the files in it, on your own computer.</p>
              <button onClick={newConv} className="inline-flex items-center gap-2 rounded-xl bg-accent hover:bg-accent-dark text-white px-5 py-2.5 font-medium transition-colors">
                <FolderOpen size={16} /> Choose a folder
              </button>
              {convs.length > 0 && <p className="text-sm text-muted mt-5">or continue a chat from the list on the left</p>}
            </div>
          </div>
        ) : (
          <>
            <header className="flex items-center gap-2 px-6 h-12 border-b border-line text-sm shrink-0">
              <FolderOpen size={15} className="text-muted" />
              <span className="truncate font-medium">{curConv ? baseName(curConv.workspace) : ""}</span>
              <span className="truncate text-muted text-xs">{curConv?.workspace}</span>
            </header>
            <div className="flex-1 relative min-h-0">
            <div ref={scrollRef} onScroll={onScroll} className="absolute inset-0 overflow-auto">
              <div className="mx-auto max-w-3xl px-6 py-6 space-y-5">
                {msgs.length === 0 && !live.busy && (
                  <div className="pt-16 text-center">
                    <h2 className="text-2xl mb-5">How can I help with this folder?</h2>
                    <div className="grid gap-2 max-w-md mx-auto">
                      {suggestions.map((s) => (
                        <button key={s} onClick={() => send(s)} disabled={!modelReady}
                          className="text-left rounded-xl border border-line bg-card px-4 py-3 text-sm hover:border-accent disabled:opacity-50 transition-colors">{s}</button>
                      ))}
                    </div>
                    {!modelReady && <p className="text-xs text-muted mt-3">Waiting for the model to finish loading…</p>}
                  </div>
                )}
                {msgs.map((m) => <Row key={m.id} m={m} />)}
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
                  <textarea ref={taRef} value={input} onChange={(e) => setInput(e.target.value)} rows={1}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
                    placeholder={modelReady ? "Ask for something…" : "Model is still loading — you can type meanwhile"}
                    className="w-full resize-none bg-transparent px-4 pt-3 pb-1 outline-none placeholder:text-muted" />
                  <div className="flex items-center justify-between px-3 pb-2">
                    <button onClick={toggleEdits} title="Let me edit files inside this folder without asking each time"
                      className={"flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition-colors " + (autoEdit ? "bg-accent/15 text-accent" : "text-muted hover:bg-panel")}>
                      {autoEdit ? <Check size={13} /> : <ShieldAlert size={13} />} {autoEdit ? "Edits allowed in folder" : "Ask before editing"}
                    </button>
                    <div className="flex items-center gap-2">
                    {input.trim().length > 20 && !live.busy && (
                      <button onClick={tidy} disabled={tidying || !modelReady} title="Ask the model to turn this into a clear request"
                        className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-muted hover:bg-panel disabled:opacity-40">
                        <Sparkles size={13} /> {tidying ? "Tidying…" : "Tidy up"}
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
                      <button onClick={() => send()} disabled={!input.trim() || !modelReady} title={modelReady ? "Send" : "Waiting for the model"}
                        className="grid place-items-center w-8 h-8 rounded-lg bg-accent text-white disabled:opacity-30 hover:bg-accent-dark transition-colors"><ArrowUp size={16} /></button>
                    )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </main>
    {showSettings && <Settings status={status} onClose={() => setShowSettings(false)} />}
    </div>
  );
}

function Assistant({ children }: { children: string }) {
  return (
    <div className="flex gap-3">
      <div className="shrink-0 grid place-items-center w-7 h-7 rounded-full bg-accent text-white text-xs mt-0.5">L</div>
      <div className="prose min-w-0 flex-1"><Markdown remarkPlugins={[remarkGfm]}>{children}</Markdown></div>
    </div>
  );
}

function Row({ m }: { m: Msg }) {
  const b = m.body ?? {};
  if (m.role === "user")
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl bg-panel-2 px-4 py-2.5 whitespace-pre-wrap break-words">{text(b.text)}</div>
      </div>
    );
  if (m.role === "assistant") return <Assistant>{text(b.text)}</Assistant>;
  if (m.role === "error")
    return <div className="rounded-lg bg-red-50 text-red-800 text-sm px-3 py-2 dark:bg-red-950 dark:text-red-200">{text(typeof b === "string" ? b : b?.message ?? b)}</div>;
  if (m.role === "tool") {
    const declined = b.status === "cancelled";
    const nm = String(b.request?.name ?? b.name ?? "");
    const saved = /memory_save/.test(nm) && /Saved memory #(\d+): (.*)/.exec(String(b.output ?? ""));
    if (saved) return <MemoryChip id={Number(saved[1])} text={saved[2]} />;
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
