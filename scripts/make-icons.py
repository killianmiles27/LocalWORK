"""Draw the LocalWORK app icon (same geometry as src/Logo.tsx and public/icon.svg) and write
src-tauri/icons/icon.png (512) and icon.ico (16-256). Run with any Python that has Pillow."""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RIDGE = [(12, 50), (24, 33), (31, 41), (41, 24), (53, 50)]
STROKE = 6.5
INDIGO, EMBER, WHITE = (58, 71, 196, 255), (217, 102, 58, 255), (255, 255, 255, 255)


def draw(size):
    k = 8  # supersample, then downscale for clean edges
    s = size * k / 64.0  # geometry is on a 64-unit grid
    im = Image.new("RGBA", (size * k, size * k), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([2 * s, 2 * s, 62 * s, 62 * s], radius=14 * s, fill=INDIGO)
    # one ridge line with an ember beacon over the summit: calm, sturdy, local
    pts = [(x * s, y * s) for x, y in RIDGE]
    d.line(pts, fill=WHITE, width=round(STROKE * s), joint="curve")
    r = STROKE * s / 2
    for x, y in (pts[0], pts[-1]):  # round caps
        d.ellipse([x - r, y - r, x + r, y + r], fill=WHITE)
    d.ellipse([36.5 * s, 9.5 * s, 45.5 * s, 18.5 * s], fill=EMBER)
    return im.resize((size, size), Image.LANCZOS)


out = os.path.join(ROOT, "src-tauri", "icons")
draw(512).save(os.path.join(out, "icon.png"))
sizes = [16, 24, 32, 48, 64, 128, 256]
draw(256).save(os.path.join(out, "icon.ico"), sizes=[(n, n) for n in sizes])
print("wrote", out)
