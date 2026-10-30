/** "Adjust rooms" on a scene's room set: per-room nudges on a fixed grid, and the panel's error copy. */
import { errorCode, wizardErrorMessage } from './wizard/run'

/** One room's move (metres, plot x/z) and turn (degrees about +Y), as `PUT /api/room-sets/:id` takes it. */
export interface RoomNudge { dx: number; dz: number; yaw: number }

export const MOVE_STEP_M = 0.05
export const TURN_STEP_DEG = 5

const ZERO: RoomNudge = { dx: 0, dz: 0, yaw: 0 }

/** `v` on the `step` grid, as the nearest multiple (no float drift, no -0). */
function onGrid(v: number, step: number): number {
  const n = Math.round(v / step)
  // Round through the step's decimals so 7 × 0.05 is 0.35, not 0.35000000000000003
  return Number((n * step).toFixed(6)) + 0
}

/** Within -180 (exclusive) .. 180. */
function wrapYaw(deg: number): number {
  const w = ((((deg + 180) % 360) + 360) % 360) - 180
  return w === -180 ? 180 : w + 0
}

/** `nudge` with one axis moved one step (0.05 m, or 5° for yaw) in `dir`, snapped to that axis's grid. */
export function stepNudge(nudge: RoomNudge, axis: keyof RoomNudge, dir: 1 | -1): RoomNudge {
  if (axis === 'yaw') return { ...nudge, yaw: wrapYaw(onGrid(nudge.yaw, TURN_STEP_DEG) + dir * TURN_STEP_DEG) }
  return { ...nudge, [axis]: onGrid(onGrid(nudge[axis], MOVE_STEP_M) + dir * MOVE_STEP_M, MOVE_STEP_M) }
}

/** One nudge per room: the stored ones (a new set stores none), the rest unmoved. */
export function nudgesFor(roomCount: number, stored: unknown): RoomNudge[] {
  const list = Array.isArray(stored) ? (stored as RoomNudge[]) : []
  return Array.from({ length: roomCount }, (_, i) => (list[i] ? { dx: list[i].dx, dz: list[i].dz, yaw: list[i].yaw } : { ...ZERO }))
}

export const SCAN_DELETED_MESSAGE = "This room's scan was deleted, so it can't be restyled or adjusted any more."

/** Plain words for a failed room-set read or save. */
export function roomSetErrorMessage(err: unknown): string {
  if (errorCode(err) === 'scan_deleted') return SCAN_DELETED_MESSAGE
  return wizardErrorMessage(err)
}
