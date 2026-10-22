import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { cloudChanged, cloudChoices, type CloudConfig } from "./cloud-ui";
import { Button, input } from "./settings-ui";

type Route = { routing: string; model: string | null; locked: boolean; offline?: boolean };
type Decision = { conv: string; target: string; label: string; reason: string; redacted: number };
export default function ChatRouting({ conv, ensureConversation, disabled, onError }: {
  conv: string | null; ensureConversation: () => Promise<string>; disabled: boolean; onError: (s: string) => void;
}) {
  const [config, setConfig] = useState<CloudConfig | null>(null);
  const [route, setRoute] = useState<Route | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [sent, setSent] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    setDecision(null); setSent(undefined); setRoute(null);
    const refresh = async () => {
      const [c, r] = await Promise.all([invoke<CloudConfig>("cloud_get"), conv ? invoke<Route>("chat_route_get", { conv }) : Promise.resolve(null)]);
      if (alive) { setConfig(c); setRoute(r); }
    };
    const changed = () => { refresh().catch(e => onError(String(e))); };
    changed(); window.addEventListener("cloud-changed", changed);
    const sub = listen<Decision>("route", e => { if (alive && e.payload.conv === conv) { setDecision(e.payload); setSent(undefined); changed(); } });
    return () => { alive = false; window.removeEventListener("cloud-changed", changed); sub.then(f => f()); };
  }, [conv]);
  if (!config) return null;
  const choices = cloudChoices(config);
  async function pick(model: string) {
    setBusy(true);
    try {
      const id = conv ?? await ensureConversation();
      await invoke("chat_route_set", { conv: id, model: model || null });
      setRoute(await invoke<Route>("chat_route_get", { conv: id })); cloudChanged();
    } catch (e) { onError(String(e)); }
    finally { setBusy(false); }
  }
  return <div className="border-b border-line mb-1 pb-2 px-2.5 space-y-2">
    <label className="block text-xs text-muted">Reply location
      <select aria-label="Reply location" className={`${input} mt-1`} disabled={disabled || busy || config.routing === "local" || route?.locked || route?.offline} value={route?.model || ""} onChange={e => pick(e.target.value)}>
        <option value="">{config.routing === "auto" ? "Automatic · local first" : "Local · default"}</option>
        <option value="local">Local · always on this PC</option>
        {choices.map(c => <option key={c.value} value={c.value}>Cloud · {c.label}</option>)}
      </select>
    </label>
    {config.routing === "local" && <p className="text-[11px] text-muted">Local only. Enable cloud in Settings → Cloud.</p>}
    {route?.offline && <p className="text-[11px] text-muted">Offline · this chat stays on this PC.</p>}
    {route?.locked && <div className="text-xs text-muted">🔒 Sensitive chat · stays local <Button small disabled={disabled || busy} onClick={async () => {
      if (!conv || !confirm("Allow this chat to be considered for cloud routing again? The privacy filter still checks future requests.")) return;
      try { await invoke("chat_unlock", { conv }); setRoute(await invoke("chat_route_get", { conv })); cloudChanged(); } catch (e) { onError(String(e)); }
    }}>Unlock</Button></div>}
    {decision && <div className="text-[11px] text-muted break-words"><span className="font-medium">{decision.target === "local" ? "Local" : "Cloud"} · {decision.label}</span><div>{decision.reason}{decision.redacted ? ` · ${decision.redacted} details replaced` : ""}</div></div>}
    {conv && <button className="text-[11px] text-accent" onClick={async () => { try { setSent(await invoke("route_last_sent", { conv })); } catch (e) { onError(String(e)); } }}>View last cloud request</button>}
    {sent !== undefined && <div><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all select-text text-[11px] bg-panel-2 rounded p-2">{JSON.stringify(sent, null, 2)}</pre><Button small onClick={() => setSent(undefined)}>Hide request</Button></div>}
  </div>;
}
