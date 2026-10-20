#!/bin/sh
set -e

# Auto-create/update database tables on first boot
if [ -n "$DATABASE_URL" ]; then
  echo "[vlm-server] Running drizzle-kit push to sync schema..."
  cd /app/apps/server
  # Drop the legacy (never-populated) analytics tables first, or push stops at a rename prompt.
  node scripts/pre-push-upgrade.mjs 2>&1 || echo "[vlm-server] pre-push upgrade SQL failed"
  yes | npx drizzle-kit push 2>&1 || echo "[vlm-server] drizzle-kit push failed, trying raw SQL fallback..."

  # Fallback: ensure critical columns exist even if drizzle-kit push fails
  echo "[vlm-server] Ensuring critical schema columns exist..."
  node -e "
    const postgres = require('postgres');
    const sql = postgres(process.env.DATABASE_URL);
    (async () => {
      // Enums
      try {
        await sql\`DO \$\$ BEGIN CREATE TYPE org_role AS ENUM ('owner','admin','member'); EXCEPTION WHEN duplicate_object THEN NULL; END \$\$\`;
        await sql\`DO \$\$ BEGIN CREATE TYPE invite_status AS ENUM ('pending','accepted','declined','expired'); EXCEPTION WHEN duplicate_object THEN NULL; END \$\$\`;
        console.log('[vlm-server] enums ensured');
      } catch(e) { console.log('[vlm-server] enums:', e.message); }

      // Organizations table
      try {
        await sql\`CREATE TABLE IF NOT EXISTS organizations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, billing_owner_id UUID, logo_url TEXT, metadata JSONB, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())\`;
        console.log('[vlm-server] organizations table ensured');
      } catch(e) { console.log('[vlm-server] organizations:', e.message); }

      // org_id columns on all data tables
      const orgIdTables = ['users', 'scenes', 'media_assets', 'events', 'giveaways', 'subscriptions', 'streaming_servers'];
      for (const table of orgIdTables) {
        const col = table === 'users' ? 'active_org_id' : 'org_id';
        try {
          await sql.unsafe(\`ALTER TABLE \${table} ADD COLUMN IF NOT EXISTS \${col} UUID\`);
          console.log('[vlm-server] ' + col + ' on ' + table + ' ensured');
        } catch(e) { console.log('[vlm-server] ' + table + '.' + col + ':', e.message); }
      }

      // Other new tables
      try {
        await sql\`CREATE TABLE IF NOT EXISTS org_members (org_id UUID NOT NULL, user_id UUID NOT NULL, role org_role NOT NULL DEFAULT 'member', joined_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (org_id, user_id))\`;
        await sql\`CREATE TABLE IF NOT EXISTS org_invites (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), org_id UUID NOT NULL, email TEXT NOT NULL, role org_role NOT NULL DEFAULT 'member', invited_by UUID NOT NULL, status invite_status NOT NULL DEFAULT 'pending', token TEXT UNIQUE NOT NULL, expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW())\`;
        await sql\`CREATE TABLE IF NOT EXISTS api_keys (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL, org_id UUID, name TEXT NOT NULL, key_hash TEXT NOT NULL, key_prefix TEXT NOT NULL, scopes TEXT[], last_used_at TIMESTAMPTZ, expires_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW())\`;
        await sql\`CREATE TABLE IF NOT EXISTS password_reset_tokens (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID NOT NULL, token TEXT UNIQUE NOT NULL, expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW())\`;
        console.log('[vlm-server] new tables ensured');
      } catch(e) { console.log('[vlm-server] new tables:', e.message); }

      // Hand-off codes (HUD Stats tab sign-in); matches authHandoffCodes in src/db/schema.ts
      try {
        await sql\`CREATE TABLE IF NOT EXISTS auth_handoff_codes (code_hash TEXT PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, wallet TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, used_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\`;
        await sql\`ALTER TABLE auth_handoff_codes ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'account'\`;
        await sql\`ALTER TABLE auth_handoff_codes ADD COLUMN IF NOT EXISTS scene_id UUID REFERENCES scenes(id) ON DELETE CASCADE\`;
        await sql\`ALTER TABLE auth_handoff_codes ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES analytics_scenes(id) ON DELETE CASCADE\`;
        await sql\`ALTER TABLE auth_handoff_codes ADD COLUMN IF NOT EXISTS pass_expires_at TIMESTAMPTZ\`;
        console.log('[vlm-server] auth_handoff_codes table ensured');
      } catch(e) { console.log('[vlm-server] auth_handoff_codes:', e.message); }

      // Per-scene media library; matches sceneLibrary in src/db/schema.ts
      try {
        await sql\`CREATE TABLE IF NOT EXISTS scene_library (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), scene_id UUID NOT NULL REFERENCES scenes(id) ON DELETE CASCADE, media_asset_id UUID REFERENCES media_assets(id) ON DELETE CASCADE, asset_item_id UUID REFERENCES asset_library_items(id) ON DELETE CASCADE, added_by UUID REFERENCES users(id) ON DELETE SET NULL, booking_id UUID REFERENCES bookings(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), CONSTRAINT scene_library_one_item CHECK ((media_asset_id IS NULL) <> (asset_item_id IS NULL)))\`;
        await sql\`CREATE UNIQUE INDEX IF NOT EXISTS scene_library_media_uq ON scene_library (scene_id, media_asset_id) WHERE media_asset_id IS NOT NULL\`;
        await sql\`CREATE UNIQUE INDEX IF NOT EXISTS scene_library_asset_uq ON scene_library (scene_id, asset_item_id) WHERE asset_item_id IS NOT NULL\`;
        await sql\`CREATE INDEX IF NOT EXISTS scene_library_scene_idx ON scene_library (scene_id)\`;
        console.log('[vlm-server] scene_library table ensured');
      } catch(e) { console.log('[vlm-server] scene_library:', e.message); }

      // Catalog packs; matches catalogPacks / assetLibraryItems in src/db/schema.ts
      try {
        await sql\`CREATE TABLE IF NOT EXISTS catalog_packs (id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, license TEXT NOT NULL, attribution TEXT NOT NULL, source_url TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\`;
        await sql\`ALTER TABLE asset_library_items ADD COLUMN IF NOT EXISTS pack_id TEXT REFERENCES catalog_packs(id) ON DELETE RESTRICT\`;
        await sql\`ALTER TABLE asset_library_items ADD COLUMN IF NOT EXISTS style TEXT\`;
        await sql\`ALTER TABLE asset_library_items ADD COLUMN IF NOT EXISTS venue_tags TEXT[]\`;
        await sql\`ALTER TABLE asset_library_items ADD COLUMN IF NOT EXISTS source_ref TEXT\`;
        await sql\`ALTER TABLE asset_library_items ADD COLUMN IF NOT EXISTS content_hash TEXT\`;
        await sql\`CREATE UNIQUE INDEX IF NOT EXISTS asset_library_items_pack_ref ON asset_library_items (pack_id, source_ref)\`;
        await sql\`CREATE INDEX IF NOT EXISTS asset_library_items_content_hash_idx ON asset_library_items (content_hash)\`;
        console.log('[vlm-server] catalog packs ensured');
      } catch(e) { console.log('[vlm-server] catalog packs:', e.message); }

      // Hyperfy worlds; matches hyperfyWorlds in src/db/schema.ts
      try {
        await sql\`CREATE TABLE IF NOT EXISTS hyperfy_worlds (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), scene_id UUID NOT NULL REFERENCES scenes(id) ON DELETE CASCADE, owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'self', key_hash TEXT NOT NULL UNIQUE, key_prefix TEXT NOT NULL, last_seen_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\`;
        await sql\`CREATE INDEX IF NOT EXISTS hyperfy_worlds_scene_idx ON hyperfy_worlds (scene_id)\`;
        await sql\`ALTER TABLE hyperfy_worlds ADD COLUMN IF NOT EXISTS slug TEXT, ADD COLUMN IF NOT EXISTS address TEXT, ADD COLUMN IF NOT EXISTS fly_app TEXT, ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'running', ADD COLUMN IF NOT EXISTS error_message TEXT, ADD COLUMN IF NOT EXISTS admin_code_enc TEXT, ADD COLUMN IF NOT EXISTS ends_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS ended_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS purge_after TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS purged_at TIMESTAMPTZ, ADD COLUMN IF NOT EXISTS purge_claimed_at TIMESTAMPTZ\`;
        await sql\`CREATE UNIQUE INDEX IF NOT EXISTS hyperfy_worlds_slug_uq ON hyperfy_worlds (slug) WHERE purged_at IS NULL\`;
        console.log('[vlm-server] hyperfy worlds ensured');
      } catch(e) { console.log('[vlm-server] hyperfy worlds:', e.message); }

      // Upload status (two-step companion uploads); matches mediaAssets / uploadTokens in src/db/schema.ts
      try {
        await sql\`ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ready'\`;
        await sql\`ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS error TEXT\`;
        await sql\`ALTER TABLE media_assets ALTER COLUMN storage_key DROP NOT NULL\`;
        await sql\`ALTER TABLE upload_tokens ADD COLUMN IF NOT EXISTS kinds TEXT[]\`;
        await sql\`ALTER TABLE upload_tokens ADD COLUMN IF NOT EXISTS minter_wallet TEXT\`;
        await sql\`ALTER TABLE upload_tokens ADD COLUMN IF NOT EXISTS minter_verified BOOLEAN NOT NULL DEFAULT false\`;
        console.log('[vlm-server] media status columns ensured');
      } catch(e) { console.log('[vlm-server] media status columns:', e.message); }

      // One-time startup job markers; matches systemFlags in src/db/schema.ts
      try {
        await sql\`CREATE TABLE IF NOT EXISTS system_flags (key TEXT PRIMARY KEY, set_at TIMESTAMPTZ NOT NULL DEFAULT NOW())\`;
        console.log('[vlm-server] system_flags table ensured');
      } catch(e) { console.log('[vlm-server] system_flags:', e.message); }

      // model enum value
      try {
        await sql\`ALTER TYPE element_type ADD VALUE IF NOT EXISTS 'model'\`;
        console.log('[vlm-server] model enum value ensured');
      } catch(e) { console.log('[vlm-server] model enum:', e.message); }
      // Hyperfy analytics location kind
      try {
        await sql\`ALTER TYPE analytics_scene_kind ADD VALUE IF NOT EXISTS 'hyperfy'\`;
        console.log('[vlm-server] hyperfy analytics kind ensured');
      } catch(e) { console.log('[vlm-server] hyperfy analytics kind:', e.message); }
      await sql.end();
    })();
  " 2>&1 || echo "[vlm-server] SQL fallback had errors"
  cd /app
fi

# Debug: verify dashboard exists
echo "[vlm-server] CWD: $(pwd)"
echo "[vlm-server] DASHBOARD_DIR: $DASHBOARD_DIR"
ls -la "${DASHBOARD_DIR:-./dashboard}/" 2>&1 | head -5 || echo "[vlm-server] WARNING: dashboard dir missing!"

# Start the server
exec node apps/server/dist/index.js
