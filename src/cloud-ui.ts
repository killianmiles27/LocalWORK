export type Provider = { id: string; name: string; baseUrl: string; models: string[]; hasKey?: boolean };
export type CloudConfig = {
  routing: "local" | "manual" | "auto"; cloudDefault: string | null; privacyGate: string;
  providers: Provider[]; chatgpt: { signedIn: boolean; email?: string; models: string[] };
};
export function cloudChoices(c: CloudConfig) {
  return [
    ...c.providers.flatMap(p => p.models.map(m => ({ value: `cloud:${p.id}:${m}`, label: `${p.name} · ${m}` }))),
    ...(c.chatgpt.signedIn ? c.chatgpt.models.map(m => ({ value: `cloud:chatgpt:${m}`, label: `ChatGPT · ${m}` })) : []),
  ];
}
export const cloudChanged = () => window.dispatchEvent(new Event("cloud-changed"));
