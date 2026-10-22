import { createRoot } from "react-dom/client";
import CloudSettings from "../../src/CloudSettings";
import ChatRouting from "../../src/ChatRouting";
import "../../src/index.css";

let config = { routing: "local", cloudDefault: null, privacyGate: "off", providers: [] as any[], chatgpt: { signedIn: false, models: [] } };
let selected: string | null = null;
let locked = false;
const calls: { cmd: string; args: any }[] = [];
(window as any).calls = calls;
(window as any).__TAURI_INTERNALS__ = {
  transformCallback: () => 1,
  invoke: async (cmd: string, args: any = {}) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "cloud_get": return structuredClone(config);
      case "gate_status": return { installed: true, running: false };
      case "route_mode_set": config.routing = args.mode; return;
      case "cloud_set": (config as any)[args.key] = args.value; return;
      case "cloud_provider_save": config.providers = [{ ...args.provider, id: "test", hasKey: true }]; return;
      case "cloud_models": config.providers[0].models = ["model-a"]; return ["model-a"];
      case "chat_route_get": return { routing: config.routing, model: selected, locked };
      case "chat_route_set": selected = args.model; return;
      case "gate_test": return { masked: "Hello [PERSON_1]", sensitivity: 0.2 };
      case "route_last_sent": return { sent: { messages: [{ content: "Hello [PERSON_1]" }] } };
      case "chat_unlock": locked = false; return;
      default: if (cmd.startsWith("plugin:event|")) return 1; throw new Error(`Unexpected IPC ${cmd}`);
    }
  },
};
createRoot(document.getElementById("root")!).render(<main className="bg-bg text-ink p-5 max-w-2xl space-y-6"><CloudSettings /><div className="w-80"><ChatRouting conv="fixture" ensureConversation={async () => "fixture"} disabled={false} onError={e => { throw new Error(e); }} /></div></main>);
