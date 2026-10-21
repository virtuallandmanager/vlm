import { Euler, Matrix4, PerspectiveCamera, Quaternion, Raycaster, Vector2, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import { HYPERFY_DEFAULT_FOV, pointerRay, toVlmRay } from '../src/edit/rays.js'

const close = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) => {
  expect(a.x).toBeCloseTo(b.x, 6)
  expect(a.y).toBeCloseTo(b.y, 6)
  expect(a.z).toBeCloseTo(b.z, 6)
}

describe('pointerRay', () => {
  it('a locked pointer ray is the camera forward', () => {
    const quaternion = new Quaternion().setFromEuler(new Euler(0, Math.PI / 2, 0, 'YXZ')) // facing -x
    const ray = pointerRay({ position: new Vector3(1, 2, 3), quaternion }, null)
    close(ray.origin, { x: 1, y: 2, z: 3 })
    close(ray.direction, { x: -1, y: 0, z: 0 })
    // Third person: Hyperfy's camera sits `zoom` metres behind the rig along the rig's local +z.
    const back = pointerRay({ position: new Vector3(1, 2, 3), quaternion, zoom: 1.5 }, null)
    close(back.origin, { x: 2.5, y: 2, z: 3 })
    close(back.direction, { x: -1, y: 0, z: 0 })
  })

  it('an unlocked pointer ray uses the default fov', () => {
    // Hyperfy's camera: new THREE.PerspectiveCamera(70, ...) in src/core/World.js.
    expect(HYPERFY_DEFAULT_FOV).toBe(70)
    const camera = { position: new Vector3(0, 0, 0), quaternion: new Quaternion() }
    // Top centre of the screen (Hyperfy pointer coords run 0..1 with y down) is half the vertical fov up.
    const top = pointerRay(camera, { x: 0.5, y: 0, aspect: 16 / 9 })
    close(top.origin, { x: 0, y: 0, z: 0 })
    const half = (35 * Math.PI) / 180
    close(top.direction, { x: 0, y: Math.sin(half), z: -Math.cos(half) })

    // Matches three.js Raycaster.setFromCamera for a 70° camera, turned and moved, at an off-centre pointer.
    const cam = new PerspectiveCamera(70, 2, 0.2, 1200)
    cam.position.set(4, 1.6, -2)
    cam.quaternion.setFromEuler(new Euler(-0.3, 0.8, 0, 'YXZ'))
    cam.updateMatrixWorld()
    const rc = new Raycaster()
    rc.setFromCamera(new Vector2(0.8 * 2 - 1, -(0.25 * 2 - 1)), cam)
    const ray = pointerRay({ position: cam.position, quaternion: cam.quaternion }, { x: 0.8, y: 0.25, aspect: 2 })
    close(ray.origin, rc.ray.origin)
    close(ray.direction, rc.ray.direction)
  })
})

describe('toVlmRay', () => {
  it('takes a world ray into the app frame and mirrors z', () => {
    // App root at (10, 0, 0), scaled 2: world (12, 2, -4) is local (1, 1, -2), which is VLM (1, 1, 2).
    const root = new Matrix4().compose(new Vector3(10, 0, 0), new Quaternion(), new Vector3(2, 2, 2))
    const inverse = new Matrix4().copy(root).invert()
    const ray = toVlmRay({ origin: { x: 12, y: 2, z: -4 }, direction: { x: 0, y: 0, z: -1 } }, inverse)
    close(ray.origin, { x: 1, y: 1, z: 2 })
    close(ray.direction, { x: 0, y: 0, z: 1 })
    // No inverse: the app root is the world origin.
    const plain = toVlmRay({ origin: { x: 1, y: 2, z: 3 }, direction: { x: 0.6, y: 0, z: 0.8 } })
    close(plain.origin, { x: 1, y: 2, z: -3 })
    close(plain.direction, { x: 0.6, y: 0, z: -0.8 })
  })
})
