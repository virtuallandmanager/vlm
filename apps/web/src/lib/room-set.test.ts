import { describe, expect, it } from 'vitest'
import { MOVE_STEP_M, ROOM_LAYOUT_NOTICE, TURN_STEP_DEG, nudgesFor, roomSetErrorMessage, sceneHasRoomSet, stepNudge } from './room-set'

describe('stepNudge', () => {
  const zero = { dx: 0, dz: 0, yaw: 0 }

  it('moves x and z by 0.05 m and turns by 5°', () => {
    expect(MOVE_STEP_M).toBe(0.05)
    expect(TURN_STEP_DEG).toBe(5)
    expect(stepNudge(zero, 'dx', 1)).toEqual({ dx: 0.05, dz: 0, yaw: 0 })
    expect(stepNudge(zero, 'dz', -1)).toEqual({ dx: 0, dz: -0.05, yaw: 0 })
    expect(stepNudge(zero, 'yaw', 1)).toEqual({ dx: 0, dz: 0, yaw: 5 })
  })

  it('lands on the grid without float drift after many steps', () => {
    let n = zero
    for (let i = 0; i < 7; i++) n = stepNudge(n, 'dx', 1)
    expect(n.dx).toBe(0.35)
    for (let i = 0; i < 3; i++) n = stepNudge(n, 'dx', -1)
    expect(n.dx).toBe(0.2)
  })

  it('snaps an off-grid value to the grid before stepping', () => {
    expect(stepNudge({ dx: 0.123, dz: 0, yaw: 0 }, 'dx', 1)).toEqual({ dx: 0.15, dz: 0, yaw: 0 })
    expect(stepNudge({ dx: 0, dz: 0, yaw: 2.4 }, 'yaw', -1)).toEqual({ dx: 0, dz: 0, yaw: -5 })
  })

  it('keeps yaw within -180..180', () => {
    expect(stepNudge({ dx: 0, dz: 0, yaw: 180 }, 'yaw', 1)).toEqual({ dx: 0, dz: 0, yaw: -175 })
    expect(stepNudge({ dx: 0, dz: 0, yaw: -175 }, 'yaw', -1)).toEqual({ dx: 0, dz: 0, yaw: 180 })
  })

  it('never shows negative zero', () => {
    expect(Object.is(stepNudge({ dx: 0.05, dz: 0, yaw: 0 }, 'dx', -1).dx, 0)).toBe(true)
  })
})

describe('nudgesFor', () => {
  it('fills a nudge per room, keeping the stored ones', () => {
    expect(nudgesFor(2, [])).toEqual([{ dx: 0, dz: 0, yaw: 0 }, { dx: 0, dz: 0, yaw: 0 }])
    expect(nudgesFor(2, [{ dx: 1, dz: 2, yaw: 5 }, { dx: 0, dz: 0, yaw: 0 }])).toEqual([{ dx: 1, dz: 2, yaw: 5 }, { dx: 0, dz: 0, yaw: 0 }])
    expect(nudgesFor(1, {})).toEqual([{ dx: 0, dz: 0, yaw: 0 }])
  })
})

describe('roomSetErrorMessage', () => {
  it('explains a deleted scan in plain words', () => {
    const err = Object.assign(new Error('scan_deleted'), { status: 409, body: { error: 'scan_deleted' } })
    expect(roomSetErrorMessage(err)).toBe("This room's scan was deleted, so it can't be restyled or adjusted any more.")
  })
})

describe('sceneHasRoomSet', () => {
  it('is true when any element is a room set, false otherwise', () => {
    expect(sceneHasRoomSet([])).toBe(false)
    expect(sceneHasRoomSet([{ roomSetId: null }, {}])).toBe(false)
    expect(sceneHasRoomSet([{ roomSetId: null }, { roomSetId: 'set-1' }])).toBe(true)
  })

  it("has the spec's exact notice", () => {
    expect(ROOM_LAYOUT_NOTICE).toBe("This World will show your room's layout to anyone who visits.")
  })
})
