import math

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


def test_runs_match_cells():
    shapes = marker_shapes(ID140, D140)
    cells = encode(ID140)
    for ring, (r0, r1) in enumerate(RING_RADII(D140)):
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


def test_corner_marks_differ():
    def rects(i, d):
        return [s for s in marker_shapes(i, d) if isinstance(s, Rect)]

    a, b = rects(ID120, D120), rects(ID140, D140)
    assert a != b
    for r in a + b:
        near = min(abs(r.x0), abs(r.x1)) , min(abs(r.y0), abs(r.y1))
        assert math.hypot(*near) >= 72 - 1e-9


def test_scales_with_diameter():
    assert RING_RADII(70) == [tuple(r / 2 for r in ring) for ring in RING_RADII(140)]


def test_render_samples():
    img = render(ID140, D140, 4)
    assert img.mode == "L" and img.size == (600, 600)
    assert img.getpixel((300, 300)) < 80
    assert img.getpixel((300, 300 - 66 * 4)) > 180


def test_render_matches_cells():
    img = render(ID140, D140, 4)
    cells = encode(ID140)
    c = img.width / 2
    for ring, (r0, r1) in enumerate(RING_RADII(D140)):
        rm = (r0 + r1) / 2
        for k in range(24):
            a = math.radians(15 * k + 7.5)
            px = img.getpixel((int(c + rm * 4 * math.sin(a)), int(c - rm * 4 * math.cos(a))))
            assert (px < 80) == cells[ring * 24 + k], (ring, k)
            assert px < 80 or px > 180
