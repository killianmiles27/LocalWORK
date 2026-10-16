// Offline adaptation of OpenIntelligentUI's apps/mcp/src/renderer.ts.
// Upstream MIT license and pinned provenance: vendor/open-intelligent-ui/.
import { THEME_CSS, SVG_CLASSES_CSS, FORM_STYLES_CSS } from "./vendor/open-intelligent-ui/design-system";
import license from "./vendor/open-intelligent-ui/LICENSE?raw";

export const FRAME_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";

const BRIDGE_JS = `
window.sendPrompt = function(text) {
  if (typeof text === 'string' && text.trim() && text.length <= 4000)
    parent.postMessage({type:'send-prompt', text:text.trim()}, '*');
};
document.addEventListener('click', function(e) {
  var a = e.target.closest && e.target.closest('a[href]');
  if (a && !a.getAttribute('href').startsWith('#')) e.preventDefault();
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

/** Office exports are untrusted. Never inject their markup into the application DOM. */
export function previewDocument(html: string): string {
  return `<!DOCTYPE html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">${html}`;
}

export function frameMessage(data: unknown): { text?: string; height?: number } | null {
  if (!data || typeof data !== "object") return null;
  const m = data as Record<string, unknown>;
  if (m.type === "send-prompt" && typeof m.text === "string" && m.text.trim() && m.text.length <= 4000)
    return { text: m.text.trim() };
  if (m.type === "widget-resize" && typeof m.height === "number" && Number.isFinite(m.height))
    return { height: Math.min(800, Math.max(240, m.height)) };
  return null;
}
