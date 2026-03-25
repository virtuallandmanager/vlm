#!/bin/sh
set -e

# Auto-create/update database tables on first boot
if [ -n "$DATABASE_URL" ]; then
  echo "[vlm-server] Running drizzle-kit push to sync schema..."
  cd /app/apps/server
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

      // model enum value
      try {
        await sql\`ALTER TYPE element_type ADD VALUE IF NOT EXISTS 'model'\`;
        console.log('[vlm-server] model enum value ensured');
      } catch(e) { console.log('[vlm-server] model enum:', e.message); }
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
