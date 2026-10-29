/**
 * Design Studio: the page's types (the server's JSON, from apps/server/src/routes/studio.ts and studio/*.ts), its
 * copy, and the pure decisions the studio pages make. Kept free of React so it tests in node.
 */
import type { Tone } from '@/components/ui'

export type StudioKind = 'wearable' | 'emote'
export type StudioAgent = 'claude' | 'codex'

export type StudioUsage = {
  plan: string
  promptsLeft: number
  credits: number
  allowance: number
  resetsAt: string
  openDesigns: number
  openDesignLimit: number | null
  topup: { cents: number; prompts: number }
}

export type StudioDesign = {
  id: string
  name: string
  kind: StudioKind
  agent: string
  status: 'idle' | 'building' | string
  archivedAt: string | null
  lastJobAt: string | null
  finalizedAt: string | null
  createdAt: string
}

export type Checker = { pass: boolean; failures: number; warnings: number } | null

export type StudioView = { status: 'queued' | 'ready' | 'failed' | string; frames: number; urls: string[]; renderedAt: string }

export type FinalizedRevision = {
  revision: number
  kind: 'first' | 'revision'
  status: 'packaging' | 'ready' | 'failed' | string
  amountCents: number
  paidAt: string | null
  report: { status: 'pending' | 'refunded' | 'waived' | string; createdAt: string } | null
  reportableUntil: string | null
}

export type StudioPiece = {
  id: string
  category: string
  name: string
  revision: { number: number; changeKind: string; checker: Checker; createdAt: string } | null
  renders: Record<string, StudioView>
  finalized: FinalizedRevision[]
}

export type StudioProposal = { slots: { category: string; recommended: boolean; reason?: string }[] }

export type StudioMessage = {
  id: string
  role: 'user' | 'agent' | 'system'
  agent: string | null
  text: string
  proposal: StudioProposal | null
  jobId: string | null
  createdAt: string
}

export type StudioDetail = {
  design: StudioDesign
  pieces: StudioPiece[]
  messages: StudioMessage[]
  activeJob: { id: string; type: 'prompt' | 'render' | 'finalize' | string; status: string } | null
  lastPrompt: { jobId: string; outcome: string | null; status: string } | null
}

export type QuoteLine = {
  category: string
  revisionId: string
  revisionNumber: number
  pieceName: string
  priceKind: 'first' | 'first_extra' | 'revision' | 'revision_extra'
  amountCents: number
  waived: boolean
}

export type Quote = {
  pieces: { category: string; name: string; revisionNumber: number; state: 'payable' | 'entitled' | 'blocked' | 'none'; kind: 'first' | 'revision'; checker: Checker }[]
  lines: QuoteLine[]
  totalCents: number
  blocked: string[]
  notes: string[]
}

/** What the room sends (apps/server/src/studio/events.ts). */
export type StudioEvent =
  | { type: 'progress'; jobId: string; text: string }
  | { type: 'phase'; jobId: string; phase: string }
  | { type: 'job'; jobId: string; status: 'queued' | 'taken' | 'done' | 'failed'; outcome?: string; error?: string }

export type RenderView = { bodyShape: 'male' | 'female'; outfit: 'default' | 'outfit-2' | 'outfit-3'; emote: string | null }

export const AGENTS: { id: string; label: string; soon?: true }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'grok', label: 'Grok Build', soon: true },
]

export const agentLabel = (id: string | null | undefined) => AGENTS.find((a) => a.id === id)?.label ?? id ?? 'Agent'

/** `upper_body` → `upper body`. */
export const categoryLabel = (category: string) => category.replace(/_/g, ' ')

function joinAnd(items: string[]): string {
  return items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** `2900` → `$29`, `1950` → `$19.50`. */
export function formatCents(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`
}

/** Time left until `resetsAt`: `3 h 20 min`, or `20 min` under an hour. */
export function untilReset(resetsAt: string, now: Date): string {
  const mins = Math.max(0, Math.round((new Date(resetsAt).getTime() - now.getTime()) / 60_000))
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`
}

export type Refusal = { text: string; action?: 'topup' | 'settings' | 'fix' }

/** A refused request in the page's words, keyed by the server's `code`. */
export function refusalMessage(
  err: { status?: number; body?: { code?: string; resetsAt?: string; categories?: string[] } },
  now: Date,
): Refusal {
  const b = err.body ?? {}
  switch (b.code) {
    case 'allowance':
      return {
        text: `You’ve used today’s prompts. More at midnight UTC${b.resetsAt ? ` (in ${untilReset(b.resetsAt, now)})` : ''}.`,
        action: 'topup',
      }
    case 'cost_ceiling':
      return { text: 'The studio needs a rest for today. Come back tomorrow.' }
    case 'busy':
      return { text: 'The agent is still working on your last message.' }
    case 'open_design_limit':
      return { text: 'Your plan has room for one open design. Archive or finalize the one you have, or upgrade.', action: 'settings' }
    case 'checks_failed':
      return {
        text: `${joinAnd((b.categories ?? []).map(categoryLabel)) || 'A piece'} failed the checker. Ask the agent to fix it: it doesn’t use a prompt.`,
        action: 'fix',
      }
    case 'payments_unavailable':
      return { text: 'Payments aren’t available right now.' }
    case 'stripe_error':
      return { text: 'Stripe didn’t answer. Try again in a moment.' }
    default:
      return { text: 'Something went wrong. Try again.' }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The design id of `/studio/<id>/`: the static export has one page for every design, so the id comes from the URL. */
export function designIdFromPath(pathname: string, param?: string): string | null {
  if (param && param !== '_' && UUID.test(param)) return param
  const m = /^\/studio\/([^/]+)\/?$/.exec(pathname)
  return m && UUID.test(m[1]) ? m[1] : null
}

/** Signed frame URLs last at least an hour: the page re-reads the design every 45 minutes it stays open. */
export const FRAME_REFRESH_MS = 45 * 60_000

export const refreshDue = (fetchedAt: number, now: number) => now - fetchedAt >= FRAME_REFRESH_MS

export function designBadge(d: StudioDesign): { label: string; tone: Tone } {
  if (d.archivedAt) return { label: 'Archived', tone: 'neutral' }
  if (d.finalizedAt) return { label: 'Finalized', tone: 'success' }
  if (d.status === 'building') return { label: 'Building', tone: 'info' }
  return { label: 'Draft', tone: 'violet' }
}

/** `5 min ago`, `3 h ago`, `2 days ago`. */
export function relativeTime(iso: string, now: Date): string {
  const mins = Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  if (mins < 24 * 60) return `${Math.floor(mins / 60)} h ago`
  const days = Math.floor(mins / (24 * 60))
  return `${days} ${days === 1 ? 'day' : 'days'} ago`
}

/** `free plan · 3 prompts left today`, plus `· 7 bought` with bought prompts. */
export function usageLine(u: StudioUsage): string {
  return `${u.plan} plan · ${u.promptsLeft} prompts left today${u.credits > 0 ? ` · ${u.credits} bought` : ''}`
}
