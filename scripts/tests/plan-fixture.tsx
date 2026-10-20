import { useState } from "react";
import { createRoot } from "react-dom/client";
import PlanDock, { latestPlan, type PlanStep } from "../../src/PlanDock";

const unfinished: PlanStep[] = [
  { text: "Review the source data", status: "done" },
  { text: "Build the report", status: "doing" },
  { text: "Verify the result", status: "todo" },
];

function Fixture() {
  const [state, setState] = useState<"paused" | "busy" | "done" | "stale">("paused");
  const steps = state === "done" ? unfinished.map(step => ({ ...step, status: "done" as const })) : unfinished;
  const messages: { id: number; role: string; body: any }[] = [
    { id: 1, role: "user", body: { text: "Build a report" } },
    { id: 2, role: "tool", body: { request: { name: "update_plan", args: { steps } } } },
  ];
  if (state === "stale") messages.push({ id: 3, role: "user", body: { text: "Start a new task" } });
  const plan = latestPlan(messages);
  return (
    <main className="min-h-screen bg-panel p-6 text-ink">
      <nav className="mb-4 flex gap-2" aria-label="Fixture state">
        <button onClick={() => setState("paused")}>Paused</button>
        <button onClick={() => setState("busy")}>Busy</button>
        <button onClick={() => setState("done")}>Done</button>
        <button onClick={() => setState("stale")}>New turn</button>
      </nav>
      <PlanDock plan={plan} busy={state === "busy" || state === "stale"} />
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
