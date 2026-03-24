#!/bin/sh
set -e

# Auto-create/update database tables on first boot
if [ -n "$DATABASE_URL" ]; then
  echo "[vlm-server] Running drizzle-kit push to sync schema..."
  cd /app/apps/server
  npx drizzle-kit push --force 2>&1 || echo "[vlm-server] Schema push failed — tables may already exist"
  cd /app
fi

# Start the server
exec node apps/server/dist/index.js
