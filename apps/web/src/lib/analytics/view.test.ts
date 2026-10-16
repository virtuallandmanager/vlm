import { describe, it, expect } from 'vitest'
import { resolveView, dashboardHref, isNoAccess, NO_SCENE_NOTE } from './view'
import type { AnalyticsLocation } from './types'

const loc = (id: string, vlmSceneId: string | null): AnalyticsLocation => ({
  id, locationKey: `key-${id}`, kind: 'parcels', title: null, walletVisibility: false, verifiedSessionShare: 0,
  since: null, until: null, vlmSceneId, baseParcel: '0,0', parcels: ['0,0'], canManage: false,
})
const none = { location: null, scene: null }

describe('resolveView', () => {
  it('lists several locations, redirects when there is exactly one', () => {
    expect(resolveView([loc('a', 's1'), loc('b', 's2')], none)).toEqual({ view: 'list' })
    expect(resolveView([loc('a', 's1')], none)).toEqual({ view: 'redirect', locationId: 'a' })
    expect(resolveView([], none)).toEqual({ view: 'list' })
  })
  it('opens a known location and refuses an unknown one', () => {
    const a = loc('a', 's1')
    expect(resolveView([a, loc('b', null)], { location: 'a', scene: null })).toEqual({ view: 'dashboard', location: a })
    expect(resolveView([a], { location: 'zzz', scene: null })).toEqual({ view: 'no-access' })
    expect(resolveView([], { location: 'a', scene: null })).toEqual({ view: 'no-access' })
  })
  it('maps ?scene= to its location, or the list with a note', () => {
    expect(resolveView([loc('a', 's1'), loc('b', 's2')], { location: null, scene: 's2' })).toEqual({ view: 'redirect', locationId: 'b' })
    expect(resolveView([loc('a', 's1')], { location: null, scene: 'nope' })).toEqual({ view: 'list', note: NO_SCENE_NOTE })
  })
  it('prefers ?location= over ?scene=', () => {
    const a = loc('a', 's1')
    expect(resolveView([a, loc('b', 's2')], { location: 'a', scene: 's2' })).toEqual({ view: 'dashboard', location: a })
  })
})

describe('helpers', () => {
  it('builds the trailing-slash dashboard link', () => {
    expect(dashboardHref('a b')).toBe('/analytics/?location=a%20b')
  })
  it('treats 403 and 404 as no access, other errors as retryable', () => {
    expect(isNoAccess({ status: 403 })).toBe(true)
    expect(isNoAccess({ status: 404 })).toBe(true)
    expect(isNoAccess({ status: 500 })).toBe(false)
    expect(isNoAccess(new Error('x'))).toBe(false)
    expect(isNoAccess(null)).toBe(false)
  })
})
