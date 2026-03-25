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
      try {
        await sql\`ALTER TABLE users ADD COLUMN IF NOT EXISTS active_org_id UUID\`;
        console.log('[vlm-server] active_org_id column ensured');
      } catch(e) { console.log('[vlm-server] active_org_id:', e.message); }
      try {
        await sql\`CREATE TABLE IF NOT EXISTS organizations (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, billing_owner_id UUID, logo_url TEXT, metadata JSONB, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())\`;
        console.log('[vlm-server] organizations table ensured');
      } catch(e) { console.log('[vlm-server] organizations:', e.message); }
      try {
        await sql\`DO \$\$ BEGIN CREATE TYPE org_role AS ENUM ('owner','admin','member'); EXCEPTION WHEN duplicate_object THEN NULL; END \$\$\`;
        await sql\`DO \$\$ BEGIN CREATE TYPE invite_status AS ENUM ('pending','accepted','declined','expired'); EXCEPTION WHEN duplicate_object THEN NULL; END \$\$\`;
        console.log('[vlm-server] enums ensured');
      } catch(e) { console.log('[vlm-server] enums:', e.message); }
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
