// Offline adaptation of OpenIntelligentUI's apps/mcp/src/renderer.ts.
// Upstream MIT license and pinned provenance: vendor/open-intelligent-ui/.
import { THEME_CSS, SVG_CLASSES_CSS, FORM_STYLES_CSS } from "./vendor/open-intelligent-ui/design-system";
import { UI_RUNTIME_CSS, UI_RUNTIME_JS } from "./ui-runtime";
import license from "./vendor/open-intelligent-ui/LICENSE?raw";

export const FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

const BRIDGE_JS = `
window.sendPrompt = function(text) {
  if (typeof text === 'string' && text.trim() && text.length <= 4000)
    parent.postMessage({type:'send-prompt', text:text.trim()}, '*');
};
document.addEventListener('click', function(e) {
  var a = e.target.closest && e.target.closest('a[href]');
  if (!a || a.getAttribute('href').startsWith('#')) return;
  e.preventDefault();
  if (/^https?:/i.test(a.href) && a.href.length <= 2000) parent.postMessage({type:'open-url', url:a.href}, '*');
}, true);
document.addEventListener('submit', function(e) { e.preventDefault(); }, true);
function reportHeight() {
  parent.postMessage({type:'widget-resize', height:document.documentElement.scrollHeight}, '*');
}
new ResizeObserver(reportHeight).observe(document.body);
window.addEventListener('load', reportHeight);
`;

/** Wrap an agent-generated body with the actual upstream theme and form/SVG styles. */
export function assembleDocument(html: string): string {
  return `<!DOCTYPE html><!-- Open Intelligent UI, adapted for LocalWORK.\n${license}\n--><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">
<style>${THEME_CSS}\n${SVG_CLASSES_CSS}\n${FORM_STYLES_CSS}\nhtml, body { background:var(--color-background-primary); }\n#content { padding:16px; overflow-wrap:anywhere; }</style></head>
<body><div id="content">${html}</div><script>${BRIDGE_JS}</script></body></html>`;
}

/** Body fragment for a render_ui spec: runtime CSS, mount point and the interpreter script. */
export function specFragment(spec: unknown, state?: unknown): string {
  if (typeof spec === "string") { try { spec = JSON.parse(spec); } catch { /* shown as text */ } }
  const esc = (c: string) => "\\" + "u" + c.charCodeAt(0).toString(16).padStart(4, "0"); // keeps "<" and line separators out of the script text
  const data = JSON.stringify({ spec: spec ?? null, state: state ?? {} }).replace(new RegExp("[<" + String.fromCharCode(0x2028, 0x2029) + "]", "g"), esc);
  return `<style>${UI_RUNTIME_CSS}</style><div id="app"></div><script>${UI_RUNTIME_JS}\n(function(){var d=${data};LW.mount(d.spec,d.state,document.getElementById('app'),document)})();</script>`;
}

export function assembleSpec(title: string, spec: unknown, state?: unknown): string {
  return assembleDocument(specFragment(spec, state)).replace("<html>", `<html><!-- ${String(title).replace(/-->|--/g, "-").slice(0, 120)} -->`);
}

/** Office exports are untrusted. Never inject their markup into the application DOM. */
export function previewDocument(html: string): string {
  return `<!DOCTYPE html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">${html}`;
}

export function frameMessage(data: unknown): { text?: string; height?: number; url?: string } | null {
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  if (m.type === "send-prompt" && typeof m.text === "string" && m.text.trim() && m.text.length <= 4000)
    return { text: m.text.trim() };
  if (m.type === "open-url" && typeof m.url === "string" && m.url.length <= 2000) {
    try { const u = new URL(m.url); if (u.protocol === "https:" || u.protocol === "http:") return { url: u.href }; } catch { /* not a URL */ }
    return null;
  }
  if (m.type === "widget-resize" && typeof m.height === "number" && Number.isFinite(m.height))
    return { height: Math.min(800, Math.max(240, m.height)) };
  return null;
}
