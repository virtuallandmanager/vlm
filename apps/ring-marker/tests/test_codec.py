import json
import random
from pathlib import Path

from ringmarker.codec import CELLS, TEST_MARKERS, Decoded, code_of, decode, encode

VECTORS = Path(__file__).resolve().parent.parent / "vectors" / "codec.json"


def symbol_cells(j):
    """Cell indices (ring*24+cell) of symbol j, matching the placement rule."""
    ring = j // 4
    start = ((j % 4) * 6 + (0, 2, 4)[ring]) % 24
    return [ring * 24 + (start + b) % 24 for b in range(6)]


def flip(cells, idxs):
    out = list(cells)
    for i in idxs:
        out[i] = not out[i]
    return out


def test_round_trip():
    for i in (0, 1, 0xFFFFFFFF, 0x2E3D4C5B):
        for v in (0, 15):
            cells = encode(i, v)
            assert len(cells) == CELLS == 72
            assert decode(cells) == Decoded(i, v, 0)


def test_id_zero_is_not_blank():
    assert 20 <= sum(encode(0)) <= 52


def test_corrects_two_symbol_errors():
    base = encode(0x2E3D4C5B)
    bad = flip(base, [symbol_cells(0)[2], symbol_cells(7)[4]])
    assert decode(bad) == Decoded(0x2E3D4C5B, 0, 2)


def test_rejects_three_symbol_errors():
    base = encode(0x2E3D4C5B)
    bad = flip(base, [symbol_cells(j)[1] for j in (0, 5, 9)])
    assert decode(bad) is None


def test_erasures():
    base = encode(0x2E3D4C5B, 3)
    bad = list(base)
    for j in range(1, 7):
        for c in symbol_cells(j):
            bad[c] = None
    assert decode(bad) == Decoded(0x2E3D4C5B, 3, 6)


def test_erasures_plus_error_over_limit():
    base = encode(0x2E3D4C5B)
    bad = list(base)
    for j in range(1, 6):
        for c in symbol_cells(j):
            bad[c] = None
    bad[symbol_cells(8)[0]] = not bad[symbol_cells(8)[0]]
    assert decode(bad) is None


def test_radial_scratch_hits_few_symbols():
    base = encode(0x2E3D4C5B)
    bad = list(base)
    for ring in range(3):
        for cell in (5, 6, 7):
            bad[ring * 24 + cell] = None
    assert decode(bad) == Decoded(0x2E3D4C5B, 0, 4)


def test_two_erased_symbols_plus_one_error_counts_three():
    bad = list(encode(0x2E3D4C5B))
    for j in (2, 4):
        for c in symbol_cells(j):
            bad[c] = None
    bad[symbol_cells(8)[3]] = not bad[symbol_cells(8)[3]]
    assert decode(bad) == Decoded(0x2E3D4C5B, 0, 3)


def test_random_cells_rarely_decode():
    rng = random.Random(1)
    hits = sum(
        decode([rng.random() < 0.5 for _ in range(72)]) is not None
        for _ in range(20000)
    )
    assert hits <= 2


def test_code_of():
    assert code_of(0) == "0000000" and code_of(0xFFFFFFFF) == "3ZZZZZZ"


def test_test_markers_have_distinct_codes():
    assert len({code_of(i) for i, _ in TEST_MARKERS.values()}) == 3


def to_bits(cells):
    return "".join("?" if c is None else "1" if c else "0" for c in cells)


def from_bits(s):
    return [None if ch == "?" else ch == "1" for ch in s]


def test_vectors_file_matches():
    data = json.loads(VECTORS.read_text())
    assert len(data["encode"]) == 12 and len(data["decode"]) == 13
    for e in data["encode"]:
        assert to_bits(encode(e["id"], e["version"])) == e["cells"]
    for d in data["decode"]:
        got = decode(from_bits(d["cells"]))
        if d["expect"] is None:
            assert got is None
        else:
            assert got == Decoded(d["expect"]["id"], d["expect"]["version"], d["expect"]["corrected"])


def test_vectors_cover_rejection_rules():
    from ringmarker.codec import _decode
    reasons = {_decode(from_bits(d["cells"]))[1] for d in json.loads(VECTORS.read_text())["decode"]}
    assert {"too_many_erasures", "degree_deficient_locator", "too_many_errors",
            "over_budget", "root_count"} <= reasons
