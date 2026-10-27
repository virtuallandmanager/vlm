import { AD_LIMITS } from '@virvixr/shared'
import type { AdItem, Quat, Vec3 } from '@virvixr/shared'

const HOUR_MS = 60 * 60 * 1000

export class AdRotation {
  private items: AdItem[]
  private readonly now: () => number
  /** When the visitor saw each ad, by adId; shared between rotations when `opts.history` is given. */
  private readonly shown: Map<string, number[]>
  private lastAdId: string | null = null
  private cursor = -1

  /** Pass one `history` to several rotations to apply the frequency cap across all of them. */
  constructor(items: AdItem[], opts?: { now?: () => number; history?: Map<string, number[]> }) {
    this.items = items
    this.now = opts?.now ?? Date.now
    this.shown = opts?.history ?? new Map()
  }

  setItems(items: AdItem[]): void {
    const last = this.lastAdId
    this.items = items
    // keep the cursor on the item we last showed so the order continues
    this.cursor = last === null ? -1 : items.findIndex((i) => i.adId === last)
  }

  /**
   * The next ad, skipping capped ones and avoiding a back-to-back repeat. House ads are never capped; when every
   * eligible item is capped, the least recently seen one repeats so the space is never empty.
   */
  next(allowVideo: boolean): AdItem | null {
    const t = this.now()
    const n = this.items.length
    let repeat: AdItem | null = null
    let leastRecent: { item: AdItem; idx: number; at: number } | null = null
    for (let step = 1; step <= n; step++) {
      const idx = (this.cursor + step + n) % n
      const item = this.items[idx]
      if (!allowVideo && item.kind === 'video') continue
      const recent = this.recent(item.adId, t)
      if (!item.house && recent.length >= AD_LIMITS.freqCapPerHour) {
        const at = recent[recent.length - 1]
        if (!leastRecent || at < leastRecent.at) leastRecent = { item, idx, at }
        continue
      }
      if (item.adId === this.lastAdId) {
        repeat ??= item
        continue
      }
      return this.pick(item, idx)
    }
    if (repeat) return this.pick(repeat, this.items.indexOf(repeat))
    return leastRecent ? this.pick(leastRecent.item, leastRecent.idx) : null
  }

  /** The visitor had this ad on screen: one showing counts against its frequency cap. */
  seen(adId: string): void {
    const t = this.now()
    this.shown.set(adId, [...this.recent(adId, t), t])
  }

  private recent(adId: string, t: number): number[] {
    const recent = (this.shown.get(adId) ?? []).filter((at) => t - at < HOUR_MS)
    this.shown.set(adId, recent)
    return recent
  }

  private pick(item: AdItem, idx: number): AdItem {
    this.lastAdId = item.adId
    this.cursor = idx
    return item
  }
}

export function durationMs(item: AdItem): number | null {
  return item.kind === 'image' ? AD_LIMITS.imageSeconds * 1000 : null
}

export function isOnScreen(
  camera: { position: Vec3; rotation: Quat },
  ad: { position: Vec3; shortSideM: number },
): boolean {
  const dx = ad.position.x - camera.position.x
  const dy = ad.position.y - camera.position.y
  const dz = ad.position.z - camera.position.z
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (dist === 0 || dist > AD_LIMITS.onScreenMaxDistanceM) return false
  if (ad.shortSideM / dist < AD_LIMITS.onScreenMinApparent) return false

  // camera forward: +Z rotated by the quaternion (left-handed, Y up)
  const { x, y, z, w } = camera.rotation
  const fx = 2 * (x * z + w * y)
  const fy = 2 * (y * z - w * x)
  const fz = 1 - 2 * (x * x + y * y)
  const cos = (fx * dx + fy * dy + fz * dz) / (Math.sqrt(fx * fx + fy * fy + fz * fz) * dist)
  const angleDeg = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI
  return angleDeg <= AD_LIMITS.onScreenHalfAngleDeg
}
