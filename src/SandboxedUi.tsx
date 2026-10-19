import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { assembleDocument, frameMessage, previewDocument } from "./intelligent-ui";

type Props = { html: string; title: string; designSystem?: boolean; expanded?: boolean; onDraft?: (text: string) => void };

export default function SandboxedUi({ html, title, designSystem = false, expanded = false, onDraft }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(360);
  const [suggestion, setSuggestion] = useState("");
  // Links inside a frame open in the system browser, but only after the user confirms here:
  // the frame's own script could post the same message without any click.
  const [link, setLink] = useState("");
  const doc = useMemo(() => designSystem ? assembleDocument(html) : previewDocument(html), [html, designSystem]);
  useEffect(() => { setSuggestion(""); setLink(""); setHeight(360); }, [doc]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      // Opaque frames have origin "null". Source identity, never the reported origin, binds the bridge.
      if (event.source !== frame.current?.contentWindow) return;
      const message = frameMessage(event.data);
      if (message?.height) setHeight(message.height);
      if (message?.text && designSystem) setSuggestion(message.text);
      if (message?.url) setLink(message.url);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [designSystem]);
  return (
    <div className={expanded ? "flex flex-col h-full min-h-0" : "min-w-0"}>
      <iframe ref={frame} title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={doc}
        className={"w-full border-0 rounded-lg " + (expanded ? `flex-1 min-h-0 ${designSystem ? "bg-card" : "bg-white"}` : "bg-transparent")}
        style={expanded ? undefined : { height }} />
      {link && (
        <div role="dialog" aria-label="Open link" className="m-2 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-line bg-panel p-3 text-sm">
          <span className="min-w-0 flex-1 break-all">Open <span className="font-medium">{new URL(link).host}</span>?<span className="block text-xs text-muted">{link.length > 160 ? link.slice(0, 160) + "…" : link}</span></span>
          <button onClick={() => { invoke("open_external", { url: link }).catch(() => {}); setLink(""); }} className="text-accent hover:underline">Open in browser</button>
          <button onClick={() => setLink("")} className="text-muted hover:underline">Cancel</button>
        </div>
      )}
      {suggestion && onDraft && (
        <div className="m-2 rounded-lg border border-line bg-panel p-3 text-sm">
          <p className="text-xs text-muted mb-1">Suggested follow-up</p>
          <p className="whitespace-pre-wrap break-words max-h-28 overflow-auto">{suggestion}</p>
          <button onClick={() => { onDraft(suggestion); setSuggestion(""); }} className="mt-2 text-accent hover:underline">Add to my message</button>
          <button onClick={() => setSuggestion("")} className="ml-4 text-muted hover:underline">Dismiss</button>
        </div>
      )}
    </div>
  );
}
