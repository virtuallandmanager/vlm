import { describe, expect, it } from 'vitest'
import { Euler, Matrix4, Quaternion, Vector3 } from 'three'
import { MODEL_TURN, toHyperfyTransform, toVirviPosition, worldToLocal } from '../src/transform.js'

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

  it('a 90° yaw in Virvi faces the same way after mapping', () => {
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

describe('MODEL_TURN', () => {
  it('a model placed with the mapped transform and turned by MODEL_TURN inside it lands where Decentraland shows it', () => {
    // Decentraland shows a glTF point g at local (-gx, gy, gz), then applies the element's transform.
    const [rx, ry, rz] = [20, 135, -10]
    const virvi = { position: v(4, 1, 7), rotation: v(rx, ry, rz), scale: v(2, 3, 0.5) }
    const dclQ = new Quaternion().setFromEuler(new Euler(rad(rx), rad(ry), rad(rz), 'YXZ'))
    const t = toHyperfyTransform(virvi)
    const group = new Matrix4().compose(
      new Vector3(...t.position),
      new Quaternion().setFromEuler(new Euler(t.rotation[0], t.rotation[1], t.rotation[2], 'YXZ')),
      new Vector3(...t.scale),
    )
    const inner = new Matrix4().makeRotationFromEuler(new Euler(MODEL_TURN[0], MODEL_TURN[1], MODEL_TURN[2], 'YXZ'))
    for (const g of [new Vector3(1, 0, 0), new Vector3(0, 0, 1), new Vector3(0.3, -2, 5)]) {
      const dcl = new Vector3(-g.x, g.y, g.z).multiply(new Vector3(2, 3, 0.5)).applyQuaternion(dclQ).add(new Vector3(4, 1, 7))
      const expected = new Vector3(dcl.x, dcl.y, -dcl.z)
      const actual = g.clone().applyMatrix4(inner).applyMatrix4(group)
      expect(actual.x).toBeCloseTo(expected.x)
      expect(actual.y).toBeCloseTo(expected.y)
      expect(actual.z).toBeCloseTo(expected.z)
    }
  })
})

describe('toVirviPosition and worldToLocal', () => {
  it('toVirviPosition undoes the position mapping of toHyperfyTransform', () => {
    const t = toHyperfyTransform({ position: v(1, 2, 3), rotation: v(0, 0, 0), scale: v(1, 1, 1) })
    expect(toVirviPosition({ x: t.position[0], y: t.position[1], z: t.position[2] })).toEqual(v(1, 2, 3))
  })

  it('a world position under a moved, turned and scaled app comes back as the Virvi position', () => {
    const root = new Matrix4().compose(new Vector3(10, -2, 30), new Quaternion().setFromEuler(new Euler(0, 1.1, 0.2)), new Vector3(2, 2, 2))
    const inverse = root.clone().invert()
    const virvi = v(4, 1.5, -6)
    const t = toHyperfyTransform({ position: virvi, rotation: v(0, 0, 0), scale: v(1, 1, 1) })
    const world = new Vector3(...t.position).applyMatrix4(root)
    const back = toVirviPosition(worldToLocal(world, inverse))
    expect(back.x).toBeCloseTo(virvi.x)
    expect(back.y).toBeCloseTo(virvi.y)
    expect(back.z).toBeCloseTo(virvi.z)
  })

  it('with the app at the origin, only z flips', () => {
    expect(toVirviPosition(worldToLocal({ x: 1, y: 2, z: 3 }, new Matrix4()))).toEqual(v(1, 2, -3))
  })
})
