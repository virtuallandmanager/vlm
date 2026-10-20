import { and, eq, inArray, lte, gt, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { bookings, venues } from '../db/schema.js'

/** True when a confirmed or live booking covers `now` and lists this element (or its original) as rentable. */
export async function isUnderActiveBooking(
  sceneId: string,
  element: { id: string; clonedFromId: string | null },
  now: Date,
): Promise<boolean> {
  const ids = element.clonedFromId ? [element.id, element.clonedFromId] : [element.id]
  const idList = sql.join(ids.map((i) => sql`${i}`), sql`, `)
  const [row] = await db
    .select({ id: bookings.id })
    .from(bookings)
    .innerJoin(venues, eq(venues.id, bookings.venueId))
    .where(
      and(
        eq(venues.sceneId, sceneId),
        inArray(bookings.status, ['confirmed', 'live']),
        lte(bookings.startsAt, now),
        gt(bookings.endsAt, now),
        sql`${venues.rentableElementIds} && ARRAY[${idList}]::uuid[]`,
      ),
    )
    .limit(1)
  return !!row
}
