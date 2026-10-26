/**
 * Ring marker codec: systematic RS(12,6) over GF(64) laid out on 3 staggered rings.
 * A port of apps/ring-marker/ringmarker/codec.py (encode and code_of only; the Quest app
 * decodes). apps/ring-marker/vectors/codec.json is the contract.
 *
 * Cell index = ring * 24 + cell; true means "on" (dark, raised).
 */

export const RING_CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

const CELLS = 72
const PER_RING = 24
const N = 12
const K = 6
const NSYM = 6
const OFFSET = [0, 2, 4]

// XOR mask: the first 72 bits (MSB first) of SHA-256("VLM ring marker v0"). Precomputed so
// this module stays synchronous in the browser (Web Crypto digest is async). Made once with:
//   python3 -c "import sys; sys.path.insert(0,'apps/ring-marker'); from ringmarker.codec import MASK; print(''.join('1' if m else '0' for m in MASK))"
const MASK_BITS = '101111001101010100011110111111111010111100111011010110110110110001010101'
const MASK: boolean[] = Array.from(MASK_BITS, (b) => b === '1')

// --- GF(64), x^6 + x + 1 ---
const EXP = new Array<number>(126).fill(0)
const LOG = new Array<number>(64).fill(0)
{
  let x = 1
  for (let i = 0; i < 63; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 64) x ^= 0x43
  }
  for (let i = 63; i < 126; i++) EXP[i] = EXP[i - 63]
}

const gmul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]])

const pmul = (p: number[], q: number[]): number[] => {
  const out = new Array<number>(p.length + q.length - 1).fill(0)
  for (let i = 0; i < p.length; i++) for (let j = 0; j < q.length; j++) out[i + j] ^= gmul(p[i], q[j])
  return out
}

// Generator with roots alpha^0 .. alpha^5 (low degree first, monic).
let GEN = [1]
for (let j = 0; j < NSYM; j++) GEN = pmul(GEN, [EXP[j], 1])

const SYMBOL_CELLS: number[][] = Array.from({ length: N }, (_, j) => {
  const ring = Math.floor(j / 4)
  const start = ((j % 4) * 6 + OFFSET[ring]) % PER_RING
  return Array.from({ length: 6 }, (_, b) => ring * PER_RING + ((start + b) % PER_RING))
})

/** Systematic codeword: data symbols followed by 6 parity symbols. */
function rsEncode(data: number[]): number[] {
  let rem = new Array<number>(NSYM).fill(0) // rem[0] is the highest-degree remainder coefficient
  for (const d of data) {
    const fb = d ^ rem[0]
    rem = [...rem.slice(1), 0]
    if (fb) for (let i = 0; i < NSYM; i++) rem[i] ^= gmul(fb, GEN[NSYM - 1 - i])
  }
  return [...data, ...rem]
}

/** Encodes a 32-bit id and 4-bit version into the 72 masked cells. */
export function encodeRing(markerId: number, version = 0): boolean[] {
  if (!Number.isInteger(markerId) || markerId < 0 || markerId >= 2 ** 32) throw new RangeError('markerId must be 32-bit')
  if (!Number.isInteger(version) || version < 0 || version >= 16) throw new RangeError('version must be 4-bit')
  // Six 6-bit symbols, high bits first: version (4 bits) then the id (32 bits). 2^32 > the
  // int32 range, so split instead of shifting a 36-bit value.
  const hi = version * 16 + Math.floor(markerId / 2 ** 28) // top 8 bits of the 36
  const lo = markerId % 2 ** 28 // low 28 bits
  const value = BigInt(hi) * (1n << 28n) + BigInt(lo)
  const data = Array.from({ length: K }, (_, i) => Number((value >> BigInt(30 - 6 * i)) & 63n))
  const symbols = rsEncode(data)
  const raw = new Array<boolean>(CELLS).fill(false)
  symbols.forEach((s, j) => SYMBOL_CELLS[j].forEach((c, b) => (raw[c] = ((s >> (5 - b)) & 1) === 1)))
  return raw.map((c, i) => c !== MASK[i])
}

/** The 32-bit id as 7 Crockford base32 characters. */
export function ringCodeOf(markerId: number): string {
  let out = ''
  for (let i = 0; i < 7; i++) out += RING_CROCKFORD[Math.floor(markerId / 2 ** (30 - 5 * i)) & 31]
  return out
}

/** Reads a typed code: case-insensitive, I/L as 1, O as 0, hyphens and spaces ignored. */
export function parseRingCode(code: string): number | null {
  const clean = code.toUpperCase().replace(/[-\s]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0')
  if (clean.length !== 7) return null
  let value = 0
  for (const ch of clean) {
    const d = RING_CROCKFORD.indexOf(ch)
    if (d < 0) return null
    value = value * 32 + d
  }
  return value < 2 ** 32 ? value : null
}

/** Uniform 32-bit id, never 0. Server-only use. */
export function randomRingId(): number {
  // vlm-shared's tsconfig has neither DOM nor Node types, so type the global by hand.
  const { crypto } = globalThis as unknown as { crypto: { getRandomValues(a: Uint32Array): Uint32Array } }
  const buf = new Uint32Array(1)
  do crypto.getRandomValues(buf)
  while (buf[0] === 0)
  return buf[0]
}
