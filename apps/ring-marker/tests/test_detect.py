import json
import math

import numpy as np
import pytest
from PIL import Image

from ringmarker.codec import TEST_MARKERS
from ringmarker import detect as D
from ringmarker.detect import detect
from ringmarker.layout import CODE_RINGS_REF
from ringmarker.render import render
from ringmarker.testset import generate

# Range images allowed to give no detection at all (never a wrong id). Only d = 1.8 m may appear here.
KNOWN_MISSES: set[str] = set()


@pytest.fixture(scope="session")
def testset(tmp_path_factory):
    out = tmp_path_factory.mktemp("testset")
    generate(out)
    manifest = json.loads((out / "manifest.json").read_text())
    images = {e["name"]: np.asarray(Image.open(out / e["file"]).convert("L")) for e in manifest}
    return manifest, images


@pytest.fixture(scope="session")
def detections(testset):
    manifest, images = testset
    return {e["name"]: detect(images[e["name"]]) for e in manifest}


def test_clean_render():
    mid, dia = TEST_MARKERS["RING140"]
    found = detect(np.array(render(mid, dia, 2.0)))
    assert len(found) == 1
    assert found[0].marker_id == mid and found[0].version == 0
    assert abs(found[0].center_px[0] - 150) < 1 and abs(found[0].center_px[1] - 150) < 1


def test_testset_cases(testset, detections):
    manifest, _ = testset
    failures = []
    for e in manifest:
        found = detections[e["name"]]
        if e["expect"] == "none":
            if found:
                failures.append((e["name"], "expected none", [hex(d.marker_id) for d in found]))
            continue
        if e["name"] in KNOWN_MISSES:
            assert not found, f"{e['name']} is a known miss but now detects; remove it from KNOWN_MISSES"
            continue
        want = {m["id"] for m in e["markers"]}
        got = {d.marker_id for d in found}
        if got != want or len(found) != len(want):
            failures.append((e["name"], "ids", sorted(map(hex, got)), sorted(map(hex, want))))
            continue
        for m in e["markers"]:
            (d,) = [d for d in found if d.marker_id == m["id"]]
            err = math.dist(d.center_px, m["center_px"])
            if err > 3:
                failures.append((e["name"], "centre error", round(err, 2)))
    assert not failures, failures


def test_known_misses_only_far():
    for name in KNOWN_MISSES:
        assert name.startswith("range-") and "-1.8-" in name


def test_rotation_reported(detections):
    for name, want in (("rotated_73", 73.0), ("rotated_180", 180.0)):
        (d,) = detections[name]
        diff = (d.rotation_deg - want + 180) % 360 - 180
        assert abs(diff) <= 2, (name, d.rotation_deg)


def test_never_wrong_id(testset, detections):
    manifest, _ = testset
    for e in manifest:
        drawn = {m["id"] for m in e["markers"]}
        for d in detections[e["name"]]:
            assert d.marker_id in drawn, (e["name"], hex(d.marker_id))


def _crop(img, side, cut):
    h, w = img.shape
    view = {"left": img[:, cut:], "right": img[:, :w - cut], "top": img[cut:, :], "bottom": img[:h - cut, :]}[side]
    return np.ascontiguousarray(view)


def test_cropped_marker_erases_off_image_cells():
    """A marker partly out of frame decodes to its own id or not at all; cells sampled off the image are erasures."""
    mid, dia = TEST_MARKERS["RING140"]
    ppm = 2.0
    img = np.array(render(mid, dia, ppm))
    checked = 0
    for cut in range(40, 80, 4):
        for side in ("left", "right", "top", "bottom"):
            im = _crop(img, side, cut)
            h, w = im.shape
            found = detect(im)
            assert all(d.marker_id == mid for d in found), (side, cut, [hex(d.marker_id) for d in found])
            if not found:
                continue
            # true centre in pixel-index coordinates after the crop
            cx = 149.5 - (cut if side == "left" else 0)
            cy = 149.5 - (cut if side == "top" else 0)
            masks = D.threshold(im, D.window_size(w))
            dot = min(D.dot_candidates(masks[0]), key=lambda q: math.dist(q[:2], (cx, cy)))
            cells, _, _ = D.read_cells(im, masks, dot)
            for ring, (r0, r1) in enumerate(CODE_RINGS_REF):
                m = (r0 + r1) / 2
                for k in range(24):
                    mu = k * 15 + 7.5
                    pts = [(m, mu), (m, mu - 3), (m, mu + 3), (m - 1, mu), (m + 1, mu)]
                    xs = [cx + ppm * r * math.sin(math.radians(a)) for r, a in pts]
                    ys = [cy - ppm * r * math.cos(math.radians(a)) for r, a in pts]
                    far_out = any(x < -2 or x > w + 1 or y < -2 or y > h + 1 for x, y in zip(xs, ys))
                    if far_out:
                        assert cells[ring * 24 + k] is None, (side, cut, ring, k)
                        checked += 1
    assert checked > 0


def test_degenerate_inputs_reject_without_raising():
    pts = np.array([[1.0, 2.0]] * 70)  # all edges at one point: singular normal matrix
    assert D.fit_conic(pts) is None
    assert D.Frame.from_conic(None, 0.0, 0.0) is None
    assert detect(np.full((120, 160), 128, np.uint8)) == []
    assert detect(np.zeros((120, 160), np.uint8)) == []


def test_blob_order_is_raster_order():
    img = np.full((60, 60), 200, np.uint8)
    img[40:50, 5:15] = 0   # lower blob, left
    img[5:15, 40:50] = 0   # upper blob, right: first in raster order
    dark, _ = D.threshold(img, 15)
    order = D.dot_candidates(dark, with_order=True)
    assert [o[0] for o in order] == sorted(o[0] for o in order) and order[0][1][1] < 30
