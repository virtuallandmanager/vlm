/**
 * Constraints Drizzle can't express. Idempotent; runs on every boot after
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
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_renter_present') THEN
        ALTER TABLE bookings ADD CONSTRAINT bookings_renter_present
          CHECK (renter_user_id IS NOT NULL OR renter_wallet IS NOT NULL);
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'access_grants_subject_present') THEN
        ALTER TABLE access_grants ADD CONSTRAINT access_grants_subject_present
          CHECK (wallet_address IS NOT NULL OR user_id IS NOT NULL);
      END IF;
    END $$;
  `)
}
