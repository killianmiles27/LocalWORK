// The agent's latest update_plan, pinned above the composer so long tasks stay easy to follow.
// It reads only the messages already loaded for the chat, so it costs nothing extra.
import { useEffect, useState } from "react";
import { Check, ChevronDown, ChevronUp, Circle, ListChecks, Loader2, X } from "lucide-react";

export type PlanStep = { text: string; status: "todo" | "doing" | "done" };

/** Steps from the most recent update_plan call in a message list, or null when there is none. */
export function latestPlan(msgs: { role: string; body: any }[]): { steps: PlanStep[]; key: string } | null {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const b = msgs[i].body ?? {};
    if (msgs[i].role !== "tool" || !/update_plan$/.test(String(b.request?.name ?? b.name ?? ""))) continue;
    let a = b.request?.args;
    if (typeof a === "string") { try { a = JSON.parse(a); } catch { a = null; } }
    a = a?.arguments ?? a;
    const steps = Array.isArray(a?.steps) ? a.steps.filter((s: any) => s && typeof s.text === "string" && s.text.trim())
      .slice(0, 50).map((s: any) => ({ text: s.text.trim(), status: s.status === "done" || s.status === "doing" ? s.status : "todo" })) : [];
    return steps.length ? { steps, key: String((msgs[i] as any).id ?? i) } : null;
  }
  return null;
}

export default function PlanDock({ plan, busy }: { plan: { steps: PlanStep[]; key: string } | null; busy: boolean }) {
  const [open, setOpen] = useState(true);
  const [hidden, setHidden] = useState<string | null>(null);
  const doneAll = !!plan && plan.steps.every(s => s.status === "done");
  // A finished plan folds away once the turn ends; a new plan shows again.
  useEffect(() => { if (doneAll && !busy) setOpen(false); }, [doneAll, busy]);
  useEffect(() => { if (plan && busy && !doneAll) setOpen(true); }, [plan?.key]);
  if (!plan || hidden === plan.key) return null;
  const done = plan.steps.filter(s => s.status === "done").length;
  const current = plan.steps.find(s => s.status === "doing") ?? plan.steps.find(s => s.status === "todo");
  return (
    <section aria-label="Plan" className="mb-2 rounded-xl border border-line bg-card text-sm shadow-sm">
      <div className="flex items-center gap-2 px-3 py-2">
        <button onClick={() => setOpen(o => !o)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <ListChecks size={15} className={doneAll ? "text-green-600" : "text-accent"} />
          <span className="shrink-0 font-medium">{doneAll ? "Plan complete" : "Plan"}</span>
          <span className="shrink-0 text-xs text-muted tabular-nums">{done}/{plan.steps.length}</span>
          {!open && current && !doneAll && <span className="truncate text-muted">· {current.text}</span>}
          <span className="ml-auto shrink-0 text-muted">{open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}</span>
        </button>
        {!busy && <button onClick={() => setHidden(plan.key)} title="Hide plan" aria-label="Hide plan" className="shrink-0 text-muted hover:text-ink"><X size={14} /></button>}
      </div>
      <div className="h-0.5 bg-panel-2"><div className="h-full bg-accent transition-all duration-500" style={{ width: `${(done / plan.steps.length) * 100}%` }} /></div>
      {open && (
        <ol className="max-h-48 space-y-1 overflow-auto px-3 py-2">
          {plan.steps.map((s, i) => (
            <li key={i} className="flex items-start gap-2">
              {s.status === "done" ? <Check size={15} className="mt-0.5 shrink-0 text-green-600" />
                : s.status === "doing" ? <Loader2 size={15} className={"mt-0.5 shrink-0 text-accent " + (busy ? "animate-spin" : "")} />
                : <Circle size={15} className="mt-0.5 shrink-0 text-muted" />}
              <span className={s.status === "done" ? "text-muted line-through" : s.status === "doing" ? "font-medium" : ""}>{s.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
