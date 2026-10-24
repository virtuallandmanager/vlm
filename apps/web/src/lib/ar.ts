import type { ArMarkerView, ArSpaceView } from 'vlm-shared'

export const AR_MIN_DIAMETER_MM = 60
export const AR_MAX_DIAMETER_MM = 256
export const AR_DEFAULT_DIAMETER_MM = 140

export type ArFileFormat = 'stl-base' | 'stl-raised' | '3mf' | 'pdf' | 'svg'
export type ArMounting = 'none' | 'tape' | 'magnets' | 'screws' | 'keyhole'

/** A marker is aligned once the headset has stored its pose. */
export function alignmentStatus(m: ArMarkerView): 'not_aligned' | 'aligned' {
  return m.pose ? 'aligned' : 'not_aligned'
}

/** What a space still needs before visitors can use it. Publishing is allowed regardless; the UI says what is missing. */
export function spaceReadiness(s: ArSpaceView): { ok: boolean; missing: Array<'marker' | 'alignment'> } {
  const markers = s.floors.flatMap((f) => f.markers)
  const missing: Array<'marker' | 'alignment'> = []
  if (markers.length === 0) missing.push('marker')
  else if (markers.some((m) => alignmentStatus(m) === 'not_aligned')) missing.push('alignment')
  return { ok: missing.length === 0, missing }
}

export const shareUrl = (code: string): string => `https://vlm.gg/s/${code}`

const ERRORS: Record<string, string> = {
  no_access: "You don't have access to build AR spaces in this scene.",
  bad_diameter: 'Size must be between 60 and 256 mm.',
  last_floor: "A space needs at least one floor: you can't remove the last floor.",
  bad_request: "Something in that entry isn't valid",
  not_found: 'That item no longer exists. Reload the page.',
  no_room_for_screws: 'Not enough room for screw holes at this size: pick another mounting',
  too_large_for_paper: 'Too big for Letter paper at 100%: use the 3D print files',
}

export const friendlyArError = (code: string): string => ERRORS[code] ?? (code || 'Something went wrong')
