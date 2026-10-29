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
  paymentId: string
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

const PHASES: Record<string, string> = {
  building: 'Building…',
  checking: 'Running the checks…',
  rendering: 'Rendering the preview…',
  saving: 'Saving…',
  packaging: 'Packaging your files…',
}

/** A worker path (`/work/…`, `/opt/…`, `/tmp/…`) shortened to its last segment. */
const shortenPaths = (text: string) => text.replace(/\/(?:work|opt|tmp)\/\S+/g, (p) => p.split('/').filter(Boolean).pop() ?? p)

/**
 * The line under the "agent is working" bubble: the job's newest event the page shows. The agent's notes show; its
 * commands (`Running: …`) don't; a phase shows in plain words.
 */
export function progressFor(events: StudioEvent[], jobId: string): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.jobId !== jobId) continue
    if (e.type === 'progress' && e.text.trim() && !e.text.startsWith('Running:')) return shortenPaths(e.text.trim())
    if (e.type === 'phase' && PHASES[e.phase]) return PHASES[e.phase]
  }
  return null
}

export const initialTicks = (proposal: StudioProposal) =>
  new Set(proposal.slots.filter((s) => s.recommended).map((s) => s.category))

/** The ticked slots in the proposal's order: the server refuses an empty `selectedSlots`, so none ticked can't build. */
export function slotSelection(proposal: StudioProposal, ticked: Set<string>): { canBuild: boolean; slots: string[] } {
  const slots = proposal.slots.map((s) => s.category).filter((c) => ticked.has(c))
  return { canBuild: slots.length > 0, slots }
}

/** When to re-read the design: often while a job runs and the room is down, rarely while the room carries it. */
export function nextPoll(detail: StudioDetail, connected: boolean): number | null {
  if (!detail.activeJob) return null
  return connected ? 30_000 : 5_000
}

export type ComposerMode = 'send' | 'busy' | 'continue' | 'out' | 'archived'

/** After a cost stop the person may press Continue (free) or send something new instead. */
export const canSend = (mode: ComposerMode) => mode === 'send' || mode === 'continue'

/** A job starting (maybe from another tab) or ending changes the design: re-read it. Progress doesn't. */
export const reloadsOn = (e: StudioEvent) =>
  e.type === 'job' && (e.status === 'queued' || e.status === 'done' || e.status === 'failed')

export function composerState(detail: StudioDetail, usage: StudioUsage | null, now: Date): { mode: ComposerMode; note: string } {
  const note = usage ? `${usage.promptsLeft} prompts left today · ${usage.plan} plan` : ''
  if (detail.design.archivedAt) return { mode: 'archived', note: 'This design is archived. Unarchive it to keep working on it.' }
  if (detail.activeJob?.type === 'prompt') return { mode: 'busy', note: 'The agent is still working on your last message.' }
  if (detail.lastPrompt?.outcome === 'ceiling') return { mode: 'continue', note }
  if (usage && usage.promptsLeft <= 0) return { mode: 'out', note: refusalMessage({ body: { code: 'allowance', resetsAt: usage.resetsAt } }, now).text }
  return { mode: 'send', note }
}

/** The server's view key, `<mode>-<bodyShape>-<outfit>[-<emote>]` (apps/server/src/studio/designs.ts `viewKey`). */
export function viewKey(kind: string, view: RenderView): string {
  return `${kind === 'emote' ? 'emote' : 'spin'}-${view.bodyShape}-${view.outfit}${view.emote ? `-${view.emote}` : ''}`
}

const mod = (n: number, m: number) => ((n % m) + m) % m

/** The frame a drag lands on: one stage width is one full turn, and the item turns the way the cursor moves. */
export function frameAt(start: number, dx: number, width: number, frames: number): number {
  if (!(width > 0) || !(frames > 0)) return start
  return mod(start - Math.round((dx / width) * frames), frames)
}

export type StageState =
  | { kind: 'frames'; urls: string[]; renderedAt: string }
  | { kind: 'rendering' }
  | { kind: 'empty'; text: string }

/** What the stage shows for a piece's view: its frames, a render in progress, or plain words, never a broken image. */
export function stageState(piece: StudioPiece | undefined, key: string, pending: Set<string>): StageState {
  if (!piece) return { kind: 'empty', text: 'The agent hasn’t built anything yet. Describe what you want on the left.' }
  const view = piece.renders[key]
  if (view?.status === 'ready' && view.urls.length > 0) return { kind: 'frames', urls: view.urls, renderedAt: view.renderedAt }
  if (pending.has(key) || view?.status === 'queued') return { kind: 'rendering' }
  if (view) return { kind: 'empty', text: 'That view didn’t render. Pick it again to retry.' }
  return { kind: 'empty', text: 'This view hasn’t been rendered yet.' }
}

/** A piece tab's status: any running prompt may change any piece. */
export function pieceTabStatus(piece: StudioPiece, detail: StudioDetail): 'ready' | 'building' | 'new' {
  if (detail.activeJob?.type === 'prompt') return 'building'
  return piece.revision ? 'ready' : 'new'
}

const UNLOCKS: Record<StudioKind, string> = {
  wearable: 'Finalize to get the GLBs, thumbnail, Builder settings, listing text, curation report, renders and a promo clip.',
  emote: 'Finalize to get the GLB, thumbnail, emote report, renders and a promo clip.',
}

/** The strip under the preview: what finalizing unlocks, its price, and the pieces the checker blocks. */
export function finalizeStrip(quote: Quote | null, kind: StudioKind): { unlocks: string; button: string | null; blocked: string | null } {
  return {
    unlocks: UNLOCKS[kind] ?? UNLOCKS.wearable,
    button: quote && quote.lines.length > 0 ? `Finalize · ${formatCents(quote.totalCents)}` : null,
    blocked: quote?.blocked.length ? refusalMessage({ body: { code: 'checks_failed', categories: quote.blocked } }, new Date()).text : null,
  }
}

export const REPORT_MIN = 10
export const REPORT_MAX = 2000

export const reportOk = (text: string) => text.trim().length >= REPORT_MIN && text.length <= REPORT_MAX

/** The checkout covers every payable piece; only reports the server will take are sent. */
export function checkoutBody(reports: Record<string, string>): { reports?: Record<string, string> } {
  const ok = Object.entries(reports).filter(([, t]) => reportOk(t)).map(([c, t]) => [c, t.trim()] as const)
  return ok.length ? { reports: Object.fromEntries(ok) } : {}
}

/** The dialog's total: a reported line is waived, and waiving one changes no other line's price. */
export const dialogTotal = (quote: Quote, reported: string[]) =>
  quote.lines.reduce((n, l) => n + (reported.includes(l.category) ? 0 : l.amountCents), 0)

/** Stripe's return URL carries `?payment=`: until the webhook grants it, the page says what is happening. */
const BANNER_SLOW_MS = 2 * 60_000

export type PaymentBanner = { kind: 'packaging' | 'ready' | 'failed' | 'slow'; text: string }

export function paymentBanner(searchPayment: string | null, detail: StudioDetail, startedAt: number, now: Date): PaymentBanner | null {
  if (!searchPayment) return null
  const fresh = detail.pieces.flatMap((p) => p.finalized).filter((f) => f.paymentId === searchPayment)
  if (!fresh.length) {
    return now.getTime() - startedAt > BANNER_SLOW_MS
      ? { kind: 'slow', text: 'Stripe hasn’t confirmed the payment yet. This page will update when it does.' }
      : { kind: 'packaging', text: 'Payment received. Packaging your files…' }
  }
  if (fresh.some((f) => f.status === 'packaging')) return { kind: 'packaging', text: 'Payment received. Packaging your files…' }
  if (fresh.some((f) => f.status === 'failed')) return { kind: 'failed', text: 'Packaging didn’t finish. Try again below: it’s free.' }
  return { kind: 'ready', text: 'Your files are ready below.' }
}

/** What a paid revision offers: its package (download, packaging or a free retry), and a mistake report while open. */
export function revisionActions(f: FinalizedRevision, now: Date): {
  download: boolean; retry: boolean; packaging: boolean; report: 'open' | 'done' | 'closed' | 'none'
} {
  const report = f.report ? 'done'
    : f.kind !== 'revision' || !(f.amountCents > 0) ? 'none'
      : f.reportableUntil && new Date(f.reportableUntil).getTime() > now.getTime() ? 'open'
        : 'closed'
  return { download: f.status === 'ready', retry: f.status === 'failed', packaging: f.status === 'packaging', report }
}

/**
 * Whether a view button says "Rendering…": its view is rendering, and it is either the button last picked or a view
 * other than the one shown. The shown view's other selected buttons (Male, Default under Dance) share its key but
 * didn't ask for it.
 */
export function viewButtonRendering<K extends keyof RenderView>(
  dim: K, value: RenderView[K], current: RenderView, lastPicked: keyof RenderView | null, rendering: (v: RenderView) => boolean,
): boolean {
  const next = { ...current, [dim]: value }
  return rendering(next) && (dim === lastPicked || current[dim] !== value)
}
