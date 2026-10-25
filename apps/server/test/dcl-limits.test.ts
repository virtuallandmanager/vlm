import { describe, it, expect } from 'vitest'
import { plotParcels, parseParcel, dclBudget, validPlot } from 'vlm-shared'

describe('Decentraland plot geometry and budget', () => {
  it('plotParcels lists every parcel from the base', () => {
    expect(plotParcels({ width: 2, depth: 2, base: { x: 0, y: 0 } })).toEqual(['0,0', '1,0', '0,1', '1,1'])
    expect(plotParcels({ width: 1, depth: 1, base: { x: -3, y: 5 } })).toEqual(['-3,5'])
  })
  it('dclBudget scales per parcel and reserves runtime entities', () => {
    expect(dclBudget(4)).toEqual({ triangles: 40_000, entities: 780, files: 800, maxFileBytes: 52_428_800 })
  })
  it('validPlot refuses fractional, zero and oversized plots', () => {
    expect(validPlot({ width: 3, depth: 3, base: { x: 0, y: 0 } })).toBe(true)
    for (const p of [{ width: 0, depth: 1 }, { width: 1.5, depth: 1 }, { width: 11, depth: 1 }, null, 'x'])
      expect(validPlot(p && typeof p === 'object' ? { ...p, base: { x: 0, y: 0 } } : p)).toBe(false)
  })
  it('parseParcel', () => {
    expect(parseParcel('-3,5')).toEqual({ x: -3, y: 5 })
    expect(parseParcel('a,b')).toBeNull()
  })
})
