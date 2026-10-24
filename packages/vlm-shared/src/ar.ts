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
