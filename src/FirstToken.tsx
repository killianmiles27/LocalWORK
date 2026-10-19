import { useEffect, useState } from "react";

// How long the first reply of a chat takes to start (agent spawn + prompt prefill), learned per
// mode and effort as a moving average. Kept in this browser's storage; losing it only loses the estimate.
const KEY = "ttft-v1";
type Learned = Record<string, { ms: number; n: number }>;
const load = (): Learned => { try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch { return {}; } };

export function ttftEstimate(key: string): number | null { return load()[key]?.ms ?? null; }
export function ttftRecord(key: string, ms: number) {
  if (!(ms > 200 && ms < 15 * 60_000)) return;
  const all = load();
  const old = all[key];
  // Early samples weigh more; later ones settle to a 30% step so one odd run does not swing it.
  all[key] = old ? { ms: Math.round(old.ms + (ms - old.ms) * Math.max(0.3, 1 / (old.n + 1))), n: old.n + 1 } : { ms, n: 1 };
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* estimate only */ }
}

/** Countdown to the expected first token; counts up until this mode has a sample. */
export default function FirstTokenCountdown({ start, estimate }: { start: number; estimate: number | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(t); }, []);
  const elapsed = now - start;
  const left = estimate == null ? null : Math.ceil((estimate - elapsed) / 1000);
  const pct = estimate ? Math.min(1, elapsed / estimate) : 0;
  return (
    <div data-testid="first-token" className="flex items-center gap-2.5 text-muted text-sm">
      <span className="relative w-24 h-1 rounded-full bg-line overflow-hidden">
        {estimate
          ? <span className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-300 ease-linear" style={{ width: `${pct * 100}%` }} />
          : <span className="absolute inset-y-0 w-1/3 rounded-full bg-accent/70 animate-[slide_1.2s_ease-in-out_infinite]" />}
      </span>
      <span className="tabular-nums">
        {left == null ? `Starting… ${Math.floor(elapsed / 1000)}s` : left > 0 ? `First words in ~${left}s` : "Any moment…"}
      </span>
    </div>
  );
}
