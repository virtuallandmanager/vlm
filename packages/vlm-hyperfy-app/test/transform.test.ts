import { describe, expect, it } from 'vitest'
import { Euler, Quaternion, Vector3 } from 'three'
import { toHyperfyTransform } from '../src/transform.js'

const v = (x: number, y: number, z: number) => ({ x, y, z })
const rad = (d: number) => (d * Math.PI) / 180

describe('toHyperfyTransform', () => {
  it('position z is mirrored', () => {
    const t = toHyperfyTransform({ position: v(1, 2, 3), rotation: v(0, 0, 0), scale: v(1, 1, 1) })
    expect(t.position).toEqual([1, 2, -3])
  })

  it('rotation degrees become radians with x and y negated', () => {
    const t = toHyperfyTransform({ position: v(0, 0, 0), rotation: v(10, 20, 30), scale: v(1, 1, 1) })
    expect(t.rotation[0]).toBeCloseTo(-rad(10))
    expect(t.rotation[1]).toBeCloseTo(-rad(20))
    expect(t.rotation[2]).toBeCloseTo(rad(30))
  })

  it('scale is unchanged', () => {
    const t = toHyperfyTransform({ position: v(0, 0, 0), rotation: v(0, 0, 0), scale: v(2, 3, 4) })
    expect(t.scale).toEqual([2, 3, 4])
  })

  it('a 90° yaw in VLM faces the same way after mapping', () => {
    const t = toHyperfyTransform({ position: v(0, 0, 0), rotation: v(0, 90, 0), scale: v(1, 1, 1) })
    // DCL forward (0,0,1) yawed 90° is (1,0,0); in Hyperfy that is still (1,0,0)
    const q = new Quaternion().setFromEuler(new Euler(t.rotation[0], t.rotation[1], t.rotation[2], 'YXZ'))
    const f = new Vector3(0, 0, -1).applyQuaternion(q) // Hyperfy forward is -Z, which is DCL +Z mirrored
    expect(f.x).toBeCloseTo(1)
    expect(f.y).toBeCloseTo(0)
    expect(f.z).toBeCloseTo(0)
  })

  it('a combined rotation (20, 135, -10) keeps forward, up and right pointing the same way', () => {
    const [rx, ry, rz] = [20, 135, -10]
    const dcl = new Quaternion().setFromEuler(new Euler(rad(rx), rad(ry), rad(rz), 'YXZ'))
    const t = toHyperfyTransform({ position: v(0, 0, 0), rotation: v(rx, ry, rz), scale: v(1, 1, 1) })
    const hf = new Quaternion().setFromEuler(new Euler(t.rotation[0], t.rotation[1], t.rotation[2], 'YXZ'))
    const mirror = (p: Vector3) => new Vector3(p.x, p.y, -p.z)
    // DCL basis: forward +Z, up +Y, right +X
    for (const base of [new Vector3(0, 0, 1), new Vector3(0, 1, 0), new Vector3(1, 0, 0)]) {
      const expected = mirror(base.clone().applyQuaternion(dcl))
      const actual = mirror(base).applyQuaternion(hf)
      expect(actual.x).toBeCloseTo(expected.x)
      expect(actual.y).toBeCloseTo(expected.y)
      expect(actual.z).toBeCloseTo(expected.z)
    }
  })
})
