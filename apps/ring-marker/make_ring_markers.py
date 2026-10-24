#!/usr/bin/env python3
"""Writes print files for every test marker. Usage: python3 make_ring_markers.py [out_dir=out]"""
import sys
from pathlib import Path

from ringmarker.codec import TEST_MARKERS
from ringmarker.printfiles import write_print_files


def main() -> None:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else "out")
    for name, (marker_id, diameter) in TEST_MARKERS.items():
        files = write_print_files(marker_id, diameter, out, name)
        print(f"{name}: {diameter:.0f} mm, {len(files)} files in {out}")


if __name__ == "__main__":
    main()
