import { Object3D, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { Gizmo, type GizmoNode } from '../src/edit/gizmo.js'
import type { GizmoHandle } from '../src/edit/controller.js'

/** Hyperfy-like nodes on three.js Object3D, so the parts' world placement can be measured. */
function build() {
  const handles = new Map<Object3D, { data?: Record<string, unknown> }>()
  const pressed: GizmoHandle[] = []
  const root = new Object3D()
  const host = {
    create(_type: 'group' | 'prim', data?: Record<string, unknown>) {
      const n = new Object3D()
      handles.set(n, { data })
      return n as unknown as GizmoNode
    },
    add: (n: GizmoNode) => root.add(n as unknown as Object3D),
    remove: (n: GizmoNode) => root.remove(n as unknown as Object3D),
  }
  const gizmo = new Gizmo(host, { down: (h) => pressed.push(h), enter() {}, leave() {} })
  return { gizmo, root, handles, pressed }
}

describe('Gizmo', () => {
  it('each arrow tip points along its VLM axis (Hyperfy z mirrored)', () => {
    const { gizmo, root, handles, pressed } = build()
    gizmo.show('move', [0, 0, 0])
    root.updateMatrixWorld(true)
    const tips: Record<string, Vector3> = {}
    for (const [node, { data }] of handles) {
      if (data?.type !== 'cone') continue
      ;(node as unknown as GizmoNode).onPointerDown!()
      const h = pressed.pop()!
      if (h.kind === 'arrow') tips[h.axis] = node.getWorldPosition(new Vector3())
    }
    // VLM (x, y, z) is Hyperfy (x, y, -z).
    const vlm = (p: Vector3) => ({ x: p.x, y: p.y, z: -p.z })
    expect(vlm(tips.x).x).toBeGreaterThan(0.5)
    expect(vlm(tips.y).y).toBeGreaterThan(0.5)
    expect(vlm(tips.z).z).toBeGreaterThan(0.5)
    for (const [axis, tip] of Object.entries(tips)) {
      const p = vlm(tip)
      for (const other of ['x', 'y', 'z'] as const) if (other !== axis) expect(Math.abs(p[other])).toBeLessThan(1e-9)
    }
  })
})
