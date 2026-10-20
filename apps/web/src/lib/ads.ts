import type { AdShape, LevelCounts } from 'vlm-shared'

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
