export type Mode = { id: string; label: string; description?: string; config: string; context: number | null; found: boolean; active: boolean; modelId?: string; modelLabel?: string; profileLabel?: string; pickerVisible?: boolean };
export function groupLocalModels(modes: Mode[]) {
  const groups = new Map<string, { id: string; label: string; profiles: Mode[] }>();
  for (const mode of modes) {
    if (mode.pickerVisible === false) continue;
    const id = mode.modelId || mode.id;
    const label = (mode.modelLabel || mode.label).replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    const group = groups.get(id) || { id, label, profiles: [] };
    if (group.profiles.some(p => p.config.replace(/\//g, "\\").toLowerCase() === mode.config.replace(/\//g, "\\").toLowerCase())) continue;
    group.profiles.push(mode); groups.set(id, group);
  }
  return [...groups.values()].map(m => ({ ...m, profiles: m.profiles.sort((a, b) => (a.context ?? 0) - (b.context ?? 0) || a.label.localeCompare(b.label)) }));
}
