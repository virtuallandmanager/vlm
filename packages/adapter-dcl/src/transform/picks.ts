// Editor-only click areas: pointer colliders on images and videos, the pointer bit on model meshes, and a marker
// sphere per sound. All on CL_POINTER (never CL_PHYSICS); clear() undoes exactly what was added.
import { engine, Entity, Transform, MeshRenderer, MeshCollider, Material, GltfContainer, ColliderLayer } from '@dcl/sdk/ecs'
import type { PBMeshCollider } from '@dcl/sdk/ecs'
import { Color4, Vector3 } from '@dcl/sdk/math'
import type { ElementKind } from '@virvixr/core'
import type { EntityHandle, Vec3 } from '@virvixr/shared'

export const MARKER_SIZE = 0.3
const MARKER_COLOR = Color4.create(1, 0.6, 0.1, 1)

/** How an item was made clickable, so it can be undone exactly. */
export type Pick = {
  sk: string
  element: ElementKind
  entity: Entity
  how: 'self' | 'child' | 'mask' | 'marker'
  helper: Entity | null
  prevMask?: number
}

const isOurPlane = (mc: PBMeshCollider | null): boolean =>
  mc?.mesh?.$case === 'plane' && mc.collisionMask === ColliderLayer.CL_POINTER

export function entityPosition(entity: Entity, up = 0): Vec3 | null {
  const pos = Transform.getOrNull(entity)?.position
  return pos ? { x: pos.x, y: pos.y + up, z: pos.z } : null
}

/** Moves an entity only when its position actually changed. */
export function follow(entity: Entity, pos: Vec3): void {
  const t = Transform.getOrNull(entity)
  if (!t) return
  if (Math.abs(t.position.x - pos.x) < 1e-4 && Math.abs(t.position.y - pos.y) < 1e-4 && Math.abs(t.position.z - pos.z) < 1e-4) return
  Transform.getMutable(entity).position = Vector3.create(pos.x, pos.y, pos.z)
}

export class Picks {
  private picks = new Map<string, Pick>()
  private byEntity = new Map<Entity, string>()
  private helpers = new Set<Entity>()

  get(sk: string): Pick | undefined {
    return this.picks.get(sk)
  }

  /** The sk behind an item entity or one of its helpers. */
  skAt(entity: Entity): string | null {
    return this.byEntity.get(entity) ?? null
  }

  isHelper(entity: Entity): boolean {
    return this.helpers.has(entity)
  }

  /**
   * Adds click areas for new items, drops them for removed ones, and re-applies any a manager replaced.
   * Returns sk → item entity for every live item.
   */
  sync(items: { sk: string; element: ElementKind; entity: EntityHandle }[]): Map<string, Entity> {
    const live = new Map<string, Entity>()
    for (const item of items) {
      const entity = item.entity as Entity
      live.set(item.sk, entity)
      const p = this.picks.get(item.sk)
      if (p && p.entity === entity) this.refresh(p)
      else {
        if (p) this.remove(p)
        this.picks.delete(item.sk)
        this.add(item.sk, item.element, entity)
      }
    }
    for (const [sk, p] of this.picks) {
      if (live.has(sk)) continue
      this.remove(p)
      this.picks.delete(sk)
    }
    this.byEntity.clear()
    this.helpers.clear()
    for (const p of this.picks.values()) {
      this.byEntity.set(p.entity, p.sk)
      if (p.helper !== null) {
        this.byEntity.set(p.helper, p.sk)
        this.helpers.add(p.helper)
      }
    }
    return live
  }

  /** Sound markers follow their sounds. */
  followItems(): void {
    for (const p of this.picks.values()) {
      if (p.how !== 'marker' || p.helper === null) continue
      const pos = entityPosition(p.entity)
      if (pos) follow(p.helper, pos)
    }
  }

  clear(): void {
    for (const p of this.picks.values()) this.remove(p)
    this.picks.clear()
    this.byEntity.clear()
    this.helpers.clear()
  }

  private add(sk: string, element: ElementKind, entity: Entity): void {
    const p: Pick = { sk, element, entity, how: 'self', helper: null }
    if (element === 'image' || element === 'video' || element === 'ad_space') {
      if (MeshCollider.has(entity)) this.addChildPlane(p)
      else MeshCollider.setPlane(entity, ColliderLayer.CL_POINTER)
    } else if (element === 'model') {
      const g = GltfContainer.getMutableOrNull(entity)
      if (!g) return // not loadable here (missing model): nothing to click; retried on the next sync
      p.how = 'mask'
      p.prevMask = g.visibleMeshesCollisionMask
      g.visibleMeshesCollisionMask = (p.prevMask ?? 0) | ColliderLayer.CL_POINTER
    } else {
      p.how = 'marker'
      const m = engine.addEntity()
      Transform.create(m, {
        // Hidden below the floor until followItems gives it the sound's position
        position: entityPosition(entity) ?? Vector3.create(0, -100, 0),
        scale: Vector3.create(MARKER_SIZE, MARKER_SIZE, MARKER_SIZE),
      })
      MeshRenderer.setSphere(m)
      Material.setBasicMaterial(m, { diffuseColor: MARKER_COLOR, castShadows: false })
      MeshCollider.setSphere(m, ColliderLayer.CL_POINTER)
      p.helper = m
    }
    this.picks.set(sk, p)
  }

  /** A pointer plane on a child entity, for items that already have a collider of their own. */
  private addChildPlane(p: Pick): void {
    const c = engine.addEntity()
    Transform.create(c, { parent: p.entity })
    MeshCollider.setPlane(c, ColliderLayer.CL_POINTER)
    p.how = 'child'
    p.helper = c
  }

  private refresh(p: Pick): void {
    if (p.how === 'self') {
      const mc = MeshCollider.getOrNull(p.entity)
      if (!mc) MeshCollider.setPlane(p.entity, ColliderLayer.CL_POINTER)
      else if (!isOurPlane(mc)) this.addChildPlane(p) // a manager set its own collider: don't fight it
    } else if (p.how === 'mask') {
      const g = GltfContainer.getOrNull(p.entity)
      if (!g) return
      const mask = g.visibleMeshesCollisionMask ?? 0
      if (mask & ColliderLayer.CL_POINTER) return
      // The model was reloaded; its new mask is the one to restore
      p.prevMask = g.visibleMeshesCollisionMask
      GltfContainer.getMutable(p.entity).visibleMeshesCollisionMask = mask | ColliderLayer.CL_POINTER
    }
  }

  private remove(p: Pick): void {
    if (p.helper !== null) engine.removeEntity(p.helper)
    if (p.how === 'self' && isOurPlane(MeshCollider.getOrNull(p.entity))) MeshCollider.deleteFrom(p.entity)
    if (p.how === 'mask') {
      const g = GltfContainer.getMutableOrNull(p.entity)
      if (g) g.visibleMeshesCollisionMask = p.prevMask
    }
  }
}
