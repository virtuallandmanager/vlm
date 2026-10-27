import { describe, it, expect } from 'vitest'
import { dashboardUrlFor, dashboardOriginFor, analyticsUrlFor, handoffUrlFor } from '../src/dashboard-url.js'

describe('dashboardUrlFor', () => {
  it('maps known API hosts to the website', () => {
    expect(dashboardUrlFor('https://api.virvi.io')).toBe('https://virvi.io')
    expect(dashboardUrlFor('https://api.virvi.io/')).toBe('https://virvi.io')
    expect(dashboardUrlFor('https://api.staging.virvi.io')).toBe('https://staging.virvi.io')
    expect(dashboardUrlFor('http://localhost:3010')).toBe('http://localhost:3000')
    expect(dashboardUrlFor('http://127.0.0.1:3010')).toBe('http://localhost:3000')
  })
  it('self-hosted servers serve their own dashboard', () => {
    expect(dashboardUrlFor('https://virvi.example.com:8443/base')).toBe('https://virvi.example.com:8443')
  })
  it('falls back to virvi.io for garbage', () => {
    expect(dashboardUrlFor('not a url')).toBe('https://virvi.io')
  })
  it('builds the analytics deep link', () => {
    expect(analyticsUrlFor('https://api.virvi.io', 'abc-123')).toBe('https://virvi.io/analytics/?scene=abc-123')
  })
  it('builds the hand-off link with the code and next in the fragment, never the query', () => {
    expect(handoffUrlFor('https://api.virvi.io', 'a+b/c', '/analytics/?scene=abc')).toBe('https://virvi.io/auth/handoff/#code=a%2Bb%2Fc&next=%2Fanalytics%2F%3Fscene%3Dabc')
  })
  it('builds no hand-off link when the dashboard origin cannot be derived (a code must never go to virvi.io by fallback)', () => {
    expect(handoffUrlFor('http://[::1]:3010', 'c', '/analytics/')).toBeNull()
    expect(handoffUrlFor('https://user:pw@virvi.example.com', 'c', '/analytics/')).toBeNull()
  })
})

describe('dashboardOriginFor', () => {
  it('returns the derived origin for parseable API URLs', () => {
    expect(dashboardOriginFor('https://api.virvi.io')).toBe('https://virvi.io')
    expect(dashboardOriginFor('https://virvi.example.com:8443/base')).toBe('https://virvi.example.com:8443')
  })
  it('returns null instead of falling back to virvi.io', () => {
    expect(dashboardOriginFor('not a url')).toBeNull()
    expect(dashboardOriginFor('http://[::1]:3010')).toBeNull()
    expect(dashboardOriginFor('https://user:pw@virvi.example.com')).toBeNull()
    expect(dashboardOriginFor('')).toBeNull()
  })
  it('dashboardUrlFor keeps its virvi.io fallback for those', () => {
    expect(dashboardUrlFor('http://[::1]:3010')).toBe('https://virvi.io')
  })
})
