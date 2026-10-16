import { describe, it, expect } from 'vitest'
import { dashboardUrlFor, analyticsUrlFor, handoffUrlFor } from '../src/dashboard-url.js'

describe('dashboardUrlFor', () => {
  it('maps known API hosts to the website', () => {
    expect(dashboardUrlFor('https://api.vlm.gg')).toBe('https://vlm.gg')
    expect(dashboardUrlFor('https://api.vlm.gg/')).toBe('https://vlm.gg')
    expect(dashboardUrlFor('https://staging-api.vlm.gg')).toBe('https://staging.vlm.gg')
    expect(dashboardUrlFor('http://localhost:3010')).toBe('http://localhost:3000')
    expect(dashboardUrlFor('http://127.0.0.1:3010')).toBe('http://localhost:3000')
  })
  it('self-hosted servers serve their own dashboard', () => {
    expect(dashboardUrlFor('https://vlm.example.com:8443/base')).toBe('https://vlm.example.com:8443')
  })
  it('falls back to vlm.gg for garbage', () => {
    expect(dashboardUrlFor('not a url')).toBe('https://vlm.gg')
  })
  it('builds the analytics deep link', () => {
    expect(analyticsUrlFor('https://api.vlm.gg', 'abc-123')).toBe('https://vlm.gg/analytics/?scene=abc-123')
  })
  it('builds the hand-off link with the code and next encoded', () => {
    expect(handoffUrlFor('https://api.vlm.gg', 'a+b/c', '/analytics/?scene=abc')).toBe('https://vlm.gg/auth/handoff/?code=a%2Bb%2Fc&next=%2Fanalytics%2F%3Fscene%3Dabc')
  })
})
