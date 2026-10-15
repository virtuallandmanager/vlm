# VLM Smart Wearable Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A VLM smart wearable that shows a My Scenes stats panel everywhere and takes over the VLM HUD for a picked scene whenever the scene's own HUD isn't controlling it.

**Architecture:** The wearable signs in with Decentraland signed fetch through the existing `POST /api/auth/platform`, polls a new `GET /api/remote/overview`, and joins one scene room at a time without rendering content. Scene rooms publish `visitors` and `hudWallets` as Colyseus room metadata so the overview can report live counts and whether a scene HUD is connected for you. The HUD's panels and action wiring move out of `createVLM` so the scene HUD and the wearable share them; the wearable adds a remote mode with numeric transform editing.

**Tech Stack:** Fastify 5, Drizzle/Postgres, Colyseus 0.15, vitest (real Postgres `vlm_test`), Decentraland SDK7 (React-ECS UI, smart-wearable CLI project), pnpm/turbo monorepo. Node at `~/.nvm/versions/node/v20.20.2/bin`.

**Spec:** `docs/superpowers/specs/2026-10-14-vlm-smart-wearable-design.md`

## Global Constraints

- The packed wearable (all files, uncompressed) must be ≤ 3 MB.
- Wearable `scene.json` `requiredPermissions`: `["USE_FETCH", "USE_WEBSOCKET"]`; both body shapes (`BaseMale`, `BaseFemale`).
- Wearable connections never count as visitors and never render scene content.
- Edits from the wearable go through the same REST routes and permission checks as the scene HUD (`scene.edit` etc.); viewers are stats-only.
- Scene-mode HUD behaviour is unchanged for existing scenes.
- Never run destructive SQL against production. Production access (`railway ssh -s vlm-server -i ~/.ssh/id_stevenwritescode`) is read-only in every task. Never print secrets (`.env`, Railway variables, `~/.config/vlm/*`).
- Don't touch billing routes. Don't push or deploy; the controller does that with the user.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Server tests: `cd apps/server && PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH pnpm test` (vitest, real Postgres `vlm_test`, schema created by `drizzle-kit push --force` in `test/global-setup.ts`).

## Rulings made while writing this plan (against the spec)

1. **Session endpoint:** the spec's `POST /api/remote/session` is not built. `POST /api/auth/platform` already verifies Decentraland signed fetch without needing a location and returns a verified-wallet access + refresh token (`wallet`, `verified: true`). The wearable uses it through `VLMHttpClient.authenticateWithPlatform`. If wrong: add a thin alias route later.
2. **How a scene HUD is recognised:** every in-world client joins rooms with `clientType: 'analytics'` today (`vlm-core` `VLM.connectToScene` hard-codes it), so `hudWallets` can't come from `clientType`. New join options `source: 'scene' | 'wearable'` and `hud: boolean`. `hudWallets` = the verified actor wallets of clients with `source !== 'wearable' && hud === true`. Clients that send neither (vlm-dcl ≤ 2.1.0) count as "no HUD", which is the spec's "old vlm-dcl" row (wearable stays visible). Wallets come from the verified token, never from options.
3. **No content in the wearable:** `VLM.connectToScene(sceneId, opts?)` gains `{ source, hud, renderContent }`; with `renderContent: false` the scene-content handlers (`scene_preset_update`, `scene_change_preset`, `scene_video_status`) don't touch `SceneManager`, but `init` still resolves the connect.
4. **Edits stay on REST:** the scene HUD already edits through REST (`createElement`, `updateElement`, `updateInstance`, `deleteElement`), and the server broadcasts the result. The wearable does the same. Its room connection keeps its Layout list live (upsert/delete/preset messages) and keeps `hudWallets`/`visitors` honest.
5. **Worlds match by realm:** the spec says "Worlds never match". That would show two HUDs when you stand in your own World with its HUD running. The wearable treats "in this scene" as: Genesis City parcel match, or current realm = the scene's World name. Combined with `hudActive`, a World scene with a running HUD hides the wearable HUD; without one, it stays. If wrong: drop the realm check in `standingIn()`.
6. **Stats definitions:** `visitorsNow` = room metadata `visitors` (0 with no open room); it includes hosts standing there. `todayVisitors` = distinct `visitor_hash` in `analytics_sessions` started since max(UTC midnight, the active setup's `started_at`). `todayPeak` = max `peak_concurrency` in `analytics_rollup_hourly` for today's hours (lags until the hourly rollup runs). `streamLive` = any video element in the active preset whose `liveSrc` is a `streaming_servers.hls_playlist_url` with `status = 'live'` (same rule as `streaming/live-status.ts`).
7. **Numeric editing** is remote mode only (spec §5); scene mode keeps "place in front of me".

## Review Focus

1. A scene HUD that disconnects (player leaves, client crashes) must drop out of `hudWallets` on `onLeave`, or the wearable HUD never comes back → test in Task 4.
2. Two clients with the same wallet in one room (scene HUD + wearable): leaving one must not remove the other's contribution → Task 4 counts per session, not per wallet.
3. A viewer, or a wallet whose role was revoked, must get no edit controls and REST must still refuse → Task 5 overview `role`, Task 8 handler checks role.
4. A scene with no active setup (dashboard-only scene) has no parcels: it is listed but never "stood in" → Task 5 returns `parcels: []`, Task 9 `standingIn()` returns false.
5. Overview poll when the token expires mid-session: refresh, then retry once; no error spam → Task 9.

---

### Task 1: Spike — bare smart wearable (GATE)

**Files:**
- Create: `apps/vlm-wearable-spike/` (throwaway; not in turbo pipelines)
- Create: `docs/superpowers/notes/2026-10-14-wearable-spike-findings.md`

This task decides whether the rest of the plan runs. **If any of: React-ECS UI renders, `signedFetch` reaches the server with verifiable headers, a Colyseus room join succeeds, or the minified packed size ≤ 3 MB fails, the controller stops and reports to the user before Task 2.**

- [ ] **Step 1: Scaffold**

```bash
cd ~/-VLM/vlm-v2/apps && mkdir vlm-wearable-spike && cd vlm-wearable-spike
PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH npx @dcl/sdk-commands init --yes --project smart-wearable
```

Edit `scene.json`: add `"requiredPermissions": ["USE_FETCH", "USE_WEBSOCKET"]`. Check `wearable.json` has a unique `id` and both `BaseMale` and `BaseFemale` representations. Add `apps/vlm-wearable-spike` to `pnpm-workspace.yaml` exclusions if the workspace globs pick it up (`!apps/vlm-wearable-spike`), so it installs with npm on its own.

- [ ] **Step 2: Probe code** — `src/index.ts`:

```ts
import ReactEcs, { ReactEcsRenderer, UiEntity, Label } from '@dcl/sdk/react-ecs'
import { signedFetch } from '~system/SignedFetch'
import { Client } from 'colyseus.js'

const SERVER = 'https://api.vlm.gg'
const WSS = 'wss://api.vlm.gg'
const results: Record<string, string> = { ui: 'ok (you can read this)', signedFetch: 'pending', auth: 'pending', ws: 'pending' }

ReactEcsRenderer.setUiRenderer(() => (
  <UiEntity uiTransform={{ positionType: 'absolute', position: { right: 12, top: 62 }, width: 320, flexDirection: 'column', padding: 8 }} uiBackground={{ color: { r: 0.1, g: 0.1, b: 0.15, a: 0.9 } }}>
    {Object.entries(results).map(([k, v]) => <Label key={k} value={`${k}: ${v}`} fontSize={12} />)}
  </UiEntity>
))

export async function main() {
  try {
    const res = await signedFetch({ url: `${SERVER}/api/auth/platform`, init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' } })
    results.signedFetch = `HTTP ${res.status}`
    const body = JSON.parse(res.body || '{}')
    results.auth = body.verified ? `verified ${String(body.user?.id).slice(0, 8)}` : `not verified (guest=${!!body.guest})`
    const client = new Client(WSS)
    // A random UUID scene: the room is created and accepts the join even with no scene row
    const room = await client.joinOrCreate('vlm_scene', { sceneId: '00000000-0000-4000-8000-000000000000', sessionToken: body.accessToken, clientType: 'analytics' })
    results.ws = `joined ${room.roomId}`
    room.onMessage('*', () => {})
  } catch (e) {
    results.ws = results.ws === 'pending' ? `failed: ${String(e)}` : results.ws
  }
}
```

Install `colyseus.js` the same version `vlm-core` uses (`grep colyseus.js packages/vlm-core/package.json`). If `colyseus.js` needs the WebSocket polyfill that `vlm-core` ships (`packages/vlm-core/src` network polyfills), copy the import used by `vlm-core` instead of re-writing it.

- [ ] **Step 3: Preview** — `npx @dcl/sdk-commands start --port 8010` from the spike folder; open the preview. Record what the panel says. (In preview, `auth` is expected to be unverified — that's fine; Sepolia gives the real answer.)

- [ ] **Step 4: Size** — `npx @dcl/sdk-commands build --production && npm run pack`; record `unzip -l smart-wearable.zip | tail -1` (total uncompressed) and `ls -la bin/index.js`. Then add the real HUD weight: temporarily import `DclHUDRenderer` from `vlm-adapter-dcl` and `VLM` from `vlm-core` (workspace `file:` links), call `new DclHUDRenderer().init()`, rebuild with `--production`, record the size again, then revert that import.

- [ ] **Step 5 (USER STEP): Sepolia "See in world"** — the user uploads `smart-wearable.zip` in the Builder (Collections → new collection → upload, set hide/replace categories), then "See in world" on Sepolia, wears it and reads the four lines. The controller asks the user for the four values.

- [ ] **Step 6: Findings note** — write `docs/superpowers/notes/2026-10-14-wearable-spike-findings.md` with: each probe's result (preview and Sepolia), sizes (bare, with HUD), whether `teleportTo` from `~system/RestrictedActions` is allowed (call it from a button in a second run if time permits), and a verdict: GO, GO with slim bundle (spec §5 fallback), or STOP.

- [ ] **Step 7: Commit** — `git add docs/superpowers/notes/2026-10-14-wearable-spike-findings.md apps/vlm-wearable-spike && git commit -m "spike: bare smart wearable probes (UI, signed fetch, room join, size)"`. Exclude `node_modules`, `bin`, and the zip (add an `apps/vlm-wearable-spike/.gitignore`).

**Gate:** controller reads the verdict. STOP → report to the user. GO with slim bundle → Task 7 uses the slim path (noted there).

---

### Task 2: Fix the boot-time `drizzle-kit push` failure

**Files:**
- Modify: `apps/server/src/db/schema.ts` and/or `apps/server/scripts/pre-push-upgrade.mjs` (whichever the diagnosis points at)
- Create: `apps/server/scripts/check-prod-shape-push.sh`
- Modify: `apps/server/entrypoint.sh` (log line only, see Step 5)

On the 2026-10-14 deploy, `yes | npx drizzle-kit push` failed with `PostgresError: column "id" is in a primary key`; the server started anyway. Statements after the failing one were not applied (`playback_id` exists because it ran earlier in the batch, or was applied on an earlier attempt). The next table (`remote_panel_prefs`, Task 3) would silently never be created.

- [ ] **Step 1: Capture production's schema, read-only.** Dump schema only — no data — from production through Railway SSH with Node (the container has `postgres` but likely no `pg_dump`):

```bash
cd ~/-VLM/vlm-v2
cat > /tmp/claude-501/schema-shape.cjs <<'EOF'
const p = require('postgres'); const s = p(process.env.DATABASE_URL, { max: 1 })
;(async () => {
  const cols = await s`select table_name, column_name, data_type, udt_name, is_nullable, column_default from information_schema.columns where table_schema='public' order by table_name, ordinal_position`
  const cons = await s`select conrelid::regclass::text as tbl, conname, contype, pg_get_constraintdef(oid) as def from pg_constraint where connamespace='public'::regnamespace order by 1,2`
  const idx = await s`select tablename, indexname, indexdef from pg_indexes where schemaname='public' order by 1,2`
  const enums = await s`select t.typname, array_agg(e.enumlabel order by e.enumsortorder) as labels from pg_type t join pg_enum e on e.enumtypid=t.oid group by 1`
  console.log(JSON.stringify({ cols, cons, idx, enums }))
  await s.end()
})()
EOF
b64=$(base64 < /tmp/claude-501/schema-shape.cjs | tr -d '\n')
railway ssh -s vlm-server -i ~/.ssh/id_stevenwritescode "cd /app/apps/server && echo $b64 | base64 -d > ./.shape.cjs && node ./.shape.cjs > /tmp/shape.json 2>&1; cat /tmp/shape.json; rm -f ./.shape.cjs /tmp/shape.json" 2>/dev/null | grep '^{' > /tmp/claude-501/prod-shape.json
```

Only SELECTs on catalog views. Do not print `DATABASE_URL`.

- [ ] **Step 2: Rebuild the shape locally and reproduce.** Write `apps/server/scripts/check-prod-shape-push.sh` modelled on `scripts/check-upgrade-push.sh` (same `CHECK_DB` must contain `upgrade_check` guard, same cleanup trap, same portable timeout): create scratch DB `vlm_upgrade_check_prod`, recreate enums, tables, columns, constraints and indexes from `prod-shape.json` (a small Node script that emits `CREATE TYPE … / CREATE TABLE … / ALTER TABLE … ADD CONSTRAINT …` in dependency order — FKs last), run `node scripts/pre-push-upgrade.mjs`, then `npx drizzle-kit push --verbose --strict < /dev/null` and capture the printed SQL. Expected: the same `column "id" is in a primary key` error, and the verbose output names the statement (typically `ALTER TABLE "<t>" ALTER COLUMN "id" DROP NOT NULL` or a PK drop/re-add).

- [ ] **Step 3: Find the cause.** Compare that table's definition in `prod-shape.json` with `schema.ts`. Likely suspects (check each, write down which): tables the entrypoint's raw-SQL fallback creates with `id UUID PRIMARY KEY` (`organizations`, `org_invites`, `api_keys`, `password_reset_tokens`) where `schema.ts` differs (no `.primaryKey()`, a composite key, or `.notNull()` missing); or a table whose primary key name differs from Drizzle's `<table>_pkey`.

- [ ] **Step 4: Fix and prove.** Change `schema.ts` to match the production shape that's correct (prefer not changing production's PK), or add an idempotent non-destructive statement to `scripts/pre-push-upgrade.mjs` (e.g. renaming a constraint) — never a DROP of data. Re-run `scripts/check-prod-shape-push.sh`: drizzle-kit must exit 0 and a second push must report no changes. Run `scripts/check-upgrade-push.sh` too (the old upgrade path must still pass). Run the full server suite.

- [ ] **Step 5: Make the next failure loud.** In `entrypoint.sh`, change the push fallback echo to `echo "[vlm-server] SCHEMA PUSH FAILED — new tables/columns may be missing"` so it stands out in Railway logs (behaviour unchanged).

- [ ] **Step 6: Commit** — `fix(server): boot-time schema push no longer fails on <table>.id primary key`. Note in the commit body which statement failed and why.

---

### Task 3: Panel prefs table + command-center ownership fix

**Files:**
- Modify: `apps/server/src/db/schema.ts` (append)
- Modify: `apps/server/src/routes/command-center.ts:23-79`
- Test: `apps/server/test/command-center-status.test.ts` (new), `apps/server/test/analytics-schema.test.ts` pattern for the table check if useful

**Interfaces:** Produces `remotePanelPrefs` table export used by Task 5.

- [ ] **Step 1: Failing test for the ownership fix** — `test/command-center-status.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { events } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { createUser, testApp, tokenFor } from './helpers/factories.js'

describe('GET /api/command-center/:eventId/status', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })

  it('refuses a signed-in user who does not own the event', async () => {
    const owner = await createUser()
    const other = await createUser()
    const [event] = await db.insert(events).values({ ownerId: owner.id, name: 'Launch' } as any).returning()
    const res = await app.inject({ method: 'GET', url: `/api/command-center/${event.id}/status`, headers: { authorization: `Bearer ${tokenFor(other)}` } })
    expect(res.statusCode).toBe(403)
  })

  it('lets the owner and admins read it', async () => {
    const owner = await createUser()
    const admin = await createUser({ role: 'admin' })
    const [event] = await db.insert(events).values({ ownerId: owner.id, name: 'Launch' } as any).returning()
    for (const u of [owner, admin]) {
      const res = await app.inject({ method: 'GET', url: `/api/command-center/${event.id}/status`, headers: { authorization: `Bearer ${tokenFor(u)}` } })
      expect(res.statusCode).toBe(200)
    }
  })
})
```

Check the `events` insert columns against `schema.ts` (required fields like `startTime`) and fill them in.

- [ ] **Step 2: Run** — `pnpm test command-center-status` → first test FAILS (200).

- [ ] **Step 3: Fix** — in the status handler, after the 404 check, add the same check the broadcast route uses:

```ts
      if (event.ownerId !== request.user.id && request.user.role !== 'admin') {
        return reply.status(403).send({ error: 'Forbidden' })
      }
```

- [ ] **Step 4: Table** — append to `schema.ts` (after `locationSetups`):

```ts
/** The HUD panel a user last had open per scene, so the wearable hand-off reopens it. */
export const remotePanelPrefs = pgTable(
  'remote_panel_prefs',
  {
    userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    sceneId: uuid('scene_id').notNull().references(() => scenes.id, { onDelete: 'cascade' }),
    panel: text('panel').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.sceneId] }) }),
)
```

- [ ] **Step 5: Run** the whole server suite (global setup pushes the new table) → PASS. Re-run `scripts/check-prod-shape-push.sh` from Task 2: push exits 0 and creates `remote_panel_prefs`.

- [ ] **Step 6: Commit** — `feat(server): remote_panel_prefs table; command-center status requires event ownership`.

---

### Task 4: Room join source + `visitors` / `hudWallets` metadata

**Files:**
- Modify: `apps/server/src/ws/VLMSceneRoom.ts` (`JoinOptions`, `ClientMeta`, `onJoin`, `onLeave`, new `publishPresence()`)
- Modify: `apps/server/test/helpers/game-server.ts` (`joinScene` takes extra options)
- Test: `apps/server/test/room-presence.test.ts` (new)

**Interfaces:**
- Consumes: `Actor` from `client.auth` (`wallet`, `verified`).
- Produces: room metadata `{ sceneId: string, visitors: number, hudWallets: string[] }` (read in Task 5 via `matchMaker.query({ name: 'vlm_scene' })`); join options `source?: 'scene' | 'wearable'`, `hud?: boolean`.

- [ ] **Step 1: Helper** — change `joinScene(url, sceneId, token?)` to `joinScene(url, sceneId, token?, extra: Record<string, unknown> = {})` and spread `extra` into the join options. Existing callers are unchanged.

- [ ] **Step 2: Failing test** — `test/room-presence.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRequire } from 'node:module'
import { resetDb } from './helpers/db.js'
import { createScene, createUser, tokenFor } from './helpers/factories.js'
import { joinScene, startGameServer } from './helpers/game-server.js'

const { matchMaker } = createRequire(import.meta.url)('colyseus') as any
const meta = async (sceneId: string) => {
  const [r] = await matchMaker.query({ name: 'vlm_scene' })
  const rooms = await matchMaker.query({ name: 'vlm_scene' })
  return (rooms.find((x: any) => x.metadata?.sceneId === sceneId) ?? r)?.metadata
}
const settle = () => new Promise((r) => setTimeout(r, 150))

describe('scene room presence metadata', () => {
  let gs: Awaited<ReturnType<typeof startGameServer>>
  beforeEach(async () => {
    await resetDb()
    gs = await startGameServer()
  })
  afterEach(async () => gs.stop())

  it('counts visitors, not wearables, and lists wallets with a scene HUD', async () => {
    const host = await createUser({ wallet: '0x00000000000000000000000000000000000000aa' })
    const { scene } = await createScene(host)
    const visitor = await joinScene(gs.url, scene.id)
    const hud = await joinScene(gs.url, scene.id, tokenFor(host), { source: 'scene', hud: true })
    const wearable = await joinScene(gs.url, scene.id, tokenFor(host), { source: 'wearable', hud: true })
    await settle()
    expect(await meta(scene.id)).toEqual({ sceneId: scene.id, visitors: 2, hudWallets: ['0x00000000000000000000000000000000000000aa'] })

    await hud.room.leave()
    await settle()
    expect((await meta(scene.id)).hudWallets).toEqual([])
    expect((await meta(scene.id)).visitors).toBe(1)
    await visitor.room.leave()
    await wearable.room.leave()
  })

  it('keeps a wallet listed while another of its scene-HUD sessions remains', async () => {
    const host = await createUser({ wallet: '0x00000000000000000000000000000000000000ab' })
    const { scene } = await createScene(host)
    const a = await joinScene(gs.url, scene.id, tokenFor(host), { source: 'scene', hud: true })
    const b = await joinScene(gs.url, scene.id, tokenFor(host), { source: 'scene', hud: true })
    await settle()
    await a.room.leave()
    await settle()
    expect((await meta(scene.id)).hudWallets).toEqual(['0x00000000000000000000000000000000000000ab'])
    await b.room.leave()
  })

  it('ignores hud from unverified or wallet-less clients and old clients that send no source', async () => {
    const host = await createUser({ wallet: '0x00000000000000000000000000000000000000ac' })
    const { scene } = await createScene(host)
    const old = await joinScene(gs.url, scene.id, tokenFor(host))
    const unverified = await joinScene(gs.url, scene.id, tokenFor(host, { verified: false }), { source: 'scene', hud: true })
    await settle()
    expect(await meta(scene.id)).toEqual({ sceneId: scene.id, visitors: 2, hudWallets: [] })
    await old.room.leave()
    await unverified.room.leave()
  })
})
```

(Remove the unused `[r]` line in `meta` if lint complains; it's a fallback for single-room runs.)

- [ ] **Step 3: Run** → FAIL (metadata undefined).

- [ ] **Step 4: Implement** in `VLMSceneRoom.ts`:

```ts
interface JoinOptions {
  sessionToken: string
  sceneId: string
  clientType?: 'host' | 'analytics'
  /** Where the client runs; old clients send nothing (= 'scene'). */
  source?: 'scene' | 'wearable'
  /** The client shows the management HUD for this wallet (scene clients only). */
  hud?: boolean
  user?: { id: string; displayName?: string; connectedWallet?: string }
  [key: string]: unknown
}

interface ClientMeta {
  userId: string
  displayName: string
  clientType: 'host' | 'analytics'
  sceneId: string
  source: 'scene' | 'wearable'
  /** Verified wallet of a scene client showing the HUD, else null. */
  hudWallet: string | null
}
```

In `onJoin`, when building the meta:

```ts
    const source = options.source === 'wearable' ? 'wearable' : 'scene'
    const hudWallet = source === 'scene' && options.hud === true && actor.verified && actor.wallet ? actor.wallet.toLowerCase() : null
    this.clientMeta.set(client.sessionId, { userId, displayName, clientType, sceneId: this.sceneId, source, hudWallet })
    this.publishPresence()
```

In `onLeave`, after `this.clientMeta.delete(client.sessionId)`: `this.publishPresence()`.

```ts
  /** Room metadata the remote overview reads through matchMaker.query (spec §4). */
  private publishPresence() {
    let visitors = 0
    const hud = new Set<string>()
    for (const m of this.clientMeta.values()) {
      if (m.source !== 'wearable') visitors++
      if (m.hudWallet) hud.add(m.hudWallet)
    }
    void Promise.resolve(this.setMetadata({ sceneId: this.sceneId, visitors, hudWallets: [...hud].sort() })).catch(() => {})
  }
```

Also call `this.publishPresence()` at the end of `onCreate` so a room with no clients yet reports `visitors: 0`.

- [ ] **Step 5: Run** the new test and `scene-room.test.ts`, `live-updates.test.ts` → PASS.

- [ ] **Step 6: Commit** — `feat(server): scene rooms publish visitors and scene-HUD wallets as metadata`.

---

### Task 5: `GET /api/remote/overview` and `PUT /api/remote/last-panel`

**Files:**
- Create: `apps/server/src/routes/remote.ts`
- Create: `apps/server/src/services/scene-list.ts` (extracted from `GET /api/scenes`)
- Modify: `apps/server/src/routes/scenes.ts:105-160` (use the extracted helper)
- Modify: `apps/server/src/app.ts` (register `remoteRoutes` next to `sceneRoleRoutes`)
- Test: `apps/server/test/remote-overview.test.ts`

**Interfaces:**
- Consumes: `remotePanelPrefs` (Task 3); room metadata (Task 4); `actorFromClaims`, `authenticate`, `verifiedWalletsOf`.
- Produces:
  - `listScenesForActor(actor: Actor): Promise<Array<{ scene: typeof scenes.$inferSelect; role: 'owner' | 'cohost' | 'editor' | 'viewer' }>>` in `services/scene-list.ts`.
  - `GET /api/remote/overview` → `{ scenes: RemoteSceneRow[] }` where
    ```ts
    type RemoteSceneRow = {
      sceneId: string; name: string
      role: 'host' | 'cohost' | 'editor' | 'viewer'
      parcels: string[]; baseParcel: string | null; world: string | null
      visitorsNow: number; todayVisitors: number; todayPeak: number
      streamLive: boolean
      activePreset: { id: string; name: string } | null
      hudActive: boolean
      lastPanel: string | null
    }
    ```
    (`owner` from `listScenesForActor` maps to `host`.) Add the same type to `packages/vlm-shared/src/types` as `RemoteSceneRow` and export it.
  - `PUT /api/remote/last-panel` body `{ sceneId: string, panel: string }` → `204`; `403` without any role on the scene; `400` on a bad body. `panel` must be one of `Object.values(HUDPanelType)` from `vlm-shared`.

- [ ] **Step 1: Extract `listScenesForActor`.** Move the body of `GET /api/scenes` (owned + collaborators + `sceneRoles` by user id or wallet, ranking `owner > cohost > editor > viewer`) into `services/scene-list.ts`, returning each scene with its best role. `GET /api/scenes` calls it and keeps its exact response shape. Run `scenes-list-roles.test.ts` and `scene-routes.test.ts` → PASS (no behaviour change).

- [ ] **Step 2: Failing tests** — `test/remote-overview.test.ts`. Use `testApp()`, `startGameServer()` (so `matchMaker` has rooms), `createUser`, `createScene`, `createElement`, `createAnalyticsScene`, `insertSession`, `createSetup`. Cases:
  1. Unauthenticated → 401. Guest token (`tokenFor(u, { guest: true, verified: false })`) → `{ scenes: [] }`.
  2. Lists scenes where the wallet is host, cohost (via `scene_roles` by wallet only, no user id), editor, viewer; never a scene with no role or a revoked role. `role` values are `host|cohost|editor|viewer`.
  3. `parcels`/`baseParcel`/`world` come from the active setup's analytics scene; an ended setup or no setup → `parcels: []`, `baseParcel: null`, `world: null`.
  4. `visitorsNow`: join two visitors and one `source: 'wearable'` client → 2. No room → 0.
  5. `hudActive`: true while a `source: 'scene', hud: true` client with this wallet is in the room; false after it leaves.
  6. `todayVisitors`: two sessions today with distinct hashes + one yesterday + one today before the setup's `startedAt` → 2. `todayPeak` from `analytics_rollup_hourly` rows for today (insert two hours with `peakConcurrency` 3 and 5 → 5; yesterday's 9 ignored).
  7. `streamLive`: a video element in the active preset with `properties.liveSrc` equal to a `streaming_servers` row's `hlsPlaylistUrl` with `status: 'live'` → true; `status: 'offline'` → false.
  8. `lastPanel`: `PUT /api/remote/last-panel` then overview returns it; a second PUT overwrites; PUT on a scene with no role → 403; unknown panel → 400.

- [ ] **Step 3: Run** → FAIL (404 route).

- [ ] **Step 4: Implement `routes/remote.ts`.** Shape:

```ts
import type { FastifyInstance } from 'fastify'
import { and, eq, gte, inArray, isNull, sql } from 'drizzle-orm'
import { createRequire } from 'node:module'
import { HUDPanelType } from 'vlm-shared'
import { db } from '../db/connection.js'
import { analyticsRollupHourly, analyticsScenes, locationSetups, remotePanelPrefs, scenePresets, sceneElements, streamingServers } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { listScenesForActor } from '../services/scene-list.js'
import { normalizeUrl } from '../streaming/live-status.js'

const { matchMaker } = createRequire(import.meta.url)('colyseus') as any
const PANELS = new Set<string>(Object.values(HUDPanelType))
const utcMidnight = () => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); return d }

export default async function remoteRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/api/remote/overview', async (request, reply) => {
    const actor = actorFromClaims(request.user)
    if (!actor.userId || !actor.verified) return reply.send({ scenes: [] })
    const list = await listScenesForActor(actor)
    if (!list.length) return reply.send({ scenes: [] })
    const ids = list.map((x) => x.scene.id)
    // …batch queries keyed by scene id: active setups ⨝ analytics scenes; presets for activePresetId;
    // video elements of active presets; live stream URLs; panel prefs for actor.userId;
    // today's sessions (count distinct visitor_hash, started_at >= greatest(midnight, setup.started_at));
    // today's rollup max(peak_concurrency).
    const rooms: any[] = await matchMaker.query({ name: 'vlm_scene' }).catch(() => [])
    const roomBy = new Map(rooms.filter((r) => r.metadata?.sceneId).map((r) => [r.metadata.sceneId, r.metadata]))
    const wallet = actor.wallet?.toLowerCase() ?? null
    // build RemoteSceneRow[] in list order
  })

  app.put<{ Body: { sceneId?: string; panel?: string } }>('/api/remote/last-panel', async (request, reply) => {
    const { sceneId, panel } = request.body ?? {}
    if (typeof sceneId !== 'string' || typeof panel !== 'string' || !PANELS.has(panel)) return reply.status(400).send({ error: 'sceneId and a HUD panel are required' })
    const actor = actorFromClaims(request.user)
    if (!actor.userId || !actor.verified) return reply.status(403).send({ error: 'Forbidden' })
    const has = (await listScenesForActor(actor)).some((x) => x.scene.id === sceneId)
    if (!has) return reply.status(403).send({ error: 'Forbidden' })
    await db.insert(remotePanelPrefs).values({ userId: actor.userId, sceneId, panel })
      .onConflictDoUpdate({ target: [remotePanelPrefs.userId, remotePanelPrefs.sceneId], set: { panel, updatedAt: new Date() } })
    return reply.status(204).send()
  })
}
```

Fill in the batch queries with Drizzle (no per-scene query loops beyond one `inArray` per table). Use `sql\`count(distinct visitor_hash)::int\`` like `analytics-read.ts`. Keep it under ~150 lines; if it grows, move the stats queries into `services/remote-overview.ts`.

- [ ] **Step 5: Register** in `app.ts`: `import remoteRoutes from './routes/remote.js'` and `await app.register(remoteRoutes)` after `sceneRoleRoutes`.

- [ ] **Step 6: Run** the new test file and the full server suite → PASS.

- [ ] **Step 7: Client method** — `packages/vlm-client/src/http.ts`: `async getRemoteOverview(): Promise<{ scenes: RemoteSceneRow[] }>` (`GET /api/remote/overview`) and `async setLastPanel(sceneId: string, panel: string): Promise<void>` (`PUT /api/remote/last-panel`), following `getSceneRoles`'s `_fetch` style.

- [ ] **Step 8: Commit** — `feat(server): remote overview (scenes, live visitors, today's stats, HUD presence) and last-panel prefs`.

---

### Task 6: `vlm-core` connect options (`source`, `hud`, `renderContent`)

**Files:**
- Modify: `packages/vlm-core/src/VLM.ts` (`connectToScene`, `registerMessageHandlers`)
- Modify: `packages/vlm-adapter-dcl/src/index.ts` (scene HUD passes `{ source: 'scene', hud: true }` when it has a renderer)
- Test: `packages/vlm-core/test/connect-options.test.ts`

**Interfaces:**
- Produces: `connectToScene(sceneId: string, opts?: { source?: 'scene' | 'wearable'; hud?: boolean; renderContent?: boolean }): Promise<VLMStorageType>`; also `onRoomMessage(type: string, cb: (msg: unknown) => void): () => void` so the wearable can watch upsert/delete/preset messages without `SceneManager`.

- [ ] **Step 1: Failing test** — stub `ColyseusManager` like the existing core tests do (see `test/setup-client.test.ts` for the stubbing pattern): assert `joinSceneRoom` receives `source: 'wearable', hud: true` when passed, and `source: 'scene', hud: false` by default; with `renderContent: false`, an incoming `scene_preset_update { action: 'init' }` resolves the connect but `SceneManager.handlePresetUpdate` is not called (spy); `onRoomMessage('scene_preset_update', cb)` receives the message either way.

- [ ] **Step 2: Run** → FAIL.

- [ ] **Step 3: Implement** — store `opts` on the instance for the lifetime of the connection; in `registerMessageHandlers`, guard the three content handlers with `if (this.renderContent)` but always emit `scene_initialized` on `init` and always fan out to `onRoomMessage` listeners. Default `renderContent: true`.

- [ ] **Step 4: Scene HUD** — in `createVLM`'s `connectAs` (adapter `index.ts`), call `vlm.connectToScene(sceneId, { source: 'scene', hud: !!renderer })`; `connectContentOnly` and `reconnect` keep `hud: false` / the same flag respectively. Visitors are unchanged.

- [ ] **Step 5: Run** core tests (`pnpm --filter vlm-core test`) and typecheck (`pnpm turbo typecheck`) → PASS.

- [ ] **Step 6: Commit** — `feat(core): connect options for source, HUD presence and content-free clients`.

---

### Task 7: Shared HUD controller + remote mode

**Files:**
- Create: `packages/vlm-adapter-dcl/src/hud-controller.ts` (moved from `createVLM`'s `installConnectedHandler`)
- Modify: `packages/vlm-adapter-dcl/src/index.ts` (use it)
- Modify: `packages/vlm-adapter-dcl/src/DclHUDRenderer.tsx` (mode, numeric transform editor, scene picker slot, exported root)
- Modify: `packages/vlm-adapter-dcl/package.json` (`exports["./hud"]`)
- Test: `packages/vlm-adapter-dcl/test/hud-controller.test.ts` (new; add vitest to the package like `vlm-core`)

**Interfaces:**
- Produces (from `vlm-adapter-dcl/hud`):
  - `installHudController(opts: { vlm: VLM; renderer: DclHUDRenderer; sceneId: string; role: SceneRole; mode: 'scene' | 'remote'; onRetry: () => Promise<void> }): () => void` (returns an uninstall function).
  - `DclHUDRenderer.init(opts?: { mode?: 'scene' | 'remote'; extra?: () => ReactEcs.JSX.Element | null })` — `extra` renders beside the HUD (the wearable's My Scenes panel); mode `'remote'` hides **Place** and shows per-instance numeric editors in Layout.
  - `DclHUDRenderer.setActive(on: boolean)` — hide the whole management HUD without destroying state (used by the hand-off).
  - Scene actions added in remote mode: `layout_instances` `{ elementId }` (loads instances), `instance_update` `{ instanceId, position?, rotation?, scale? }`, `instance_nudge` `{ instanceId, axis: 'x'|'y'|'z', field: 'position'|'rotation'|'scale', delta: number }`.

- [ ] **Step 1: Move without changing behaviour.** Cut `installConnectedHandler` and its helpers (`refresh`, `refreshMedia`, `activePreset`, `refreshLayout`, `place`, the action switch) into `hud-controller.ts` as `installHudController`. `placementInFrontOfPlayer` stays scene-mode only. `index.ts` calls `installHudController({ …, mode: 'scene', onRetry: () => reconnect(sceneId) })`. Typecheck and build the smart-item test scene (`cd test-scenes/dcl-smart-item-test && npx sdk-commands build`) → no errors. Commit: `refactor(dcl): HUD action wiring in its own module`.

- [ ] **Step 2: Failing tests for remote actions.** In `test/hud-controller.test.ts`, stub `vlm.httpClient` (`getScene`, `updateInstance`) and a renderer double; mock `@dcl/sdk/*` imports (`vi.mock('@dcl/sdk/ecs', …)`) as needed. Cases: `instance_nudge` position x +0.5 on an instance at x=1 calls `updateInstance(id, { position: { x: 1.5, y, z } })`; rotation nudges in degrees; scale nudges never go below 0.01; `instance_update` sends exactly the fields given; viewer role → no HTTP call and an edit message; `media_place` in remote mode → refused with "Place from inside the scene" (no HTTP call); the same nudge produces the same `updateInstance` payload in scene mode as in remote mode (spec §8 "same messages").

- [ ] **Step 3: Run** → FAIL.

- [ ] **Step 4: Implement** the remote actions in the controller (keep the busy lock; refresh the instance list after each write from the response) and the renderer UI: in `SceneLayoutPanel`, remote mode shows, per element, an **Edit** toggle that lists its instances with three rows (Position, Rotation°, Scale), each with `−`/`+` nudge buttons (0.5 m, 15°, 0.1) and an `Input` per axis that submits on blur. Hide `AssetBrowserPanel`'s **Place** button in remote mode and show "Place from inside the scene". `init({ extra })`: `ReactEcsRenderer.setUiRenderer(() => <UiEntity …>{VLMHUD when active}{extra?.()}</UiEntity>)`.

- [ ] **Step 5: Export** — `package.json` `"exports": { …, "./hud": { "types": "./dist/hud.d.ts", "default": "./dist/hud.js" } }` with `src/hud.ts` re-exporting `DclHUDRenderer`, `installHudController`, `setSceneActionHandler`, types. It must not import `DclAdapter` or `analytics.ts` (keeps the wearable bundle small). If Task 1's verdict was "GO with slim bundle", `hud.ts` must also avoid `vlm-core`'s `SceneManager` import chain — check with `npx esbuild src/hud.ts --bundle --external:@dcl/* --metafile=meta.json` and inspect.

- [ ] **Step 6: Run** adapter tests, core tests, typecheck, and rebuild the smart-item test scene → PASS.

- [ ] **Step 7: Commit** — `feat(dcl): remote HUD mode with numeric transform editing; exported HUD entry`.

---

### Task 8: Wearable hand-off logic (pure, tested)

**Files:**
- Create: `apps/vlm-wearable/` (SDK7 smart-wearable project; copy `scene.json`/`wearable.json` shape from the spike; real unique `id`)
- Create: `apps/vlm-wearable/src/handoff.ts`
- Test: `apps/vlm-wearable/test/handoff.test.ts` (vitest; the package's `test` script runs only `test/`)

**Interfaces:**
- Consumes: `RemoteSceneRow` (vlm-shared).
- Produces:
  ```ts
  export type Where = { parcel: string /* "x,y" */; realm: { isWorld: boolean; worldName: string | null } }
  export function standingIn(rows: RemoteSceneRow[], where: Where): RemoteSceneRow | null
  export type HudDecision = { showHud: boolean; sceneId: string | null; reason: 'in-scene-hud' | 'outside' | 'no-hud-here' | 'viewer' | 'none' }
  export function decide(rows: RemoteSceneRow[], where: Where, picked: string | null): HudDecision
  export function parcelOf(globalX: number, globalZ: number): string // floor(x/16), floor(z/16)
  ```

- [ ] **Step 1: Failing tests** — `handoff.test.ts`:
  - `parcelOf(-0.1, 15.9)` → `"-1,0"`; `parcelOf(16, -16)` → `"1,-1"`.
  - `standingIn`: GC parcel in a row's `parcels` → that row; a World realm whose `worldName` equals a row's `world` (case-insensitive) → that row; GC parcel while `realm.isWorld` → null; row with `parcels: []` → never.
  - `decide`: standing in a scene with `hudActive: true` → `{ showHud: false, sceneId: null, reason: 'in-scene-hud' }`; standing in a scene with `hudActive: false` → HUD for that scene (`no-hud-here`); outside with `picked` → HUD for `picked` (`outside`); outside with no pick → `{ showHud: false, sceneId: null, reason: 'none' }`; picked row is a viewer → `showHud: false, reason: 'viewer'`.
  - Hand-off (spec §7): walk-in sequence — rows with `hudActive: false` while standing in → HUD stays for that scene; next poll `hudActive: true` → hides. No intermediate state hides it.

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (≈50 lines). **Step 4: Run** → PASS.

- [ ] **Step 5: Commit** — `feat(wearable): hand-off rules`.

---

### Task 9: Wearable app (My Scenes panel, sessions, room, teleport)

**Files:**
- Create: `apps/vlm-wearable/src/index.ts`, `src/MyScenesPanel.tsx`, `src/session.ts`
- Create: `apps/vlm-wearable/scripts/check-size.mjs`
- Modify: `apps/vlm-wearable/package.json` (`build` = `sdk-commands build --production && node scripts/check-size.mjs`, `pack`)

**Interfaces:**
- Consumes: Tasks 5–8 (`getRemoteOverview`, `setLastPanel`, `connectToScene(…, { source: 'wearable', hud: true, renderContent: false })`, `onRoomMessage`, `installHudController`, `DclHUDRenderer.init({ mode: 'remote', extra })`, `setActive`, `decide`, `parcelOf`).

- [ ] **Step 1: Session** (`session.ts`): `VLMHttpClient(apiUrl)` + a `signedRequest` adapter built on `~system/SignedFetch` (same shape as `DclAdapter.signedRequest`); `authenticateWithPlatform({}, {}, adapter)`; on any 401 from overview, `refreshToken()` then retry once; on failure re-run platform auth. Server unreachable → `state.stale = true`, keep the last rows, retry every 10 s.

- [ ] **Step 2: Panel** (`MyScenesPanel.tsx`): one row per `RemoteSceneRow` — name, `👥 visitorsNow`, `today todayVisitors · peak todayPeak`, `● LIVE` when `streamLive`, preset name; buttons **Open** (disabled while `decide()` says in-scene-hud, or for viewers) and **Go**. Header shows "VLM unreachable — retrying" and "(stale)" when stale; empty state "No VLM scenes yet — set one up from its in-world HUD" plus a vlm.gg link via `openExternalUrl` only if `OPEN_EXTERNAL_LINK` was granted (otherwise plain text). Place it top-left so it never overlaps the scene HUD (top-right).

- [ ] **Step 3: Loop** (`index.ts`): poll overview every 10 s while worn; every 1 s compute `parcelOf` from `Transform.get(engine.PlayerEntity)` (portable experiences get global coordinates) and the realm from `getRealm` (`~system/Runtime`), run `decide()`. When the decided scene changes: leave the old room, `connectToScene(new, { source: 'wearable', hud: true, renderContent: false })`, `installHudController({ mode: 'remote', … })`, open `lastPanel` if set, `renderer.setActive(true)`. When `showHud` is false: `setActive(false)` and leave the room after 30 s of staying hidden (avoid churn at parcel borders). On panel change, `setLastPanel(sceneId, panel)` (debounced 2 s).

- [ ] **Step 4: Go** — Genesis City: `teleportTo({ worldCoordinates: { x, y } })` from `~system/RestrictedActions` with the row's `baseParcel`; World: `changeRealm({ realm: row.world })`. Declined → nothing. Use whatever Task 1's findings say is allowed; if teleport is blocked in wearables, show the coordinates instead.

- [ ] **Step 5: Size check** (`scripts/check-size.mjs`): sum the sizes of every file that `npm run pack` puts in the zip (read the zip with `unzip -l` or walk the pack inputs) and exit 1 if > 3 × 1024 × 1024, printing the total and the five biggest files.

- [ ] **Step 6: Build** — `npm run build` → passes the size check. Preview with the local server: `npx @dcl/sdk-commands start --port 8010` alongside the smart-item test scene (8003) per the multi-scene preview docs.

- [ ] **Step 7: Commit** — `feat(wearable): VLM smart wearable — My Scenes, remote HUD, hand-off, teleport`.

---

### Task 10: Docs + manual in-world run

**Files:**
- Modify: `packages/vlm-smart-item-dcl/README.md` (short "VLM wearable" section)
- Create: `apps/vlm-wearable/README.md` (build, pack, Builder upload, Sepolia test, publish steps for the user)

- [ ] **Step 1: Docs** — wearable README: prerequisites, `npm run build`, `npm run pack`, Builder upload (both body shapes, hide/replace categories), Sepolia "See in world", then the Curation Committee submission (user's step, MANA fee). vlm-dcl README: two sentences — scenes with vlm-dcl ≥ 2.2 hand off to the wearable automatically; older scenes always show the wearable HUD.

- [ ] **Step 2 (USER STEP): In-world run** (spec §8), on Sepolia with the API deployed:
  1. Stand in the test scene: scene HUD shows; wearable shows My Scenes only.
  2. Walk out: wearable HUD opens on the same scene and last panel.
  3. Move the duck by numbers from outside; someone inside sees it move live.
  4. Walk back in: wearable HUD closes after the scene HUD connects (never a gap).
  5. From another parcel, **Go** teleports there.
  6. Visitor count on the panel matches people present (wearer excluded).

- [ ] **Step 3: Commit** — `docs: VLM wearable build, test and publish guide`.

---

## Self-review notes

- Spec §3 table → Task 8 `decide()` + Task 9 loop. §4 session → ruling 1; overview/last-panel → Task 5; room change → Task 4; command-center fix → Task 3. §5 shared HUD → Task 7; wearable → Tasks 8–9; size fallback → Task 1 verdict + Task 7 Step 5. §6 spike → Task 1. §7 errors → Task 9 Steps 1–4, Task 8 hand-off test. §8 testing → Tasks 3–9 tests, Task 10 manual run.
- Names used across tasks: `RemoteSceneRow`, `listScenesForActor`, `remotePanelPrefs`, `publishPresence`, `connectToScene(sceneId, { source, hud, renderContent })`, `onRoomMessage`, `installHudController`, `DclHUDRenderer.init({ mode, extra })`, `setActive`, `decide`, `standingIn`, `parcelOf`.
