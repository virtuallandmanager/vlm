#!/bin/sh
# Upgrade-path check for the boot-time schema sync (entrypoint.sh).
#
# Creates a scratch database, pushes the pre-analytics schema (commit 73f1efe) into it, runs
# scripts/pre-push-upgrade.mjs, then pushes the current schema with stdin closed and asserts that
# drizzle-kit exits 0 within a timeout (an interactive rename prompt would hang or fail instead).
# Drops the scratch database afterwards.
#
# Run it with BASE_REF=main as well: that base still has vlm_scene_id, so it checks the Virvi column rename. (virvi-rename: keep)
#
# Usage: scripts/check-upgrade-push.sh [--skip-presync]
#   PG_ADMIN_URL   admin connection (default postgres://vlm:vlm_dev@localhost:5432/postgres)
#   CHECK_DB       scratch database name (default virvi_upgrade_check)
#   BASE_REF       git ref holding the old schema (default 73f1efe)
#   PUSH_TIMEOUT   seconds before the head push counts as hung (default 120)
set -eu

cd "$(dirname "$0")/.."
SERVER_DIR=$(pwd)
ADMIN_URL=${PG_ADMIN_URL:-postgres://vlm:vlm_dev@localhost:5432/postgres}
CHECK_DB=${CHECK_DB:-virvi_upgrade_check}
BASE_REF=${BASE_REF:-73f1efe}
PUSH_TIMEOUT=${PUSH_TIMEOUT:-120}
SKIP_PRESYNC=0
[ "${1:-}" = "--skip-presync" ] && SKIP_PRESYNC=1

case "$CHECK_DB" in
  *upgrade_check*) ;;
  *) echo "CHECK_DB must contain 'upgrade_check' (refusing to touch $CHECK_DB)"; exit 2 ;;
esac

DB_URL=$(node -e 'const u = new URL(process.argv[1]); u.pathname = "/" + process.argv[2]; console.log(u.toString())' "$ADMIN_URL" "$CHECK_DB")
WORK=$(mktemp -d "$SERVER_DIR/.upgrade-check.XXXXXX")

run_sql() {
  url=$1
  shift
  ADMIN_URL="$url" node --input-type=module -e "
    import postgres from 'postgres'
    const sql = postgres(process.env.ADMIN_URL, { max: 1, onnotice: () => {} })
    try { await sql.unsafe(process.argv[1]) } finally { await sql.end() }
  " "$1"
}
admin() { run_sql "$ADMIN_URL" "$1"; }

cleanup() {
  rm -rf "$WORK"
  admin "DROP DATABASE IF EXISTS \"$CHECK_DB\" WITH (FORCE)" || true
}
trap cleanup EXIT

# Run a command with a timeout (portable: macOS has no coreutils timeout).
with_timeout() {
  secs=$1
  shift
  perl -e 'alarm shift; exec @ARGV or die "exec failed: $!"' "$secs" "$@"
}

echo "== creating scratch database $CHECK_DB"
admin "DROP DATABASE IF EXISTS \"$CHECK_DB\" WITH (FORCE)"
admin "CREATE DATABASE \"$CHECK_DB\""

echo "== pushing base schema from $BASE_REF"
git show "$BASE_REF:apps/server/src/db/schema.ts" > "$WORK/schema.ts"
cat > "$WORK/drizzle.config.ts" <<EOF
import { defineConfig } from 'drizzle-kit'
export default defineConfig({ schema: '$WORK/schema.ts', dialect: 'postgresql', dbCredentials: { url: process.env.DATABASE_URL! } })
EOF
DATABASE_URL="$DB_URL" with_timeout "$PUSH_TIMEOUT" npx drizzle-kit push --force --config "$WORK/drizzle.config.ts" < /dev/null > "$WORK/base.log" 2>&1 || {
  cat "$WORK/base.log"
  echo "FAIL: could not push the base schema"
  exit 1
}
if [ "$BASE_REF" = 73f1efe ]; then
  run_sql "$DB_URL" "SELECT user_id FROM analytics_sessions LIMIT 0; SELECT name FROM analytics_actions LIMIT 0"
  echo "   base schema in place (legacy analytics_sessions.user_id + analytics_actions)"
fi

if [ "$SKIP_PRESYNC" = 1 ]; then
  echo "== skipping pre-push upgrade SQL (--skip-presync)"
else
  echo "== running scripts/pre-push-upgrade.mjs"
  DATABASE_URL="$DB_URL" node scripts/pre-push-upgrade.mjs
  echo "== running it again (must be idempotent)"
  DATABASE_URL="$DB_URL" node scripts/pre-push-upgrade.mjs
fi

echo "== pushing head schema non-interactively (stdin </dev/null, timeout ${PUSH_TIMEOUT}s)"
set +e
DATABASE_URL="$DB_URL" with_timeout "$PUSH_TIMEOUT" npx drizzle-kit push < /dev/null > "$WORK/head.log" 2>&1
code=$?
set -e
tail -n 15 "$WORK/head.log"
if [ "$code" -ne 0 ]; then
  echo "FAIL: head push exited $code (142 = timed out waiting on a prompt)"
  exit 1
fi

if [ "$SKIP_PRESYNC" = 0 ]; then
  echo "== re-running the pre-push SQL on the upgraded database (next boot; must keep the new tables)"
  DATABASE_URL="$DB_URL" node scripts/pre-push-upgrade.mjs
fi

# The next boot pushes again over a schema push itself created. Postgres 18 names NOT NULL
# constraints, which drizzle-kit 0.30 tried to drop (failing on primary keys); composite primary
# keys whose columns aren't alphabetical were dropped and re-added on every push.
echo "== pushing head schema again (next boot: must succeed and drop no constraint)"
set +e
DATABASE_URL="$DB_URL" with_timeout "$PUSH_TIMEOUT" npx drizzle-kit push --verbose < /dev/null > "$WORK/again.log" 2>&1
code=$?
set -e
if [ "$code" -ne 0 ]; then
  tail -n 15 "$WORK/again.log"
  echo "FAIL: second head push exited $code"
  exit 1
fi
if grep -q 'DROP CONSTRAINT' "$WORK/again.log"; then
  grep 'DROP CONSTRAINT' "$WORK/again.log" | head -5
  echo "FAIL: second head push drops constraints on an up-to-date schema"
  exit 1
fi

echo "== verifying the head tables exist"
run_sql "$DB_URL" "SELECT location_key FROM analytics_scenes LIMIT 0; SELECT visitor_hash, last_seen_at FROM analytics_sessions LIMIT 0" ||
  { echo "FAIL: head analytics tables missing after push"; exit 1; }
echo "== verifying the Virvi column and index names"
run_sql "$DB_URL" "DO \$\$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'vlm_scene_id') THEN RAISE EXCEPTION 'vlm_scene_id still exists'; END IF; -- virvi-rename: keep
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = current_schema() AND column_name = 'virvi_scene_id' AND table_name IN ('analytics_scenes', 'location_setups')) <> 2 THEN RAISE EXCEPTION 'virvi_scene_id missing'; END IF;
  IF to_regclass('analytics_scenes_virvi_scene_idx') IS NULL OR to_regclass('location_setups_virvi_scene_idx') IS NULL THEN RAISE EXCEPTION 'virvi_scene indexes missing'; END IF;
END \$\$" || { echo "FAIL: Virvi column or index names missing after push"; exit 1; }
echo "PASS: upgrade push completed non-interactively (exit 0)"
