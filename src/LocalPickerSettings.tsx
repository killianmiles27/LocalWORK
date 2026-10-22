import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button, Message, Section } from "./settings-ui";
import { groupLocalModels, type Mode } from "./modelPicker";
import { cloudChanged } from "./cloud-ui";
export default function LocalPickerSettings() {
  const [modes, setModes] = useState<Mode[]>([]), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const load = () => invoke<{ modes: Mode[] }>("modes_list").then(r => setModes(r.modes));
  useEffect(() => { load().catch(e => setError(String(e))); }, []);
  async function save(configs: string[] | null) {
    setBusy(true); setError("");
    try { await invoke("local_picker_set", { configs }); await load(); cloudChanged(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  return <Section title="Local models in your picker" note="Only checked profiles appear in the chat picker. Hidden profiles stay saved and remain available for editing." action={<Button small disabled={busy} onClick={() => save(null)}>Show all</Button>}>
    <div className="max-h-64 overflow-auto p-3.5 space-y-3">{groupLocalModels(modes.map(m => ({ ...m, pickerVisible: true }))).map(model => <div key={model.id}><div className="text-sm font-medium mb-1">{model.label} <span className="text-xs text-muted">Local</span></div><div className="flex flex-wrap gap-x-4 gap-y-1">{model.profiles.map(m => <label key={m.id} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={m.pickerVisible !== false} disabled={busy} onChange={e => save(modes.filter(p => p.id === m.id ? e.target.checked : p.pickerVisible !== false).map(p => p.config))} />{m.profileLabel || m.label}</label>)}</div></div>)}{!modes.length && <p className="text-xs text-muted">No local profiles found.</p>}<Message error>{error}</Message></div>
  </Section>;
}
