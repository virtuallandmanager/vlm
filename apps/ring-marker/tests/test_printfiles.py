import struct
import zipfile
from collections import Counter

from ringmarker.codec import TEST_MARKERS
from ringmarker.printfiles import build_meshes, write_print_files

ID140, D140 = TEST_MARKERS["RING140"]


def test_stl_is_watertight():
    for mesh in build_meshes(ID140, D140):
        edges = Counter()
        for a, b, c in mesh.tris:
            for e in ((a, b), (b, c), (c, a)):
                edges[frozenset(e)] += 1
        assert all(n == 2 for n in edges.values())
        # outward winding: signed volume is positive
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
    assert zipfile.is_zipfile(tmp_path / "RING140.3mf")
    data = (tmp_path / "RING140-raised.stl").read_bytes()
    assert struct.unpack("<I", data[80:84])[0] * 50 + 84 == len(data)
