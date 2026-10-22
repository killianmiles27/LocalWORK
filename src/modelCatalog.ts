// Model list for the Model library: a small built-in fallback (used before PolyStrata is installed, or offline)
// and the code that turns the engine's own catalog (`engine_catalog`) into the same shape.

export type Hw = { ram_gib?: number; disk_free_gib?: number; gpu?: { name?: string; vram_gib?: number } | null };

export type CatalogModel = {
  family: string; familyTitle: string; id: string; label: string; about?: string;
  sizeGb?: number; ramGb?: number; vramGb?: number; context: number; hf?: string; poly: boolean; preview?: boolean;
};

export type Fit = "good" | "tight" | "big" | "unknown";

export const FIT_LABEL: Record<Fit, string> = { good: "Fits well", tight: "Tight", big: "Too big", unknown: "Size unknown" };
export const FIT_STYLE: Record<Fit, string> = {
  good: "bg-emerald-500/15 text-emerald-600", tight: "bg-amber-500/15 text-amber-600",
  big: "bg-red-500/15 text-red-500", unknown: "bg-panel-2 text-muted",
};

/** Compare what a model needs with this PC: system RAM (the engine streams experts from it), VRAM and free disk. */
export function fitOf(m: CatalogModel, hw: Hw | null): Fit {
  if (!hw?.ram_gib || m.ramGb == null) return "unknown";
  if (m.sizeGb != null && hw.disk_free_gib != null && m.sizeGb > hw.disk_free_gib) return "big";
  if (m.ramGb > hw.ram_gib) return "big";
  const vramShort = m.vramGb != null && (hw.gpu?.vram_gib ?? 0) < m.vramGb;
  return m.ramGb > hw.ram_gib - 4 || vramShort ? "tight" : "good";
}

// Built-in fallback: sizes as listed by PolyStrata for the LFM2.5 family. The engine's own list replaces this.
const lfm = (id: string, sizeGb: number, ramGb: number): CatalogModel => ({
  family: "lfm25", familyTitle: "LFM2.5", id, label: id, sizeGb, ramGb, context: 32768, poly: true,
  about: "Runs on the PolyStrata engine.",
});
export const STATIC_MODELS: CatalogModel[] = [
  lfm("UD-Q3_K_XL", 10.9, 16), lfm("QAD-Q4_0", 13.6, 18), lfm("UD-Q4_K_XL", 14.9, 20), lfm("UD-Q6_K_XL", 21.9, 27), lfm("Q8_0", 25.5, 31),
];

type Raw = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
/** PolyStrata currently reports Hugging Face URLs (often pinned to a commit), not owner/repository slugs. */
function hfRepo(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return;
  const repo = s.match(/^(?:https?:\/\/)?(?:www\.)?huggingface\.co\/([\w.-]+\/[\w.-]+)(?:\/|$)/i)?.[1] ?? s;
  return /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : undefined;
}

/** `engine_catalog().families` -> flat model list. The engine's field names are read defensively. */
export function normalizeCatalog(families: unknown): CatalogModel[] {
  const out: CatalogModel[] = [];
  for (const f of Array.isArray(families) ? (families as Raw[]) : []) {
    const fam = (f.family ?? {}) as Raw;
    for (const m of (Array.isArray(f.models) ? f.models : []) as Raw[]) {
      const repo = hfRepo(m.hf) ?? hfRepo(m.repo) ?? hfRepo(fam.hf) ?? hfRepo(fam.repo);
      out.push({
        family: String(f.id), familyTitle: str(fam.title) ?? String(f.id), id: String(m.id), label: String(m.id),
        about: str(m.about) ?? str(fam.about), sizeGb: num(m.download_gb) ?? num(m.size_gb),
        ramGb: num(m.ram_gb), vramGb: num(m.vram_gb), context: 32768,
        hf: repo, poly: !!f.poly, preview: !!f.preview || !!fam.experimental,
      });
    }
  }
  return out;
}
