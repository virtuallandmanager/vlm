import { describe, it, expect } from 'vitest'
import type { ArMarkerView, ArSpaceView } from 'vlm-shared'
import { alignmentStatus, friendlyArError, shareUrl, spaceReadiness } from './ar'

const marker = (pose: ArMarkerView['pose']): ArMarkerView => ({ id: 'm', ringId: 1, code: '2E3D4C5', diameterMm: 140, whereText: null, pose })
const space = (markers: ArMarkerView[]): ArSpaceView => ({
  id: 's', sceneId: 'sc', name: 'Hall', place: null, lat: null, lng: null, published: false,
  floors: [{ id: 'f', name: 'Ground', heightM: 0, sortOrder: 0, markers }],
})
const pose = { x: 0, y: 0, z: 0, headingDeg: 0 }

describe('alignmentStatus', () => {
  it('is not_aligned without a pose and aligned with one', () => {
    expect(alignmentStatus(marker(null))).toBe('not_aligned')
    expect(alignmentStatus(marker(pose))).toBe('aligned')
  })
})

describe('spaceReadiness', () => {
  it('asks for a marker when there are none', () => {
    expect(spaceReadiness(space([]))).toEqual({ ok: false, missing: ['marker'] })
  })
  it('asks for alignment when a marker is unaligned', () => {
    expect(spaceReadiness(space([marker(null)]))).toEqual({ ok: false, missing: ['alignment'] })
    expect(spaceReadiness(space([marker(pose), marker(null)]))).toEqual({ ok: false, missing: ['alignment'] })
  })
  it('is ok when every marker is aligned', () => {
    expect(spaceReadiness(space([marker(pose)]))).toEqual({ ok: true, missing: [] })
  })
})

describe('shareUrl', () => {
  it('builds the vlm.gg link', () => {
    expect(shareUrl('2E3D4C5')).toBe('https://vlm.gg/s/2E3D4C5')
  })
})

describe('friendlyArError', () => {
  it('maps known codes and falls back to the raw message', () => {
    expect(friendlyArError('last_floor')).toMatch(/last floor/i)
    expect(friendlyArError('no_room_for_screws')).toBe('Not enough room for screw holes at this size: pick another mounting')
    expect(friendlyArError('too_large_for_paper')).toBe('Too big for Letter paper at 100%: use the 3D print files')
    expect(friendlyArError('bad_request')).toBe("Something in that entry isn't valid")
    expect(friendlyArError('weird')).toBe('weird')
    expect(friendlyArError('')).toBe('Something went wrong')
  })
})
