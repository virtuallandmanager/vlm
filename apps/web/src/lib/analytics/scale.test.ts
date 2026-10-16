import { describe, it, expect } from 'vitest'
import { linearScale, niceTicks } from './scale'

describe('scales', () => {
  it('linearScale maps domain to range', () => {
    const s = linearScale([0, 10], [100, 0])
    expect(s(0)).toBe(100)
    expect(s(5)).toBe(50)
    expect(s(10)).toBe(0)
  })
  it('linearScale with an empty domain maps to the range start', () => {
    expect(linearScale([3, 3], [0, 50])(3)).toBe(0)
  })
  it('niceTicks picks 1/2/5 steps covering the max', () => {
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8])
    expect(niceTicks(100)).toEqual([0, 50, 100])
    expect(niceTicks(0)).toEqual([0, 1])
    expect(niceTicks(3)).toEqual([0, 1, 2, 3])
  })
})
