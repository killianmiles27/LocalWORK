import { useEffect, useRef } from "react";
import mountainUrl from "./assets/mountain.jpg";

// Dithered-glyph mountain behind the app. Painted once per resize/theme change; no animation loop.
const CW = 5, CH = 7, HEX = "0123456789abcdef";
const thr = (x: number, y: number) => { let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const jx = (x: number, y: number) => ((Math.imul(x, 2246822519) ^ Math.imul(y, 3266489917)) >>> 0) % 5 - 2;
const jy = (x: number, y: number) => ((Math.imul(x, 3266489917) ^ Math.imul(y, 668265263)) >>> 0) % 5 - 2;
const glyph = (x: number, y: number) => HEX[(Math.imul(x ^ 0x9e37, 2654435761) ^ Math.imul(y ^ 0x85eb, 2246822519)) >>> 28];
const CASTLE_X = .18; // castle centre as a fraction of the photo width; kept on the left at every window size
const CAP = .4;

export default function Mountain() {
  const baseRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const bc = baseRef.current!;
    const bx = bc.getContext("2d")!;
    const css = () => getComputedStyle(document.documentElement);
    const dark = matchMedia("(prefers-color-scheme: dark)");
        let dpr = 1, W = 0, H = 0, cols = 0, rows = 0, lum = new Float32Array(0);
    let img: ImageData | null = null, timer = 0, ink = "", base = .1, font = "";

    function build() {
      dpr = Math.min(2, devicePixelRatio || 1);
      W = innerWidth; H = innerHeight;
      bc.width = Math.round(W * dpr); bc.height = Math.round(H * dpr); bx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(W / CW); rows = Math.ceil(H / CH);
      lum = new Float32Array(cols * rows);
      const st = css();
      ink = st.getPropertyValue("--color-mountain").trim() || "#3a47c4";
      base = parseFloat(st.getPropertyValue("--mountain-base")) || .1;
      font = "8px " + (st.getPropertyValue("--font-sans").trim() || "sans-serif");
      if (!img) return;
      const iw = img.width, ih = img.height, sc = Math.max(W / iw, H / ih), ox = Math.max(0, Math.min(iw * sc - W, CASTLE_X * iw * sc - Math.max(.18 * W, 320))), oy = (ih * sc - H) / 2, dk = dark.matches;
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const px = Math.min(iw - 1, Math.floor(((x + .5) * CW + ox) / sc)), py = Math.min(ih - 1, Math.floor(((y + .5) * CH + oy) / sc));
        let l = img.data[(py * iw + px) * 4] / 255; l = dk ? l : 1 - l; lum[y * cols + x] = Math.pow(l, 1.15);
      }
      // box-blur high-pass so ridges and the castle read as shapes, not a blob
      const rr = 7, tmp = new Float32Array(cols * rows), bl = new Float32Array(cols * rows);
      for (let y = 0; y < rows; y++) { let a = 0, n = 0; for (let x = -rr; x < cols + rr; x++) { const xi = x + rr < cols ? x + rr : -1, xo = x - rr - 1; if (xi >= 0) { a += lum[y * cols + xi]; n++; } if (xo >= 0) { a -= lum[y * cols + xo]; n--; } if (x >= 0 && x < cols) tmp[y * cols + x] = a / n; } }
      const rv = Math.round(rr * CW / CH);
      for (let x = 0; x < cols; x++) { let a = 0, n = 0; for (let y = -rv; y < rows + rv; y++) { const yi = y + rv < rows ? y + rv : -1, yo = y - rv - 1; if (yi >= 0) { a += tmp[yi * cols + x]; n++; } if (yo >= 0) { a -= tmp[yo * cols + x]; n--; } if (y >= 0 && y < rows) bl[y * cols + x] = a / n; } }
      for (let i = 0; i < lum.length; i++) { const l = lum[i]; lum[i] = Math.max(0, Math.min(1, (l - .5) * 1.8 + .5 + (l - bl[i]) * 3.2)); }
      paintBase();
    }

    function paintBase() {
      bx.clearRect(0, 0, W, H); bx.font = font; bx.textBaseline = "top"; bx.fillStyle = ink; bx.globalAlpha = Math.min(CAP, base);
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        if (lum[y * cols + x] <= thr(x, y)) continue;
        bx.fillText(glyph(x, y), x * CW + jx(x, y) * .5, y * CH + jy(x, y) * .6);
      }
      bx.globalAlpha = 1;
    }

    const rebuild = () => { clearTimeout(timer); timer = window.setTimeout(() => { if (img) build(); }, 150); };

    const im = new Image();
    im.onload = () => {
      const c = document.createElement("canvas"); c.width = im.width; c.height = im.height;
      const g = c.getContext("2d")!; g.drawImage(im, 0, 0); img = g.getImageData(0, 0, c.width, c.height);
      build();
    };
    im.src = mountainUrl;

    addEventListener("resize", rebuild);
    dark.addEventListener("change", rebuild);
    return () => { clearTimeout(timer); removeEventListener("resize", rebuild); dark.removeEventListener("change", rebuild); };
  }, []);
  const cls = "absolute inset-0 w-full h-full";
  return <div aria-hidden="true" className="fixed inset-0 pointer-events-none z-0"><canvas ref={baseRef} className={cls} /></div>;
}
