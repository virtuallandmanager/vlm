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


def test_corner_marks_differ():
    a, b = _rects(ID140, D140), _rects(ID140 ^ 1, D140)
    assert a != b  # same diameter: only the ID differs
    assert any(a != _rects(i, D140) for i in range(ID140 + 1, ID140 + 6))
    # the four corners of one marker are not all the same pattern
    half = plaque_side(D140) / 2
    pats = {q: frozenset((round(r.x0 - (half if q[0] else -half)), round(r.y0 - (half if q[1] else -half))) for r in a if (r.x0 > 0, r.y0 > 0) == q) for q in [(0, 1), (1, 1), (1, 0), (0, 0)]}
    assert len(set(pats.values())) > 1
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
