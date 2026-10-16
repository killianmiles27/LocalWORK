import { useEffect, useRef } from "react";
import mountainUrl from "./assets/mountain.jpg";

// Dithered-glyph mountain behind the app: nearly invisible at rest, brighter under the cursor, soft ripple on click.
const CW = 5, CH = 7, HEX = "0123456789abcdef";
const BAYER = (() => {
  const b4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5], q = [0, 2, 3, 1], out: number[] = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) out[y * 8 + x] = (b4[(y & 3) * 4 + (x & 3)] * 4 + q[(y >> 2) * 2 + (x >> 2)]) / 64;
  return out;
})();
const glyph = (x: number, y: number) => { const k = Math.sin((x * 12.9898 + y * 78.233) * 43758.5453); return HEX[Math.floor((k - Math.floor(k)) * 16)]; };

export default function Mountain() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current!, cx = cv.getContext("2d")!;
    const css = () => getComputedStyle(document.documentElement);
    const dark = matchMedia("(prefers-color-scheme: dark)");
    const reduce = matchMedia("(prefers-reduced-motion: reduce)");
    let W = 0, H = 0, cols = 0, rows = 0, lum = new Float32Array(0), heat = new Float32Array(0);
    let img: ImageData | null = null, mouse: { x: number; y: number } | null = null, raf = 0, timer = 0, ink = "", base = .1;
    const ripples: { x: number; y: number; t: number }[] = [];

    function build() {
      const dpr = Math.min(2, devicePixelRatio || 1);
      W = innerWidth; H = innerHeight;
      cv.width = W * dpr; cv.height = H * dpr; cx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(W / CW); rows = Math.ceil(H / CH);
      lum = new Float32Array(cols * rows); heat = new Float32Array(cols * rows);
      ink = css().getPropertyValue("--color-mountain").trim() || "#3a47c4";
      base = parseFloat(css().getPropertyValue("--mountain-base")) || .1;
      if (!img) return;
      const iw = img.width, ih = img.height, sc = Math.max(W / iw, H / ih), ox = (iw * sc - W) / 2, oy = (ih * sc - H) / 2, dk = dark.matches;
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const px = Math.min(iw - 1, Math.floor(((x + .5) * CW + ox) / sc)), py = Math.min(ih - 1, Math.floor(((y + .5) * CH + oy) / sc));
        let l = img.data[(py * iw + px) * 4] / 255; l = dk ? l : 1 - l; lum[y * cols + x] = Math.pow(l, 1.15);
      }
      // box-blur high-pass so ridges and the castle read as shapes, not a blob
      const rr = 7, tmp = new Float32Array(cols * rows), bl = new Float32Array(cols * rows);
      for (let y = 0; y < rows; y++) { let a = 0, n = 0; for (let x = -rr; x < cols + rr; x++) { const xi = x + rr < cols ? x + rr : -1, xo = x - rr - 1; if (xi >= 0) { a += lum[y * cols + xi]; n++; } if (xo >= 0) { a -= lum[y * cols + xo]; n--; } if (x >= 0 && x < cols) tmp[y * cols + x] = a / n; } }
      const rv = Math.round(rr * CW / CH);
      for (let x = 0; x < cols; x++) { let a = 0, n = 0; for (let y = -rv; y < rows + rv; y++) { const yi = y + rv < rows ? y + rv : -1, yo = y - rv - 1; if (yi >= 0) { a += tmp[yi * cols + x]; n++; } if (yo >= 0) { a -= tmp[yo * cols + x]; n--; } if (y >= 0 && y < rows) bl[y * cols + x] = a / n; } }
      for (let i = 0; i < lum.length; i++) { const l = lum[i]; lum[i] = Math.max(0, Math.min(1, (l - .5) * 1.5 + .5 + (l - bl[i]) * 2.6)); }
    }

    function frame(t: number) {
      cx.clearRect(0, 0, W, H); cx.font = "8px " + (css().getPropertyValue("--font-sans").trim() || "sans-serif"); cx.textBaseline = "top"; cx.fillStyle = ink;
      const R = 85;
      if (mouse) {
        const cx0 = Math.floor(mouse.x / CW), cy0 = Math.floor(mouse.y / CH), rx = Math.ceil(R / CW), ry = Math.ceil(R / CH);
        for (let y = Math.max(0, cy0 - ry); y < Math.min(rows, cy0 + ry); y++) for (let x = Math.max(0, cx0 - rx); x < Math.min(cols, cx0 + rx); x++) {
          const d = Math.hypot((x + .5) * CW - mouse.x, (y + .5) * CH - mouse.y);
          if (d < R) { const h = 1 - d / R, i = y * cols + x; heat[i] = Math.max(heat[i], h * h * .5); }
        }
      }
      for (let i = ripples.length - 1; i >= 0; i--) {
        const p = ripples[i], age = (t - p.t) / 1000;
        if (age > 1.8) { ripples.splice(i, 1); continue; }
        const rad = age * 170, amp = .28 * (1 - age / 1.8);
        for (let y = 0; y < rows; y++) {
          const dy = (y + .5) * CH - p.y; if (Math.abs(dy) > rad + 14) continue;
          for (let x = 0; x < cols; x++) {
            const dx = (x + .5) * CW - p.x, w = Math.abs(Math.hypot(dx, dy) - rad);
            if (w < 14) { const k = amp * (1 - w / 14), j = y * cols + x; if (k > heat[j]) heat[j] = k; }
          }
        }
      }
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        const i = y * cols + x, hv = heat[i];
        if (hv > 0) heat[i] = hv * .92 < .01 ? 0 : hv * .92;
        if (lum[i] <= BAYER[(y & 7) * 8 + (x & 7)]) continue;
        cx.globalAlpha = Math.min(.34, base + hv * .45);
        cx.fillText(glyph(x, y), x * CW, y * CH);
      }
      cx.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    }

    // With reduced motion: draw one still frame, no cursor or ripple animation.
    const still = () => { cancelAnimationFrame(raf); frame(0); cancelAnimationFrame(raf); };
    const start = () => { cancelAnimationFrame(raf); if (reduce.matches) still(); else raf = requestAnimationFrame(frame); };
    const rebuild = () => { clearTimeout(timer); timer = window.setTimeout(() => { build(); start(); }, 120); };

    const im = new Image();
    im.onload = () => {
      const c = document.createElement("canvas"); c.width = im.width; c.height = im.height;
      const g = c.getContext("2d")!; g.drawImage(im, 0, 0); img = g.getImageData(0, 0, c.width, c.height);
      build(); start();
    };
    im.src = mountainUrl;

    const onMove = (e: MouseEvent) => { if (!reduce.matches) mouse = { x: e.clientX, y: e.clientY }; };
    const onLeave = () => { mouse = null; };
    const onClick = (e: MouseEvent) => { if (!reduce.matches) ripples.push({ x: e.clientX, y: e.clientY, t: performance.now() }); };
    const onVis = () => { if (document.hidden) cancelAnimationFrame(raf); else start(); };
    addEventListener("mousemove", onMove); document.addEventListener("mouseleave", onLeave);
    addEventListener("click", onClick); addEventListener("resize", rebuild);
    document.addEventListener("visibilitychange", onVis);
    dark.addEventListener("change", rebuild); reduce.addEventListener("change", rebuild);
    return () => {
      cancelAnimationFrame(raf); clearTimeout(timer);
      removeEventListener("mousemove", onMove); document.removeEventListener("mouseleave", onLeave);
      removeEventListener("click", onClick); removeEventListener("resize", rebuild);
      document.removeEventListener("visibilitychange", onVis);
      dark.removeEventListener("change", rebuild); reduce.removeEventListener("change", rebuild);
    };
  }, []);
  return <canvas ref={ref} aria-hidden="true" className="fixed inset-0 w-full h-full pointer-events-none z-0" />;
}
