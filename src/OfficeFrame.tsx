// Word, PowerPoint and Excel previews with a small bridge for the file pane: highlight what changed since
// the last load, report text the user selects (for notes to the assistant) and, in edit mode, let the user
// change text in place. The frame stays sandboxed; every message is bound to this frame's window.
import { useEffect, useMemo, useRef } from "react";
import { previewDocument } from "./intelligent-ui";

export type FrameSelection = { text: string; node: string; rect: { top: number; left: number; bottom: number } };
type Props = {
  html: string; title: string; editing: boolean; previous?: Record<string, string>; scroll?: number;
  onTexts: (texts: Record<string, string>) => void; onScroll: (y: number) => void;
  onSelect: (s: FrameSelection | null) => void; onEdit: (node: string, before: string, after: string) => void;
};

const BRIDGE = `
(function(){
var editing = false, origin = null, timer = 0;
function post(m){ parent.postMessage(m, '*'); }
function leaves(){ return Array.prototype.filter.call(document.querySelectorAll('[data-path]'), function(e){ return e.tagName !== 'TH' && !e.querySelector('[data-path]'); }); }
function text(e){ return (e.innerText || '').replace(/\\u00a0/g, ' '); }
function report(){ var o = {}; leaves().forEach(function(e){ o[e.getAttribute('data-path')] = text(e); }); post({type:'lw-texts', texts:o}); }
if (document.readyState === 'complete') report(); else window.addEventListener('load', report);
window.addEventListener('message', function(ev){
  if (ev.source !== parent || !ev.data) return;
  var d = ev.data;
  if (d.type === 'lw-flash') {
    var first = null;
    (d.paths || []).forEach(function(p){ var e = document.querySelector('[data-path="' + CSS.escape(p) + '"]'); if (e) { e.classList.add('lw-changed'); first = first || e; } });
    if (first) first.scrollIntoView({block:'center'});
  }
  if (d.type === 'lw-scroll-to') window.scrollTo(0, d.y || 0);
  if (d.type === 'lw-edit-mode') {
    editing = !!d.on;
    leaves().forEach(function(e){ if (editing) e.setAttribute('contenteditable', 'plaintext-only'); else e.removeAttribute('contenteditable'); });
    document.documentElement.classList.toggle('lw-editing', editing);
  }
});
window.addEventListener('scroll', function(){ clearTimeout(timer); timer = setTimeout(function(){ post({type:'lw-scroll', y:window.scrollY}); }, 150); });
document.addEventListener('focusin', function(e){
  var t = e.target.closest && e.target.closest('[contenteditable]'); if (!t) return;
  var f = t.getAttribute('data-formula'); if (f) t.textContent = f;
  origin = text(t);
}, true);
document.addEventListener('focusout', function(e){
  var t = e.target.closest && e.target.closest('[contenteditable]'); if (!t || origin === null) return;
  var before = origin, after = text(t); origin = null;
  if (after !== before) post({type:'lw-edit', path:t.getAttribute('data-path'), before:before, after:after});
}, true);
window.addEventListener('keydown', function(e){
  if (!e.target.isContentEditable) return;
  e.stopImmediatePropagation();
  if (e.key === 'Escape') { if (origin !== null) e.target.textContent = origin; origin = null; e.target.blur(); }
  if (e.key === 'Enter' && (e.target.tagName === 'TD' || e.ctrlKey)) { e.preventDefault(); e.target.blur(); }
}, true);
document.addEventListener('mouseup', function(){
  setTimeout(function(){
    if (editing) return;
    var s = getSelection(), t = s ? String(s).replace(/\\s+/g, ' ').trim() : '';
    if (!t || !s.rangeCount) { post({type:'lw-select', text:''}); return; }
    var r = s.getRangeAt(0).getBoundingClientRect(), n = s.anchorNode && (s.anchorNode.nodeType === 1 ? s.anchorNode : s.anchorNode.parentElement);
    var host = n && n.closest('[data-path]');
    post({type:'lw-select', text:t.slice(0, 1000), path:host ? host.getAttribute('data-path') : '', rect:{top:r.top, left:r.left, bottom:r.bottom}});
  }, 0);
});
})();`;
const STYLE = `<style>
@keyframes lw-fade { from { background-color: rgba(250,204,21,.45); } to { background-color: transparent; } }
.lw-changed { animation: lw-fade 6s ease-out forwards; border-radius: 3px; }
.lw-editing [contenteditable] { cursor: text; }
.lw-editing [contenteditable]:hover { outline: 1px dashed #60a5fa; outline-offset: 1px; }
.lw-editing [contenteditable]:focus { outline: 2px solid #3b82f6; outline-offset: 1px; }
</style>`;

const short = (s: unknown, n: number) => typeof s === "string" ? s.slice(0, n) : "";

export default function OfficeFrame({ html, title, editing, previous, scroll, onTexts, onScroll, onSelect, onEdit }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const doc = useMemo(() => previewDocument(`${STYLE}${html}<script>${BRIDGE}</script>`), [html]);
  const latest = useRef({ editing, previous, scroll, onTexts, onScroll, onSelect, onEdit });
  latest.current = { editing, previous, scroll, onTexts, onScroll, onSelect, onEdit };
  useEffect(() => { frame.current?.contentWindow?.postMessage({ type: "lw-edit-mode", on: editing }, "*"); }, [editing]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const win = frame.current?.contentWindow;
      // Opaque frames have origin "null"; the source window, not the origin, binds the bridge.
      if (!win || event.source !== win || !event.data || typeof event.data !== "object") return;
      const m = event.data as Record<string, any>, h = latest.current;
      if (m.type === "lw-texts" && m.texts && typeof m.texts === "object") {
        const texts: Record<string, string> = {};
        for (const [k, v] of Object.entries(m.texts).slice(0, 20000)) if (typeof v === "string") texts[short(k, 300)] = v;
        const changed = h.previous ? Object.keys(texts).filter(k => texts[k].trim() && texts[k] !== h.previous![k]).slice(0, 200) : [];
        if (changed.length) win.postMessage({ type: "lw-flash", paths: changed }, "*");
        else if (h.scroll) win.postMessage({ type: "lw-scroll-to", y: h.scroll }, "*");
        if (h.editing) win.postMessage({ type: "lw-edit-mode", on: true }, "*");
        h.onTexts(texts);
      } else if (m.type === "lw-scroll" && Number.isFinite(m.y)) h.onScroll(m.y);
      else if (m.type === "lw-select") {
        const frameBox = frame.current!.getBoundingClientRect(), r = m.rect;
        h.onSelect(typeof m.text === "string" && m.text && r && [r.top, r.left, r.bottom].every(Number.isFinite)
          ? { text: short(m.text, 1000), node: short(m.path, 300), rect: { top: frameBox.top + r.top, left: frameBox.left + r.left, bottom: frameBox.top + r.bottom } }
          : null);
      } else if (m.type === "lw-edit" && h.editing && typeof m.path === "string" && m.path.startsWith("/") && typeof m.before === "string" && typeof m.after === "string")
        h.onEdit(short(m.path, 300), m.before, short(m.after, 65536));
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);
  return <iframe ref={frame} title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={doc} className="h-full w-full rounded-lg border-0 bg-white" />;
}

/** "slide 2", "paragraph 5" or "cell B3 (Sheet1)" for an OfficeCLI element path. */
export function describeNode(node: string): string {
  const slide = /\/slide\[(\d+)\]/.exec(node)?.[1];
  if (slide) return `slide ${slide}`;
  const para = /^\/body\/p\[(\d+)\]$/.exec(node)?.[1];
  if (para) return `paragraph ${para}`;
  const cell = /^\/([^/]+)\/([A-Z]+\d+)$/.exec(node);
  if (cell) return `cell ${cell[2]} (${cell[1]})`;
  return node.startsWith("/body/tbl") ? "a table" : "";
}
