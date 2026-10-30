import { and, desc, eq, gt, inArray, max, ne } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { studioFlags, studioPauses, studioScopeEvents, users } from '../db/schema.js'
import { config } from '../config.js'
import { sendEmail } from '../services/email.js'
import { promptStatus, type Exec } from './quota.js'

/**
 * Keeping the studio to design work. The worker's scope check turns an off-topic message down before the agent runs
 * (outcome off_topic, refunded); an agent that stops on one writes out/declined.json (outcome declined, counted). Both
 * are logged here for the owner. The user only ever sees a category's fixed words, never the model's note.
 */

export const CATEGORY_WORDS: Record<string, string> = {
  coding: 'coding help', writing: 'writing', research: 'research', chat: 'general chat', other: 'other work',
}
export const SCOPE_CATEGORIES = Object.keys(CATEGORY_WORDS)

export const offTopicNote = (category: string, counted = false) =>
  `The studio only builds Decentraland wearables and emotes, so this message (${CATEGORY_WORDS[category] ?? CATEGORY_WORDS.other}) wasn’t sent to the agent. ` +
  (counted ? 'It counted as a prompt, because several recent messages weren’t design work.' : 'It wasn’t counted.')

/**
 * Whether a turn-down by the check is free: the first STUDIO_FLAG_THRESHOLD in the window are, so an honest odd
 * message costs nothing, and a script sending nothing but off-topic messages pays for each one after that.
 */
export async function offTopicIsFree(exec: Exec, userId: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - config.studioFlag.windowHours * 3600_000)
  const earlier = await exec.select({ id: studioScopeEvents.id }).from(studioScopeEvents)
    .where(and(eq(studioScopeEvents.userId, userId), eq(studioScopeEvents.by, 'check'), gt(studioScopeEvents.createdAt, since)))
  return earlier.length < config.studioFlag.threshold
}
export const DECLINED_NOTE = 'The agent only works on Decentraland wearables and emotes, so it stopped.'

const MESSAGE_MAX = 2000
const NOTE_MAX = 120

export async function logScopeEvent(exec: Exec, e: {
  userId: string; designId: string; jobId: string; by: string; category: string; note: string; message: string
}): Promise<void> {
  await exec.insert(studioScopeEvents).values({
    ...e, category: SCOPE_CATEGORIES.includes(e.category) ? e.category : 'other',
    note: e.note.slice(0, NOTE_MAX), message: e.message.slice(0, MESSAGE_MAX),
  })
}

type Mailer = (to: string, subject: string, html: string) => Promise<boolean>
let mailer: Mailer = sendEmail
/** Tests swap the owner's mail out; null puts the real one back. */
export function setFlagMailer(m: Mailer | null) {
  mailer = m ?? sendEmail
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/** Mail to the owner (STUDIO_FLAG_EMAIL); nothing when it's unset, and a failure is logged, never thrown. */
export async function mailOwner(subject: string, html: string): Promise<void> {
  if (!config.studioFlag.email) return
  try {
    await mailer(config.studioFlag.email, subject, html)
  } catch (err) {
    console.error('[studio] owner email failed:', err instanceof Error ? err.message : err)
  }
}

/**
 * Opens a flag once the account reaches the threshold of turn-downs within the window (counting only those after its
 * last dismissal), and emails the owner when this call opened it. The unique open-flag index makes concurrent calls
 * open one flag and send one email.
 */
export async function maybeFlag(userId: string, now: Date): Promise<'opened' | null> {
  const { threshold, windowHours } = config.studioFlag
  const [{ closed }] = await db.select({ closed: max(studioFlags.closedAt) }).from(studioFlags).where(eq(studioFlags.userId, userId))
  const windowStart = new Date(now.getTime() - windowHours * 3600_000)
  const since = closed && closed > windowStart ? closed : windowStart
  const events = await db.select().from(studioScopeEvents)
    .where(and(eq(studioScopeEvents.userId, userId), gt(studioScopeEvents.createdAt, since)))
    .orderBy(desc(studioScopeEvents.createdAt))
  if (events.length < threshold) return null
  const [flag] = await db.insert(studioFlags).values({ userId, openedAt: now }).onConflictDoNothing().returning()
  if (!flag) return null
  const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId))
  const { plan } = await promptStatus(userId, now)
  const latest = events.slice(0, 5).map((e) =>
    `<li><b>${escapeHtml(CATEGORY_WORDS[e.category] ?? e.category)}</b> (${e.by === 'check' ? 'the check' : 'the agent'}): ` +
    `“${escapeHtml(e.message.slice(0, 300))}” <i>${escapeHtml(e.note)}</i></li>`).join('')
  await mailOwner(`Studio flag: ${u?.email ?? userId}`, `
    <p>${escapeHtml(u?.email ?? userId)} (${escapeHtml(plan)} plan) has ${events.length} turn-downs in the studio since
    ${since.toISOString().slice(0, 16).replace('T', ' ')} UTC.</p>
    <ul>${latest}</ul>
    <p><a href="${config.publicUrl}/admin/studio">Review it on the Studio flags page</a>: dismiss it, or pause their studio access.</p>`)
  return 'opened'
}

export async function isPaused(userId: string): Promise<boolean> {
  const [p] = await db.select({ userId: studioPauses.userId }).from(studioPauses).where(eq(studioPauses.userId, userId))
  return !!p
}

export async function pauseUser(userId: string, adminId: string, now: Date): Promise<boolean> {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId))
  if (!u) return false
  await db.insert(studioPauses).values({ userId, pausedAt: now, pausedBy: adminId }).onConflictDoNothing()
  return true
}

export async function resumeUser(userId: string): Promise<void> {
  await db.delete(studioPauses).where(eq(studioPauses.userId, userId))
}

/** Closes an open flag; false when there is none by that id. */
export async function dismissFlag(flagId: string, adminId: string, now: Date): Promise<boolean> {
  const [f] = await db.update(studioFlags).set({ status: 'dismissed', closedAt: now, closedBy: adminId })
    .where(and(eq(studioFlags.id, flagId), eq(studioFlags.status, 'open'))).returning({ id: studioFlags.id })
  return !!f
}

/** Flags for the admin page, newest first, each with its account and its latest turn-downs. */
export async function listFlags(status: 'open' | 'closed', now: Date) {
  const rows = await db.select({ f: studioFlags, email: users.email }).from(studioFlags)
    .innerJoin(users, eq(users.id, studioFlags.userId))
    .where(status === 'open' ? eq(studioFlags.status, 'open') : ne(studioFlags.status, 'open'))
    .orderBy(desc(studioFlags.openedAt)).limit(200)
  const ids = [...new Set(rows.map((r) => r.f.userId))]
  const paused = new Set(ids.length ? (await db.select().from(studioPauses).where(inArray(studioPauses.userId, ids))).map((p) => p.userId) : [])
  return Promise.all(rows.map(async ({ f, email }) => {
    const events = await db.select().from(studioScopeEvents)
      .where(eq(studioScopeEvents.userId, f.userId))
      .orderBy(desc(studioScopeEvents.createdAt)).limit(20)
    return {
      id: f.id, status: f.status, openedAt: f.openedAt, closedAt: f.closedAt,
      user: { id: f.userId, email, plan: (await promptStatus(f.userId, now)).plan },
      paused: paused.has(f.userId),
      events: events.map((e) => ({ by: e.by, category: e.category, note: e.note, message: e.message, designId: e.designId, createdAt: e.createdAt })),
    }
  }))
}
