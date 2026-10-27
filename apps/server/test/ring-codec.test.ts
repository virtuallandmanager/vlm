import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { encodeRing, parseRingCode, randomRingId, ringCodeOf } from '@virvixr/shared'

const vectors = JSON.parse(readFileSync(new URL('../../ring-marker/vectors/codec.json', import.meta.url), 'utf8'))

const toBits = (cells: boolean[]) => cells.map((c) => (c ? '1' : '0')).join('')

describe('ring codec', () => {
  it('encodes every vector exactly as the Python reference', () => {
    expect(vectors.encode.length).toBeGreaterThan(0)
    for (const v of vectors.encode) expect(toBits(encodeRing(v.id, v.version ?? 0))).toBe(v.cells)
  })
  it('writes the test markers codes', () => {
    expect(ringCodeOf(0x2e3d4c5b)).toHaveLength(7)
    expect(parseRingCode(ringCodeOf(0x2e3d4c5b))).toBe(0x2e3d4c5b)
  })
  it('reads codes forgivingly and rejects bad ones', () => {
    const c = ringCodeOf(0x1d2c3b4a)
    expect(parseRingCode(c.toLowerCase())).toBe(0x1d2c3b4a)
    expect(parseRingCode(c.slice(0, 3) + '-' + c.slice(3))).toBe(0x1d2c3b4a)
    expect(parseRingCode(c.replace(/1/g, 'I').replace(/0/g, 'O'))).toBe(0x1d2c3b4a)
    expect(parseRingCode('ZZZZZZZ')).toBeNull() // 35 bits, above 2^32
    expect(parseRingCode('ABC')).toBeNull()
    expect(parseRingCode('ABCDEFU')).toBeNull() // U isn't in the alphabet
  })
  it('makes non-zero 32-bit ids', () => {
    for (let i = 0; i < 100; i++) {
      const id = randomRingId()
      expect(id).toBeGreaterThan(0)
      expect(id).toBeLessThan(2 ** 32)
    }
  })
})
