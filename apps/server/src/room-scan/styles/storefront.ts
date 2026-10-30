import { MeshData, wallBox, type MeshPart, type V2 } from '../mesh.js'
import type { StyleKit } from './index.js'

const AWNING_DEPTH = 0.4 // stays inside the 0.5 m plot margin
const SIGN_HEIGHT = 0.3
const MAX_SIGN_TEXT = 60

/**
 * A facade with a glass-tinted wall at the front door, an awning over the
 * door and a sign board above it. The sign's text is only the board's node
 * name (`sign: <text>`); the text itself isn't rendered.
 */
export const storefront: StyleKit = {
  outerMaterial: { name: 'exterior-storefront', color: '#6E7F8A' },
  roof: 'flat',
  roofMaterial: { name: 'roof', color: '#4F5357' },
  doorWallMaterial: { name: 'storefront-glass', color: '#7FB0C4', metallic: 0.2, roughness: 0.1 },
  outerWallHeight: ceiling => ceiling,
  extras: ({ door, signText }) => {
    if (!door) return []
    const span = (half: number): [V2, V2] => [
      [door.center[0] - door.along[0] * half, door.center[1] - door.along[1] * half],
      [door.center[0] + door.along[0] * half, door.center[1] + door.along[1] * half],
    ]
    const parts: MeshPart[] = []
    const awningTop = Math.min(door.top + 0.25, door.wallTop)
    const awning = new MeshData()
    const [a0, a1] = span(door.width / 2 + 0.2)
    wallBox(awning, a0, a1, door.normal, 0, AWNING_DEPTH, awningTop - 0.12, awningTop)
    parts.push({ name: 'awning', material: { name: 'awning', color: '#B8483E' }, mesh: awning })

    const text = (signText ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_SIGN_TEXT)
    if (text) {
      const y0 = Math.max(Math.min(awningTop + 0.05, door.wallTop - SIGN_HEIGHT), door.top)
      const sign = new MeshData()
      const [s0, s1] = span(Math.max(door.width, 1.2) / 2)
      wallBox(sign, s0, s1, door.normal, 0, 0.04, y0, y0 + SIGN_HEIGHT)
      parts.push({ name: `sign: ${text}`, material: { name: 'sign', color: '#2E2A26' }, mesh: sign })
    }
    return parts
  },
}
