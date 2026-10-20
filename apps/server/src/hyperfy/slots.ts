import { and, count, eq, isNull, notInArray } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { hyperfyWorlds } from '../db/schema.js'
import { getSubscription, TIER_LIMITS } from '../integrations/stripe.js'

/**
 * A user's hosted-world slots. Hosted worlds that are provisioning or running count; failed worlds (already cleaned
 * up), ended, purged and self-run worlds don't. Pass a transaction to count inside it.
 */
export async function hostedWorldSlots(userId: string, executor: Pick<typeof db, 'select'> = db): Promise<{ used: number; limit: number }> {
  const [{ used }] = await executor
    .select({ used: count() })
    .from(hyperfyWorlds)
    .where(
      and(
        eq(hyperfyWorlds.ownerId, userId),
        eq(hyperfyWorlds.kind, 'hosted'),
        isNull(hyperfyWorlds.purgedAt),
        notInArray(hyperfyWorlds.status, ['ended', 'failed']),
      ),
    )
  const { tier } = await getSubscription(userId)
  return { used, limit: TIER_LIMITS[tier].hyperfyInstances }
}
