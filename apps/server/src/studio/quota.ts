import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { studioPromptCredits, studioUsageDays } from '../db/schema.js'
import { getSubscription } from '../integrations/stripe.js'

/**
 * The Design Studio's daily prompt allowance and the hidden daily cost ceiling, per user and UTC day. A prompt counts
 * when it is accepted and is given back when its job ends in `error` or is lost. The allowance applies even when
 * config.allFeaturesUnlocked: prompts run on Virvi's paid agent keys. Gifted prompts (from gift codes) come next, never
 * expire, and skip the cost ceiling: the code's prompt count is their cap. Bought prompts (credits) are used after
 * those, never expire, and are still stopped by the cost ceiling; a given-back prompt returns to where it came from.
 */

export type PromptSource = 'allowance' | 'gift' | 'credit'

/** A database handle or an open transaction. */
export type Exec = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

export const utcDay = (now: Date) => now.toISOString().slice(0, 10)

function nextUtcMidnight(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString()
}

async function limitsFor(userId: string) {
  const sub = await getSubscription(userId)
  return { plan: sub.tier as string, allowance: sub.limits.studioPromptsPerDay, ceiling: sub.limits.studioDailyCostCeilingUsd }
}

async function usage(userId: string, day: string, exec: Exec = db) {
  const [row] = await exec.select().from(studioUsageDays)
    .where(and(eq(studioUsageDays.userId, userId), eq(studioUsageDays.day, day)))
  return { prompts: row?.prompts ?? 0, costUsd: row?.costUsd ?? 0 }
}

async function creditBalance(userId: string, exec: Exec = db): Promise<number> {
  const [row] = await exec.select({ balance: studioPromptCredits.balance }).from(studioPromptCredits)
    .where(eq(studioPromptCredits.userId, userId))
  return row?.balance ?? 0
}

async function giftedBalance(userId: string, exec: Exec = db): Promise<number> {
  const [row] = await exec.select({ gifted: studioPromptCredits.gifted }).from(studioPromptCredits)
    .where(eq(studioPromptCredits.userId, userId))
  return row?.gifted ?? 0
}

export async function promptStatus(userId: string, now: Date) {
  const { plan, allowance, ceiling } = await limitsFor(userId)
  const { prompts, costUsd } = await usage(userId, utcDay(now))
  const credits = await creditBalance(userId)
  const gifted = await giftedBalance(userId)
  return {
    plan,
    allowance,
    used: prompts,
    credits,
    gifted,
    left: Math.max(0, allowance - prompts) + credits + gifted,
    resetsAt: nextUtcMidnight(now),
    overCostCeiling: costUsd >= ceiling && gifted === 0,
  }
}

/**
 * Takes one prompt from today's allowance (when counted) in a single statement, so concurrent reservations never pass
 * it; once the allowance is spent, one gifted prompt, then one credit, each also in a single statement. Every
 * reservation, counted or not, is refused once today's spend reaches the cost ceiling, unless the user has gifted
 * prompts: past the ceiling an uncounted reservation (otherwise free) also takes one gifted prompt, so gifts cannot
 * fund unlimited runs; the job records `from: 'gift'` and the prompt is given back if the job errors.
 */
export async function reservePrompt(
  userId: string,
  now: Date,
  opts: { counted: boolean },
  exec: Exec = db,
): Promise<{ ok: true; day: string; from: PromptSource | null } | { ok: false; reason: 'allowance' | 'cost_ceiling' }> {
  const { allowance, ceiling } = await limitsFor(userId)
  const day = utcDay(now)
  const inc = opts.counted ? 1 : 0
  const rows = await exec.execute(sql`
    INSERT INTO studio_usage_days (user_id, day, prompts, cost_usd)
    SELECT ${userId}, ${day}, ${inc}, 0 WHERE ${inc} <= ${allowance} AND 0 < ${ceiling}
    ON CONFLICT (user_id, day) DO UPDATE SET prompts = studio_usage_days.prompts + EXCLUDED.prompts
    WHERE studio_usage_days.cost_usd < ${ceiling}
      AND (EXCLUDED.prompts = 0 OR studio_usage_days.prompts < ${allowance})
    RETURNING prompts`)
  if ((rows as unknown as unknown[]).length) return { ok: true, day, from: opts.counted ? 'allowance' : null }
  const { costUsd } = await usage(userId, day, exec)
  if (opts.counted || costUsd >= ceiling) {
    const gift = await exec.execute(sql`
      UPDATE studio_prompt_credits SET gifted = gifted - 1, updated_at = now()
      WHERE user_id = ${userId} AND gifted > 0
      RETURNING gifted`)
    if ((gift as unknown as unknown[]).length) return { ok: true, day, from: 'gift' }
  }
  if (costUsd >= ceiling) return { ok: false, reason: 'cost_ceiling' }
  const credit = await exec.execute(sql`
    UPDATE studio_prompt_credits SET balance = balance - 1, updated_at = now()
    WHERE user_id = ${userId} AND balance > 0
    RETURNING balance`)
  if ((credit as unknown as unknown[]).length) return { ok: true, day, from: 'credit' }
  return { ok: false, reason: 'allowance' }
}

/** Gives a counted prompt back: to the day's allowance, to the gifted balance, or as a credit when a credit paid for it. */
export async function refundPrompt(userId: string, day: string, from: PromptSource | null, exec: Exec = db): Promise<void> {
  if (from === 'credit') {
    await exec.insert(studioPromptCredits).values({ userId, balance: 1 })
      .onConflictDoUpdate({ target: studioPromptCredits.userId, set: { balance: sql`${studioPromptCredits.balance} + 1`, updatedAt: new Date() } })
    return
  }
  if (from === 'gift') {
    await exec.insert(studioPromptCredits).values({ userId, gifted: 1 })
      .onConflictDoUpdate({ target: studioPromptCredits.userId, set: { gifted: sql`${studioPromptCredits.gifted} + 1`, updatedAt: new Date() } })
    return
  }
  await exec.update(studioUsageDays)
    .set({ prompts: sql`GREATEST(${studioUsageDays.prompts} - 1, 0)` })
    .where(and(eq(studioUsageDays.userId, userId), eq(studioUsageDays.day, day)))
}

export async function recordCost(userId: string, day: string, costUsd: number, exec: Exec = db): Promise<void> {
  if (!(costUsd > 0)) return
  await exec.insert(studioUsageDays).values({ userId, day, prompts: 0, costUsd })
    .onConflictDoUpdate({
      target: [studioUsageDays.userId, studioUsageDays.day],
      set: { costUsd: sql`${studioUsageDays.costUsd} + ${costUsd}` },
    })
}
