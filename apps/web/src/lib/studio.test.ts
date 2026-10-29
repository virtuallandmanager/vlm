import { describe, it, expect } from 'vitest'
import { AGENTS, designBadge, designIdFromPath, formatCents, refreshDue, refusalMessage, relativeTime, untilReset, usageLine, type StudioDesign, type StudioUsage } from './studio'

const NOW = new Date('2026-10-29T21:55:00Z')
const at = (ms: number) => new Date(NOW.getTime() + ms).toISOString()
const MIN = 60_000

describe('AGENTS', () => {
  it('offers Claude Code and Codex, with Grok coming soon', () => {
    expect(AGENTS).toEqual([
      { id: 'claude', label: 'Claude Code' },
      { id: 'codex', label: 'Codex' },
      { id: 'grok', label: 'Grok Build', soon: true },
    ])
  })
})

describe('refusalMessage', () => {
  const r = (code: string, body: Record<string, unknown> = {}, status = 409) => refusalMessage({ status, body: { code, ...body } }, NOW)

  it('names when the allowance comes back and offers a top-up', () => {
    expect(r('allowance', { resetsAt: at(125 * MIN) }, 429)).toEqual({
      text: 'You’ve used today’s prompts. More at midnight UTC (in 2 h 5 min).',
      action: 'topup',
    })
  })
  it('never shows the cost ceiling’s numbers', () => {
    const m = r('cost_ceiling', { resetsAt: at(125 * MIN) }, 429)
    expect(m.text).toBe('The studio needs a rest for today. Come back tomorrow.')
    expect(m.text).not.toMatch(/\d/)
    expect(m.action).toBeUndefined()
  })
  it('says the agent is busy', () => {
    expect(r('busy').text).toBe('The agent is still working on your last message.')
  })
  it('points the open-design limit at settings', () => {
    expect(r('open_design_limit', {}, 403)).toEqual({
      text: 'Your plan has room for one open design. Archive or finalize the one you have, or upgrade.',
      action: 'settings',
    })
  })
  it('names the pieces that failed the checker and offers the free fix', () => {
    expect(r('checks_failed', { categories: ['hat', 'feet'] })).toEqual({
      text: 'hat and feet failed the checker. Ask the agent to fix it: it doesn’t use a prompt.',
      action: 'fix',
    })
    expect(r('checks_failed', { categories: ['upper_body'] }).text).toMatch(/^upper body failed/)
  })
  it('explains payments being off and Stripe not answering', () => {
    expect(r('payments_unavailable', {}, 503).text).toBe('Payments aren’t available right now.')
    expect(r('stripe_error', {}, 502).text).toBe('Stripe didn’t answer. Try again in a moment.')
  })
  it('falls back to plain words for anything else', () => {
    expect(r('who_knows')).toEqual({ text: 'Something went wrong. Try again.' })
    expect(refusalMessage({}, NOW)).toEqual({ text: 'Something went wrong. Try again.' })
  })
})

describe('formatCents', () => {
  it('drops zero cents and keeps the rest', () => {
    expect(formatCents(2900)).toBe('$29')
    expect(formatCents(1950)).toBe('$19.50')
    expect(formatCents(0)).toBe('$0')
  })
})

describe('untilReset', () => {
  it('counts hours and minutes, or minutes alone under an hour', () => {
    expect(untilReset(at(20 * MIN), NOW)).toBe('20 min')
    expect(untilReset(at(180 * MIN), NOW)).toBe('3 h 0 min')
    expect(untilReset(at(-5 * MIN), NOW)).toBe('0 min')
  })
})

describe('designIdFromPath', () => {
  const id = '2f1c6a0e-8d3b-4c1a-9f6e-0b7d5e4a3c21'
  it('reads the design id from the path in a static export', () => {
    expect(designIdFromPath(`/studio/${id}/`)).toBe(id)
    expect(designIdFromPath(`/studio/${id}`, '_')).toBe(id)
  })
  it('refuses the placeholder and anything that is not a uuid', () => {
    expect(designIdFromPath('/studio/_/')).toBeNull()
    expect(designIdFromPath('/studio/not-a-design/')).toBeNull()
    expect(designIdFromPath('/studio/')).toBeNull()
  })
  it('prefers a real route param', () => {
    expect(designIdFromPath('/studio/_/', id)).toBe(id)
  })
})

describe('refreshDue', () => {
  it('re-reads frame urls after 45 minutes, well before they expire', () => {
    const t0 = 1_000_000
    expect(refreshDue(t0, t0 + 44 * MIN)).toBe(false)
    expect(refreshDue(t0, t0 + 46 * MIN)).toBe(true)
  })
})

describe('designBadge', () => {
  const d = (over: Partial<StudioDesign>): StudioDesign => ({
    id: 'd1', name: 'Cap', kind: 'wearable', agent: 'claude', status: 'idle', archivedAt: null, lastJobAt: null,
    finalizedAt: null, createdAt: NOW.toISOString(), ...over,
  })
  it('names each state', () => {
    expect(designBadge(d({}))).toEqual({ label: 'Draft', tone: 'violet' })
    expect(designBadge(d({ status: 'building' }))).toEqual({ label: 'Building', tone: 'info' })
    expect(designBadge(d({ finalizedAt: NOW.toISOString() }))).toEqual({ label: 'Finalized', tone: 'success' })
    expect(designBadge(d({ archivedAt: NOW.toISOString() }))).toEqual({ label: 'Archived', tone: 'neutral' })
  })
  it('lets archived win over finalized', () => {
    expect(designBadge(d({ archivedAt: NOW.toISOString(), finalizedAt: NOW.toISOString(), status: 'building' })).label).toBe('Archived')
  })
})

describe('relativeTime', () => {
  it('reads as plain words', () => {
    expect(relativeTime(at(-20 * 1000), NOW)).toBe('just now')
    expect(relativeTime(at(-5 * MIN), NOW)).toBe('5 min ago')
    expect(relativeTime(at(-3 * 60 * MIN), NOW)).toBe('3 h ago')
    expect(relativeTime(at(-50 * 60 * MIN), NOW)).toBe('2 days ago')
    expect(relativeTime(at(-25 * 60 * MIN), NOW)).toBe('1 day ago')
  })
})

describe('usageLine', () => {
  const u: StudioUsage = { plan: 'free', promptsLeft: 3, credits: 0, allowance: 3, resetsAt: NOW.toISOString(), openDesigns: 0, openDesignLimit: 1, topup: { cents: 500, prompts: 10 } }
  it('names the plan and the prompts left, and bought prompts when there are any', () => {
    expect(usageLine(u)).toBe('free plan · 3 prompts left today')
    expect(usageLine({ ...u, credits: 7 })).toBe('free plan · 3 prompts left today · 7 bought')
  })
})
