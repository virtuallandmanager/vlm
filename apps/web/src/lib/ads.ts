import { VideoSourceType } from '@virvixr/shared'
import type { AdShape, LevelCounts } from '@virvixr/shared'

const SHAPE_LABELS: Record<AdShape, string> = {
  '16:9': '16:9 landscape',
  '1:1': '1:1 square',
  '9:16': '9:16 portrait',
  '2:5': '2:5 tall',
}

export function shapeLabel(shape: AdShape): string {
  return SHAPE_LABELS[shape]
}

export function isHttpsUrl(s: string): boolean {
  try {
    return new URL(s).protocol === 'https:'
  } catch {
    return false
  }
}

/** Verified clicks over verified on-screen views, e.g. '1.3%'. */
export function clickRate(c: LevelCounts): string {
  if (c.screen === 0) return '—'
  return `${((c.click / c.screen) * 100).toFixed(1)}%`
}

const AD_MODES_HOUSE = 'House ads fill it unless a partner ad is placed on it.'

/** Label for a video screen's off image field, or null when its mode does not use one (ads modes use it as their fallback). */
export function offImageLabel(offType: number): string | null {
  if (offType === VideoSourceType.IMAGE) return 'Off Image URL'
  if (offType === VideoSourceType.ADS || offType === VideoSourceType.PLAYLIST_ADS) return 'Fallback Image URL (shown when no ad can play)'
  return null
}

/** What a video screen's ads mode does, or null for the other modes. */
export function adModeHint(offType: number): string | null {
  if (offType === VideoSourceType.ADS) return `Shows ads while no stream is live. ${AD_MODES_HOUSE}`
  if (offType === VideoSourceType.PLAYLIST_ADS) return `Plays the playlist with an ad after every video. ${AD_MODES_HOUSE}`
  return null
}
