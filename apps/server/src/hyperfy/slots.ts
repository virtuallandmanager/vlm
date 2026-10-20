import { and, count, eq, isNull, ne } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { hyperfyWorlds } from '../db/schema.js'
import { getSubscription, TIER_LIMITS } from '../integrations/stripe.js'

/**
 * A user's hosted-world slots. Every hosted world that isn't purged counts (provisioning, running, failed);
 * ended worlds and self-run worlds don't.
 */
export async function hostedWorldSlots(userId: string): Promise<{ used: number; limit: number }> {
  const [{ used }] = await db
    .select({ used: count() })
    .from(hyperfyWorlds)
    .where(
      and(
        eq(hyperfyWorlds.ownerId, userId),
        eq(hyperfyWorlds.kind, 'hosted'),
        isNull(hyperfyWorlds.purgedAt),
        ne(hyperfyWorlds.status, 'ended'),
      ),
    )
  const { tier } = await getSubscription(userId)
  return { used, limit: TIER_LIMITS[tier].hyperfyInstances }
}
