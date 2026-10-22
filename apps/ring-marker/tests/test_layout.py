import math

import pytest

from ringmarker.codec import TEST_MARKERS, encode
from ringmarker.layout import RING_RADII, Disc, Rect, Sector, marker_shapes, plaque_side
from ringmarker.render import render

ID120, D120 = TEST_MARKERS["RING120"]
ID140, D140 = TEST_MARKERS["RING140"]


def covers(shape, x, y):
    if isinstance(shape, Disc):
        return math.hypot(x, y) <= shape.r
    if isinstance(shape, Rect):
        return shape.x0 <= x <= shape.x1 and shape.y0 <= y <= shape.y1
    r = math.hypot(x, y)
    a = math.degrees(math.atan2(x, y)) % 360
    if not shape.r0 <= r <= shape.r1:
        return False
    return any(shape.a0 <= a + k <= shape.a1 for k in (0, 360))


def test_plaque_side():
    assert plaque_side(140) == 150
    assert abs(plaque_side(170) - 170 * 150 / 140) < 1e-9


def test_shapes_inside_plaque():
    half = plaque_side(D140) / 2
    for s in marker_shapes(ID140, D140):
        if isinstance(s, Rect):
            assert -half <= s.x0 < s.x1 <= half and -half <= s.y0 < s.y1 <= half
        elif isinstance(s, Sector):
            assert 0 < s.r0 < s.r1 <= D140 / 2
        else:
            assert s.r <= D140 / 2


@pytest.mark.parametrize("name", list(TEST_MARKERS))
def test_runs_match_cells(name):
    mid, dia = TEST_MARKERS[name]
    shapes = marker_shapes(mid, dia)
    cells = encode(mid)
    for ring, (r0, r1) in enumerate(RING_RADII(dia)):
        rm = (r0 + r1) / 2
        for k in range(24):
            a = math.radians(15 * k + 7.5)
            on = any(covers(s, rm * math.sin(a), rm * math.cos(a)) for s in shapes if isinstance(s, Sector))
            assert on == cells[ring * 24 + k], (ring, k)


def test_finder_gap():
    finder = [s for s in marker_shapes(ID140, D140) if isinstance(s, Sector) and s.r0 >= 62 - 1e-9]
    assert len(finder) == 1 and (finder[0].a0, finder[0].a1) == (8, 352)
    for a in (-7.9, -4, 0, 4, 7.9):
        r = 66 * 1.0
        assert not covers(finder[0], r * math.sin(math.radians(a)), r * math.cos(math.radians(a)))


def _rects(i, d):
    return [s for s in marker_shapes(i, d) if isinstance(s, Rect)]


def corner_cell_grids(rects, d):
    """The four corners (TL, TR, BR, BL) as 3x3 on/off grids in a common frame: row 0 / col 0 is the square at the plaque corner."""
    sc = d / 140
    half, step, inset = plaque_side(d) / 2, 4 * sc, 3 * sc
    grids = {q: [[False] * 3 for _ in range(3)] for q in range(4)}
    for r in rects:
        right, top = r.x0 > 0, r.y0 > 0
        q = {(False, True): 0, (True, True): 1, (True, False): 2, (False, False): 3}[(right, top)]
        col = (half - inset - r.x1 if right else r.x0 + half - inset) / step
        row = (half - inset - r.y1 if top else r.y0 + half - inset) / step
        grids[q][round(row)][round(col)] = True
    return [grids[q] for q in range(4)]


def test_corner_grid_helper_detects_identical_corners():
    base = [Rect(-72, 60, -68, 64), Rect(-68, 56, -64, 60)]  # two squares at the top-left, plaque half 75, inset 3
    mirrored = base + [Rect(-r.x1, r.y0, -r.x0, r.y1) for r in base]
    mirrored += [Rect(r.x0, -r.y1, r.x1, -r.y0) for r in mirrored]
    grids = corner_cell_grids(mirrored, 140)
    assert grids[0] == grids[1] == grids[2] == grids[3] and grids[0][0][0] and grids[0][1][1]
    # and the real marker's corners are not all equal
    assert len({str(g) for g in corner_cell_grids(_rects(ID140, D140), D140)}) > 1


def test_corner_marks_differ():
    a, b = _rects(ID140, D140), _rects(ID140 ^ 1, D140)
    assert a != b  # same diameter: only the ID differs
    assert any(a != _rects(i, D140) for i in range(ID140 + 1, ID140 + 6))
    grids = corner_cell_grids(a, D140)
    assert all(g[0][0] for g in grids)  # the outermost square is always on
    assert any(g != grids[0] for g in grids[1:])  # corners differ in content, not just position
    for r in _rects(ID120, D120) + a:
        near = min(abs(r.x0), abs(r.x1)), min(abs(r.y0), abs(r.y1))
        assert math.hypot(*near) >= 72 - 1e-9


def test_diameter_limit():
    with pytest.raises(ValueError):
        marker_shapes(ID140, 256.5)
    marker_shapes(ID140, 256)


def test_scales_with_diameter():
    assert RING_RADII(70) == [tuple(r / 2 for r in ring) for ring in RING_RADII(140)]


def test_render_samples():
    img = render(ID140, D140, 4)
    assert img.mode == "L" and img.size == (600, 600)
    assert img.getpixel((300, 300)) < 80
    assert img.getpixel((300, 300 - 66 * 4)) > 180


@pytest.mark.parametrize("name", list(TEST_MARKERS))
def test_render_matches_cells(name):
    mid, dia = TEST_MARKERS[name]
    img = render(mid, dia, 4)
    cells = encode(mid)
    c = img.width / 2
    for ring, (r0, r1) in enumerate(RING_RADII(dia)):
        rm = (r0 + r1) / 2
        for k in range(24):
            a = math.radians(15 * k + 7.5)
            px = img.getpixel((int(c + rm * 4 * math.sin(a)), int(c - rm * 4 * math.cos(a))))
            assert (px < 80) == cells[ring * 24 + k], (ring, k)
            assert px < 80 or px > 180
