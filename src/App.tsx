import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

type Conv = { id: string; title: string; workspace: string; updated: number };
type Msg = { id: number; role: string; body: any; ts: number };
type Status = { state: string; detail: string; port: number; model: string };
type Approval = { conv: string; call_id: string; tool: string; class: string; reason: string; description?: string; args: any; can_remember: boolean };

const pill: Record<string, [string, string]> = {
  ready: ["bg-green-100 text-green-800", "Model ready"],
  starting: ["bg-amber-100 text-amber-800", "Model starting…"],
  loading: ["bg-amber-100 text-amber-800", "Model loading…"],
  stopped: ["bg-stone-200 text-stone-700", "Model stopped"],
  error: ["bg-red-100 text-red-800", "Model error"],
};

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
  const curRef = useRef<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  curRef.current = cur;

  const refreshConvs = () => invoke<Conv[]>("list_conversations").then(setConvs);
  const reload = (id: string) => invoke<Msg[]>("load_messages", { id }).then((m) => curRef.current === id && setMsgs(m));

  useEffect(() => {
    refreshConvs();
    invoke<Status>("model_status").then(setStatus);
    const subs = [
      listen<Status>("model-status", (e) => setStatus(e.payload)),
      listen<Approval>("approval-request", (e) => setApprovals((a) => [...a, e.payload])),
      listen<{ conv: string; ev: any }>("agent-event", (e) => {
        const { conv, ev } = e.payload;
        if (conv !== curRef.current) return;
        switch (ev.type) {
          case "text_delta": setLive((l) => ({ ...l, busy: true, text: l.text + ev.text })); break;
          case "thinking": setLive((l) => ({ ...l, busy: true, thinking: l.thinking + ev.text })); break;
          case "tool_request": case "tool_running": case "tool_result": case "tool_cancelled":
            setLive((l) => ({ ...l, busy: true, text: "", thinking: "" })); reload(conv); break;
          case "stream_end": case "error": case "agent_exit":
            setLive({ text: "", thinking: "", busy: false }); reload(conv); refreshConvs(); break;
        }
      }),
    ];
    return () => { subs.forEach((s) => s.then((f) => f())); };
  }, []);

  useEffect(() => {
    setLive({ text: "", thinking: "", busy: false });
    setMsgs([]);
    if (cur) reload(cur);
  }, [cur]);
  useEffect(() => endRef.current?.scrollIntoView({ block: "end" }), [msgs, live]);

  async function newConv() {
    const dir = await open({ directory: true, title: "Choose a workspace folder" });
    if (typeof dir !== "string") return;
    try { const id = await invoke<string>("create_conversation", { workspace: dir }); await refreshConvs(); setCur(id); }
    catch (e) { setErr(String(e)); }
  }
  async function send() {
    if (!cur || !input.trim() || live.busy) return;
    const text = input; setInput(""); setErr("");
    setLive({ text: "", thinking: "", busy: true });
    try { await invoke("agent_send", { id: cur, text, autoEdit }); await reload(cur); refreshConvs(); }
    catch (e) { setErr(String(e)); setLive({ text: "", thinking: "", busy: false }); }
  }
  function answer(a: Approval, allow: boolean, remember: boolean) {
    invoke("agent_answer", { id: a.conv, callId: a.call_id, allow, remember });
    setApprovals((x) => x.filter((y) => y.call_id !== a.call_id));
  }

  const [cls, label] = pill[status.state] ?? pill.error;
  const mine = approvals.filter((a) => a.conv === cur);
  const curConv = convs.find((c) => c.id === cur);

  return (
    <div className="flex h-full">
      <aside className="w-64 border-r border-stone-200 bg-stone-100 flex flex-col">
        <button onClick={newConv} className="m-3 rounded-md bg-stone-900 text-white py-2 hover:bg-stone-700">New conversation</button>
        <div className="flex-1 overflow-auto">
          {convs.map((c) => (
            <div key={c.id} onClick={() => setCur(c.id)}
              className={"group px-3 py-2 cursor-pointer border-l-2 " + (c.id === cur ? "bg-white border-blue-600" : "border-transparent hover:bg-stone-200")}>
              <div className="truncate font-medium">{c.title}</div>
              <div className="truncate text-xs text-stone-500 flex justify-between">
                <span className="truncate">{c.workspace}</span>
                <button className="hidden group-hover:block text-red-600"
                  onClick={async (e) => { e.stopPropagation(); if (confirm("Delete this conversation?")) { await invoke("delete_conversation", { id: c.id }); if (cur === c.id) setCur(null); refreshConvs(); } }}>delete</button>
              </div>
            </div>
          ))}
        </div>
      </aside>
      <main className="flex-1 flex flex-col min-w-0">
        <header className="flex items-center justify-between px-4 py-2 border-b border-stone-200 bg-white">
          <div className="truncate text-stone-600">{curConv ? curConv.workspace : "Local work assistant"}</div>
          <div className="flex items-center gap-2">
            <span title={status.detail} className={"rounded-full px-3 py-1 text-xs " + cls}>{label}</span>
            {status.state === "ready" ? (
              <button className="text-xs text-stone-500 underline" onClick={() => invoke("model_stop")}>stop</button>
            ) : status.state === "stopped" || status.state === "error" ? (
              <button className="text-xs text-blue-700 underline" onClick={() => invoke("model_start").catch((e) => setErr(String(e)))}>start</button>
            ) : null}
          </div>
        </header>
        {!cur ? (
          <div className="flex-1 grid place-items-center text-stone-500">Create a conversation and pick a workspace folder to begin.</div>
        ) : (
          <>
            <div className="flex-1 overflow-auto px-6 py-4 space-y-3">
              {msgs.map((m) => <Row key={m.id} m={m} />)}
              {live.thinking && <div className="text-xs text-stone-400 italic whitespace-pre-wrap max-h-24 overflow-auto">{live.thinking}</div>}
              {live.text && <Bubble who="assistant"><div className="md"><Markdown remarkPlugins={[remarkGfm]}>{live.text}</Markdown></div></Bubble>}
              {live.busy && !live.text && <div className="text-stone-400 text-sm">Working…</div>}
              {mine.map((a) => (
                <div key={a.call_id} className="rounded-lg border-2 border-amber-400 bg-amber-50 p-3">
                  <div className="font-medium">{a.reason} <span className="text-xs uppercase text-amber-700">{a.class}</span></div>
                  <div className="text-xs text-stone-600 mt-1">{a.tool}</div>
                  <pre className="text-xs bg-white border rounded p-2 mt-2 max-h-40 overflow-auto whitespace-pre-wrap">{JSON.stringify(a.args, null, 2)}</pre>
                  <div className="flex gap-2 mt-2">
                    <button onClick={() => answer(a, true, false)} className="rounded bg-green-700 text-white px-3 py-1">Allow once</button>
                    {a.can_remember && <button onClick={() => answer(a, true, true)} className="rounded bg-green-100 text-green-900 px-3 py-1">Allow for this conversation</button>}
                    <button onClick={() => answer(a, false, false)} className="rounded bg-red-100 text-red-800 px-3 py-1">Deny</button>
                  </div>
                </div>
              ))}
              <div ref={endRef} />
            </div>
            {err && <div className="px-6 py-1 text-red-700 text-sm">{err}</div>}
            <div className="border-t border-stone-200 bg-white p-3">
              <textarea value={input} onChange={(e) => setInput(e.target.value)} rows={3}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder="Ask for something… (Enter to send, Shift+Enter for a new line)"
                className="w-full resize-none rounded-md border border-stone-300 p-2 outline-none focus:border-blue-500" />
              <div className="flex items-center justify-between mt-2">
                <label className="text-xs text-stone-600 flex items-center gap-1">
                  <input type="checkbox" checked={autoEdit} onChange={(e) => setAutoEdit(e.target.checked)} /> Allow edits inside the workspace without asking
                </label>
                <div className="flex gap-2">
                  {live.busy && <button onClick={() => invoke("agent_stop", { id: cur })} className="rounded border border-stone-300 px-3 py-1">Stop</button>}
                  <button onClick={send} disabled={live.busy || !input.trim()} className="rounded bg-blue-700 text-white px-4 py-1 disabled:opacity-40">Send</button>
                </div>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function Bubble({ who, children }: { who: "user" | "assistant"; children: React.ReactNode }) {
  return (
    <div className={who === "user" ? "flex justify-end" : "flex"}>
      <div className={"max-w-[80%] rounded-lg px-3 py-2 " + (who === "user" ? "bg-blue-700 text-white whitespace-pre-wrap" : "bg-white border border-stone-200")}>{children}</div>
    </div>
  );
}

function Row({ m }: { m: Msg }) {
  const b = m.body ?? {};
  if (m.role === "user") return <Bubble who="user">{b.text}</Bubble>;
  if (m.role === "assistant")
    return <Bubble who="assistant"><div className="md"><Markdown remarkPlugins={[remarkGfm]}>{b.text ?? ""}</Markdown></div></Bubble>;
  if (m.role === "error") return <div className="text-red-700 text-sm">Error: {typeof b === "string" ? b : b?.message ?? JSON.stringify(b)}</div>;
  if (m.role === "tool")
    return (
      <details className="text-xs text-stone-600 bg-stone-100 rounded px-2 py-1">
        <summary className="cursor-pointer">{b.status === "cancelled" ? "Declined: " : "Tool: "}{b.request?.name ?? b.name}</summary>
        <pre className="whitespace-pre-wrap mt-1 max-h-48 overflow-auto">{JSON.stringify(b.request?.args ?? {}, null, 1)}{"\n---\n"}{b.output}</pre>
      </details>
    );
  return null;
}
