"""Geometry of the ring marker. Lengths in mm, centre at the origin, +y up.

Angles are degrees clockwise from the top: a point at angle a, radius r is (r*sin a, r*cos a).
Everything is specified at a 140 mm diameter and scaled by diameter_mm / 140.
"""
import hashlib
from dataclasses import dataclass

from .codec import encode

REF_DIAMETER = 140.0
PLAQUE_REF = 150.0
FINDER_REF = (62.0, 70.0)
CODE_RINGS_REF = [(51.0, 59.0), (40.0, 48.0), (29.0, 37.0)]  # ring 0 outermost
DOT_REF = 12.0
FINDER_ANGLES = (8.0, 352.0)
INSET_DEG = 1.2
PER_RING = 24
CELL_DEG = 360.0 / PER_RING
CORNER_SQUARE_REF = 4.0
CORNER_INSET_REF = 3.0


@dataclass(frozen=True)
class Sector:
    """Annular sector. a1 > a0; a1 may exceed 360 for a run wrapping past the top (a0 is in [0, 360))."""
    r0: float
    r1: float
    a0: float
    a1: float


@dataclass(frozen=True)
class Disc:
    r: float


@dataclass(frozen=True)
class Rect:
    x0: float
    y0: float
    x1: float
    y1: float


def _scale(diameter_mm: float) -> float:
    return diameter_mm / REF_DIAMETER


def plaque_side(diameter_mm: float) -> float:
    return diameter_mm * PLAQUE_REF / REF_DIAMETER


def RING_RADII(diameter_mm: float) -> list[tuple[float, float]]:
    s = _scale(diameter_mm)
    return [(a * s, b * s) for a, b in CODE_RINGS_REF]


def finder_radii(diameter_mm: float) -> tuple[float, float]:
    s = _scale(diameter_mm)
    return FINDER_REF[0] * s, FINDER_REF[1] * s


def dot_radius(diameter_mm: float) -> float:
    return DOT_REF * _scale(diameter_mm)


def _runs(on: list[bool]) -> list[tuple[int, int]]:
    """Runs of consecutive True cells as (start, length), wrapping 23 -> 0. All-on gives (0, 24)."""
    n = len(on)
    if all(on):
        return [(0, n)]
    runs = []
    for k in range(n):
        if on[k] and not on[(k - 1) % n]:
            length = 1
            while on[(k + length) % n]:
                length += 1
            runs.append((k, length))
    return runs


def corner_grids(marker_id: int, diameter_mm: float) -> list[tuple[float, float, float, list[list[bool]]]]:
    """Four corner marks (TL, TR, BR, BL) as (x0, y_top, step, 3x3 cells with row 0 at the top).

    The square at the plaque corner is always on; the other 8, read row by row from the top-left, take the bits
    of SHA-256(id as 4 big-endian bytes), 8 bits per corner (most significant first), corners in order TL, TR, BR, BL.
    """
    s = _scale(diameter_mm)
    half = plaque_side(diameter_mm) / 2
    step, inset = CORNER_SQUARE_REF * s, CORNER_INSET_REF * s
    digest = hashlib.sha256(marker_id.to_bytes(4, "big")).digest()
    out = []
    for c, (right, bottom) in enumerate([(False, False), (True, False), (True, True), (False, True)]):
        byte = digest[c]
        outer = (2 if bottom else 0, 2 if right else 0)
        cells = [[False] * 3 for _ in range(3)]
        bit = 0
        for row in range(3):
            for col in range(3):
                if (row, col) == outer:
                    cells[row][col] = True
                else:
                    cells[row][col] = bool((byte >> (7 - bit)) & 1)
                    bit += 1
        x0 = half - inset - 3 * step if right else -half + inset
        y_top = -half + inset + 3 * step if bottom else half - inset
        out.append((x0, y_top, step, cells))
    return out


def marker_shapes(marker_id: int, diameter_mm: float, version: int = 0) -> list[Sector | Disc | Rect]:
    cells = encode(marker_id, version)
    shapes: list[Sector | Disc | Rect] = []
    f0, f1 = finder_radii(diameter_mm)
    shapes.append(Sector(f0, f1, FINDER_ANGLES[0], FINDER_ANGLES[1]))
    for ring, (r0, r1) in enumerate(RING_RADII(diameter_mm)):
        on = cells[ring * PER_RING:(ring + 1) * PER_RING]
        for start, length in _runs(on):
            if length == PER_RING:
                shapes.append(Sector(r0, r1, 0.0, 360.0))
            else:
                a0 = start * CELL_DEG + INSET_DEG
                shapes.append(Sector(r0, r1, a0, a0 + length * CELL_DEG - 2 * INSET_DEG))
    shapes.append(Disc(dot_radius(diameter_mm)))
    for x0, y_top, step, grid in corner_grids(marker_id, diameter_mm):
        for row in range(3):
            for col in range(3):
                if grid[row][col]:
                    shapes.append(Rect(x0 + col * step, y_top - (row + 1) * step, x0 + (col + 1) * step, y_top - row * step))
    return shapes
