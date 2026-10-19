// Sidebar date groups. Kept free of React so the Node tests can load it directly.
export type Dated = { updated: number; pinned?: boolean };

export const GROUPS = ["Pinned", "Today", "Yesterday", "Previous 7 days", "Previous 30 days", "Older"] as const;

const DAY = 86_400_000;

export function groupOf(c: Dated, now = Date.now()): (typeof GROUPS)[number] {
  if (c.pinned) return "Pinned";
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const start = today.getTime();
  if (c.updated >= start) return "Today";
  if (c.updated >= start - DAY) return "Yesterday";
  if (c.updated >= start - 7 * DAY) return "Previous 7 days";
  if (c.updated >= start - 30 * DAY) return "Previous 30 days";
  return "Older";
}

/** Chats split into labelled groups in display order; empty groups are left out. */
export function groupChats<T extends Dated>(list: T[], now = Date.now()): { label: string; items: T[] }[] {
  const by = new Map<string, T[]>(GROUPS.map(g => [g, []]));
  for (const c of list) by.get(groupOf(c, now))!.push(c);
  return GROUPS.map(label => ({ label, items: by.get(label)! })).filter(g => g.items.length);
}
