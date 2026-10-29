export type LineHunk = { oldStart: number; oldEnd: number; newStart: number; newEnd: number };
export type LineDiff = { before: string[]; after: string[]; hunks: LineHunk[]; coarse: boolean };
const lines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** Half-open line ranges. Tokens retain their terminators so an undo never normalizes CRLF or EOF. */
export function lineDiff(oldText: string, currentText: string): LineDiff {
  const before = lines(oldText), after = lines(currentText), hunks: LineHunk[] = [];
  let start = 0, oldEnd = before.length, newEnd = after.length;
  while (start < oldEnd && start < newEnd && before[start] === after[start]) start++;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
  const n = oldEnd - start, m = newEnd - start;
  // Bound both CPU and memory on large/repetitive documents. The coarse range is still exact to undo.
  const coarse = (n + 1) * (m + 1) > 2_000_000;
  if (coarse || !n || !m) {
    if (n || m) hunks.push({ oldStart: start, oldEnd, newStart: start, newEnd });
    return { before, after, hunks, coarse };
  }
  const width = m + 1, lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    lcs[i * width + j] = before[start + i] === after[start + j]
      ? 1 + lcs[(i + 1) * width + j + 1]
      : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
  }
  let i = 0, j = 0, hunk: LineHunk | undefined;
  const flush = () => { if (hunk) hunks.push(hunk); hunk = undefined; };
  while (i < n || j < m) {
    if (i < n && j < m && before[start + i] === after[start + j]) { flush(); i++; j++; continue; }
    hunk ??= { oldStart: start + i, oldEnd: start + i, newStart: start + j, newEnd: start + j };
    if (i < n && (j === m || lcs[(i + 1) * width + j] >= lcs[i * width + j + 1])) i++; else j++;
    hunk.oldEnd = start + i; hunk.newEnd = start + j;
  }
  flush();
  return { before, after, hunks, coarse };
}

export function undoHunk(diff: LineDiff, index: number): string {
  const h = diff.hunks[index];
  if (!h) throw Error("This change is no longer available; reload the comparison");
  return [...diff.after.slice(0, h.newStart), ...diff.before.slice(h.oldStart, h.oldEnd), ...diff.after.slice(h.newEnd)].join("");
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
/** Generated markup contains only escaped file text and our own fixed highlighting styles. */
export function linePreview(diff: LineDiff, side: "before" | "after"): string {
  const old = side === "before", changed = new Set<number>();
  for (const h of diff.hunks) for (let i = old ? h.oldStart : h.newStart; i < (old ? h.oldEnd : h.newEnd); i++) changed.add(i);
  return `<style>body{margin:0;font:13px monospace;color:#172033;background:#fff}pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}pre>span{display:block;min-height:1.4em;padding:0 8px}.added{background:#dcfce7}.removed{background:#fee2e2}.number{display:inline-block;width:4em;color:#64748b;user-select:none}</style><pre>${diff[side].map((line, i) => `<span${changed.has(i) ? ` class="${old ? "removed" : "added"}"` : ""}><small class="number">${i + 1}</small>${escapeHtml(line.replace(/\r?\n$/, ""))}</span>`).join("")}</pre>`;
}

type Change = { id: string; path: string } & ({ revision: string } | { diff: LineDiff; hunk: number });
type ChangeUi = { busy: (value: boolean) => void; error: (value: string) => void; saved: () => void };
/** One user mutation, with failure recovery independent of chat/model state. */
export async function applyDocumentChange(invoke: (command: string, args: Record<string, unknown>) => Promise<unknown>, change: Change, ui: ChangeUi): Promise<void> {
  ui.busy(true); ui.error("");
  try {
    const { id, path } = change;
    if ("revision" in change) await invoke("document_restore", { id, path, revision: change.revision });
    else await invoke("document_save", { id, path, content: undoHunk(change.diff, change.hunk), expected: change.diff.after.join("") });
    ui.saved();
  } catch (e) { ui.error(String(e)); }
  finally { ui.busy(false); }
}
