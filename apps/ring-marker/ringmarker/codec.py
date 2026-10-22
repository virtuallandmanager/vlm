"""Ring marker codec: systematic RS(12,6) over GF(64) laid out on 3 staggered rings.

Cell index = ring * 24 + cell; True means "on" (dark, raised).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
from dataclasses import dataclass

CELLS = 72
RINGS = 3
PER_RING = 24
N, K, NSYM = 12, 6, 6
OFFSET = (0, 2, 4)
CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

TEST_MARKERS: dict[str, tuple[int, float]] = {
    "RING120": (0x1D2C3B4A, 120.0),
    "RING140": (0x2E3D4C5B, 140.0),
    "RING170": (0x3F4E5D6C, 170.0),
}


@dataclass(frozen=True)
class Decoded:
    marker_id: int
    version: int
    corrected: int  # errors corrected + erased symbols repaired


# --- GF(64), x^6 + x + 1 -------------------------------------------------
EXP = [0] * 126
LOG = [0] * 64
_x = 1
for _i in range(63):
    EXP[_i] = _x
    LOG[_x] = _i
    _x <<= 1
    if _x & 64:
        _x ^= 0x43
for _i in range(63, 126):
    EXP[_i] = EXP[_i - 63]


def gmul(a: int, b: int) -> int:
    return 0 if a == 0 or b == 0 else EXP[LOG[a] + LOG[b]]


def ginv(a: int) -> int:
    return EXP[63 - LOG[a]]


def pmul(p: list[int], q: list[int]) -> list[int]:
    out = [0] * (len(p) + len(q) - 1)
    for i, a in enumerate(p):
        for j, b in enumerate(q):
            out[i + j] ^= gmul(a, b)
    return out


def peval(p: list[int], x: int) -> int:
    """Evaluate polynomial (low degree first) at x."""
    acc = 0
    for c in reversed(p):
        acc = gmul(acc, x) ^ c
    return acc


# Generator with roots alpha^0 .. alpha^5 (low degree first, monic).
GEN = [1]
for _j in range(NSYM):
    GEN = pmul(GEN, [EXP[_j], 1])

# --- layout and mask -----------------------------------------------------
_digest = hashlib.sha256(b"VLM ring marker v0").digest()
MASK = [(_digest[i // 8] >> (7 - i % 8)) & 1 == 1 for i in range(CELLS)]


def _symbol_cells(j: int) -> list[int]:
    ring = j // 4
    start = ((j % 4) * 6 + OFFSET[ring]) % PER_RING
    return [ring * PER_RING + (start + b) % PER_RING for b in range(6)]


SYMBOL_CELLS = [_symbol_cells(j) for j in range(N)]


def _rs_encode(data: list[int]) -> list[int]:
    """Systematic codeword: data symbols followed by 6 parity symbols."""
    # Remainder of data(x) * x^6 mod GEN(x); data[0] is the highest power.
    rem = [0] * NSYM  # rem[0] is the highest-degree remainder coefficient
    for d in data:
        fb = d ^ rem[0]
        rem = rem[1:] + [0]
        if fb:
            for i in range(NSYM):
                rem[i] ^= gmul(fb, GEN[NSYM - 1 - i])
    return data + rem


def _cells_from_symbols(symbols: list[int]) -> list[bool]:
    cells = [False] * CELLS
    for j, s in enumerate(symbols):
        for b, c in enumerate(SYMBOL_CELLS[j]):
            cells[c] = bool((s >> (5 - b)) & 1)
    return cells


def encode(marker_id: int, version: int = 0) -> list[bool]:
    if not 0 <= marker_id < 1 << 32:
        raise ValueError("marker_id must be 32-bit")
    if not 0 <= version < 16:
        raise ValueError("version must be 4-bit")
    value = (version << 32) | marker_id
    data = [(value >> (30 - 6 * i)) & 63 for i in range(K)]
    raw = _cells_from_symbols(_rs_encode(data))
    return [c != m for c, m in zip(raw, MASK)]


# --- decoding ------------------------------------------------------------
def _berlekamp_massey(s: list[int]) -> list[int]:
    c, b = [1], [1]
    L, m, bb = 0, 1, 1
    for n, _ in enumerate(s):
        d = s[n]
        for i in range(1, L + 1):
            if i < len(c):
                d ^= gmul(c[i], s[n - i])
        if d == 0:
            m += 1
            continue
        t = list(c)
        coef = gmul(d, ginv(bb))
        shifted = [0] * m + [gmul(coef, x) for x in b]
        if len(shifted) > len(c):
            c += [0] * (len(shifted) - len(c))
        for i, x in enumerate(shifted):
            c[i] ^= x
        if 2 * L <= n:
            L, b, bb, m = n + 1 - L, t, d, 1
        else:
            m += 1
    return c[: L + 1] + [0] * max(0, L + 1 - len(c))


def decode(cells: list[bool | None]) -> Decoded | None:
    if len(cells) != CELLS:
        raise ValueError("expected 72 cells")
    raw = [None if c is None else (c != m) for c, m in zip(cells, MASK)]
    recv = [0] * N
    erased = []
    for j, idxs in enumerate(SYMBOL_CELLS):
        v = 0
        for c in idxs:
            if raw[c] is None:
                erased.append(j)
                break
            v = (v << 1) | int(raw[c])
        else:
            recv[j] = v
            continue
        recv[j] = 0
    e = len(erased)
    if e > NSYM:
        return None
    loc = [EXP[(N - 1 - j) % 63] for j in range(N)]  # X_j = alpha^(11-j)
    syn = [0] * NSYM
    for t in range(NSYM):
        acc = 0
        for j in range(N):
            acc ^= gmul(recv[j], EXP[(t * (N - 1 - j)) % 63])
        syn[t] = acc

    gamma = [1]
    for j in erased:
        gamma = pmul(gamma, [1, loc[j]])
    mod = pmul(syn, gamma)[:NSYM]
    mod += [0] * (NSYM - len(mod))
    sigma = _berlekamp_massey(mod[e:])
    nerr = len(sigma) - 1
    while nerr > 0 and sigma[nerr] == 0:
        nerr -= 1
    if nerr > 2 or 2 * nerr + e > NSYM or len(sigma) - 1 != nerr:
        return None
    lam = pmul(gamma, sigma[: nerr + 1])
    omega = pmul(syn, lam)[:NSYM]
    dlam = [lam[i] if i % 2 == 1 else 0 for i in range(1, len(lam))]  # derivative

    fixed = list(recv)
    roots = 0
    for j in range(N):
        xinv = ginv(loc[j])
        if peval(lam, xinv) != 0:
            continue
        roots += 1
        den = peval(dlam, xinv)
        if den == 0:
            return None
        fixed[j] ^= gmul(loc[j], gmul(peval(omega, xinv), ginv(den)))
    if roots != len(lam) - 1:
        return None

    # The repaired word must be a true codeword (parity re-derives from data).
    if _rs_encode(fixed[:K]) != fixed:
        return None
    value = 0
    for s in fixed[:K]:
        value = (value << 6) | s
    nbad = sum(1 for j in range(N) if j not in erased and fixed[j] != recv[j])
    return Decoded(value & 0xFFFFFFFF, value >> 32, nbad + e)


def code_of(marker_id: int) -> str:
    return "".join(CROCKFORD[(marker_id >> (30 - 5 * i)) & 31] for i in range(7))


# --- test vectors --------------------------------------------------------
def _bits(cells: list[bool | None]) -> str:
    return "".join("?" if c is None else "1" if c else "0" for c in cells)


def _expect(d: Decoded | None):
    return None if d is None else {
        "id": d.marker_id, "version": d.version, "corrected": d.corrected}


def build_vectors() -> dict:
    enc_cases = [(0, 0), (1, 0), (0xFFFFFFFF, 0), (0, 15), (0xFFFFFFFF, 15)]
    enc_cases += [(i, 0) for i, _ in TEST_MARKERS.values()]
    enc_cases += [(0x12345678, 1), (0xDEADBEEF, 7), (0x80000000, 2), (0x0000FFFF, 9)]
    encode_vectors = [
        {"id": i, "version": v, "cells": _bits(encode(i, v))} for i, v in enc_cases
    ]

    mid = TEST_MARKERS["RING140"][0]
    base = encode(mid, 0)

    def flipped(idx):
        out = list(base)
        for i in idx:
            out[i] = not out[i]
        return out

    def erased(idx, src=None):
        out = list(src or base)
        for i in idx:
            out[i] = None
        return out

    def sym(j):
        return SYMBOL_CELLS[j]

    rng = random.Random(7)
    cases = [
        list(base),                                              # clean
        encode(0, 0),                                            # id 0 clean
        encode(0xFFFFFFFF, 15),                                  # max clean
        flipped([sym(3)[0]]),                                    # 1 error
        flipped([sym(0)[2], sym(7)[4]]),                         # 2 errors
        flipped([sym(0)[1], sym(5)[1], sym(9)[1]]),              # 3 errors
        flipped(sym(10)),                                        # whole parity symbol wrong
        erased([c for j in range(1, 7) for c in sym(j)]),        # 6 erased symbols
        erased([c for j in range(1, 6) for c in sym(j)], flipped([sym(8)[0]])),  # 5 erased + 1 error
        erased([r * 24 + c for r in range(3) for c in (5, 6, 7)]),  # radial wedge
        erased([c for j in (2, 4) for c in sym(j)], flipped([sym(8)[3]])),  # 2 erased + 1 error
        [rng.random() < 0.5 for _ in range(72)],                 # noise
    ]
    decode_vectors = [
        {"cells": _bits(c), "expect": _expect(decode(c))} for c in cases
    ]
    return {"encode": encode_vectors, "decode": decode_vectors}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--vectors", required=True)
    args = ap.parse_args()
    with open(args.vectors, "w") as f:
        json.dump(build_vectors(), f, indent=1)
        f.write("\n")


if __name__ == "__main__":
    main()
