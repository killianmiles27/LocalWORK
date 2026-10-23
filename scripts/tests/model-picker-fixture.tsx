import { createRoot } from "react-dom/client";
import ModeSwitcher from "../../src/ModeSwitcher";
import "../../src/index.css";

const modes = [
  { id: "swift-q2-128", modelId: "swift-q2", modelLabel: "Swift Q2", profileLabel: "128K", label: "swift-q2-128", config: "swift-128.json", context: 131072, found: true, active: true, pickerVisible: true },
  { id: "swift-q2-256", modelId: "swift-q2", modelLabel: "Swift Q2", profileLabel: "256K", label: "swift-q2-256", config: "swift-256.json", context: 262144, found: true, active: false, pickerVisible: true },
  { id: "gemma-128", modelId: "gemma-4", modelLabel: "Gemma 4", profileLabel: "128K", label: "gemma-128", config: "gemma-128.json", context: 131072, found: true, active: false, pickerVisible: true },
  { id: "gemma-256", modelId: "gemma-4", modelLabel: "Gemma 4", profileLabel: "256K", label: "gemma-256", config: "gemma-256.json", context: 262144, found: true, active: false, pickerVisible: true },
  { id: "swift-iq2-xs", modelId: "swift-iq2", modelLabel: "Swift IQ2 XS (older)", profileLabel: "128K", label: "swift-iq2-xs", config: "old.json", context: 131072, found: true, active: false, pickerVisible: false },
];
const calls: { cmd: string; args: any }[] = [];
const listeners = new Map<number, (event: any) => void>();
let callbackId = 0;
(window as any).calls = calls;
(window as any).__TAURI_INTERNALS__ = {
  transformCallback: (cb: (event: any) => void) => { const id = ++callbackId; listeners.set(id, cb); return id; },
  invoke: async (cmd: string, args: any = {}) => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "modes_list": return { modes, effort: { effort: "medium", config: "medium", override: null, options: ["none", "low", "medium", "high"] } };
      case "mode_switch": return;
      case "plugin:event|listen": return args.handler;
      case "plugin:event|unlisten": listeners.delete(args.eventId); return;
      default: throw new Error(`Unexpected IPC ${cmd}`);
    }
  },
};

createRoot(document.getElementById("root")!).render(<main className="bg-bg text-ink"><div style={{ position: "fixed", left: "min(600px, 48vw)", bottom: 32 }}><ModeSwitcher ready state="ready" onKey={() => {}} onError={e => { throw new Error(e); }} running={false} /></div></main>);
