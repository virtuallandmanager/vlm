import { MeshData, wallBox, type MeshPart, type V2 } from '../mesh.js'
import type { StyleKit } from './index.js'

const CANOPY_DEPTH = 0.4 // stays inside the 0.5 m plot margin
const CANOPY_THICKNESS = 0.08

/** Siding outer walls, a 25° pitched roof, and a canopy over the front door. */
export const house: StyleKit = {
  outerMaterial: { name: 'exterior-siding', color: '#AFC0C8' },
  roof: 'pitched',
  roofMaterial: { name: 'roof', color: '#7A3B2E' },
  outerWallHeight: ceiling => ceiling,
  extras: ({ door }) => {
    if (!door) return []
    const half = door.width / 2 + 0.15
    const from: V2 = [door.center[0] - door.along[0] * half, door.center[1] - door.along[1] * half]
    const to: V2 = [door.center[0] + door.along[0] * half, door.center[1] + door.along[1] * half]
    const y1 = Math.min(door.top + 0.18, door.wallTop)
    const mesh = new MeshData()
    wallBox(mesh, from, to, door.normal, 0, CANOPY_DEPTH, y1 - CANOPY_THICKNESS, y1)
    return [{ name: 'canopy', material: { name: 'canopy', color: '#5B4636' }, mesh } satisfies MeshPart]
  },
}
