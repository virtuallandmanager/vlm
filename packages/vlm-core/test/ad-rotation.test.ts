import { describe, it, expect } from 'vitest'
import { AD_LIMITS } from 'vlm-shared'
import type { AdItem } from 'vlm-shared'
import { AdRotation, durationMs, isOnScreen } from '../src/ads/rotation.js'

const item = (adId: string, kind: 'image' | 'video' = 'image'): AdItem => ({
  adId,
  creativeId: `c-${adId}`,
  kind,
  url: `https://cdn.example/${adId}`,
  clickUrl: 'https://example.com',
  house: false,
})

describe('AdRotation', () => {
  it('rotation never repeats back to back when two ads are eligible', () => {
    const r = new AdRotation([item('a'), item('b')])
    const seq = Array.from({ length: 6 }, () => r.next(true)!.adId)
    expect(seq).toEqual(['a', 'b', 'a', 'b', 'a', 'b'])
  })

  it('rotation repeats the only eligible item', () => {
    const r = new AdRotation([item('a')])
    expect(r.next(true)!.adId).toBe('a')
    expect(r.next(true)!.adId).toBe('a')
  })

  it('rotation skips videos when video is not allowed', () => {
    const r = new AdRotation([item('v', 'video'), item('i')])
    expect(r.next(false)!.adId).toBe('i')
    expect(r.next(false)!.adId).toBe('i')
    expect(r.next(true)!.adId).toBe('v')
  })

  it('a showing counts against the frequency cap only once it has been seen', () => {
    let t = 1_000_000
    const r = new AdRotation([item('a'), item('b')], { now: () => t })
    // picked but never on screen: nothing is capped
    const unseen = Array.from({ length: AD_LIMITS.freqCapPerHour * 4 }, () => r.next(true)!.adId)
    expect(unseen.filter((x) => x === 'a')).toHaveLength(AD_LIMITS.freqCapPerHour * 2)
    for (let i = 0; i < AD_LIMITS.freqCapPerHour; i++) r.seen('a')
    expect([r.next(true)!.adId, r.next(true)!.adId, r.next(true)!.adId]).toEqual(['b', 'b', 'b'])
    t += 60 * 60 * 1000 + 1
    expect([r.next(true)!.adId, r.next(true)!.adId]).toContain('a')
  })

  it('house ads are never capped', () => {
    const r = new AdRotation([{ ...item('h'), house: true }, item('p')])
    for (let i = 0; i < AD_LIMITS.freqCapPerHour * 3; i++) r.seen('h')
    for (let i = 0; i < AD_LIMITS.freqCapPerHour; i++) r.seen('p')
    expect([r.next(true)!.adId, r.next(true)!.adId]).toEqual(['h', 'h'])
  })

  it('when every eligible item is capped the least recently seen one repeats', () => {
    let t = 1_000_000
    const r = new AdRotation([item('a'), item('b')], { now: () => t })
    for (let i = 0; i < AD_LIMITS.freqCapPerHour; i++) r.seen('b')
    t += 1000
    for (let i = 0; i < AD_LIMITS.freqCapPerHour; i++) r.seen('a')
    expect(r.next(true)!.adId).toBe('b')
    t += 1000
    r.seen('b')
    expect(r.next(true)!.adId).toBe('a')
    expect(new AdRotation([item('v', 'video'), item('i')], { now: () => t }).next(false)!.adId).toBe('i')
  })

  it('rotation returns null when nothing is eligible', () => {
    expect(new AdRotation([]).next(true)).toBeNull()
    expect(new AdRotation([item('v', 'video')]).next(false)).toBeNull()
  })

  it('setItems replaces the items but keeps frequency history', () => {
    const r = new AdRotation([item('a')])
    for (let i = 0; i < AD_LIMITS.freqCapPerHour; i++) r.seen('a')
    r.setItems([item('a'), item('c')])
    expect(r.next(true)!.adId).toBe('c')
    expect(r.next(true)!.adId).toBe('c')
  })

  it('rotations sharing a history share the frequency cap', () => {
    const history = new Map<string, number[]>()
    const r1 = new AdRotation([item('a'), item('c')], { history })
    const r2 = new AdRotation([item('a')], { history })
    for (let i = 0; i < AD_LIMITS.freqCapPerHour / 2; i++) {
      r1.seen('a')
      r2.seen('a')
    }
    expect([r1.next(true)!.adId, r1.next(true)!.adId]).toEqual(['c', 'c'])
    expect(new AdRotation([item('a'), item('c')]).next(true)!.adId).toBe('a')
  })
})

describe('durationMs', () => {
  it('is imageSeconds for images and null for videos', () => {
    expect(durationMs(item('a'))).toBe(AD_LIMITS.imageSeconds * 1000)
    expect(durationMs(item('v', 'video'))).toBeNull()
  })
})

describe('isOnScreen', () => {
  const identity = { x: 0, y: 0, z: 0, w: 1 }
  const cam = { position: { x: 0, y: 0, z: 0 }, rotation: identity }
  const at = (x: number, y: number, z: number, shortSideM = 4) => ({ position: { x, y, z }, shortSideM })

  it('isOnScreen is false beyond 25 m, outside 35 degrees, or when apparent size is under 0.04', () => {
    expect(isOnScreen(cam, at(0, 0, 10))).toBe(true)
    // distance
    expect(isOnScreen(cam, at(0, 0, 26, 10))).toBe(false)
    // angle: 45 degrees off forward
    expect(isOnScreen(cam, at(10, 0, 10))).toBe(false)
    // just inside 35 degrees
    const rad = (34 * Math.PI) / 180
    expect(isOnScreen(cam, at(10 * Math.sin(rad), 0, 10 * Math.cos(rad)))).toBe(true)
    // apparent: 1 / 10 = 0.1 ok, 0.3 / 10 = 0.03 too small
    expect(isOnScreen(cam, at(0, 0, 10, 1))).toBe(true)
    expect(isOnScreen(cam, at(0, 0, 10, 0.3))).toBe(false)
    // behind the camera
    expect(isOnScreen(cam, at(0, 0, -10))).toBe(false)
  })

  it('uses the camera rotation: +Z rotated by the quaternion is forward', () => {
    // 90 degrees about Y turns +Z forward into +X
    const s = Math.SQRT1_2
    const turned = { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: s, z: 0, w: s } }
    expect(isOnScreen(turned, at(10, 0, 0))).toBe(true)
    expect(isOnScreen(turned, at(0, 0, 10))).toBe(false)
  })
})
