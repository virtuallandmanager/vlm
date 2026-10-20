import { AD_LIMITS } from 'vlm-shared'
import type { AdItem, Quat, Vec3 } from 'vlm-shared'

const HOUR_MS = 60 * 60 * 1000

export class AdRotation {
  private items: AdItem[]
  private readonly now: () => number
  /** When each ad was shown, by adId; shared between rotations when `opts.history` is given. */
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

  next(allowVideo: boolean): AdItem | null {
    const t = this.now()
    const n = this.items.length
    let fallback: AdItem | null = null
    for (let step = 1; step <= n; step++) {
      const idx = (this.cursor + step + n) % n
      const item = this.items[idx]
      if (!allowVideo && item.kind === 'video') continue
      if (this.recentCount(item.adId, t) >= AD_LIMITS.freqCapPerHour) continue
      if (item.adId === this.lastAdId) {
        fallback ??= item
        continue
      }
      return this.pick(item, idx, t)
    }
    return fallback ? this.pick(fallback, this.items.indexOf(fallback), t) : null
  }

  private recentCount(adId: string, t: number): number {
    const recent = (this.shown.get(adId) ?? []).filter((at) => t - at < HOUR_MS)
    this.shown.set(adId, recent)
    return recent.length
  }

  private pick(item: AdItem, idx: number, t: number): AdItem {
    this.shown.get(item.adId)!.push(t)
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
