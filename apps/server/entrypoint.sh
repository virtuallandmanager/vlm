#!/bin/sh
set -e

# Auto-create/update database tables on first boot
if [ -n "$DATABASE_URL" ]; then
  echo "[vlm-server] Running drizzle-kit push to sync schema..."
  cd /app/apps/server
  echo "yes" | npx drizzle-kit push 2>&1 || echo "[vlm-server] Schema push failed — tables may already exist"
  cd /app
fi

# Debug: verify dashboard exists
echo "[vlm-server] CWD: $(pwd)"
echo "[vlm-server] DASHBOARD_DIR: $DASHBOARD_DIR"
ls -la "${DASHBOARD_DIR:-./dashboard}/" 2>&1 | head -5 || echo "[vlm-server] WARNING: dashboard dir missing!"

# Start the server
exec node apps/server/dist/index.js
