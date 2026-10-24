#!/usr/bin/env python3
"""Test registration markers for the Vision Pro / iPhone detection-range check (spike, not the real generator).

Layout follows docs/superpowers/specs/2026-10-21-ar-spaces-design.md (branch feature/ar-spaces-design):
QR code (version 2, error correction M) of HTTPS://VLM.GG/S/<CODE>, a 2-module quiet zone, then a 2-module
border ring of black and white blocks taken from SHA-256(code), solid in the corners. The ring's outer square is
the tracked image: 33 modules across, 120 mm or 170 mm wide.

Writes, per marker, into the output folder:
  <code>-reference.png   the tracked image only, for the apps' image tracking (exactly the printed square)
  <code>-paper.pdf       a US Letter page with the marker at exact size and a 100 mm check bar
  <code>-base.stl        the light plaque, 4.0 mm thick
  <code>-raised.stl      the dark parts (code, ring, rim), 0.6 mm on top of the base; same origin as the base
  <code>.3mf             both parts as one object with two colours, for multicolour printers

Usage: python3 tools/make_markers.py [out_dir]   (default: markers/)
"""
import hashlib
import struct
import sys
import zipfile
from pathlib import Path

import qrcode
from PIL import Image, ImageDraw, ImageFont

MARKERS = [  # code, tracked width (mm), plaque margin (mm): every plaque stays within 180 mm
    ("TEST12", 120.0, 15.0),
    ("TEST17", 170.0, 4.0),
]
QUIET = 2  # modules
RING = 2  # modules
BASE_MM = 4.0
RAISED_MM = 0.6
RIM_MM = 2.0
DPI = 600


def qr_matrix(code: str) -> list[list[bool]]:
    q = qrcode.QRCode(version=2, error_correction=qrcode.constants.ERROR_CORRECT_M, border=0)
    q.add_data(f"HTTPS://VLM.GG/S/{code}", optimize=0)
    q.make(fit=False)
    return q.get_matrix()


def marker_grid(code: str) -> list[list[bool]]:
    """True = dark. The QR in the middle, the quiet zone, then the hashed ring (corners solid)."""
    qr = qr_matrix(code)
    n = len(qr) + 2 * (QUIET + RING)
    grid = [[False] * n for _ in range(n)]
    off = QUIET + RING
    for y, row in enumerate(qr):
        for x, v in enumerate(row):
            grid[off + y][off + x] = v
    bits = "".join(f"{b:08b}" for b in hashlib.sha256(code.encode()).digest())
    i = 0
    for y in range(n):
        for x in range(n):
            if RING <= x < n - RING and RING <= y < n - RING:
                continue
            corner = (x < RING or x >= n - RING) and (y < RING or y >= n - RING)
            grid[y][x] = corner or bits[i % len(bits)] == "1"
            i += 1
    return grid


def reference_png(grid, path: Path, px: int = 32) -> None:
    n = len(grid)
    img = Image.new("L", (n * px, n * px), 255)
    d = ImageDraw.Draw(img)
    for y in range(n):
        for x in range(n):
            if grid[y][x]:
                d.rectangle([x * px, y * px, (x + 1) * px - 1, (y + 1) * px - 1], fill=0)
    img.save(path)


def font(size: int):
    for f in ("/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/SFNS.ttf"):
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            pass
    return ImageFont.load_default()


def paper_pdf(grid, code: str, width_mm: float, path: Path) -> None:
    mm = lambda v: round(v / 25.4 * DPI)
    page = Image.new("L", (mm(215.9), mm(279.4)), 255)
    d = ImageDraw.Draw(page)
    n = len(grid)
    left, top = (mm(215.9) - mm(width_mm)) // 2, mm(30)
    for y in range(n):
        for x in range(n):
            if grid[y][x]:
                x0 = left + mm(x * width_mm / n)
                y0 = top + mm(y * width_mm / n)
                d.rectangle([x0, y0, left + mm((x + 1) * width_mm / n) - 1, top + mm((y + 1) * width_mm / n) - 1], fill=0)
    big, small = font(mm(5)), font(mm(3.5))
    d.text((mm(15), mm(12)), f"VLM marker test {code} - {width_mm:.0f} mm", font=big, fill=0)
    y = top + mm(width_mm) + mm(12)
    d.text((mm(15), y), "Print at 100% / Actual size (no 'fit to page'). The bar below must measure 100 mm;", font=small, fill=0)
    d.text((mm(15), y + mm(5)), f"if it doesn't, the marker isn't {width_mm:.0f} mm and the test distances will be off.", font=small, fill=0)
    bar_y = y + mm(14)
    d.rectangle([mm(15), bar_y, mm(115) - 1, bar_y + mm(3)], fill=0)
    for t in range(0, 101, 10):
        d.rectangle([mm(15 + t) - (2 if t else 0), bar_y - mm(2), mm(15 + t) + 1, bar_y], fill=0)
    d.text((mm(118), bar_y - mm(1)), "100 mm", font=small, fill=0)
    d.text((mm(15), bar_y + mm(8)), "Glue to stiff card, keep it flat, and mount at eye level (about 1.5 m). Matte paper is best.", font=small, fill=0)
    page.save(path, "PDF", resolution=DPI)


# ── meshes (millimetres, plaque centred on the origin, z up from the plaque's back) ──────────────────────────


class Mesh:
    def __init__(self):
        self.verts: list[tuple[float, float, float]] = []
        self.index: dict[tuple[float, float, float], int] = {}
        self.tris: list[tuple[int, int, int]] = []

    def v(self, p):
        p = tuple(round(c, 4) for c in p)
        if p not in self.index:
            self.index[p] = len(self.verts)
            self.verts.append(p)
        return self.index[p]

    def quad(self, a, b, c, d):  # counter-clockwise seen from outside
        ia, ib, ic, id_ = (self.v(p) for p in (a, b, c, d))
        self.tris += [(ia, ib, ic), (ia, ic, id_)]

    def box(self, x0, y0, x1, y1, z0, z1):
        self.quad((x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1))
        self.quad((x0, y0, z0), (x0, y1, z0), (x1, y1, z0), (x1, y0, z0))
        self.quad((x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1))
        self.quad((x1, y1, z0), (x0, y1, z0), (x0, y1, z1), (x1, y1, z1))
        self.quad((x0, y1, z0), (x0, y0, z0), (x0, y0, z1), (x0, y1, z1))
        self.quad((x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1))

    def grid(self, cells, x0, y0, step, z0, z1):
        """Extrudes dark cells of a boolean grid (row 0 at the top, +y up) as one surface with walls only on edges."""
        n = len(cells)
        dark = lambda gx, gy: 0 <= gx < n and 0 <= gy < n and cells[gy][gx]
        for gy in range(n):
            for gx in range(n):
                if not dark(gx, gy):
                    continue
                xa, xb = x0 + gx * step, x0 + (gx + 1) * step
                ya, yb = y0 - (gy + 1) * step, y0 - gy * step
                self.quad((xa, ya, z1), (xb, ya, z1), (xb, yb, z1), (xa, yb, z1))
                self.quad((xa, ya, z0), (xa, yb, z0), (xb, yb, z0), (xb, ya, z0))
                if not dark(gx, gy + 1):  # below in the image = -y
                    self.quad((xa, ya, z0), (xb, ya, z0), (xb, ya, z1), (xa, ya, z1))
                if not dark(gx, gy - 1):
                    self.quad((xb, yb, z0), (xa, yb, z0), (xa, yb, z1), (xb, yb, z1))
                if not dark(gx - 1, gy):
                    self.quad((xa, yb, z0), (xa, ya, z0), (xa, ya, z1), (xa, yb, z1))
                if not dark(gx + 1, gy):
                    self.quad((xb, ya, z0), (xb, yb, z0), (xb, yb, z1), (xb, ya, z1))

    def frame(self, outer, inner, z0, z1):
        """A square ring: outer and inner half-widths."""
        o, i = outer, inner
        for (ax, ay), (bx, by) in [((-o, -o), (o, -o)), ((o, -o), (o, o)), ((o, o), (-o, o)), ((-o, o), (-o, -o))]:
            cx, cy = (ax / o * i, ay / o * i), (bx / o * i, by / o * i)
            self.quad((ax, ay, z1), (bx, by, z1), (cy[0], cy[1], z1), (cx[0], cx[1], z1))  # top
            self.quad((ax, ay, z0), (cx[0], cx[1], z0), (cy[0], cy[1], z0), (bx, by, z0))  # bottom
            self.quad((ax, ay, z0), (bx, by, z0), (bx, by, z1), (ax, ay, z1))  # outer wall
            self.quad((cy[0], cy[1], z0), (cx[0], cx[1], z0), (cx[0], cx[1], z1), (cy[0], cy[1], z1))  # inner wall


def write_stl(mesh: Mesh, path: Path, name: str) -> None:
    with open(path, "wb") as f:
        f.write(name.encode()[:80].ljust(80, b" "))
        f.write(struct.pack("<I", len(mesh.tris)))
        for a, b, c in mesh.tris:
            pa, pb, pc = mesh.verts[a], mesh.verts[b], mesh.verts[c]
            u = [pb[k] - pa[k] for k in range(3)]
            w = [pc[k] - pa[k] for k in range(3)]
            nrm = (u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0])
            ln = sum(x * x for x in nrm) ** 0.5 or 1
            f.write(struct.pack("<12fH", *(x / ln for x in nrm), *pa, *pb, *pc, 0))


def write_3mf(parts: list[tuple[str, Mesh, str]], path: Path) -> None:
    mats = "".join(f'<base name="{n}" displaycolor="{c}"/>' for n, _, c in parts)
    objs, items = [], []
    for i, (name, m, _) in enumerate(parts):
        vs = "".join(f'<vertex x="{x}" y="{y}" z="{z}"/>' for x, y, z in m.verts)
        ts = "".join(f'<triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in m.tris)
        objs.append(f'<object id="{i + 2}" name="{name}" type="model" pid="1" pindex="{i}"><mesh><vertices>{vs}</vertices><triangles>{ts}</triangles></mesh></object>')
    comps = "".join(f'<component objectid="{i + 2}"/>' for i in range(len(parts)))
    pid = len(parts) + 2
    objs.append(f'<object id="{pid}" name="marker" type="model"><components>{comps}</components></object>')
    items.append(f'<item objectid="{pid}"/>')
    model = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
        f'<resources><basematerials id="1">{mats}</basematerials>{"".join(objs)}</resources>'
        f'<build>{"".join(items)}</build></model>'
    )
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
        )
        z.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
        )
        z.writestr("3D/3dmodel.model", model)


def main() -> None:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "markers")
    out.mkdir(parents=True, exist_ok=True)
    for code, width, margin in MARKERS:
        grid = marker_grid(code)
        n = len(grid)
        step = width / n
        half = width / 2 + margin
        assert 2 * half <= 180, code
        reference_png(grid, out / f"{code}-reference.png")
        paper_pdf(grid, code, width, out / f"{code}-paper.pdf")
        base = Mesh()
        base.box(-half, -half, half, half, 0, BASE_MM)
        raised = Mesh()
        raised.grid(grid, -width / 2, width / 2, step, BASE_MM, BASE_MM + RAISED_MM)
        raised.frame(half, half - RIM_MM, BASE_MM, BASE_MM + RAISED_MM)
        write_stl(base, out / f"{code}-base.stl", f"VLM marker {code} base")
        write_stl(raised, out / f"{code}-raised.stl", f"VLM marker {code} raised")
        write_3mf([("base (light)", base, "#F2F2F2"), ("raised (dark)", raised, "#1A1A1A")], out / f"{code}.3mf")
        print(f"{code}: tracked {width:.0f} mm, {n} modules of {step:.2f} mm, plaque {2 * half:.0f} mm, files in {out}")


if __name__ == "__main__":
    main()
