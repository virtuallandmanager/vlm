#!/usr/bin/env python3
"""Regenerates hud-v.png, the white V of the Virvi symbol used by the in-world HUD launcher.

    python3 packages/dcl/assets/make-hud-v.py      (needs Pillow)

Geometry is the Virvi symbol (Branding/virvi-symbol-light-clean.svg): viewBox 0 0 1254 1254,
V = M 327 554.5 L 627 980 L 927 554.5, stroke-width 215, round caps and joins. The dot
(circle cx 627 cy 373 r 132) is left out: the HUD draws it as a live status indicator at the same
frame-relative position, so the PNG keeps the whole 1254 frame (scaled to 256x256), not a crop.
Rendered at 4x and downsampled for anti-aliasing; white RGB everywhere, coverage in alpha.
"""
import math
import os

from PIL import Image, ImageDraw

FRAME = 1254
SIZE = 256
SUPER = 4
POINTS = [(327, 554.5), (627, 980), (927, 554.5)]
STROKE = 215

big = SIZE * SUPER
k = big / FRAME
mask = Image.new('L', (big, big), 0)
d = ImageDraw.Draw(mask)
r = STROKE / 2 * k
pts = [(x * k, y * k) for x, y in POINTS]
for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
    # each segment as a rectangle of the stroke width ...
    a = math.atan2(y2 - y1, x2 - x1)
    nx, ny = -math.sin(a) * r, math.cos(a) * r
    d.polygon([(x1 + nx, y1 + ny), (x2 + nx, y2 + ny), (x2 - nx, y2 - ny), (x1 - nx, y1 - ny)], fill=255)
for x, y in pts:
    # ... and a disc at every vertex: round caps at the ends, a round join in the middle
    d.ellipse([x - r, y - r, x + r, y + r], fill=255)

alpha = mask.resize((SIZE, SIZE), Image.LANCZOS)
out = Image.new('RGBA', (SIZE, SIZE), (255, 255, 255, 0))
out.putalpha(alpha)
dest = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'hud-v.png')
out.save(dest, optimize=True)
print(f'wrote {dest}')
