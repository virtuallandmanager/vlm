import type { AnalyticsLocation } from './types'

export type AnalyticsView =
  | { view: 'list'; note?: string }
  | { view: 'redirect'; locationId: string }
  | { view: 'dashboard'; location: AnalyticsLocation }
  | { view: 'no-access' }

export const NO_SCENE_NOTE = 'This scene has no analytics you can see yet.'

/** What `/analytics/` shows for `?location=` / `?scene=` given the locations the user can read. */
export function resolveView(locations: AnalyticsLocation[], params: { location: string | null; scene: string | null }): AnalyticsView {
  if (params.location) {
    const loc = locations.find((l) => l.id === params.location)
    return loc ? { view: 'dashboard', location: loc } : { view: 'no-access' }
  }
  if (params.scene) {
    const loc = locations.find((l) => l.vlmSceneId === params.scene)
    return loc ? { view: 'redirect', locationId: loc.id } : { view: 'list', note: NO_SCENE_NOTE }
  }
  if (locations.length === 1) return { view: 'redirect', locationId: locations[0].id }
  return { view: 'list' }
}

export const dashboardHref = (locationId: string) => `/analytics/?location=${encodeURIComponent(locationId)}`

/** 403/404 from a location endpoint: the user can't read this location. */
export const isNoAccess = (err: unknown) => {
  const s = (err as { status?: number } | null)?.status
  return s === 403 || s === 404
}
