import { describe, it, expect, vi } from 'vitest'
import type { TransformData, Vec3 } from 'vlm-shared'
import { TransformSession, type Selected } from '../src/transform/session.js'
import {
  AXIS_VECTORS,
  eulerDegreesToQuat,
  normalize,
  quatFromAxisAngle,
  quatMultiply,
  quatToEulerDegrees,
  type Ray,
} from '../src/transform/math.js'

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z })
const down = (x: number, y: number, z: number): Ray => ({ origin: v(x, y, z), direction: v(0, -1, 0) })
const toward = (origin: Vec3, dir: Vec3): Ray => ({ origin, direction: normalize(dir) })

const item = (transform?: Partial<TransformData>): Selected => ({
  element: 'model',
  sk: 'model#1',
  name: 'Crate',
  transform: {
    position: v(1, 2, 3),
    rotation: v(0, 0, 0),
    scale: v(1, 1, 1),
    ...transform,
  },
})

function make(opts: { interval?: number } = {}) {
  let t = 0
  const onDraft = vi.fn()
  const session = new TransformSession({ now: () => t, onDraft, draftIntervalMs: opts.interval })
  return { session, onDraft, setTime: (n: number) => (t = n) }
}

function selected(transform?: Partial<TransformData>, mode: 'move' | 'rotate' | 'resize' = 'move') {
  const h = make()
  expect(h.session.select(item(transform))).toBe('ok')
  h.session.setMode(mode)
  return h
}

describe('TransformSession selection', () => {
  it('starts empty and clean', () => {
    const { session } = make()
    expect(session.selected).toBeNull()
    expect(session.draft).toBeNull()
    expect(session.dirty).toBe(false)
    expect(session.mode).toBe('move')
    expect(session.lock).toBe('free')
  })

  it('selecting exposes the item and a draft equal to its transform', () => {
    const { session } = selected()
    expect(session.selected?.sk).toBe('model#1')
    expect(session.draft).toEqual(item().transform)
    expect(session.dirty).toBe(false)
  })

  it('refuses a new selection while dirty, even the same sk', () => {
    const { session } = selected()
    session.beginDrag({ kind: 'body' }, down(0, 10, 0), v(5, 0, 5))
    session.drag(down(0, 10, 0), v(6, 0, 6))
    session.endDrag()
    expect(session.dirty).toBe(true)
    expect(session.select({ ...item(), sk: 'model#2' })).toBe('dirty')
    expect(session.select(item())).toBe('dirty')
    expect(session.selected?.sk).toBe('model#1')
  })

  it('accepts a new selection once saved', () => {
    const { session } = selected()
    session.beginDrag({ kind: 'body' }, down(0, 10, 0), v(5, 0, 5))
    session.drag(down(0, 10, 0), v(6, 0, 6))
    session.endDrag()
    session.takeSave()
    expect(session.select({ ...item(), sk: 'model#2' })).toBe('ok')
    expect(session.selected?.sk).toBe('model#2')
  })

  it('does not alias the caller transform', () => {
    const { session } = make()
    const it = item()
    session.select(it)
    session.setMode('move')
    session.beginDrag({ kind: 'body' }, down(0, 10, 0), v(5, 0, 5))
    session.drag(down(0, 10, 0), v(6, 0, 6))
    expect(it.transform.position).toEqual(v(1, 2, 3))
  })

  it('clear drops selection, draft and drag state', () => {
    const { session, onDraft } = selected()
    session.beginDrag({ kind: 'body' }, down(0, 10, 0), v(5, 0, 5))
    session.clear()
    expect(session.selected).toBeNull()
    expect(session.draft).toBeNull()
    expect(session.dirty).toBe(false)
    session.drag(down(0, 10, 0), v(6, 0, 6))
    session.endDrag()
    expect(session.draft).toBeNull()
    expect(onDraft).not.toHaveBeenCalled()
  })
})

describe('TransformSession move', () => {
  it('free move snaps to the surface hit', () => {
    const { session } = selected()
    session.beginDrag({ kind: 'body' }, down(0, 10, 0), null)
    session.drag(down(0, 10, 0), v(3, 0, 4))
    expect(session.draft?.position).toEqual(v(3, 0, 4))
    expect(session.draft?.rotation).toEqual(v(0, 0, 0))
    expect(session.dirty).toBe(true)
  })

  it('ignores a surface hit farther than 50 m and uses the fallback plane through the item', () => {
    const { session } = selected()
    const ray = toward(v(0, 10, 0), v(1, -1, 0))
    session.beginDrag({ kind: 'body' }, ray, null)
    session.drag(ray, v(100, 0, 0))
    expect(session.draft?.position.x).toBeCloseTo(8)
    expect(session.draft?.position.y).toBeCloseTo(2)
    expect(session.draft?.position.z).toBeCloseTo(0)
  })

  it('leaves the draft unchanged when there is no hit and the ray is parallel to the plane', () => {
    const { session, onDraft } = selected()
    const flat = toward(v(0, 2, 0), v(1, 0, 0))
    session.beginDrag({ kind: 'body' }, flat, null)
    session.drag(flat, null)
    expect(session.draft).toEqual(item().transform)
    expect(session.dirty).toBe(false)
    expect(onDraft).not.toHaveBeenCalled()
  })

  it('leaves the draft unchanged when the fallback plane is behind the ray', () => {
    const { session } = selected()
    const up = toward(v(0, 10, 0), v(0, 1, 0))
    session.beginDrag({ kind: 'body' }, up, null)
    session.drag(up, null)
    expect(session.draft).toEqual(item().transform)
  })

  it('cycles the lock free -> x -> y -> z -> free', () => {
    const { session } = selected()
    expect([session.cycleLock(), session.cycleLock(), session.cycleLock(), session.cycleLock()]).toEqual([
      'x',
      'y',
      'z',
      'free',
    ])
    expect(session.lock).toBe('free')
  })

  it('axis lock moves only along the axis by the closest-point delta', () => {
    const { session } = selected()
    session.cycleLock() // x
    session.beginDrag({ kind: 'body' }, down(2, 5, 3), null)
    session.drag(down(6, 5, 9), v(0, 0, 0))
    expect(session.draft?.position.x).toBeCloseTo(5) // 1 + (6 - 2)
    expect(session.draft?.position.y).toBe(2)
    expect(session.draft?.position.z).toBe(3)
  })

  it('axis lock ignores a near-parallel ray (null closest point)', () => {
    const { session } = selected()
    session.cycleLock() // x
    session.beginDrag({ kind: 'body' }, down(2, 5, 3), null)
    session.drag(toward(v(0, 2, 3), v(1, 0, 0)), null)
    expect(session.draft).toEqual(item().transform)
  })

  it('rebases when the lock changes mid-drag', () => {
    const { session } = selected()
    session.cycleLock() // x
    session.beginDrag({ kind: 'body' }, down(2, 5, 3), null)
    session.drag(down(6, 5, 3), null)
    expect(session.draft?.position.x).toBeCloseTo(5)
    session.cycleLock() // y
    // new grab happens at the next drag from the draft; first frame must not jump
    const side = toward(v(10, 4, 5), v(-1, 0, 0))
    session.drag(side, null)
    expect(session.draft?.position).toEqual(v(5, 2, 3))
    session.drag(toward(v(10, 7, 5), v(-1, 0, 0)), null)
    expect(session.draft?.position.x).toBeCloseTo(5)
    expect(session.draft?.position.y).toBeCloseTo(5) // 2 + (7 - 4)
    expect(session.draft?.position.z).toBeCloseTo(3)
  })

  it('axis lock retries an unresolved grab on the next frame instead of dying', () => {
    const { session } = selected()
    session.cycleLock() // x
    session.beginDrag({ kind: 'body' }, toward(v(0, 2, 3), v(1, 0, 0)), null) // parallel: no grab
    session.drag(down(2, 5, 3), null) // becomes the grab; no movement
    expect(session.draft).toEqual(item().transform)
    session.drag(down(6, 5, 3), null)
    expect(session.draft?.position.x).toBeCloseTo(5) // 1 + (6 - 2)
  })

  it('cycleLock while not dragging only changes the lock', () => {
    const { session } = selected()
    session.cycleLock()
    expect(session.lock).toBe('x')
    expect(session.dirty).toBe(false)
  })

  it('ignores a handle that does not fit the mode', () => {
    const { session } = selected()
    session.beginDrag({ kind: 'ring', axis: 'x' }, down(0, 10, 0), null)
    session.drag(down(0, 10, 0), v(9, 9, 9))
    expect(session.draft).toEqual(item().transform)
    session.endDrag()
  })
})

describe('TransformSession rotate', () => {
  const origin = { position: v(0, 0, 0) }

  it('composes the ring delta with the start rotation (non-commuting)', () => {
    const { session } = selected({ ...origin, rotation: v(0, 90, 0) }, 'rotate')
    session.beginDrag({ kind: 'ring', axis: 'x' }, toward(v(5, 1, 0), v(-1, 0, 0)), null)
    session.drag(toward(v(5, 0, 1), v(-1, 0, 0)), null) // +90 degrees about x
    const expected = quatToEulerDegrees(
      quatMultiply(quatFromAxisAngle(AXIS_VECTORS.x, 90), eulerDegreesToQuat(v(0, 90, 0))),
    )
    const wrongOrder = quatToEulerDegrees(
      quatMultiply(eulerDegreesToQuat(v(0, 90, 0)), quatFromAxisAngle(AXIS_VECTORS.x, 90)),
    )
    const r = session.draft!.rotation
    expect(r.x).toBeCloseTo(expected.x, 4)
    expect(r.y).toBeCloseTo(expected.y, 4)
    expect(r.z).toBeCloseTo(expected.z, 4)
    expect(Math.abs(r.z - wrongOrder.z) + Math.abs(r.x - wrongOrder.x)).toBeGreaterThan(1)
  })

  it('snaps the total delta to 15 degrees when snap is on', () => {
    const { session } = selected(origin, 'rotate')
    session.setSnap(true)
    const a = (deg: number) => {
      const r = (deg * Math.PI) / 180
      return toward(v(5, Math.cos(r), Math.sin(r)), v(-1, 0, 0))
    }
    session.beginDrag({ kind: 'ring', axis: 'x' }, a(0), null)
    session.drag(a(20), null)
    expect(session.draft?.rotation.x).toBeCloseTo(15, 4)
  })

  it('toggling snap mid-drag re-evaluates from the drag start', () => {
    const { session } = selected(origin, 'rotate')
    const a = (deg: number) => {
      const r = (deg * Math.PI) / 180
      return toward(v(5, Math.cos(r), Math.sin(r)), v(-1, 0, 0))
    }
    session.beginDrag({ kind: 'ring', axis: 'x' }, a(0), null)
    session.drag(a(20), null)
    expect(session.draft?.rotation.x).toBeCloseTo(20, 4)
    session.setSnap(true)
    session.drag(a(21), null)
    expect(session.draft?.rotation.x).toBeCloseTo(15, 4)
    session.setSnap(false)
    session.drag(a(22), null)
    expect(session.draft?.rotation.x).toBeCloseTo(22, 4)
  })

  it('accumulates across the +-180 boundary without jumping', () => {
    const { session } = selected(origin, 'rotate')
    const a = (deg: number) => {
      const r = (deg * Math.PI) / 180
      return down(Math.sin(r), 5, Math.cos(r)) // hits y=0 plane at angle deg from +z toward +x
    }
    session.beginDrag({ kind: 'ring', axis: 'y' }, a(170), null)
    session.drag(a(180), null)
    session.drag(a(-170), null) // total +20
    expect(session.draft?.rotation.x).toBeCloseTo(0, 4)
    expect(session.draft?.rotation.y).toBeCloseTo(20, 4)
    session.drag(a(-160), null) // total +30
    expect(session.draft?.rotation.y).toBeCloseTo(30, 4)
  })

  it('leaves the draft unchanged when the ray misses the ring plane', () => {
    const { session } = selected(origin, 'rotate')
    session.beginDrag({ kind: 'ring', axis: 'x' }, toward(v(5, 1, 0), v(-1, 0, 0)), null)
    session.drag(toward(v(0, 1, 0), v(0, 0, 1)), null)
    expect(session.draft).toEqual({ ...item().transform, ...origin })
  })

  it('a ring click with no movement leaves an awkward start rotation untouched and clean', () => {
    for (const rotation of [v(-10, 370, 5), v(90, 0, 30), v(-90, 45, 20)]) {
      const { session, onDraft } = selected({ ...origin, rotation }, 'rotate')
      const ray = toward(v(5, 1, 0), v(-1, 0, 0))
      session.beginDrag({ kind: 'ring', axis: 'x' }, ray, null)
      session.drag(ray, null)
      session.endDrag()
      expect(session.draft?.rotation).toEqual(rotation)
      expect(session.dirty).toBe(false)
      expect(onDraft).not.toHaveBeenCalled()
    }
  })

  it('snap that rounds the delta to zero keeps the exact start rotation', () => {
    const { session } = selected({ ...origin, rotation: v(90, 0, 30) }, 'rotate')
    session.setSnap(true)
    const a = (deg: number) => {
      const r = (deg * Math.PI) / 180
      return toward(v(5, Math.cos(r), Math.sin(r)), v(-1, 0, 0))
    }
    session.beginDrag({ kind: 'ring', axis: 'x' }, a(0), null)
    session.drag(a(5), null)
    expect(session.draft?.rotation).toEqual(v(90, 0, 30))
    expect(session.dirty).toBe(false)
  })

  it('rotating +30 then back -30 reads clean', () => {
    const { session } = selected({ ...origin, rotation: v(10, 20, 30) }, 'rotate')
    const a = (deg: number) => {
      const r = (deg * Math.PI) / 180
      return toward(v(5, Math.cos(r), Math.sin(r)), v(-1, 0, 0))
    }
    session.beginDrag({ kind: 'ring', axis: 'x' }, a(0), null)
    session.drag(a(30), null)
    expect(session.dirty).toBe(true)
    session.drag(a(0), null)
    expect(session.dirty).toBe(false)
  })

  it('rotating back to a start near 0 reads clean even if it lands at 359.99999', () => {
    const { session } = selected({ ...origin, rotation: v(0, 0, 0) }, 'rotate')
    const a = (deg: number) => {
      const r = (deg * Math.PI) / 180
      return toward(v(5, Math.cos(r), Math.sin(r)), v(-1, 0, 0))
    }
    session.beginDrag({ kind: 'ring', axis: 'x' }, a(0), null)
    session.drag(a(-30), null)
    session.drag(a(0), null)
    expect(session.dirty).toBe(false)
  })

  it('ignores a body handle in rotate mode', () => {
    const { session } = selected(origin, 'rotate')
    session.beginDrag({ kind: 'body' }, down(0, 5, 0), null)
    session.drag(down(0, 5, 0), v(4, 4, 4))
    expect(session.draft).toEqual({ ...item().transform, ...origin })
  })
})

describe('TransformSession resize', () => {
  const origin = { position: v(0, 0, 0) }
  const facing = (x: number) => toward(v(x, 0, 10), v(0, 0, -1))

  it('uniform scales by the distance ratio on the camera-facing plane', () => {
    const { session } = selected({ ...origin, scale: v(2, 1, 0.5) }, 'resize')
    session.beginDrag({ kind: 'uniform' }, facing(2), null)
    session.drag(facing(3), null)
    expect(session.draft?.scale.x).toBeCloseTo(3)
    expect(session.draft?.scale.y).toBeCloseTo(1.5)
    expect(session.draft?.scale.z).toBeCloseTo(0.75)
  })

  it('uniform snaps the factor to 0.1', () => {
    const { session } = selected(origin, 'resize')
    session.setSnap(true)
    session.beginDrag({ kind: 'uniform' }, facing(2), null)
    session.drag(facing(2.62), null)
    expect(session.draft?.scale.x).toBeCloseTo(1.3)
    expect(session.draft?.scale.y).toBeCloseTo(1.3)
  })

  it('uniform snap never goes below a factor of 0.1', () => {
    const { session } = selected(origin, 'resize')
    session.setSnap(true)
    session.beginDrag({ kind: 'uniform' }, facing(2), null)
    session.drag(facing(0.02), null)
    expect(session.draft?.scale.x).toBeCloseTo(0.1)
  })

  it('uniform floors components at 0.05', () => {
    const { session } = selected(origin, 'resize')
    session.beginDrag({ kind: 'uniform' }, facing(2), null)
    session.drag(facing(0.05), null)
    expect(session.draft?.scale).toEqual(v(0.05, 0.05, 0.05))
  })

  it('uniform does nothing when grabbed at the item centre', () => {
    const { session } = selected(origin, 'resize')
    session.beginDrag({ kind: 'uniform' }, facing(0.005), null)
    session.drag(facing(3), null)
    expect(session.draft).toEqual({ ...item().transform, ...origin })
  })

  it('uniform uses a plane fixed at drag start, not the current ray direction', () => {
    const { session } = selected(origin, 'resize')
    session.beginDrag({ kind: 'uniform' }, facing(2), null)
    // Oblique ray at x=4 on the z=0 plane
    session.drag(toward(v(4, 0, 10), v(0, 0, -1)), null)
    expect(session.draft?.scale.x).toBeCloseTo(2)
  })

  it('stretch changes only its axis, proportional to distance from the centre', () => {
    const { session } = selected({ ...origin, scale: v(2, 1, 1) }, 'resize')
    session.beginDrag({ kind: 'stretch', axis: 'x' }, down(4, 5, 0), null)
    session.drag(down(6, 5, 0), null)
    expect(session.draft?.scale).toEqual(v(3, 1, 1))
  })

  it('stretch is symmetric across the item centre', () => {
    const { session } = selected({ ...origin, scale: v(2, 1, 1) }, 'resize')
    session.beginDrag({ kind: 'stretch', axis: 'x' }, down(4, 5, 0), null)
    session.drag(down(-6, 5, 0), null)
    expect(session.draft?.scale.x).toBeCloseTo(3)
  })

  it('stretch snaps the resulting size to 0.25', () => {
    const { session } = selected({ ...origin, scale: v(2, 1, 1) }, 'resize')
    session.setSnap(true)
    session.beginDrag({ kind: 'stretch', axis: 'x' }, down(4, 5, 0), null)
    session.drag(down(5.3, 5, 0), null) // size 2.65
    expect(session.draft?.scale.x).toBeCloseTo(2.75)
    expect(session.draft?.scale.y).toBe(1)
  })

  it('stretch snap never goes below 0.25, and unsnapped floors at 0.05', () => {
    const { session } = selected({ ...origin, scale: v(2, 1, 1) }, 'resize')
    session.beginDrag({ kind: 'stretch', axis: 'y' }, toward(v(5, 4, 0), v(-1, 0, 0)), null)
    session.drag(toward(v(5, 0.01, 0), v(-1, 0, 0)), null)
    expect(session.draft?.scale.y).toBeCloseTo(0.05)
    session.setSnap(true)
    session.drag(toward(v(5, 0.01, 0), v(-1, 0, 0)), null)
    expect(session.draft?.scale.y).toBeCloseTo(0.25)
  })

  it('stretch does nothing when grabbed at the centre', () => {
    const { session } = selected({ ...origin, scale: v(2, 1, 1) }, 'resize')
    session.beginDrag({ kind: 'stretch', axis: 'x' }, down(0.005, 5, 0), null)
    session.drag(down(5, 5, 0), null)
    expect(session.draft?.scale).toEqual(v(2, 1, 1))
  })

  it("stretch follows the item's own axes: yaw 90 X handle tracks local X (scene -Z), not scene X", () => {
    const { session } = selected({ ...origin, rotation: v(0, 90, 0), scale: v(2, 1, 1) }, 'resize')
    session.beginDrag({ kind: 'stretch', axis: 'x' }, down(0, 5, -4), null)
    session.drag(down(0, 5, -6), null) // along local X
    expect(session.draft?.scale.x).toBeCloseTo(3)
    expect(session.draft?.scale.y).toBe(1)
    expect(session.draft?.scale.z).toBe(1)
    session.drag(down(3, 5, -6), null) // along scene X: no change
    expect(session.draft?.scale.x).toBeCloseTo(3)
  })

  it('stretch along scene X does nothing for a yaw-90 item grabbed on its local X', () => {
    const { session } = selected({ ...origin, rotation: v(0, 90, 0), scale: v(2, 1, 1) }, 'resize')
    session.beginDrag({ kind: 'stretch', axis: 'x' }, down(0, 5, -4), null)
    session.drag(down(5, 5, -4), null)
    expect(session.draft?.scale).toEqual(v(2, 1, 1))
  })

  it('stretch ignores a closest point farther than 50 m from the ray origin', () => {
    const { session } = selected({ ...origin, scale: v(2, 1, 1) }, 'resize')
    session.beginDrag({ kind: 'stretch', axis: 'x' }, down(4, 5, 0), null)
    session.drag(down(6, 60, 0), null)
    expect(session.draft?.scale).toEqual(v(2, 1, 1))
  })
})

describe('TransformSession save / revert / emit', () => {
  function dragged() {
    const h = selected()
    h.session.beginDrag({ kind: 'body' }, down(0, 10, 0), null)
    h.session.drag(down(0, 10, 0), v(7, 0, 8))
    h.session.endDrag()
    return h
  }

  it('takeSave returns null when nothing changed', () => {
    const { session } = selected()
    expect(session.takeSave()).toBeNull()
  })

  it('takeSave returns the draft, marks clean, and becomes the new baseline', () => {
    const { session } = dragged()
    const saved = session.takeSave()
    expect(saved).toEqual({
      element: 'model',
      sk: 'model#1',
      transform: { position: v(7, 0, 8), rotation: v(0, 0, 0), scale: v(1, 1, 1) },
    })
    expect(session.dirty).toBe(false)
    expect(session.takeSave()).toBeNull()
    expect(session.revert()).toEqual(saved!.transform)
  })

  it('revert returns the selection-time transform and marks clean', () => {
    const { session } = dragged()
    expect(session.revert()).toEqual(item().transform)
    expect(session.draft).toEqual(item().transform)
    expect(session.dirty).toBe(false)
  })

  it('dragging back to the baseline is clean again', () => {
    const { session } = dragged()
    session.beginDrag({ kind: 'body' }, down(0, 10, 0), null)
    session.drag(down(0, 10, 0), v(1, 2, 3))
    session.endDrag()
    expect(session.dirty).toBe(false)
  })

  it('revert and takeSave with no selection return null', () => {
    const { session } = make()
    expect(session.revert()).toBeNull()
    expect(session.takeSave()).toBeNull()
  })

  it('emits on the first changing drag, then every >= 100 ms, and once more on endDrag', () => {
    const { session, onDraft, setTime } = selected()
    session.beginDrag({ kind: 'body' }, down(0, 10, 0), null)
    const frames = [0, 30, 60, 90, 120, 150]
    frames.forEach((t, i) => {
      setTime(t)
      session.drag(down(0, 10, 0), v(10 + i, 0, 0))
    })
    expect(onDraft).toHaveBeenCalledTimes(2)
    setTime(160)
    session.endDrag()
    expect(onDraft).toHaveBeenCalledTimes(3)
    const last = onDraft.mock.calls[2][0]
    expect(last).toEqual({
      element: 'model',
      sk: 'model#1',
      transform: { position: v(15, 0, 0), rotation: v(0, 0, 0), scale: v(1, 1, 1) },
    })
  })

  it('honours a custom draftIntervalMs', () => {
    const { session, onDraft, setTime } = make({ interval: 50 })
    session.select(item())
    session.beginDrag({ kind: 'body' }, down(0, 10, 0), null)
    ;[0, 30, 60].forEach((t, i) => {
      setTime(t)
      session.drag(down(0, 10, 0), v(10 + i, 0, 0))
    })
    expect(onDraft).toHaveBeenCalledTimes(2)
  })

  it('a bare click (drag that changes nothing) emits nothing, even on endDrag', () => {
    const { session, onDraft } = selected()
    session.beginDrag({ kind: 'body' }, down(0, 10, 0), null)
    session.drag(down(0, 10, 0), v(1, 2, 3))
    session.endDrag()
    expect(onDraft).not.toHaveBeenCalled()
  })

  it('endDrag emits a newer position that fell inside the throttle window, and only once', () => {
    const { session, onDraft, setTime } = selected()
    session.beginDrag({ kind: 'body' }, down(0, 10, 0), null)
    setTime(0)
    session.drag(down(0, 10, 0), v(10, 0, 0))
    setTime(30)
    session.drag(down(0, 10, 0), v(11, 0, 0))
    expect(onDraft).toHaveBeenCalledTimes(1)
    session.endDrag()
    expect(onDraft).toHaveBeenCalledTimes(2)
    expect(onDraft.mock.calls[1][0].transform.position).toEqual(v(11, 0, 0))
  })

  it('endDrag does not repeat a draft that was already emitted', () => {
    const { session, onDraft, setTime } = selected()
    session.beginDrag({ kind: 'body' }, down(0, 10, 0), null)
    setTime(0)
    session.drag(down(0, 10, 0), v(10, 0, 0))
    session.endDrag()
    expect(onDraft).toHaveBeenCalledTimes(1)
  })

  it('setMode during a drag flushes the unsent draft ignoring the throttle, then cancels the drag', () => {
    const { session, onDraft, setTime } = selected()
    session.beginDrag({ kind: 'body' }, down(0, 10, 0), null)
    setTime(0)
    session.drag(down(0, 10, 0), v(10, 0, 0))
    setTime(30)
    session.drag(down(0, 10, 0), v(11, 0, 0))
    expect(onDraft).toHaveBeenCalledTimes(1)
    session.setMode('rotate')
    expect(onDraft).toHaveBeenCalledTimes(2)
    expect(onDraft.mock.calls[1][0].transform.position).toEqual(v(11, 0, 0))
    session.drag(down(0, 10, 0), v(20, 0, 0))
    session.endDrag()
    expect(session.draft?.position).toEqual(v(11, 0, 0))
    expect(onDraft).toHaveBeenCalledTimes(2)
  })

  it('setMode during a drag with nothing unsent, or with no drag, emits nothing', () => {
    const { session, onDraft } = selected()
    session.setMode('rotate')
    session.setMode('move')
    session.beginDrag({ kind: 'body' }, down(0, 10, 0), null)
    session.drag(down(0, 10, 0), v(1, 2, 3))
    session.setMode('resize')
    expect(onDraft).not.toHaveBeenCalled()
  })

  it('selected returns a copy and takeSave updates the selection transform', () => {
    const { session } = dragged()
    session.selected!.transform.position.x = 999
    expect(session.selected?.transform.position).toEqual(v(1, 2, 3))
    session.takeSave()
    expect(session.selected?.transform.position).toEqual(v(7, 0, 8))
  })

  it('takeSave then a new drag then revert returns the saved transform', () => {
    const { session } = dragged()
    session.takeSave()
    session.beginDrag({ kind: 'body' }, down(0, 10, 0), null)
    session.drag(down(0, 10, 0), v(20, 0, 20))
    session.endDrag()
    expect(session.dirty).toBe(true)
    expect(session.revert()?.position).toEqual(v(7, 0, 8))
    expect(session.dirty).toBe(false)
  })

  it('takeSave during an active drag saves the current draft; further frames dirty it again', () => {
    const { session } = selected()
    session.beginDrag({ kind: 'body' }, down(0, 10, 0), null)
    session.drag(down(0, 10, 0), v(7, 0, 8))
    expect(session.takeSave()?.transform.position).toEqual(v(7, 0, 8))
    expect(session.dirty).toBe(false)
    session.drag(down(0, 10, 0), v(9, 0, 9))
    expect(session.dirty).toBe(true)
    expect(session.revert()?.position).toEqual(v(7, 0, 8))
  })

  it('endDrag without a drag does not emit', () => {
    const { session, onDraft } = selected()
    session.endDrag()
    expect(onDraft).not.toHaveBeenCalled()
  })

  it('never hands out internal objects', () => {
    const { session, onDraft } = selected()
    session.beginDrag({ kind: 'body' }, down(0, 10, 0), null)
    session.drag(down(0, 10, 0), v(7, 0, 8))
    session.endDrag()
    const payload = onDraft.mock.calls[0][0]
    payload.transform.position.x = 999
    const d = session.draft!
    d.position.x = 555
    expect(session.draft?.position.x).toBe(7)
    const saved = session.takeSave()!
    saved.transform.position.x = 123
    expect(session.draft?.position.x).toBe(7)
    expect(session.revert()?.position.x).toBe(7)
  })
})
