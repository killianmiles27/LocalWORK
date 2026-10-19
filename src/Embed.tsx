// Inline YouTube and OpenStreetMap embeds for links that stand alone on a line. Only these two hosts
// may be framed (tauri.conf.json frame-src); every other link stays a link.
import { invoke } from "@tauri-apps/api/core";
import { ExternalLink } from "lucide-react";

export type EmbedTarget = { kind: "video" | "map"; src: string; open: string; title: string };

const num = (v: string | null | undefined, min: number, max: number) => {
  const n = Number(v);
  return v != null && v !== "" && Number.isFinite(n) && n >= min && n <= max ? n : null;
};

export function embedFor(href: string): EmbedTarget | null {
  let u: URL;
  try { u = new URL(href); } catch { return null; }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.replace(/^(www|m|music)\./, "");
  let video: string | null = null;
  if (host === "youtu.be") video = u.pathname.slice(1).split("/")[0];
  else if (host === "youtube.com" || host === "youtube-nocookie.com")
    video = u.pathname === "/watch" ? u.searchParams.get("v") : /^\/(embed|shorts|live)\/([^/]+)/.exec(u.pathname)?.[2] ?? null;
  if (video && /^[\w-]{11}$/.test(video)) {
    const t = num(u.searchParams.get("t")?.replace(/s$/, "") ?? u.searchParams.get("start"), 0, 86400);
    return { kind: "video", src: `https://www.youtube-nocookie.com/embed/${video}${t ? `?start=${Math.floor(t)}` : ""}`, open: `https://www.youtube.com/watch?v=${video}`, title: "YouTube video" };
  }
  if (host === "openstreetmap.org") {
    const m = /^#map=(\d{1,2})\/(-?[\d.]+)\/(-?[\d.]+)/.exec(u.hash);
    const lat = num(u.searchParams.get("mlat") ?? m?.[2], -85, 85), lon = num(u.searchParams.get("mlon") ?? m?.[3], -180, 180);
    if (lat == null || lon == null) return null;
    const zoom = Math.min(18, Math.max(2, num(m?.[1], 0, 19) ?? 13));
    const dLon = 360 / 2 ** zoom * 1.5, dLat = dLon * 0.55 * Math.cos(lat * Math.PI / 180);
    const bbox = [lon - dLon, lat - dLat, lon + dLon, lat + dLat].map(x => x.toFixed(5)).join(",");
    const marker = u.searchParams.has("mlat") ? `&marker=${lat},${lon}` : "";
    return { kind: "map", src: `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik${marker}`, open: u.href, title: "Map" };
  }
  return null;
}

export default function Embed({ e }: { e: EmbedTarget }) {
  return (
    <figure className="not-prose my-3 overflow-hidden rounded-xl border border-line bg-card">
      <iframe src={e.src} title={e.title} loading="lazy" referrerPolicy="strict-origin-when-cross-origin"
        sandbox="allow-scripts allow-same-origin allow-presentation" allow="fullscreen; encrypted-media; picture-in-picture" allowFullScreen
        className={"block w-full border-0 " + (e.kind === "video" ? "aspect-video" : "h-80")} />
      <figcaption className="flex items-center justify-between px-3 py-1.5 text-xs text-muted">
        <span>{e.kind === "video" ? "YouTube · privacy-enhanced mode" : "© OpenStreetMap contributors"}</span>
        <button onClick={() => invoke("open_external", { url: e.open })} className="inline-flex items-center gap-1 hover:text-ink"><ExternalLink size={12} />Open</button>
      </figcaption>
    </figure>
  );
}
