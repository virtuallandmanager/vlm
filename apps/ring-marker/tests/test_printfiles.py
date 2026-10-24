import struct
import zipfile
from collections import Counter

import pytest

from ringmarker.codec import TEST_MARKERS
from ringmarker.printfiles import build_meshes, write_print_files

ID140, D140 = TEST_MARKERS["RING140"]


@pytest.mark.parametrize("name", list(TEST_MARKERS))
def test_stl_is_watertight(name):
    mid, dia = TEST_MARKERS[name]
    for mesh in build_meshes(mid, dia):
        directed = Counter()
        for a, b, c in mesh.tris:
            for e in ((a, b), (b, c), (c, a)):
                directed[e] += 1
        # every edge is used once in each direction (closed, consistently oriented)
        assert all(n == 1 and directed.get((e[1], e[0])) == 1 for e, n in directed.items())
        vol = 0.0
        for a, b, c in mesh.tris:
            pa, pb, pc = (mesh.verts[i] for i in (a, b, c))
            vol += (pa[0] * (pb[1] * pc[2] - pb[2] * pc[1]) - pa[1] * (pb[0] * pc[2] - pb[2] * pc[0]) + pa[2] * (pb[0] * pc[1] - pb[1] * pc[0])) / 6
        assert vol > 0


def test_files_written(tmp_path):
    paths = write_print_files(ID140, D140, tmp_path, "RING140")
    assert sorted(p.name for p in paths) == sorted(
        f"RING140{s}" for s in ("-reference.png", "-paper.pdf", "-base.stl", "-raised.stl", ".3mf")
    )
    for p in paths:
        assert p.stat().st_size > 0
    assert b"DCTDecode" not in (tmp_path / "RING140-paper.pdf").read_bytes()
    assert zipfile.is_zipfile(tmp_path / "RING140.3mf")
    data = (tmp_path / "RING140-raised.stl").read_bytes()
    assert struct.unpack("<I", data[80:84])[0] * 50 + 84 == len(data)
