import { useEffect, useRef } from "react";
import mountainUrl from "./assets/mountain.jpg";

// Dithered-glyph mountain behind the app. Cheap by design:
//  - the static picture is painted once per resize/theme change onto a base canvas (no per-frame work);
//  - an overlay canvas only animates cursor glow and click ripples, touching just the cells near them;
//  - the animation loop stops entirely as soon as nothing is glowing, and while the window is hidden.
const CW = 5, CH = 7, HEX = "0123456789abcdef";
const BAYER = (() => {
  const b4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5], q = [0, 2, 3, 1], out: number[] = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) out[y * 8 + x] = (b4[(y & 3) * 4 + (x & 3)] * 4 + q[(y >> 2) * 2 + (x >> 2)]) / 64;
  return out;
})();
const tile = (x: number, y: number) => { const k = Math.sin(((x >> 3) * 127.1 + (y >> 3) * 311.7) * 43758.5453); return k - Math.floor(k); };
const thr = (x: number, y: number) => { let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263); h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
const glyph = (x: number, y: number) => { const k = Math.sin((x * 12.9898 + y * 78.233) * 43758.5453); return HEX[Math.floor((k - Math.floor(k)) * 16)]; };
const CASTLE_X = .18; // castle centre as a fraction of the photo width; kept on the left at every window size
const R = 85, RIPPLE_LIFE = 1.8, RIPPLE_BAND = 14, CAP = .34;

const IDLE_MS = 12000, DIM = .12, TYPING_DIM = .3;
export default function Mountain({ inChat, busy }: { inChat: boolean; busy: boolean }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const idle = useRef(false);
  const lastAct = useRef(performance.now());
  // Art is full on the empty start screen, calm during a chat, and drifts back in slowly when nothing is happening.
  useEffect(() => {
    const el = wrapRef.current!;
    let t = 0;
    const apply = () => {
      clearTimeout(t);
      const quiet = !busy && idle.current;
      if (quiet) { el.style.transition = "opacity 14s ease-in-out"; el.style.opacity = "1"; return; }
      el.style.transition = "opacity .5s ease-out";
      el.style.opacity = String(inChat || busy ? DIM : 1);
      if (!busy) t = window.setTimeout(() => { idle.current = true; apply(); }, IDLE_MS);
    };
    const act = (e: Event) => {
      if (e.type === "keydown") el.style.opacity = String(inChat ? DIM : TYPING_DIM);
      idle.current = false; lastAct.current = performance.now(); apply();
    };
    apply();
    const ev = ["keydown", "pointerdown", "wheel"] as const;
    ev.forEach(n => addEventListener(n, act, { passive: true }));
    return () => { clearTimeout(t); ev.forEach(n => removeEventListener(n, act)); };
  }, [inChat, busy]);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const glowRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const bc = baseRef.current!, gc = glowRef.current!;
    const bx = bc.getContext("2d")!, gx = gc.getContext("2d")!;
    const css = () => getComputedStyle(document.documentElement);
    const dark = matchMedia("(prefers-color-scheme: dark)");
    const reduce = matchMedia("(prefers-reduced-motion: reduce)");
    let dpr = 1, W = 0, H = 0, cols = 0, rows = 0, lum = new Float32Array(0), heat = new Float32Array(0);
    let img: ImageData | null = null, mouse: { x: number; y: number } | null = null, raf = 0, timer = 0, ink = "", base = .1, font = "";
    // bounding box (in cells) of cells that may still be glowing; empty when x0 > x1
    let bb = { x0: 1, y0: 1, x1: 0, y1: 0 };
    const ripples: { x: number; y: number; t: number }[] = [];

    function build() {
      dpr = Math.min(2, devicePixelRatio || 1);
      W = innerWidth; H = innerHeight;
      for (const g of [bx, gx]) { g.canvas.width = Math.round(W * dpr); g.canvas.height = Math.round(H * dpr); g.setTransform(dpr, 0, 0, dpr, 0, 0); }
      cols = Math.ceil(W / CW); rows = Math.ceil(H / CH);
      lum = new Float32Array(cols * rows); heat = new Float32Array(cols * rows);
      bb = { x0: 1, y0: 1, x1: 0, y1: 0 };
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
      for (let i = 0; i < lum.length; i++) { const l = lum[i]; lum[i] = Math.max(0, Math.min(1, (l - .5) * 1.5 + .5 + (l - bl[i]) * 2.6)); }
      paintBase();
    }

    // One static pass, no animation frames involved.
    function paintBase() {
      bx.clearRect(0, 0, W, H); bx.font = font; bx.textBaseline = "top"; bx.fillStyle = ink; bx.globalAlpha = Math.min(CAP, base);
      for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
        if (lum[y * cols + x] <= thr(x, y)) continue;
        bx.fillText(glyph(x, y), x * CW, y * CH);
      }
      bx.globalAlpha = 1;
    }

    function frame(t: number) {
      raf = 0;
      // Extend the box to cover this frame's sources, then only touch cells inside it.
      let { x0, y0, x1, y1 } = bb;
      const grow = (ax: number, ay: number, bx2: number, by2: number) => {
        ax = Math.max(0, ax); ay = Math.max(0, ay); bx2 = Math.min(cols - 1, bx2); by2 = Math.min(rows - 1, by2);
        if (x0 > x1) { x0 = ax; y0 = ay; x1 = bx2; y1 = by2; } else { x0 = Math.min(x0, ax); y0 = Math.min(y0, ay); x1 = Math.max(x1, bx2); y1 = Math.max(y1, by2); }
      };
      if (mouse) {
        const cx0 = Math.floor(mouse.x / CW), cy0 = Math.floor(mouse.y / CH), rx = Math.ceil(R / CW), ry = Math.ceil(R / CH);
        grow(cx0 - rx, cy0 - ry, cx0 + rx, cy0 + ry);
        for (let y = Math.max(0, cy0 - ry); y <= Math.min(rows - 1, cy0 + ry); y++) for (let x = Math.max(0, cx0 - rx); x <= Math.min(cols - 1, cx0 + rx); x++) {
          const d = Math.hypot((x + .5) * CW - mouse.x, (y + .5) * CH - mouse.y);
          if (d < R) { const h = 1 - d / R, i = y * cols + x; if (h * h * .5 > heat[i]) heat[i] = h * h * .5; }
        }
      }
      for (let i = ripples.length - 1; i >= 0; i--) {
        const p = ripples[i], age = (t - p.t) / 1000;
        if (age > RIPPLE_LIFE) { ripples.splice(i, 1); continue; }
        const rad = age * 170, amp = .28 * (1 - age / RIPPLE_LIFE), ext = rad + RIPPLE_BAND;
        const ax = Math.floor((p.x - ext) / CW), ay = Math.floor((p.y - ext) / CH), ex = Math.ceil((p.x + ext) / CW), ey = Math.ceil((p.y + ext) / CH);
        grow(ax, ay, ex, ey);
        for (let y = Math.max(0, ay); y <= Math.min(rows - 1, ey); y++) {
          const dy = (y + .5) * CH - p.y;
          for (let x = Math.max(0, ax); x <= Math.min(cols - 1, ex); x++) {
            const w = Math.abs(Math.hypot((x + .5) * CW - p.x, dy) - rad);
            if (w < RIPPLE_BAND) { const k = amp * (1 - w / RIPPLE_BAND), j = y * cols + x; if (k > heat[j]) heat[j] = k; }
          }
        }
      }
      if (x0 > x1) { gx.clearRect(0, 0, W, H); bb = { x0: 1, y0: 1, x1: 0, y1: 0 }; return; }

      gx.clearRect(x0 * CW, y0 * CH, (x1 - x0 + 1) * CW + CW, (y1 - y0 + 1) * CH + CH);
      gx.font = font; gx.textBaseline = "top"; gx.fillStyle = ink;
      let nx0 = 1e9, ny0 = 1e9, nx1 = -1, ny1 = -1;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const i = y * cols + x, hv = heat[i];
        if (hv <= 0) continue;
        const nh = hv * .92 < .01 ? 0 : hv * .92; heat[i] = nh;
        if (nh > 0) { if (x < nx0) nx0 = x; if (x > nx1) nx1 = x; if (y < ny0) ny0 = y; if (y > ny1) ny1 = y; }
        if (lum[i] + hv * .3 <= thr(x, y)) continue;
        // overlay alpha chosen so base + overlay composite to the target brightness
        const target = Math.min(CAP, base + hv * .45);
        gx.globalAlpha = 1 - (1 - target) / (1 - Math.min(CAP, base));
        gx.fillText(glyph(x, y), x * CW, y * CH);
      }
      gx.globalAlpha = 1;
      bb = nx1 < 0 ? { x0: 1, y0: 1, x1: 0, y1: 0 } : { x0: nx0, y0: ny0, x1: nx1, y1: ny1 };
      // Keep going only while something is glowing or the cursor / a ripple is a source.
      if (nx1 >= 0 || mouse || ripples.length) raf = requestAnimationFrame(frame);
    }
    const wake = () => { if (!raf && !reduce.matches && !document.hidden && img) raf = requestAnimationFrame(frame); };

    const rebuild = () => { clearTimeout(timer); timer = window.setTimeout(() => { if (img) build(); }, 150); };

    const im = new Image();
    im.onload = () => {
      const c = document.createElement("canvas"); c.width = im.width; c.height = im.height;
      const g = c.getContext("2d")!; g.drawImage(im, 0, 0); img = g.getImageData(0, 0, c.width, c.height);
      build();
    };
    im.src = mountainUrl;

    const onMove = (e: MouseEvent | PointerEvent) => { mouse = { x: e.clientX, y: e.clientY }; wake(); };
    const onLeave = () => { mouse = null; wake(); };
    const onClick = (e: MouseEvent) => { ripples.push({ x: e.clientX, y: e.clientY, t: performance.now() }); wake(); };
    const onVis = () => { if (document.hidden) { cancelAnimationFrame(raf); raf = 0; mouse = null; ripples.length = 0; heat.fill(0); bb = { x0: 1, y0: 1, x1: 0, y1: 0 }; gx.clearRect(0, 0, W, H); } };
    
    addEventListener("click", onClick, { passive: true }); addEventListener("resize", rebuild);
    document.addEventListener("visibilitychange", onVis); addEventListener("blur", onLeave);
    dark.addEventListener("change", rebuild);
    return () => {
      cancelAnimationFrame(raf); clearTimeout(timer);
      
      removeEventListener("click", onClick); removeEventListener("resize", rebuild);
      document.removeEventListener("visibilitychange", onVis); removeEventListener("blur", onLeave);
      dark.removeEventListener("change", rebuild);
    };
  }, []);
  const cls = "absolute inset-0 w-full h-full";
  return <div ref={wrapRef} aria-hidden="true" className="fixed inset-0 pointer-events-none z-0" style={{ opacity: 1 }}><canvas ref={baseRef} className={cls} /><canvas ref={glowRef} className={cls} /></div>;
}
