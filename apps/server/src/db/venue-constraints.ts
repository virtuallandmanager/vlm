/**
 * The exclusion constraint Drizzle can't express (CHECKs live in schema.ts). Idempotent; runs on every boot after
 * drizzle-kit push, so it also restores anything push might drop.
 * Takes an executor so the test global setup can run it without the app's db pool.
 */
export async function ensureVenueConstraints(exec: (query: string) => Promise<unknown>) {
  await exec(`CREATE EXTENSION IF NOT EXISTS btree_gist`)
  await exec(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_no_overlap') THEN
        ALTER TABLE bookings ADD CONSTRAINT bookings_no_overlap
          EXCLUDE USING gist (venue_id WITH =, blocked_range WITH &&)
          WHERE (status IN ('pending', 'confirmed', 'live'));
      END IF;
    END $$;
  `)
}
