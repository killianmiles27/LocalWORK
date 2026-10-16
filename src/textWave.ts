// Very slight wave through message text while the cursor moves. Runs only while the pointer is moving
// (decays in ~0.6s), touches transforms of visible block elements only, and is off under reduced motion.
const SEL = ".prose :is(p, li, h1, h2, h3, h4, blockquote)";
export function startTextWave() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return () => {};
  let px = 0, py = 0, energy = 0, raf = 0, last = 0;
  let els: HTMLElement[] = [];
  const reset = () => { for (const e of els) e.style.transform = ""; els = []; };
  const frame = (t: number) => {
    raf = 0;
    energy *= 0.94;
    if (energy < 0.02) { reset(); return; }
    reset();
    els = Array.from(document.querySelectorAll<HTMLElement>(SEL));
    for (const e of els) {
      const r = e.getBoundingClientRect();
      if (r.bottom < 0 || r.top > innerHeight) continue;
      const dx = Math.max(r.left - px, 0, px - r.right), dy = py - (r.top + r.height / 2);
      const d = Math.hypot(dx, dy);
      if (d > 300) continue;
      const k = (1 - d / 300) * energy;
      e.style.transform = `translateY(${(Math.sin(d / 34 - t / 200) * 1.6 * k).toFixed(2)}px)`;
    }
    raf = requestAnimationFrame(frame);
  };
  const move = (e: PointerEvent) => {
    if (e.timeStamp - last < 16) return; last = e.timeStamp;
    px = e.clientX; py = e.clientY; energy = 1;
    if (!raf && !document.hidden) raf = requestAnimationFrame(frame);
  };
  addEventListener("pointermove", move, { passive: true });
  return () => { removeEventListener("pointermove", move); cancelAnimationFrame(raf); reset(); };
}
