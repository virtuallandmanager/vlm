import type { SerializedScene } from './hyperfy.js'

export type ArMarkerView = {
  id: string
  ringId: number
  code: string
  diameterMm: number
  whereText: string | null
  pose: { x: number; y: number; z: number; headingDeg: number } | null
}

export type ArFloorView = {
  id: string
  name: string
  heightM: number
  sortOrder: number
  markers: ArMarkerView[]
}

export type ArSpaceView = {
  id: string
  sceneId: string
  name: string
  place: string | null
  lat: number | null
  lng: number | null
  published: boolean
  floors: ArFloorView[]
}

export const AR_FEED = { version: 1, holdMs: 25_000 } as const

/** The space as the headset gets it: the scene it belongs to is the feed's business, not the app's. */
export type ArSpaceWire = Omit<ArSpaceView, 'sceneId'>

export type ArFeedResponse = { v: 1; version: string; space: ArSpaceWire; scene: SerializedScene | null }

export type ArMarkerLookup = { spaceId: string; floorId: string; markerId: string; spaceName: string; whereText: string | null }
