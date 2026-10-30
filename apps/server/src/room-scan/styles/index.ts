/**
 * Exterior style library for room sets. Each style is a small kit: an outer
 * wall material, a roof kind, the height outer walls are built to, and any
 * extra parts (canopy, awning, sign). Add a style by adding a kit here.
 */
import type { MaterialSpec, MeshPart, V2 } from '../mesh.js'
import { house } from './house.js'
import { storefront } from './storefront.js'
import { plain } from './plain.js'
import { dollhouse } from './dollhouse.js'

export type RoomStyle = 'house' | 'storefront' | 'plain' | 'dollhouse'

/** Where the set's front door is: the first door in an outer wall. Floor-plan points are in the layout frame. */
export interface DoorSpot {
  /** Middle of the doorway on the wall's outer face. */
  center: V2
  /** Unit direction along the wall. */
  along: V2
  /** Unit direction out of the building. */
  normal: V2
  width: number
  /** Absolute Y of the door's top and of the wall's top above it. */
  top: number
  wallTop: number
}

export interface StyleContext { door?: DoorSpot; signText?: string }

export interface StyleKit {
  outerMaterial: MaterialSpec
  roof: 'pitched' | 'flat' | 'none'
  roofMaterial?: MaterialSpec
  /** Outer face material for the wall holding the front door, when it differs (storefront glass). */
  doorWallMaterial?: MaterialSpec
  /** How tall outer walls are built for a room with this ceiling height; shared partitions stay full height. */
  outerWallHeight: (ceiling: number) => number
  extras: (ctx: StyleContext) => MeshPart[]
}

export const STYLE_KITS: Record<RoomStyle, StyleKit> = { house, storefront, plain, dollhouse }
export const ROOM_STYLES = Object.keys(STYLE_KITS) as RoomStyle[]
