import { describe, it, expect } from 'vitest'
import { parcelRects, mapBounds, toSvg } from './parcel-map'

describe('parcel map geometry', () => {
  it('places parcels relative to the base parcel in 16 m tiles', () => {
    expect(parcelRects(['10,20', '11,20', '10,21'], '10,20')).toEqual([
      { label: '10,20', x: 0, z: 0, size: 16 },
      { label: '11,20', x: 16, z: 0, size: 16 },
      { label: '10,21', x: 0, z: 16, size: 16 },
    ])
  })
  it('handles a base parcel that is not the south-west-most parcel', () => {
    expect(parcelRects(['5,5', '4,5'], '5,5').map((r) => r.x)).toEqual([0, -16])
  })
  it('bounds cover all parcels', () => {
    expect(mapBounds(['10,20', '11,21'], '10,20', [])).toEqual({ minX: 0, minZ: 0, maxX: 32, maxZ: 32 })
  })
  it('a location without parcels fits the data, snapped to 16 m', () => {
    expect(mapBounds([], null, [{ x: 3, z: 40 }, { x: 20, z: 2 }])).toEqual({ minX: 0, minZ: 0, maxX: 32, maxZ: 48 })
  })
  it('no parcels and no data → one tile', () => {
    expect(mapBounds([], null, [])).toEqual({ minX: 0, minZ: 0, maxX: 16, maxZ: 16 })
  })
  it('toSvg keeps aspect and puts north up', () => {
    const t = toSvg({ minX: 0, minZ: 0, maxX: 32, maxZ: 16 }, 320)
    expect(t.height).toBe(160)
    expect(t.px(0)).toBe(0)
    expect(t.px(32)).toBe(320)
    expect(t.py(16)).toBe(0)
    expect(t.py(0)).toBe(160)
  })
})
