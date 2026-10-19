import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Globe, Maximize2, X } from "lucide-react";

type Frame = { file: string; t: number; url: string; title: string };

const host = (u: string) => { try { return new URL(u).host; } catch { return u; } };
const ago = (t: number) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : new Date(t).toLocaleTimeString(); };

/** Frames the browser tool saved for this chat. `tick` changes after each tool result; the screenshot is taken
 *  in the background right after, so look again shortly after the tick as well. */
export function useBrowserFrames(id: string, tick: number) {
  const [frames, setFrames] = useState<Frame[]>([]);
  const [urls, setUrls] = useState<Record<string, string>>({});
  const cache = useRef<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    async function pull() {
      try {
        const list = await invoke<Frame[]>("browser_frames", { id });
        for (const f of list) {
          if (cache.current[f.file]) continue;
          const buf = await invoke<ArrayBuffer>("browser_frame", { id, file: f.file });
          cache.current[f.file] = URL.createObjectURL(new Blob([buf], { type: "image/jpeg" }));
        }
        for (const k of Object.keys(cache.current)) if (!list.some(f => f.file === k)) { URL.revokeObjectURL(cache.current[k]); delete cache.current[k]; }
        if (active) { setFrames(list.filter(f => cache.current[f.file])); setUrls({ ...cache.current }); }
      } catch { /* no frames yet */ }
    }
    pull();
    const later = [setTimeout(pull, 700), setTimeout(pull, 2500)];
    return () => { active = false; later.forEach(clearTimeout); };
  }, [id, tick]);

  useEffect(() => () => { Object.values(cache.current).forEach(URL.revokeObjectURL); cache.current = {}; }, [id]);
  return { frames, urls };
}

/** The browser's latest page while the assistant uses it. It never covers the conversation: in a wide window
 *  it sits in the empty margin beside the composer, otherwise it is a slim strip above the composer.
 *  The `@container` that decides this is the composer area in App. */
export function BrowserPeek({ id, tick, onOpen }: { id: string; tick: number; onOpen: () => void }) {
  const { frames, urls } = useBrowserFrames(id, tick);
  const [since] = useState(Date.now());
  const [hidden, setHidden] = useState(0);
  const last = frames[frames.length - 1];
  if (!last || last.t < since || last.t <= hidden) return null;
  const name = last.title || host(last.url);
  return (
    <div data-testid="browser-peek" className="mb-2 flex items-center gap-2.5 rounded-xl border border-line bg-card p-1.5 pr-2.5 text-xs shadow-sm animate-[rise_.2s_ease-out]
      @min-[80rem]:absolute @min-[80rem]:left-full @min-[80rem]:bottom-0 @min-[80rem]:mb-0 @min-[80rem]:ml-4 @min-[80rem]:w-56 @min-[80rem]:flex-col @min-[80rem]:items-stretch @min-[80rem]:gap-0 @min-[80rem]:overflow-hidden @min-[80rem]:p-0 @min-[80rem]:pr-0 @min-[80rem]:shadow-lg">
      <button onClick={onOpen} title="Open the live browser view" className="block shrink-0">
        <img src={urls[last.file]} alt={`Browser: ${name}`} className="w-20 aspect-video rounded-md object-cover object-top bg-panel @min-[80rem]:w-full @min-[80rem]:rounded-none" />
      </button>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-muted @min-[80rem]:px-2 @min-[80rem]:py-1 @min-[80rem]:text-[11px]">
        <span className="h-1.5 w-1.5 rounded-full bg-green-500 shrink-0" />
        <span className="truncate flex-1" title={last.url}><span className="@min-[80rem]:hidden">Browsing · </span>{name}</span>
        <button onClick={onOpen} title="Expand" aria-label="Expand browser view" className="p-1 hover:text-ink"><Maximize2 size={12} /></button>
        <button onClick={() => setHidden(last.t)} title="Hide until the next page" aria-label="Hide browser preview" className="p-1 hover:text-ink"><X size={12} /></button>
      </div>
    </div>
  );
}

/** Full view for the Files panel: current page, address, and a strip of recent steps. */
export default function BrowserLive({ id, tick }: { id: string; tick: number }) {
  const { frames, urls } = useBrowserFrames(id, tick);
  const [pick, setPick] = useState<string | null>(null);
  useEffect(() => { setPick(null); }, [frames.length && frames[frames.length - 1].file]);
  if (!frames.length) return <div className="p-8 text-center text-muted"><Globe size={30} className="mx-auto mb-3" /><p className="text-sm">No browser activity in this chat yet.</p><p className="text-xs mt-2">When the assistant browses the web, each page it visits shows up here.</p></div>;
  const cur = frames.find(f => f.file === pick) ?? frames[frames.length - 1];
  return (
    <div data-testid="browser-live" className="flex flex-col gap-2 h-full">
      <div className="flex items-center gap-2 rounded-lg border border-line bg-card px-2.5 py-1.5 text-xs">
        <Globe size={13} className="text-muted shrink-0" />
        <span className="truncate flex-1" title={cur.url}>{cur.url || "about:blank"}</span>
        <span className="text-muted shrink-0">{cur === frames[frames.length - 1] ? "Latest · " : ""}{ago(cur.t)}</span>
      </div>
      <img src={urls[cur.file]} alt={cur.title || cur.url} className="w-full rounded-lg border border-line bg-panel" />
      {cur.title && <div className="text-sm truncate">{cur.title}</div>}
      <div className="flex gap-1.5 overflow-x-auto pb-1" role="listbox" aria-label="Recent browser steps">
        {[...frames].reverse().map(f => (
          <button key={f.file} role="option" aria-selected={f === cur} onClick={() => setPick(f.file)} title={`${f.title || f.url} · ${ago(f.t)}`}
            className={"shrink-0 w-24 rounded-md overflow-hidden border-2 " + (f === cur ? "border-accent" : "border-transparent hover:border-line")}>
            <img src={urls[f.file]} alt="" className="w-full aspect-video object-cover object-top bg-panel" />
          </button>
        ))}
      </div>
    </div>
  );
}
