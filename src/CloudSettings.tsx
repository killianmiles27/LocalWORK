import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Button, input, Message, Row, Section, ToggleRow } from "./settings-ui";
import { cloudChanged, cloudChoices, type CloudConfig, type Provider } from "./cloud-ui";

export default function CloudSettings() {
  const [config, setConfig] = useState<CloudConfig | null>(null);
  const [gate, setGate] = useState<{ installed: boolean; running: boolean } | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState("");
  const [draft, setDraft] = useState<Provider | null>(null);
  const [key, setKey] = useState("");
  const [sample, setSample] = useState("");
  const [result, setResult] = useState<{ masked: string; sensitivity: number } | null>(null);
  async function load() {
    const [c, g] = await Promise.all([invoke<CloudConfig>("cloud_get"), invoke<{ installed: boolean; running: boolean }>("gate_status")]);
    setConfig(c); setGate(g);
  }
  useEffect(() => {
    load().catch(e => setError(String(e)));
    const sub = listen<{ id: string; done: number; total: number | null }>("download-progress", e => {
      if (e.payload.id.startsWith("gate-")) setProgress(`${Math.round(e.payload.done / 1048576)} MB${e.payload.total ? ` / ${Math.round(e.payload.total / 1048576)} MB` : ""}`);
    });
    return () => { sub.then(f => f()); };
  }, []);
  async function run(label: string, task: () => Promise<unknown>) {
    setBusy(label); setError(""); setProgress("");
    try { await task(); await load(); cloudChanged(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(""); }
  }
  const save = (key: string, value: unknown) => run("Saving", () => invoke("cloud_set", { key, value }));
  if (!config) return <Message error={!!error}>{error || "Loading cloud settings…"}</Message>;
  const choices = cloudChoices(config);
  return <>
    <Section title="Where replies run" note="Local only is the default. Offline mode and privacy locks always keep a chat local.">
      <Row label="Routing">
        <select aria-label="Routing" className={input} disabled={!!busy} value={config.routing} onChange={e => run("Saving", () => invoke("route_mode_set", { mode: e.target.value }))}>
          <option value="local">Local only</option><option value="manual">Manual</option><option value="auto" disabled={!gate?.installed || config.privacyGate !== "on"}>Automatic</option>
        </select>
      </Row>
      <Row label="Default cloud model" hint="Used for automatic escalation.">
        <select aria-label="Default cloud model" className={input} disabled={!!busy} value={config.cloudDefault ?? ""} onChange={e => save("cloudDefault", e.target.value || null)}>
          <option value="">None</option>{choices.map(c => <option key={c.value} value={c.value}>Cloud · {c.label}</option>)}
        </select>
      </Row>
      <p className="px-3.5 py-2.5 text-xs text-muted">Automatic requires the privacy filter below. It currently escalates when the local model is unavailable, the context is nearly full, or a tool error repeats. It does not yet judge task difficulty. In Manual mode with the filter off, cloud choices send the full conversation and tool results.</p>
    </Section>
    <Section title="Cloud providers" action={<Button small disabled={!!busy} onClick={() => { setDraft({ id: "", name: "", baseUrl: "", models: [] }); setKey(""); }}>Add provider</Button>} note="Use an OpenAI-compatible API base URL, including /v1 where required. Keys are stored in Windows Credential Manager.">
      {!config.providers.length && <p className="px-3.5 py-3 text-sm text-muted">No API providers connected.</p>}
      {config.providers.map(p => <Row key={p.id} label={p.name} hint={`${p.baseUrl} · ${p.models.length} models`}>
        <div className="flex gap-1"><Button small disabled={!!busy} onClick={() => run("Fetching models", () => invoke("cloud_models", { id: p.id }))}>Fetch models</Button>
          <Button small disabled={!!busy} onClick={() => { setDraft(p); setKey(""); }}>Edit</Button>
          <Button small variant="danger" disabled={!!busy} onClick={() => run("Removing", () => invoke("cloud_provider_remove", { id: p.id }))}>Remove</Button></div>
      </Row>)}
      {draft && <form className="p-3.5 space-y-2" onSubmit={e => { e.preventDefault(); run("Saving provider", async () => { await invoke("cloud_provider_save", { provider: draft, key: key || null }); setDraft(null); setKey(""); }); }}>
        <label className="block text-xs">Name<input required className={input} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
        <label className="block text-xs">API base URL<input required type="url" className={input} placeholder="https://provider.example/v1" value={draft.baseUrl} onChange={e => setDraft({ ...draft, baseUrl: e.target.value })} /></label>
        <label className="block text-xs">API key<input type="password" autoComplete="off" className={input} placeholder={draft.hasKey ? "Leave blank to keep saved key" : "Optional for servers without authentication"} value={key} onChange={e => setKey(e.target.value)} /></label>
        <label className="block text-xs">Model IDs (one per line, or fetch after saving)<textarea className={input} value={draft.models.join("\n")} onChange={e => setDraft({ ...draft, models: e.target.value.split("\n") })} /></label>
        <div className="flex gap-2"><button type="submit" disabled={!!busy} className="rounded-lg bg-accent text-accent-fg px-3 py-1 text-sm disabled:opacity-40">Save provider</button><Button disabled={!!busy} onClick={() => { setDraft(null); setKey(""); }}>Cancel</Button></div>
      </form>}
    </Section>
    <Section title="ChatGPT subscription" note="Optional, unofficial integration using Codex OAuth, as used by pi and OpenCode. Availability depends on your account and OpenAI; API keys are separate.">
      <Row label={config.chatgpt.signedIn ? "Signed in to ChatGPT" : "Connect ChatGPT"} hint={config.chatgpt.signedIn ? `${config.chatgpt.models.length} models available` : "Sign-in opens in your browser."}>
        {config.chatgpt.signedIn ? <div className="flex gap-2"><Button small disabled={!!busy} onClick={() => run("Refreshing models", () => invoke("chatgpt_models"))}>Refresh models</Button><Button small disabled={!!busy} onClick={() => run("Signing out", () => invoke("chatgpt_logout"))}>Sign out</Button></div>
          : <Button small disabled={!!busy} onClick={() => run("Waiting for browser sign-in", () => invoke("chatgpt_login"))}>Sign in</Button>}
      </Row>
    </Section>
    <Section title="Local privacy filter" note="PII-Tracer runs in a separate CPU helper, leaving the GPU for your main model. Detection can miss sensitive content; use Local only for records that must stay on this PC.">
      <Row label={gate?.installed ? "Privacy filter installed" : "Download privacy filter"} hint="About 1.25 GB, plus a CPU runtime. Downloads only when you click Install.">
        {!gate?.installed && <Button small disabled={!!busy} onClick={() => run("Installing privacy filter", () => invoke("gate_install"))}>Install privacy filter</Button>}
      </Row>
      <ToggleRow label="Check cloud requests for personal data" hint="Sensitive chats stay local. Other detected personal details are replaced with placeholders. If checking fails, nothing goes to cloud." checked={config.privacyGate === "on"} disabled={!!busy || !gate?.installed} onChange={on => save("privacyGate", on ? "on" : "off")} />
      {gate?.installed && <div className="p-3.5 space-y-2"><label className="block text-xs">Try the filter locally<textarea className={input} value={sample} onChange={e => { setSample(e.target.value); setResult(null); }} /></label>
        <Button small disabled={!!busy || !sample.trim()} onClick={() => run("Checking sample locally", async () => setResult(await invoke("gate_test", { text: sample })))}>Test locally</Button>
        {result && <div className="text-xs select-text whitespace-pre-wrap break-words">Sensitivity: {(result.sensitivity * 100).toFixed(0)}%{"\n"}{result.masked}</div>}
      </div>}
    </Section>
    <Message error={!!error}>{error || [busy, progress].filter(Boolean).join(" · ")}</Message>
  </>;
}
