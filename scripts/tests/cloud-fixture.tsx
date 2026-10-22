import { createRoot } from "react-dom/client";
import CloudSettings from "../../src/CloudSettings";
import ModeSwitcher from "../../src/ModeSwitcher";
import "../../src/index.css";

let config = { routing: "auto", cloudDefault: null, privacyGate: "on", cloudVisibleModels: {} as Record<string, string[]>, providers: [] as any[], chatgpt: { signedIn: true, models: ["gpt-6-luna", "gpt-6.1-sol", "gpt-6-astra"], visibleModels: null as string[] | null } };
let selected: string | null = null;
let locked = false;
let gateInstalled = false;
const calls: { cmd: string; args: any }[] = [];
(window as any).calls = calls;
const listeners = new Map<number, (event: any) => void>();
let callbackId = 0;
(window as any).emitTauri = (name: string, payload: unknown) => {
  for (const [id, cb] of listeners) if ((window as any).eventNames?.[id] === name) cb({ event: name, id, payload });
};
(window as any).eventNames = {};
(window as any).finishGateInstall = (error?: string) => (window as any).gateInstallFinish?.(error);
(window as any).__TAURI_INTERNALS__ = {
  transformCallback: (cb: (event: any) => void) => { const id = ++callbackId; listeners.set(id, cb); return id; },
  invoke: async (cmd: string, args: any = {}) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "cloud_get": return structuredClone(config);
      case "gate_status": return { installed: gateInstalled, running: false };
      case "route_mode_set": config.routing = args.mode; return;
      case "cloud_set":
        (config as any)[args.key] = args.value;
        if (args.key === "cloudVisibleModels") {
          config.cloudVisibleModels = args.value;
          for (const [id, ids] of Object.entries(args.value as Record<string, string[]>)) {
            if (id === "chatgpt") config.chatgpt.visibleModels = ids;
            else { const provider = config.providers.find(p => p.id === id); if (provider) provider.visibleModels = ids; }
          }
        }
        return;
      case "cloud_provider_save": config.providers = [{ ...args.provider, id: "test", hasKey: true }]; return;
      case "cloud_models": config.providers[0].models = ["model-a"]; return ["model-a"];
      case "chat_route_get": return { routing: config.routing, model: selected, locked };
      case "chat_route_set": selected = args.model; return;
      case "gate_test": return { masked: "Hello [PERSON_1]", sensitivity: 0.2 };
      case "route_last_sent": return { sent: { messages: [{ content: "Hello [PERSON_1]" }] } };
      case "chat_unlock": locked = false; return;
      case "modes_list": return { modes: [], effort: { effort: "medium", config: "medium", override: null, options: ["none", "low", "medium", "high"] } };
      case "chatgpt_models": return config.chatgpt.models;
      case "gate_install":
        queueMicrotask(() => (window as any).emitTauri("download-progress", { id: "gate-install", done: 0, total: null, state: "downloading", stage: "downloading", message: "Downloading privacy filter…" }));
        return new Promise((resolve, reject) => { (window as any).gateInstallFinish = (error?: string) => error ? reject(new Error(error)) : (gateInstalled = true, resolve(undefined)); });
      default:
        if (cmd.startsWith("plugin:event|listen")) { const id = args.handler; (window as any).eventNames[id] = args.event; return; }
        if (cmd.startsWith("plugin:event|unlisten")) { listeners.delete(args.eventId); return; }
        throw new Error(`Unexpected IPC ${cmd}`);
    }
  },
};
createRoot(document.getElementById("root")!).render(<main className="bg-bg text-ink p-5 max-w-2xl space-y-6"><CloudSettings /><div className="w-80"><ModeSwitcher ready state="ready" onKey={() => {}} onError={e => { throw new Error(e); }} conv="fixture" ensureConversation={async () => "fixture"} running={false} /></div></main>);
