import { touchedFile } from "./Workspace";

type Message = { role: string; body: any };

// Restrict signals to this turn and this workspace; never infer a write from assistant prose.
export function verificationPrompt(messages: Message[], workspace: string): string | null {
  let start = messages.length - 1;
  while (start >= 0 && messages[start].role !== "user") start--;
  if (start < 0 || !messages.slice(start + 1).some(m => m.role === "assistant" && String(m.body?.text ?? "").trim())) return null;
  const request = messages[start].body?.text;
  if (typeof request !== "string" || !request.trim() || !workspace) return null;
  const root = workspace.replaceAll("\\", "/").replace(/\/+$/, "");
  const windows = /^[a-z]:(?:\/|$)/i.test(root) || root.startsWith("//");
  const paths = new Set<string>();
  for (const m of messages.slice(start + 1)) {
    if (m.role !== "tool" || m.body?.status !== "success") continue;
    const tool = m.body?.request, name = String(tool?.name ?? "");
    let args = tool?.args;
    if (typeof args === "string") { try { args = JSON.parse(args); } catch { continue; } }
    args = args?.arguments ?? args;
    let path: unknown;
    if (/office_recipe$/i.test(name) && /^(document|table)$/i.test(String(args?.action ?? ""))) path = args?.target;
    else if (/officecli$/i.test(name) && /^(verify|read-ranges)$/i.test(String(args?.args?.[0] ?? ""))) continue;
    else path = touchedFile(name, args);
    if (typeof path !== "string" || !path.trim()) continue;
    let normalized = path.replaceAll("\\", "/");
    const absolute = normalized.startsWith("/") || /^[a-z]:\//i.test(normalized);
    if (absolute) {
      const cmp = windows ? normalized.toLowerCase() : normalized;
      const prefix = (windows ? root.toLowerCase() : root) + "/";
      if (!cmp.startsWith(prefix)) continue;
      normalized = normalized.slice(root.length + 1);
    }
    const parts = normalized.split("/").filter(p => p && p !== ".");
    if (!parts.length || parts.includes("..")) continue;
    paths.add(parts.join("/"));
  }
  if (!paths.size) return null;
  return `Check my work in a fresh second pass. Load the check-my-work skill.\n\nOriginal user request:\n${request.trim()}\n\nFiles produced or changed in the workspace:\n${[...paths].map(p => `- ${p}`).join("\n")}\n\nRe-read these files and the original sources, independently check them against the request, and report mismatches only plus a short list of what could not be verified. Do not modify deliverables; only change a file if the user explicitly asks in this new chat. If sources are unavailable or a file could not be read, say what is unverified and never claim the check passed.`;
}
