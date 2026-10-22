import json
import math

import numpy as np
import pytest
from PIL import Image

from ringmarker.codec import TEST_MARKERS
from ringmarker.detect import detect
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
