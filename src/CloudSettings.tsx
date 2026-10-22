import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Button, input, Message, Row, Section, ToggleRow } from "./settings-ui";
import { cloudChanged, cloudChoices, type CloudConfig, type Provider } from "./cloud-ui";
import DownloadProgress, { type DownloadState } from "./DownloadProgress";

export default function CloudSettings() {
  const [config, setConfig] = useState<CloudConfig | null>(null);
  const [gate, setGate] = useState<{ installed: boolean; running: boolean } | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<DownloadState | null>(null);
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
    const sub = listen<DownloadState>("download-progress", e => {
      if (e.payload.id.startsWith("gate-")) setProgress(e.payload);
    });
    return () => { sub.then(f => f()); };
  }, []);
  async function run(label: string, task: () => Promise<unknown>) {
    setBusy(label); setError(""); setProgress(null);
    try { await task(); await load(); cloudChanged(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(""); }
  }
  const save = (key: string, value: unknown) => run("Saving", () => invoke("cloud_set", { key, value }));
  function visible(id: string, models: string[]) {
    if (!config) return;
    const catalogs = new Map([...config.providers.map(p => [p.id, p.models] as const), ["chatgpt", config.chatgpt.models] as const]);
    const value = Object.fromEntries(Object.entries(config.cloudVisibleModels ?? {}).map(([key, ids]) => [key, ids.filter(m => catalogs.get(key)?.includes(m))]));
    value[id] = models;
    run("Saving model choices", async () => {
      await invoke("cloud_set", { key: "cloudVisibleModels", value });
      const prefix = `cloud:${id}:`;
      if (config.cloudDefault?.startsWith(prefix) && !models.includes(config.cloudDefault.slice(prefix.length))) await invoke("cloud_set", { key: "cloudDefault", value: null });
    });
  }
  if (!config) return <Message error={!!error}>{error || "Loading cloud settings…"}</Message>;
  const choices = cloudChoices(config);
  return <>
    <Section title="Where replies run" note="Local only is the default. Offline mode and privacy locks always keep a chat local.">
      <Row label="Routing">
        <select aria-label="Routing" className={input} disabled={!!busy} value={config.routing} onChange={e => run("Saving", () => invoke("route_mode_set", { mode: e.target.value }))}>
          <option value="local">Local only</option><option value="manual">Manual</option><option value="auto" disabled={!gate?.installed || config.privacyGate !== "on"}>Automatic</option>
        </select>
      </Row>
      {config.routing === "auto" && <Row label="Automatic can escalate to" hint="Choose from the cloud models shown in your picker.">
        <select aria-label="Automatic escalation model" className={input} disabled={!!busy} value={config.cloudDefault ?? ""} onChange={e => save("cloudDefault", e.target.value || null)}>
          <option value="">Choose a cloud model</option>{choices.map(c => <option key={c.value} value={c.value}>{c.provider} · {c.label}</option>)}
        </select>
      </Row>}
      <p className="px-3.5 py-2.5 text-xs text-muted">Automatic requires the privacy filter below. It currently escalates when the local model is unavailable, the context is nearly full, or a tool error repeats. It does not yet judge task difficulty. In Manual mode with the filter off, cloud choices send the full conversation and tool results.</p>
    </Section>
    <Section title="Cloud providers" action={<Button small disabled={!!busy} onClick={() => { setDraft({ id: "", name: "", baseUrl: "", models: [] }); setKey(""); }}>Add provider</Button>} note="Use an OpenAI-compatible API base URL, including /v1 where required. Keys are stored in Windows Credential Manager.">
      {!config.providers.length && <p className="px-3.5 py-3 text-sm text-muted">No API providers connected.</p>}
      {config.providers.map(p => <Row key={p.id} label={p.name} hint={`${p.baseUrl} · ${p.models.length} models`}>
        <div className="flex gap-1"><Button small disabled={!!busy} onClick={() => run("Fetching models", () => invoke("cloud_models", { id: p.id }))}>Fetch models</Button>
          <Button small disabled={!!busy} onClick={() => { setDraft(p); setKey(""); }}>Edit</Button>
          <Button small variant="danger" disabled={!!busy} onClick={() => run("Removing", () => invoke("cloud_provider_remove", { id: p.id }))}>Remove</Button></div>
      </Row>)}
      {config.providers.map(p => <div key={`models:${p.id}`} className="p-3.5"><ModelSelection label={`${p.name} models`} models={p.models} selected={p.visibleModels} disabled={!!busy} onChange={ids => visible(p.id, ids)} /></div>)}
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
      {config.chatgpt.signedIn && <div className="p-3.5"><ModelSelection label="ChatGPT models" models={config.chatgpt.models} selected={config.chatgpt.visibleModels} disabled={!!busy} onChange={ids => visible("chatgpt", ids)} /></div>}
    </Section>
    <Section title="Local privacy filter" note="PII-Tracer runs in a separate CPU helper, leaving the GPU for your main model. Detection can miss sensitive content; use Local only for records that must stay on this PC.">
      <Row label={gate?.installed ? "Privacy filter installed" : "Download privacy filter"} hint="About 1.25 GB, plus a CPU runtime. Downloads only when you click Install.">
        {!gate?.installed && <Button small disabled={!!busy} onClick={() => run("Installing privacy filter", () => invoke("gate_install"))}>Install privacy filter</Button>}
      </Row>
      {busy === "Installing privacy filter" && <div className="px-3.5 py-3"><DownloadProgress label="Installing privacy filter" progress={progress} /></div>}
      <ToggleRow label="Check cloud requests for personal data" hint="Sensitive chats stay local. Other detected personal details are replaced with placeholders. If checking fails, nothing goes to cloud." checked={config.privacyGate === "on"} disabled={!!busy || !gate?.installed} onChange={on => save("privacyGate", on ? "on" : "off")} />
      {gate?.installed && <div className="p-3.5 space-y-2"><label className="block text-xs">Try the filter locally<textarea className={input} value={sample} onChange={e => { setSample(e.target.value); setResult(null); }} /></label>
        <Button small disabled={!!busy || !sample.trim()} onClick={() => run("Checking sample locally", async () => setResult(await invoke("gate_test", { text: sample })))}>Test locally</Button>
        {result && <div className="text-xs select-text whitespace-pre-wrap break-words">Sensitivity: {(result.sensitivity * 100).toFixed(0)}%{"\n"}{result.masked}</div>}
      </div>}
    </Section>
    <Message error={!!error}>{error || (busy !== "Installing privacy filter" ? busy : "")}</Message>
  </>;
}

function ModelSelection({ label, models, selected, disabled, onChange }: { label: string; models: string[]; selected?: string[] | null; disabled: boolean; onChange: (ids: string[]) => void }) {
  const [search, setSearch] = useState("");
  const chosen = selected == null ? models : selected.filter(id => models.includes(id));
  return <details className="rounded-lg border border-line min-w-0">
    <summary className="px-3 py-2 cursor-pointer text-sm" aria-label={`Choose ${label}`}>{label} <span className="text-xs text-muted">· {chosen.length} shown in picker</span></summary>
    <div className="border-t border-line p-2 space-y-2">
      {!models.length ? <p className="text-xs text-muted">No models loaded. Refresh the model list above.</p> : <>
        <input aria-label={`Search ${label}`} className={input} placeholder="Search models" value={search} onChange={e => setSearch(e.target.value)} />
        <div className="flex gap-2"><Button small disabled={disabled} onClick={() => onChange(models)}>Show all</Button><Button small disabled={disabled} onClick={() => onChange([])}>Hide all</Button></div>
        <div role="group" aria-label={`${label} in picker`} className="max-h-52 overflow-auto space-y-0.5">{models.filter(m => m.toLowerCase().includes(search.toLowerCase())).map(m => <label key={m} className="flex items-center gap-2 py-1 px-1 text-xs min-w-0"><input type="checkbox" disabled={disabled} checked={chosen.includes(m)} onChange={e => onChange(e.target.checked ? [...chosen, m] : chosen.filter(id => id !== m))} /><span className="break-all">{m}</span></label>)}</div>
      </>}
    </div>
  </details>;
}
