import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { RING_MAX_DIAMETER_MM, ringMarkerSvg, ringPlaqueSizeMm, ringShapes } from 'vlm-shared'
import { sha256 } from '../../../packages/vlm-shared/src/ring-marker/sha256'

const vectors = JSON.parse(readFileSync(new URL('../../ring-marker/vectors/layout.json', import.meta.url), 'utf8'))
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')

describe('sha256', () => {
  it('matches the FIPS vectors', () => {
    expect(hex(sha256(new Uint8Array([0x61, 0x62, 0x63])))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    expect(hex(sha256(new Uint8Array(0)))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  })
})

describe('ring layout', () => {
  it('matches the Python layout to 1 µm', () => {
    for (const m of vectors) {
      const shapes = ringShapes(m.id, m.diameter)
      expect(shapes.length).toBe(m.shapes.length)
      shapes.forEach((s, i) => {
        expect(s.kind).toBe(m.shapes[i].kind)
        for (const [k, v] of Object.entries(m.shapes[i])) if (typeof v === 'number') expect((s as any)[k]).toBeCloseTo(v as number, 3)
      })
    }
  })
  it('refuses sizes above the bed limit', () => {
    expect(() => ringShapes(1, RING_MAX_DIAMETER_MM + 1)).toThrow()
  })
  it('sizes the plaque from the diameter', () => {
    expect(ringPlaqueSizeMm(140)).toBe(150)
  })
  it('draws an SVG sized in millimetres', () => {
    const svg = ringMarkerSvg(0x2e3d4c5b, 140)
    expect(svg).toMatch(/^<svg[^>]+width="[\d.]+mm"/)
    expect(svg).toContain('viewBox=')
  })
})
