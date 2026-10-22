export type Provider = { id: string; name: string; baseUrl: string; models: string[]; hasKey?: boolean; visibleModels?: string[] | null };
export type CloudConfig = {
  routing: "local" | "manual" | "auto"; cloudDefault: string | null; privacyGate: string;
  providers: Provider[]; chatgpt: { signedIn: boolean; email?: string; models: string[]; visibleModels?: string[] | null }; cloudVisibleModels?: Record<string, string[]>;
};
export function cloudChoices(c: CloudConfig) {
  return [
    ...c.providers.flatMap(p => p.models.filter(m => m.trim() && (p.visibleModels == null || p.visibleModels.includes(m))).map(m => ({ value: `cloud:${p.id}:${m}`, label: m, provider: p.name }))),
    ...(c.chatgpt.signedIn ? c.chatgpt.models.filter(m => m.trim() && (c.chatgpt.visibleModels == null || c.chatgpt.visibleModels.includes(m))).map(m => ({ value: `cloud:chatgpt:${m}`, label: m, provider: "ChatGPT" })) : []),
  ];
}
export const cloudChanged = () => window.dispatchEvent(new Event("cloud-changed"));
