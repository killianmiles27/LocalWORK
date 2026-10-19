// Shared Markdown renderer: GFM plus math. Math is rendered to native MathML by Temml, which loads
// only when a message actually contains math, so ordinary chats pay nothing for it.
import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
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

export default function Md({ children, components, embeds = false }: { children: string; components?: Components; embeds?: boolean }) {
  return <Markdown remarkPlugins={[remarkGfm, [remarkMath, { singleDollarTextMath: false }]]}
    components={{ ...mathComponents, ...(embeds ? embedComponents : {}), ...components }}>{normalizeMath(children)}</Markdown>;
}
