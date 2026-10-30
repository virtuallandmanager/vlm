import { and, desc, eq, gt, max } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { studioFlags, studioScopeEvents, users } from '../db/schema.js'
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

export const offTopicNote = (category: string) =>
  `The studio only builds Decentraland wearables and emotes, so this message (${CATEGORY_WORDS[category] ?? CATEGORY_WORDS.other}) wasn’t sent to the agent. It wasn’t counted.`
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
