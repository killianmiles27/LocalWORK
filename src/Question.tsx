// The agent's open question (ask_user), shown above the composer until the user answers or skips it.
// Answering just sends a normal message, so the user can also ignore the card and type in the composer.
import { useEffect, useRef, useState } from "react";
import { CircleHelp, X } from "lucide-react";

export type OpenQuestion = { key: number; question: string; options: string[] };

const argsOf = (b: any) => {
  let a = b?.request?.args;
  if (typeof a === "string") { try { a = JSON.parse(a); } catch { a = null; } }
  return a?.arguments ?? a ?? {};
};
export const isAsk = (b: any) => /ask_user$/.test(String(b?.request?.name ?? b?.name ?? ""));

/** The latest ask_user call that no user message has followed yet. */
export function openQuestion(msgs: { id: number; role: string; body: any }[]): OpenQuestion | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === "user") return null;
    if (m.role !== "tool" || !isAsk(m.body) || m.body?.status === "error" || m.body?.status === "cancelled") continue;
    const a = argsOf(m.body);
    const question = String(a.question ?? "").trim();
    if (!question) return null;
    const options = Array.isArray(a.options) ? a.options.filter((o: any) => typeof o === "string" && o.trim()).slice(0, 4) : [];
    return { key: m.id, question, options };
  }
  return null;
}

/** Transcript line for an ask_user call. */
export function AskedLine({ body }: { body: any }) {
  return (
    <div className="ml-10 flex items-start gap-2 text-sm text-muted">
      <CircleHelp size={15} className="mt-0.5 shrink-0" /><span>Asked: <span className="text-ink">{String(argsOf(body).question ?? "")}</span></span>
    </div>
  );
}

export default function QuestionCard({ q, canSend, busy, onAnswer }: { q: OpenQuestion; canSend: boolean; busy?: boolean; onAnswer: (text: string) => void }) {
  const [text, setText] = useState("");
  const [dismissed, setDismissed] = useState<number | null>(null);
  // Answered while the assistant was still busy: the answer is queued, so the card steps aside.
  const [sent, setSent] = useState<number | null>(null);
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => { setText(""); }, [q.key]);
  if (dismissed === q.key || sent === q.key) return null;
  const send = (t: string) => { if (t.trim() && canSend) { onAnswer(t.trim()); setSent(q.key); } };
  return (
    <section aria-label="Question from the assistant" className="mb-2 rounded-xl border border-line bg-card p-3 text-sm shadow-sm animate-[rise_.2s_ease-out]">
      <div className="mb-1.5 flex items-center gap-1.5 text-xs text-muted">
        <CircleHelp size={13} /><span className="flex-1">Question</span>
        <button onClick={() => setDismissed(q.key)} title="Hide (answer later in the message box)" aria-label="Hide question" className="p-0.5 hover:text-ink"><X size={13} /></button>
      </div>
      <p className="font-medium whitespace-pre-wrap">{q.question}</p>
      {q.options.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {q.options.map((o) => (
            <button key={o} disabled={!canSend} onClick={() => send(o)}
              className="rounded-lg border border-line px-2.5 py-1 hover:border-accent hover:text-accent disabled:opacity-40">{o}</button>
          ))}
        </div>
      )}
      <form className="mt-2 flex items-center gap-1.5" onSubmit={(e) => { e.preventDefault(); send(text); }}>
        <input ref={box} value={text} onChange={(e) => setText(e.target.value)} placeholder={q.options.length ? "Or type your answer…" : "Your answer…"} aria-label="Your answer"
          className="min-w-0 flex-1 rounded-lg border border-line bg-transparent px-2.5 py-1.5 outline-none focus:border-accent" />
        <button type="button" disabled={!canSend} onClick={() => send("Skip that question: decide yourself and tell me what you chose.")}
          className="rounded-lg px-2.5 py-1.5 text-muted hover:bg-panel disabled:opacity-40">Skip</button>
        <button type="submit" disabled={!canSend || !text.trim()} className="rounded-lg bg-accent px-3 py-1.5 text-accent-fg hover:bg-accent-dark disabled:opacity-40">Send</button>
      </form>
      {busy && <p className="mt-1.5 text-xs text-muted">The assistant is still working. Your answer is queued and sent when this step ends.</p>}
    </section>
  );
}
