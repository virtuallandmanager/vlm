# VLM Venues — Hardening & Access Grants Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close VLM v2's auth holes and add wallet-based, time-boxed, scoped access grants for rentable venues, enforced identically by the REST API and the Colyseus scene room.

**Architecture:** One permission module (`src/auth/permissions.ts`) answers "what may this actor do in this scene right now" from ownership, org role, collaborator role, or an active access grant. REST routes and a new room message guard both call it. Venues, bookings and grants live in three new tables; each booking edits a cloned preset that a lifecycle sweep swaps in at go-live and out at the end. Grant/lifecycle changes reach rooms through Colyseus presence pub/sub, so it works in single and multi-server modes.

**Tech Stack:** Node 20+, pnpm 9, TypeScript, Fastify 5, Colyseus 0.15 (+ colyseus.js 0.15 for tests), Drizzle ORM 0.38 + drizzle-kit 0.30, PostgreSQL 16, fast-jwt 5, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-04-vlm-venues-design.md` (Sub-projects 0 and 1, §4–§5)

## Global Constraints

- Node: run everything with Node ≥ 20 (`engines.node >=20.0.0`). The machine default is Node 16; use `nvm use 20` (v20.20.2 is installed) before any `pnpm` command.
- All wallet addresses are stored and compared **lowercased**.
- Venue scopes, exactly: `screens, playlist, lights.cue, lights.faders, schedule, presets, audio, moderation, crew`.
- Venue roles, exactly: `host, cohost, vj, lighting, performer, door`, with defaults host/cohost = all scopes; vj = screens, playlist, schedule; lighting = lights.cue, lights.faders, schedule; performer = lights.cue; door = moderation.
- Default venue rules: `minHours 1, maxHours 12, setupLeadMinutes 60, graceMinutes 15, bufferMinutes 30`.
- Live window = `startsAt − setupLeadMinutes` to `endsAt + graceMinutes`. Setup window = before the live window.
- Unverified (`verified: false`) and guest tokens never pass a check that needs ownership, admin, collaboration or a grant.
- `config.allowUnverifiedPlatformAuth` defaults to `false` (env `ALLOW_UNVERIFIED_PLATFORM_AUTH=true` to enable for local preview only).
- Permission results cached per room per client for 10 seconds; invalidated by grant/booking events.
- Server-to-client error message type is `vlm_error` with `{ code, messageType }` (the spec says `error`; `vlm_error` avoids colliding with Colyseus's own error channel).

### Deviations from the spec (deliberate, small)

- `access_grants.walletAddress` is **nullable** with a check that wallet or userId is set, so an email-only renter can hold the host grant. Uniqueness is per booking on each of wallet and userId.
- `bookings` has `renterUserId` **or** `renterWallet` (one required), for the same reason.
- `venues.orgId` is nullable because `scenes.orgId` is nullable.
- `scene_elements` gains `cloned_from_id` so rentable-element checks work on booking-preset clones.
- Go-live / end is driven by a 5-second lifecycle **sweep** with idempotent `UPDATE … RETURNING` transitions instead of per-booking timers. Same behavior, safe across restarts and multiple servers, and it is the seed of sub-project 4's job loop.
- `path_segments_add` stays open to visitors: it persists nothing today.
- Room `vlm_scene` gets `filterBy(['sceneId'])`. Today every scene shares the first-created room (existing bug found while planning).

## Review Focus

1. **Checksummed wallet input** — a renter pastes `0xAbC…` (mixed case) when adding crew; the crew member signs in with the lowercase verified wallet and must get access. Test in Task 6.
2. **Expired session token on join** — access tokens expire after 15 minutes; a client joining with a stale token must join as an anonymous visitor (still receives scene data), be told `auth_status { authenticated: false }`, and have mutations rejected — not crash or silently succeed. Test in Task 7.
3. **Revocation takes effect immediately** — after a renter revokes a crew grant, that crew member's very next room mutation is rejected despite the 10-second cache, and they receive `access_revoked`. Test in Task 7.
4. **Lifecycle sweep runs twice / on two servers** — the second run must not re-publish or re-switch presets. Test in Task 8.
5. **Bad booking times** — unparseable dates, `endsAt <= startsAt`, duration outside min/max hours, or `endsAt` in the past return `400` with a message, never a 500. Test in Task 6.

---

## File Structure

**Create (server):**
- `apps/server/src/app.ts` — `buildApp()`: Fastify instance with plugins and routes, no listen.
- `apps/server/src/auth/tokens.ts` — `SessionClaims`, `verifySessionToken()` for non-Fastify callers (rooms).
- `apps/server/src/auth/actor.ts` — `Actor`, `ANONYMOUS`, `actorFromClaims()`.
- `apps/server/src/auth/roles.ts` — `initialRoleForNewUser()`.
- `apps/server/src/auth/permissions.ts` — `getSceneAccess()`, `can()`, `canWriteElement()`, `scopesForElementChange()`, `bookingWindowAt()`, `liveWindowEnd()`, `diffKeys()`.
- `apps/server/src/db/venue-constraints.ts` — `ensureVenueConstraints()` raw SQL (btree_gist, exclusion and check constraints).
- `apps/server/src/realtime/bus.ts` — `initBus()`, `publishVenueEvent()`, `venueTopic()`, `VenueEvent`.
- `apps/server/src/venues/service.ts` — venue/booking/grant operations and `VenueError`.
- `apps/server/src/venues/lifecycle.ts` — `runLifecycleSweep()`, `startLifecycleSweep()`.
- `apps/server/src/routes/venues.ts` — `/api/venues` REST routes.
- `apps/server/src/ws/scene-guard.ts` — `authorizeSceneMessage()`.
- `apps/server/vitest.config.ts`
- `apps/server/test/global-setup.ts`, `apps/server/test/helpers/{db,factories,game-server}.ts`
- `apps/server/test/*.test.ts` (one per task)

**Create (shared):**
- `packages/vlm-shared/src/venues.ts` — scopes, roles, rules, message types.

**Modify:**
- `apps/server/src/index.ts` — use `buildApp()`, explicit presence, `initBus`, `filterBy`, lifecycle sweep.
- `apps/server/src/config.ts` — `allowUnverifiedPlatformAuth`, `lifecycleSweepMs`.
- `apps/server/src/middleware/auth.ts` — JWT payload fields, reject guest tokens.
- `apps/server/src/routes/auth.ts` — platform auth, register role rule, refresh carries `wallet`/`verified`.
- `apps/server/src/routes/scenes.ts` — permission checks.
- `apps/server/src/ws/VLMSceneRoom.ts` — `onAuth`, guard, access messages, bus subscription.
- `apps/server/src/db/schema.ts` — enums, `venues`, `bookings`, `access_grants`, `scene_elements.cloned_from_id`.
- `apps/server/src/db/migrate.ts` — call `ensureVenueConstraints()`.
- `apps/server/package.json` — deps and `test` script.
- `packages/vlm-shared/src/index.ts` — export venues.
- `.env.example` — new env vars.

---

### Task 1: Test harness and `buildApp()`

**Files:**
- Create: `apps/server/src/app.ts`, `apps/server/vitest.config.ts`, `apps/server/test/global-setup.ts`, `apps/server/test/helpers/db.ts`, `apps/server/test/helpers/factories.ts`, `apps/server/test/health.test.ts`
- Modify: `apps/server/src/index.ts` (lines 39–226: Fastify setup moves to `app.ts`), `apps/server/package.json`

**Interfaces:**
- Produces: `buildApp(opts?: { rateLimit?: boolean; logger?: boolean }): Promise<FastifyInstance>`; test helpers `resetDb()`, `createUser()`, `tokenFor()`, `createScene()`, `createElement()`, `createInstance()`, `testApp()`.

- [ ] **Step 1: Start Postgres and install test deps**

```bash
nvm use 20
cd ~/-VLM/vlm-v2
docker compose -f docker-compose.dev.yml up -d postgres
cd apps/server
pnpm add -D vitest@^3 colyseus.js@^0.15.26
pnpm add fast-jwt@^5
```

Add to `apps/server/package.json` `scripts`: `"test": "vitest run"`, `"test:watch": "vitest"`.

- [ ] **Step 2: Create `apps/server/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgres://vlm:vlm_dev@localhost:5432/vlm_test'

export default defineConfig({
  resolve: {
    alias: {
      'vlm-shared': resolve(here, '../../packages/vlm-shared/src/index.ts'),
    },
  },
  test: {
    globalSetup: ['./test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 60_000,
    env: {
      DATABASE_URL: TEST_DATABASE_URL,
      JWT_SECRET: 'test-secret',
      VLM_MODE: 'single',
      LOG_LEVEL: 'silent',
      LIFECYCLE_SWEEP_MS: '0',
    },
  },
})
```

- [ ] **Step 3: Create `apps/server/test/global-setup.ts`**

Recreates the test database and pushes the Drizzle schema. Later tasks append `ensureVenueConstraints()` here (Task 3).

```ts
import postgres from 'postgres'
import { execSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEST_DATABASE_URL } from '../vitest.config'

const here = dirname(fileURLToPath(import.meta.url))

export default async function setup() {
  const url = new URL(TEST_DATABASE_URL)
  const dbName = url.pathname.slice(1)
  const adminUrl = new URL(TEST_DATABASE_URL)
  adminUrl.pathname = '/postgres'

  const admin = postgres(adminUrl.toString(), { max: 1, onnotice: () => {} })
  await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
  await admin.unsafe(`CREATE DATABASE ${dbName}`)
  await admin.end()

  execSync('pnpm exec drizzle-kit push --force', {
    cwd: resolve(here, '..'),
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
    stdio: 'pipe',
  })
}
```

- [ ] **Step 4: Create `apps/server/test/helpers/db.ts`**

```ts
import { sql } from 'drizzle-orm'
import { db } from '../../src/db/connection.js'

export async function resetDb() {
  const rows = await db.execute<{ tablename: string }>(
    sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  )
  const names = (rows as unknown as { tablename: string }[]).map((r) => `"${r.tablename}"`)
  if (names.length) await db.execute(sql.raw(`TRUNCATE ${names.join(', ')} RESTART IDENTITY CASCADE`))
}
```

- [ ] **Step 5: Create `apps/server/test/helpers/factories.ts`**

```ts
import { createSigner } from 'fast-jwt'
import { eq } from 'drizzle-orm'
import { db } from '../../src/db/connection.js'
import {
  users,
  userAuthMethods,
  scenes,
  scenePresets,
  sceneElements,
  sceneElementInstances,
} from '../../src/db/schema.js'
import { buildApp } from '../../src/app.js'

const sign = createSigner({ key: 'test-secret', expiresIn: 15 * 60 * 1000 })
const signNoExpiry = createSigner({ key: 'test-secret' })

export type TestUser = typeof users.$inferSelect & { wallet: string | null }

let counter = 0
export function randomWallet() {
  counter++
  return ('0x' + counter.toString(16).padStart(8, '0') + crypto.randomUUID().replace(/-/g, '')).slice(0, 42)
}

export async function createUser(
  opts: { role?: 'admin' | 'creator' | 'viewer'; email?: string | null; wallet?: string | null } = {},
): Promise<TestUser> {
  const [user] = await db
    .insert(users)
    .values({
      displayName: 'Test User',
      email: opts.email === undefined ? `u${Date.now()}${Math.random()}@test.dev` : opts.email,
      role: opts.role ?? 'creator',
    })
    .returning()
  const wallet = opts.wallet ? opts.wallet.toLowerCase() : null
  if (wallet) {
    await db.insert(userAuthMethods).values({
      userId: user.id,
      type: 'wallet',
      identifier: wallet,
      metadata: { verified: true },
    })
  }
  return { ...user, wallet }
}

export function tokenFor(user: TestUser, extra: Record<string, unknown> = {}) {
  return sign({
    id: user.id,
    email: user.email,
    role: user.role,
    orgId: null,
    wallet: user.wallet,
    verified: true,
    ...extra,
  })
}

export function expiredTokenFor(user: TestUser) {
  return signNoExpiry({
    id: user.id,
    email: user.email,
    role: user.role,
    wallet: user.wallet,
    verified: true,
    exp: Math.floor(Date.now() / 1000) - 60,
  })
}

export async function createScene(owner: TestUser, name = 'Venue Scene') {
  const [scene] = await db.insert(scenes).values({ ownerId: owner.id, name }).returning()
  const [preset] = await db.insert(scenePresets).values({ sceneId: scene.id, name: 'Default' }).returning()
  await db.update(scenes).set({ activePresetId: preset.id }).where(eq(scenes.id, scene.id))
  return { scene: { ...scene, activePresetId: preset.id }, preset }
}

export async function createElement(
  presetId: string,
  opts: { type?: 'image' | 'video' | 'sound' | 'widget' | 'model'; name?: string; properties?: Record<string, unknown> } = {},
) {
  const [element] = await db
    .insert(sceneElements)
    .values({
      presetId,
      type: opts.type ?? 'video',
      name: opts.name ?? 'Main Screen',
      properties: opts.properties ?? { liveSrc: 'https://old.example/live.m3u8', playlist: [] },
    })
    .returning()
  return element
}

export async function createInstance(elementId: string) {
  const [instance] = await db
    .insert(sceneElementInstances)
    .values({ elementId, position: { x: 1, y: 1, z: 1 } })
    .returning()
  return instance
}

export async function testApp() {
  const app = await buildApp({ rateLimit: false, logger: false })
  await app.ready()
  return app
}
```

- [ ] **Step 6: Write the failing test `apps/server/test/health.test.ts`**

```ts
import { describe, it, expect, afterAll } from 'vitest'
import { testApp } from './helpers/factories.js'

describe('buildApp', () => {
  it('serves the health check without listening on a port', async () => {
    const app = await testApp()
    const res = await app.inject({ method: 'GET', url: '/api/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json().checks.postgres).toBe('ok')
    await app.close()
  })
})
```

- [ ] **Step 7: Run it to verify it fails**

Run: `cd apps/server && pnpm test test/health.test.ts`
Expected: FAIL — `Cannot find module '../../src/app.js'`.

- [ ] **Step 8: Create `apps/server/src/app.ts` and slim `index.ts`**

Move, unchanged, everything in `index.ts` from `const app = Fastify({` (line 51) through the end of the static-dashboard `if/else` (line 222) into `buildApp`. Add the two options. Keep the imports that code needs in `app.ts` and remove them from `index.ts`.

```ts
import Fastify, { type FastifyInstance } from 'fastify'
// …(move the route/plugin imports from index.ts here)…

export interface BuildAppOptions {
  rateLimit?: boolean
  logger?: boolean
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel },
    genReqId: () => randomUUID(),
    bodyLimit: config.maxUploadSize,
  })

  // …CORS registration (unchanged)…

  if (opts.rateLimit !== false) {
    await app.register(import('@fastify/rate-limit'), {
      max: config.rateLimitMax,
      timeWindow: '1 minute',
    })
  }

  // …JWT, Swagger, routes, health, metrics, static dashboard (unchanged)…

  return app
}
```

In `index.ts`, `main()` becomes: run migrations, `const app = await buildApp()`, `await app.listen(...)`, then the unchanged Colyseus block that starts at `const httpServer = app.server`.

- [ ] **Step 9: Run tests and typecheck**

Run: `pnpm test test/health.test.ts && pnpm typecheck`
Expected: PASS; typecheck has no errors.

- [ ] **Step 10: Commit**

```bash
git add apps/server pnpm-lock.yaml
git commit -m "test: add vitest harness and extract buildApp"
```

---

### Task 2: Platform auth hardening (spec §4.2, §4.3)

**Files:**
- Create: `apps/server/src/auth/tokens.ts`, `apps/server/src/auth/actor.ts`, `apps/server/src/auth/roles.ts`, `apps/server/test/auth-platform.test.ts`
- Modify: `apps/server/src/config.ts`, `apps/server/src/middleware/auth.ts:7-27,86-90`, `apps/server/src/routes/auth.ts:55-61,160-200,206-266`

**Interfaces:**
- Produces:
  - `interface SessionClaims { id: string; email: string | null; role: string; orgId?: string | null; wallet?: string | null; verified?: boolean; guest?: boolean; refresh?: boolean }`
  - `verifySessionToken(token: string | undefined | null): SessionClaims | null` (rejects refresh tokens)
  - `interface Actor { userId: string | null; role: string; wallet: string | null; verified: boolean }`, `ANONYMOUS: Actor`, `actorFromClaims(c: SessionClaims | AuthUser | null): Actor`
  - `initialRoleForNewUser(): Promise<'admin' | 'creator'>`
  - `AuthUser` gains `wallet?: string | null; verified?: boolean; guest?: boolean`
  - `config.allowUnverifiedPlatformAuth: boolean`

- [ ] **Step 1: Write the failing tests `apps/server/test/auth-platform.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { users, userAuthMethods } from '../src/db/schema.js'
import { config } from '../src/config.js'
import { verifySessionToken } from '../src/auth/tokens.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor } from './helpers/factories.js'

vi.mock('../src/middleware/dcl-auth.js', () => ({
  hasDclAuthHeaders: (h: Record<string, unknown>) => !!h['x-identity-auth-chain-0'],
  verifyDclSignedFetch: async (_m: string, _p: string, h: Record<string, string>) => {
    const v = h['x-identity-auth-chain-0']
    if (typeof v === 'string' && v.startsWith('valid:')) return { walletAddress: v.slice(6), metadata: {} }
    throw new Error('bad signature')
  },
}))

const WALLET = '0x00000000000000000000000000000000000000aa'
const VICTIM = '0x00000000000000000000000000000000000000bb'

describe('POST /api/auth/platform', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(async () => {
    ;(config as any).allowUnverifiedPlatformAuth = false
    await app.close()
  })

  it('verified signed fetch creates a wallet user and a verified token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/platform',
      headers: { 'x-identity-auth-chain-0': `valid:${WALLET}` },
      payload: { user: { displayName: 'Alice' } },
    })
    expect(res.statusCode).toBe(200)
    const claims = verifySessionToken(res.json().accessToken)!
    expect(claims.wallet).toBe(WALLET)
    expect(claims.verified).toBe(true)
    const method = await db.query.userAuthMethods.findFirst({ where: eq(userAuthMethods.identifier, WALLET) })
    expect(method).toBeTruthy()
  })

  it('a forged body wallet with a bad signature gets a guest token and no account', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/platform',
      headers: { 'x-identity-auth-chain-0': 'forged' },
      payload: { user: { walletAddress: VICTIM, id: VICTIM } },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.guest).toBe(true)
    const claims = verifySessionToken(body.accessToken)!
    expect(claims.guest).toBe(true)
    expect(claims.wallet ?? null).toBeNull()
    expect(await db.query.userAuthMethods.findFirst({ where: eq(userAuthMethods.identifier, VICTIM) })).toBeUndefined()
  })

  it('a body wallet with no signature headers also gets a guest token', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/platform', payload: { user: { walletAddress: VICTIM } } })
    expect(res.json().guest).toBe(true)
  })

  it('guest tokens are rejected by authenticated REST routes', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/platform', payload: {} })
    const scenesRes = await app.inject({
      method: 'GET',
      url: '/api/scenes',
      headers: { authorization: `Bearer ${res.json().accessToken}` },
    })
    expect(scenesRes.statusCode).toBe(401)
  })

  it('preview mode issues an unverified token tied to a preview: identifier', async () => {
    ;(config as any).allowUnverifiedPlatformAuth = true
    const res = await app.inject({ method: 'POST', url: '/api/auth/platform', payload: { user: { id: VICTIM } } })
    const claims = verifySessionToken(res.json().accessToken)!
    expect(claims.verified).toBe(false)
    expect(claims.wallet ?? null).toBeNull()
    expect(await db.query.userAuthMethods.findFirst({ where: eq(userAuthMethods.identifier, `preview:${VICTIM}`) })).toBeTruthy()
    expect(await db.query.userAuthMethods.findFirst({ where: eq(userAuthMethods.identifier, VICTIM) })).toBeUndefined()
  })

  it('only the very first user is auto-promoted to admin', async () => {
    await createUser({ role: 'admin' })
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/platform',
      headers: { 'x-identity-auth-chain-0': `valid:${WALLET}` },
      payload: {},
    })
    expect(res.json().user.role).toBe('creator')
  })

  it('the first-ever platform user becomes admin in single mode', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/platform',
      headers: { 'x-identity-auth-chain-0': `valid:${WALLET}` },
      payload: {},
    })
    expect(res.json().user.role).toBe('admin')
  })

  it('refresh keeps wallet and verified=false', async () => {
    ;(config as any).allowUnverifiedPlatformAuth = true
    const login = await app.inject({ method: 'POST', url: '/api/auth/platform', payload: { user: { id: 'p1' } } })
    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { authorization: `Bearer ${login.json().refreshToken}` },
    })
    expect(refreshed.statusCode).toBe(200)
    expect(verifySessionToken(refreshed.json().accessToken)!.verified).toBe(false)
  })

  it('verifySessionToken rejects refresh tokens and garbage', async () => {
    const u = await createUser()
    expect(verifySessionToken(tokenFor(u, { refresh: true }))).toBeNull()
    expect(verifySessionToken('not-a-jwt')).toBeNull()
    expect(verifySessionToken(undefined)).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test test/auth-platform.test.ts`
Expected: FAIL — `Cannot find module '../src/auth/tokens.js'`.

- [ ] **Step 3: Add the config flag** in `apps/server/src/config.ts` after the `jwtRefreshExpiry` line:

```ts
  // Accept unverified DCL platform logins (local preview only — never in production)
  allowUnverifiedPlatformAuth: env('ALLOW_UNVERIFIED_PLATFORM_AUTH') === 'true',
```

- [ ] **Step 4: Create `apps/server/src/auth/tokens.ts`**

```ts
import { createVerifier } from 'fast-jwt'
import { config } from '../config.js'

export interface SessionClaims {
  id: string
  email: string | null
  role: string
  orgId?: string | null
  wallet?: string | null
  verified?: boolean
  guest?: boolean
  refresh?: boolean
}

const verifier = createVerifier({ key: config.jwtSecret })

/** Verify an access token outside Fastify (e.g. Colyseus onAuth). Refresh tokens are rejected. */
export function verifySessionToken(token: string | undefined | null): SessionClaims | null {
  if (!token) return null
  try {
    const claims = verifier(token) as SessionClaims
    if (claims.refresh) return null
    return claims
  } catch {
    return null
  }
}
```

- [ ] **Step 5: Create `apps/server/src/auth/actor.ts`**

```ts
import type { SessionClaims } from './tokens.js'

export interface Actor {
  userId: string | null
  role: string
  wallet: string | null
  verified: boolean
}

export const ANONYMOUS: Actor = Object.freeze({ userId: null, role: 'viewer', wallet: null, verified: false })

/** Normalize JWT claims (or request.user) into an Actor. Missing `verified` means an email/OAuth/API-key login, which is verified. */
export function actorFromClaims(c: Partial<SessionClaims> | null | undefined): Actor {
  if (!c || c.guest || !c.id) return ANONYMOUS
  return {
    userId: c.id,
    role: c.role ?? 'viewer',
    wallet: c.wallet ? c.wallet.toLowerCase() : null,
    verified: c.verified !== false,
  }
}
```

- [ ] **Step 6: Create `apps/server/src/auth/roles.ts`**

```ts
import { db } from '../db/connection.js'
import { config } from '../config.js'

/** Admin only for the very first user in single/scalable mode; everyone else is a creator. */
export async function initialRoleForNewUser(): Promise<'admin' | 'creator'> {
  if (!config.autoPromoteFirstUser) return 'creator'
  const anyUser = await db.query.users.findFirst({ columns: { id: true } })
  return anyUser ? 'creator' : 'admin'
}
```

- [ ] **Step 7: Update `apps/server/src/middleware/auth.ts`**

Extend the types:

```ts
export interface AuthUser {
  id: string
  email: string | null
  role: string
  orgId: string | null
  wallet?: string | null
  verified?: boolean
  guest?: boolean
}
```

and the `FastifyJWT.payload` type to `{ id: string; email: string | null; role: string; orgId?: string | null; wallet?: string | null; verified?: boolean; guest?: boolean; refresh?: boolean }`.

Replace the JWT branch at the end of `authenticate`:

```ts
    // ── JWT auth (default) ────────────────────────────────────────────────
    const decoded = await request.jwtVerify<AuthUser & { refresh?: boolean }>()
    if (decoded.guest) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Guest tokens cannot access the API' })
    }
    request.user = decoded
```

- [ ] **Step 8: Rewrite the platform route body in `apps/server/src/routes/auth.ts`**

Add imports: `import { initialRoleForNewUser } from '../auth/roles.js'`.

Replace everything from `// Use verified wallet if available, otherwise fall back to body data` through the final `return reply.send({...})` of `/api/auth/platform` with:

```ts
      // ── No verified wallet: guest (or preview identity in local dev) ──────
      if (!verifiedWallet && !config.allowUnverifiedPlatformAuth) {
        const guestId = `guest:${crypto.randomUUID()}`
        const accessToken = app.jwt.sign(
          { id: guestId, email: null, role: 'viewer', orgId: null, wallet: null, verified: false, guest: true },
          { expiresIn: config.jwtAccessExpiry },
        )
        return reply.send({
          user: { id: guestId, displayName, email: null, role: 'viewer' },
          accessToken,
          refreshToken: null,
          verified: false,
          guest: true,
        })
      }

      const identifier =
        verifiedWallet ??
        `preview:${platformUser?.id || platformUser?.walletAddress || crypto.randomUUID()}`

      let authMethod = await db.query.userAuthMethods.findFirst({
        where: and(eq(userAuthMethods.type, 'wallet'), eq(userAuthMethods.identifier, identifier)),
        with: { user: true },
      })

      let dbUser
      if (authMethod) {
        dbUser = authMethod.user
      } else {
        const [newUser] = await db
          .insert(users)
          .values({ displayName, email: null, role: await initialRoleForNewUser() })
          .returning()
        await db.insert(userAuthMethods).values({
          userId: newUser.id,
          type: 'wallet',
          identifier,
          metadata: { world, sceneId, verified: !!verifiedWallet },
        })
        dbUser = newUser
      }

      const claims = {
        id: dbUser.id,
        email: dbUser.email,
        role: dbUser.role,
        orgId: dbUser.activeOrgId || null,
        wallet: verifiedWallet,
        verified: !!verifiedWallet,
      }
      const accessToken = app.jwt.sign(claims, { expiresIn: config.jwtAccessExpiry })
      const refreshToken = app.jwt.sign({ ...claims, refresh: true }, { expiresIn: config.jwtRefreshExpiry })

      return reply.send({
        user: { id: dbUser.id, displayName: dbUser.displayName, email: dbUser.email, role: dbUser.role },
        accessToken,
        refreshToken,
        verified: !!verifiedWallet,
      })
```

Also change the comment above the route to: `// Verifies Decentraland signed fetch headers. Unverified requests get a guest token unless ALLOW_UNVERIFIED_PLATFORM_AUTH=true (local preview).`

- [ ] **Step 9: Use the shared role rule in register** — in `/api/auth/register` replace lines 55–61 (the `let role … if (config.autoPromoteFirstUser) {…}` block) with:

```ts
    const role = await initialRoleForNewUser()
```

- [ ] **Step 10: Refresh preserves `wallet`/`verified`** — in the refresh route, change the `jwt.verify` generic to include `wallet?: string | null; verified?: boolean`, and the sign call to:

```ts
      const accessToken = app.jwt.sign(
        {
          id: user.id,
          email: user.email,
          role: user.role,
          orgId: user.activeOrgId || null,
          wallet: decoded.wallet ?? null,
          ...(decoded.verified === false ? { verified: false } : {}),
        },
        { expiresIn: config.jwtAccessExpiry },
      )
```

- [ ] **Step 11: Run tests and typecheck**

Run: `pnpm test test/auth-platform.test.ts && pnpm typecheck`
Expected: all PASS.

- [ ] **Step 12: Commit**

```bash
git add apps/server
git commit -m "fix(auth): never trust unverified platform wallets; first-user-only admin"
```

---

### Task 3: Venue schema, constraints, and shared types (spec §5.1, §5.2)

**Files:**
- Create: `packages/vlm-shared/src/venues.ts`, `apps/server/src/db/venue-constraints.ts`, `apps/server/test/schema-venues.test.ts`
- Modify: `packages/vlm-shared/src/index.ts`, `apps/server/src/db/schema.ts`, `apps/server/src/db/migrate.ts`, `apps/server/test/global-setup.ts`, `apps/server/package.json` (add `"vlm-shared": "workspace:*"` is already present — verify)

**Interfaces:**
- Produces (vlm-shared): `VENUE_SCOPES`, `VenueScope`, `VENUE_ROLES`, `VenueRole`, `VENUE_ROLE_SCOPES`, `VenueRules`, `DEFAULT_VENUE_RULES`, `BookingWindow`, `VenueAccessMessage`, `AccessRevokedMessage`, `AuthStatusMessage`, `isVenueScope()`, `isVenueRole()`.
- Produces (schema): tables `venues`, `bookings`, `accessGrants`; enums `venueKindEnum`, `bookingStatusEnum`, `venueScopeEnum`, `venueRoleEnum`; `sceneElements.clonedFromId`; `ensureVenueConstraints(): Promise<void>`.

- [ ] **Step 1: Create `packages/vlm-shared/src/venues.ts`**

```ts
export const VENUE_SCOPES = [
  'screens',
  'playlist',
  'lights.cue',
  'lights.faders',
  'schedule',
  'presets',
  'audio',
  'moderation',
  'crew',
] as const
export type VenueScope = (typeof VENUE_SCOPES)[number]

export const VENUE_ROLES = ['host', 'cohost', 'vj', 'lighting', 'performer', 'door'] as const
export type VenueRole = (typeof VENUE_ROLES)[number]

export const VENUE_ROLE_SCOPES: Record<VenueRole, readonly VenueScope[]> = {
  host: VENUE_SCOPES,
  cohost: VENUE_SCOPES,
  vj: ['screens', 'playlist', 'schedule'],
  lighting: ['lights.cue', 'lights.faders', 'schedule'],
  performer: ['lights.cue'],
  door: ['moderation'],
}

export interface VenueRules {
  minHours: number
  maxHours: number
  setupLeadMinutes: number
  graceMinutes: number
  bufferMinutes: number
}

export const DEFAULT_VENUE_RULES: VenueRules = {
  minHours: 1,
  maxHours: 12,
  setupLeadMinutes: 60,
  graceMinutes: 15,
  bufferMinutes: 30,
}

export type BookingWindow = 'setup' | 'live'

/** Server → client on join and whenever the client's venue access changes. */
export interface VenueAccessMessage {
  bookingId: string | null
  role: VenueRole | null
  scopes: VenueScope[]
  window: BookingWindow | null
  validUntil: string | null
}

/** Server → client when the client loses venue access. */
export interface AccessRevokedMessage {
  bookingId: string | null
  reason: 'expired' | 'revoked' | 'canceled'
}

/** Server → client on join. */
export interface AuthStatusMessage {
  authenticated: boolean
}

export function isVenueScope(s: unknown): s is VenueScope {
  return typeof s === 'string' && (VENUE_SCOPES as readonly string[]).includes(s)
}

export function isVenueRole(s: unknown): s is VenueRole {
  return typeof s === 'string' && (VENUE_ROLES as readonly string[]).includes(s)
}
```

Append to `packages/vlm-shared/src/index.ts`: `export * from './venues.js';`

- [ ] **Step 2: Write the failing test `apps/server/test/schema-venues.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { VENUE_SCOPES, VENUE_ROLES, DEFAULT_VENUE_RULES } from 'vlm-shared'
import { db } from '../src/db/connection.js'
import { venues, bookings, accessGrants, venueScopeEnum, venueRoleEnum } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene } from './helpers/factories.js'

const H = 3600_000
const range = (s: Date, e: Date) => `[${s.toISOString()},${e.toISOString()})`

async function seedVenue() {
  const owner = await createUser({ role: 'admin' })
  const { scene, preset } = await createScene(owner)
  const [venue] = await db
    .insert(venues)
    .values({ sceneId: scene.id, name: 'Caldera', slug: `caldera-${Date.now()}`, defaultPresetId: preset.id, rules: DEFAULT_VENUE_RULES })
    .returning()
  return { owner, scene, preset, venue }
}

function bookingValues(venueId: string, renterUserId: string, start: Date, end: Date, status: 'confirmed' | 'canceled' = 'confirmed') {
  const buf = DEFAULT_VENUE_RULES.bufferMinutes * 60_000
  return {
    venueId,
    renterUserId,
    title: 'Show',
    startsAt: start,
    endsAt: end,
    status,
    blockedRange: range(new Date(start.getTime() - buf), new Date(end.getTime() + buf)),
  }
}

describe('venue schema', () => {
  beforeEach(resetDb)

  it('DB enums match vlm-shared constants', () => {
    expect(venueScopeEnum.enumValues).toEqual([...VENUE_SCOPES])
    expect(venueRoleEnum.enumValues).toEqual([...VENUE_ROLES])
  })

  it('rejects overlapping active bookings, including the buffer', async () => {
    const { owner, venue } = await seedVenue()
    const t0 = new Date(Date.now() + 48 * H)
    await db.insert(bookings).values(bookingValues(venue.id, owner.id, t0, new Date(t0.getTime() + 2 * H)))
    // starts 20 minutes after the first ends: inside the 30-minute buffer
    const s2 = new Date(t0.getTime() + 2 * H + 20 * 60_000)
    await expect(
      db.insert(bookings).values(bookingValues(venue.id, owner.id, s2, new Date(s2.getTime() + H))),
    ).rejects.toMatchObject({ code: '23P01' })
  })

  it('allows bookings separated by more than both buffers', async () => {
    const { owner, venue } = await seedVenue()
    const t0 = new Date(Date.now() + 48 * H)
    await db.insert(bookings).values(bookingValues(venue.id, owner.id, t0, new Date(t0.getTime() + 2 * H)))
    const s2 = new Date(t0.getTime() + 3 * H + 1)
    await db.insert(bookings).values(bookingValues(venue.id, owner.id, s2, new Date(s2.getTime() + H)))
  })

  it('canceled bookings do not block a slot', async () => {
    const { owner, venue } = await seedVenue()
    const t0 = new Date(Date.now() + 48 * H)
    await db.insert(bookings).values(bookingValues(venue.id, owner.id, t0, new Date(t0.getTime() + 2 * H), 'canceled'))
    await db.insert(bookings).values(bookingValues(venue.id, owner.id, t0, new Date(t0.getTime() + 2 * H)))
  })

  it('a grant needs a wallet or a user', async () => {
    const { owner, scene, venue } = await seedVenue()
    const t0 = new Date(Date.now() + 48 * H)
    const [b] = await db.insert(bookings).values(bookingValues(venue.id, owner.id, t0, new Date(t0.getTime() + H))).returning()
    await expect(
      db.insert(accessGrants).values({
        bookingId: b.id,
        sceneId: scene.id,
        role: 'vj',
        scopes: ['screens'],
        validFrom: new Date(),
        validUntil: t0,
      }),
    ).rejects.toMatchObject({ code: '23514' })
  })
})
```

Drizzle 0.38 rethrows postgres-js errors unwrapped, so `code` is on the error itself. If the installed Drizzle wraps errors (`DrizzleQueryError`), change the matcher to `{ cause: { code: '23P01' } }` and `{ cause: { code: '23514' } }`.

- [ ] **Step 3: Run to verify failure**

Run: `pnpm test test/schema-venues.test.ts`
Expected: FAIL — `venues` is not exported from schema.

- [ ] **Step 4: Add schema** to `apps/server/src/db/schema.ts`.

Add `customType`, `index`, `uniqueIndex` to the `drizzle-orm/pg-core` import, `sql` to the `drizzle-orm` import, and `import type { VenueRules } from 'vlm-shared'` at the top.

Add the column to `sceneElements` (after `properties`):

```ts
  clonedFromId: uuid('cloned_from_id'), // set when copied into a booking preset
```

Append at the end of the file:

```ts
// ── Venues, Bookings & Access Grants ─────────────────────────────────────────

const tstzrange = customType<{ data: string }>({
  dataType() {
    return 'tstzrange'
  },
})

export const venueKindEnum = pgEnum('venue_kind', ['permanent', 'popup'])
export const bookingStatusEnum = pgEnum('booking_status', ['pending', 'confirmed', 'live', 'ended', 'canceled'])
// Must match VENUE_SCOPES / VENUE_ROLES in vlm-shared (asserted in test/schema-venues.test.ts)
export const venueScopeEnum = pgEnum('venue_scope', [
  'screens',
  'playlist',
  'lights.cue',
  'lights.faders',
  'schedule',
  'presets',
  'audio',
  'moderation',
  'crew',
])
export const venueRoleEnum = pgEnum('venue_role', ['host', 'cohost', 'vj', 'lighting', 'performer', 'door'])

export const venues = pgTable('venues', {
  id: uuid('id').primaryKey().defaultRandom(),
  sceneId: uuid('scene_id')
    .notNull()
    .unique()
    .references(() => scenes.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').references(() => organizations.id, { onDelete: 'set null' }),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description'),
  kind: venueKindEnum('kind').notNull().default('permanent'),
  defaultPresetId: uuid('default_preset_id')
    .notNull()
    .references(() => scenePresets.id),
  timezone: text('timezone').notNull().default('UTC'),
  rules: jsonb('rules').$type<VenueRules>().notNull(),
  rentableElementIds: uuid('rentable_element_ids').array().notNull().default(sql`'{}'::uuid[]`),
  isListed: boolean('is_listed').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
})

export const bookings = pgTable(
  'bookings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    venueId: uuid('venue_id')
      .notNull()
      .references(() => venues.id, { onDelete: 'cascade' }),
    renterUserId: uuid('renter_user_id').references(() => users.id, { onDelete: 'set null' }),
    renterWallet: text('renter_wallet'),
    title: text('title').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    status: bookingStatusEnum('status').notNull().default('pending'),
    bookingPresetId: uuid('booking_preset_id').references(() => scenePresets.id, { onDelete: 'set null' }),
    holdExpiresAt: timestamp('hold_expires_at', { withTimezone: true }),
    paymentRef: jsonb('payment_ref'),
    blockedRange: tstzrange('blocked_range').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    venueIdx: index('bookings_venue_idx').on(t.venueId),
    statusIdx: index('bookings_status_idx').on(t.status),
  }),
)

export const accessGrants = pgTable(
  'access_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    bookingId: uuid('booking_id')
      .notNull()
      .references(() => bookings.id, { onDelete: 'cascade' }),
    sceneId: uuid('scene_id')
      .notNull()
      .references(() => scenes.id, { onDelete: 'cascade' }),
    walletAddress: text('wallet_address'), // lowercased
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    role: venueRoleEnum('role').notNull(),
    scopes: venueScopeEnum('scopes').array().notNull(),
    validFrom: timestamp('valid_from', { withTimezone: true }).notNull(),
    validUntil: timestamp('valid_until', { withTimezone: true }).notNull(),
    grantedByUserId: uuid('granted_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    bookingWallet: uniqueIndex('access_grants_booking_wallet_uq').on(t.bookingId, t.walletAddress),
    bookingUser: uniqueIndex('access_grants_booking_user_uq').on(t.bookingId, t.userId),
    sceneWallet: index('access_grants_scene_wallet_idx').on(t.sceneId, t.walletAddress),
    sceneUser: index('access_grants_scene_user_idx').on(t.sceneId, t.userId),
  }),
)

export const venuesRelations = relations(venues, ({ one, many }) => ({
  scene: one(scenes, { fields: [venues.sceneId], references: [scenes.id] }),
  bookings: many(bookings),
}))

export const bookingsRelations = relations(bookings, ({ one, many }) => ({
  venue: one(venues, { fields: [bookings.venueId], references: [venues.id] }),
  grants: many(accessGrants),
}))

export const accessGrantsRelations = relations(accessGrants, ({ one }) => ({
  booking: one(bookings, { fields: [accessGrants.bookingId], references: [bookings.id] }),
}))
```

- [ ] **Step 5: Create `apps/server/src/db/venue-constraints.ts`**

```ts
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
```

In `apps/server/src/db/migrate.ts`, import it and, right after the `Database connection verified` log line, add:

```ts
  await ensureVenueConstraints((q) => db.execute(sql.raw(q)))
  console.log('[vlm-server] Venue constraints ensured')
```

In `apps/server/test/global-setup.ts`, after `execSync(...)`, add:

```ts
  const { ensureVenueConstraints } = await import('../src/db/venue-constraints.js')
  const client = postgres(TEST_DATABASE_URL, { max: 1, onnotice: () => {} })
  await ensureVenueConstraints((q) => client.unsafe(q))
  await client.end()
```

- [ ] **Step 6: Run tests**

Run: `pnpm test test/schema-venues.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Confirm drizzle-kit push leaves the constraints alone**

Run: `DATABASE_URL=postgres://vlm:vlm_dev@localhost:5432/vlm_test pnpm exec drizzle-kit push`
Expected: `No changes detected`. If it instead proposes dropping `bookings_no_overlap` or the check constraints, answer **No**, and add `strict: true` to `drizzle.config.ts` so production push always prompts. `ensureVenueConstraints()` re-adds them on boot either way.

- [ ] **Step 8: Typecheck both packages and commit**

Run: `cd ~/-VLM/vlm-v2 && pnpm --filter vlm-shared build && pnpm --filter vlm-server typecheck`
Expected: no errors.

```bash
git add packages/vlm-shared apps/server
git commit -m "feat(venues): add venues, bookings, access_grants schema and shared types"
```

---

### Task 4: Permission module (spec §5.3, §5.4)

**Files:**
- Create: `apps/server/src/auth/permissions.ts`, `apps/server/test/permissions.test.ts`
- Modify: `apps/server/src/routes/auth.ts` (call `linkWalletGrants` after platform login)

**Interfaces:**
- Consumes: `Actor` (Task 2); `venues`, `bookings`, `accessGrants`, `VenueRules`, `VENUE_SCOPES` (Task 3).
- Produces:
  - `type SceneScope = VenueScope | 'scene.edit' | 'scene.admin'`
  - `type AccessLevel = 'admin' | 'owner' | 'org' | 'editor' | 'viewer' | 'grant' | 'none'`
  - `interface BookingAccess { bookingId: string; grantId: string; role: VenueRole; bookingPresetId: string | null; window: BookingWindow; validUntil: Date; rentableElementIds: Set<string> }`
  - `interface SceneAccess { level: AccessLevel; scopes: Set<SceneScope>; booking: BookingAccess | null }`
  - `getSceneAccess(actor: Actor, sceneId: string, at?: Date): Promise<SceneAccess>`
  - `can(actor, sceneId, scope, at?): Promise<{ ok: boolean; target: 'live' | 'bookingPreset' | null; bookingId?: string }>`
  - `hasScope(access: SceneAccess, scope: SceneScope): boolean`
  - `isFullAccess(access: SceneAccess): boolean` — admin/owner/org
  - `scopesForElementChange(type: string, propertyKeys: string[], fieldKeys: string[]): VenueScope[] | null`
  - `canWriteElement(access, element: { id: string; presetId: string; clonedFromId: string | null; type: string }, change: { propertyKeys: string[]; fieldKeys: string[] }): boolean`
  - `diffKeys(before: Record<string, unknown> | null | undefined, after: Record<string, unknown>): string[]`
  - `bookingWindowAt(b: { startsAt: Date; endsAt: Date }, rules: VenueRules, at: Date): BookingWindow | null`
  - `liveWindowStart(b, rules): Date`, `liveWindowEnd(b, rules): Date`
  - `toVenueAccessMessage(access: SceneAccess): VenueAccessMessage`
  - `linkWalletGrants(userId: string, wallet: string): Promise<number>`

- [ ] **Step 1: Write the failing test `apps/server/test/permissions.test.ts`**

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { DEFAULT_VENUE_RULES, VENUE_ROLE_SCOPES } from 'vlm-shared'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { venues, bookings, accessGrants, sceneCollaborators, organizations, orgMembers, scenes } from '../src/db/schema.js'
import {
  getSceneAccess,
  can,
  canWriteElement,
  scopesForElementChange,
  diffKeys,
  bookingWindowAt,
  linkWalletGrants,
} from '../src/auth/permissions.js'
import { actorFromClaims } from '../src/auth/actor.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, createElement, randomWallet, type TestUser } from './helpers/factories.js'

const H = 3600_000
const actor = (u: TestUser, extra: Record<string, unknown> = {}) =>
  actorFromClaims({ id: u.id, email: u.email, role: u.role, wallet: u.wallet, verified: true, ...extra })

async function seed(opts: { startsInMs?: number } = {}) {
  const owner = await createUser()
  const { scene, preset } = await createScene(owner)
  const screen = await createElement(preset.id, { type: 'video' })
  const bookingPreset = (await createScene(owner, 'tmp')).preset // any preset id works for access tests
  const [venue] = await db
    .insert(venues)
    .values({
      sceneId: scene.id,
      name: 'Neon Arbor',
      slug: `arbor-${crypto.randomUUID()}`,
      defaultPresetId: preset.id,
      rules: DEFAULT_VENUE_RULES,
      rentableElementIds: [screen.id],
    })
    .returning()
  const startsAt = new Date(Date.now() + (opts.startsInMs ?? 24 * H))
  const endsAt = new Date(startsAt.getTime() + 2 * H)
  const [booking] = await db
    .insert(bookings)
    .values({
      venueId: venue.id,
      renterUserId: owner.id,
      title: 'Show',
      startsAt,
      endsAt,
      status: 'confirmed',
      bookingPresetId: bookingPreset.id,
      blockedRange: `[${startsAt.toISOString()},${endsAt.toISOString()})`,
    })
    .returning()
  return { owner, scene, preset, screen, venue, booking, bookingPresetId: bookingPreset.id }
}

async function grant(
  s: Awaited<ReturnType<typeof seed>>,
  who: { wallet?: string | null; userId?: string | null },
  role: keyof typeof VENUE_ROLE_SCOPES = 'vj',
  window: { from?: Date; until?: Date; revoked?: boolean } = {},
) {
  const [g] = await db
    .insert(accessGrants)
    .values({
      bookingId: s.booking.id,
      sceneId: s.scene.id,
      walletAddress: who.wallet ?? null,
      userId: who.userId ?? null,
      role,
      scopes: [...VENUE_ROLE_SCOPES[role]],
      validFrom: window.from ?? new Date(Date.now() - H),
      validUntil: window.until ?? new Date(s.booking.endsAt.getTime() + 15 * 60_000),
      revokedAt: window.revoked ? new Date() : null,
    })
    .returning()
  return g
}

describe('getSceneAccess', () => {
  beforeEach(resetDb)

  it('global admin and scene owner get full access', async () => {
    const s = await seed()
    const admin = await createUser({ role: 'admin' })
    expect((await getSceneAccess(actor(admin), s.scene.id)).level).toBe('admin')
    const ownerAccess = await getSceneAccess(actor(s.owner), s.scene.id)
    expect(ownerAccess.level).toBe('owner')
    expect(ownerAccess.scopes.has('scene.admin')).toBe(true)
  })

  it('org owner/admin get full access; org member does not', async () => {
    const s = await seed()
    const [org] = await db.insert(organizations).values({ name: 'VLM', slug: `vlm-${crypto.randomUUID()}` }).returning()
    await db.update(scenes).set({ orgId: org.id }).where(eq(scenes.id, s.scene.id))
    const orgAdmin = await createUser()
    const member = await createUser()
    await db.insert(orgMembers).values([
      { orgId: org.id, userId: orgAdmin.id, role: 'admin' },
      { orgId: org.id, userId: member.id, role: 'member' },
    ])
    expect((await getSceneAccess(actor(orgAdmin), s.scene.id)).level).toBe('org')
    expect((await getSceneAccess(actor(member), s.scene.id)).level).toBe('none')
  })

  it('editor gets edit + venue scopes but not crew or scene.admin; viewer gets nothing', async () => {
    const s = await seed()
    const editor = await createUser()
    const viewer = await createUser()
    await db.insert(sceneCollaborators).values([
      { sceneId: s.scene.id, userId: editor.id, role: 'editor' },
      { sceneId: s.scene.id, userId: viewer.id, role: 'viewer' },
    ])
    const e = await getSceneAccess(actor(editor), s.scene.id)
    expect(e.level).toBe('editor')
    expect(e.scopes.has('scene.edit')).toBe(true)
    expect(e.scopes.has('screens')).toBe(true)
    expect(e.scopes.has('crew')).toBe(false)
    expect(e.scopes.has('scene.admin')).toBe(false)
    const v = await getSceneAccess(actor(viewer), s.scene.id)
    expect(v.level).toBe('viewer')
    expect(v.scopes.size).toBe(0)
  })

  it('active wallet grant gives its scopes in the setup window', async () => {
    const s = await seed()
    const wallet = randomWallet()
    const crew = await createUser({ wallet })
    await grant(s, { wallet })
    const a = await getSceneAccess(actor(crew), s.scene.id)
    expect(a.level).toBe('grant')
    expect([...a.scopes].sort()).toEqual(['playlist', 'schedule', 'screens'])
    expect(a.booking?.window).toBe('setup')
    expect(a.booking?.bookingPresetId).toBe(s.bookingPresetId)
    expect(await can(actor(crew), s.scene.id, 'screens')).toMatchObject({ ok: true, target: 'bookingPreset' })
    expect((await can(actor(crew), s.scene.id, 'lights.cue')).ok).toBe(false)
  })

  it('grant is live inside the live window', async () => {
    const s = await seed({ startsInMs: 30 * 60_000 }) // starts in 30 min; setup lead is 60 min
    const wallet = randomWallet()
    const crew = await createUser({ wallet })
    await grant(s, { wallet })
    expect(await can(actor(crew), s.scene.id, 'screens')).toMatchObject({ ok: true, target: 'live' })
  })

  it('expired, revoked and not-yet-valid grants give nothing', async () => {
    const s = await seed()
    const [w1, w2, w3] = [randomWallet(), randomWallet(), randomWallet()]
    const [u1, u2, u3] = await Promise.all([createUser({ wallet: w1 }), createUser({ wallet: w2 }), createUser({ wallet: w3 })])
    await grant(s, { wallet: w1 }, 'vj', { from: new Date(Date.now() - 2 * H), until: new Date(Date.now() - H) })
    await grant(s, { wallet: w2 }, 'vj', { revoked: true })
    await grant(s, { wallet: w3 }, 'vj', { from: new Date(Date.now() + H) })
    for (const u of [u1, u2, u3]) expect((await getSceneAccess(actor(u), s.scene.id)).level).toBe('none')
  })

  it('a grant on a canceled booking gives nothing', async () => {
    const s = await seed()
    const wallet = randomWallet()
    const crew = await createUser({ wallet })
    await grant(s, { wallet })
    await db.update(bookings).set({ status: 'canceled' }).where(eq(bookings.id, s.booking.id))
    expect((await getSceneAccess(actor(crew), s.scene.id)).level).toBe('none')
  })

  it('unverified token whose wallet string matches a grant gets nothing', async () => {
    const s = await seed()
    const wallet = randomWallet()
    const crew = await createUser({ wallet })
    await grant(s, { wallet })
    expect((await getSceneAccess(actor(crew, { verified: false }), s.scene.id)).level).toBe('none')
  })

  it('anonymous gets nothing', async () => {
    const s = await seed()
    expect((await getSceneAccess(actorFromClaims(null), s.scene.id)).level).toBe('none')
  })

  it('linkWalletGrants attaches wallet-only grants to the user', async () => {
    const s = await seed()
    const wallet = randomWallet()
    const g = await grant(s, { wallet })
    const crew = await createUser({ wallet })
    expect(await linkWalletGrants(crew.id, wallet.toUpperCase().replace('0X', '0x'))).toBe(1)
    const [row] = await db.select().from(accessGrants).where(eq(accessGrants.id, g.id))
    expect(row.userId).toBe(crew.id)
    // now matches by userId even without a wallet claim
    expect((await getSceneAccess(actor({ ...crew, wallet: null }), s.scene.id)).level).toBe('grant')
  })
})

describe('element write rules', () => {
  const access = (scopes: string[], presetId = 'bp', rentable = ['src-el']) => ({
    level: 'grant' as const,
    scopes: new Set(scopes as any),
    booking: {
      bookingId: 'b',
      grantId: 'g',
      role: 'vj' as const,
      bookingPresetId: presetId,
      window: 'setup' as const,
      validUntil: new Date(),
      rentableElementIds: new Set(rentable),
    },
  })
  const el = { id: 'clone-el', presetId: 'bp', clonedFromId: 'src-el', type: 'video' }

  it('maps video playlist keys to playlist and others to screens', () => {
    expect(scopesForElementChange('video', ['playlist'], [])).toEqual(['playlist'])
    expect(scopesForElementChange('video', ['liveSrc'], [])).toEqual(['screens'])
    expect(scopesForElementChange('video', ['liveSrc', 'playlistIndex'], []).sort()).toEqual(['playlist', 'screens'])
    expect(scopesForElementChange('image', ['textureSrc'], [])).toEqual(['screens'])
    expect(scopesForElementChange('sound', ['audioSrc'], [])).toEqual(['audio'])
    expect(scopesForElementChange('model', ['modelSrc'], [])).toBeNull()
    expect(scopesForElementChange('video', [], ['name'])).toBeNull()
    expect(scopesForElementChange('video', [], ['enabled'])).toEqual(['screens'])
  })

  it('grant may edit a rentable clone in its booking preset with the right scope', () => {
    expect(canWriteElement(access(['screens']), el, { propertyKeys: ['liveSrc'], fieldKeys: [] })).toBe(true)
    expect(canWriteElement(access(['screens']), el, { propertyKeys: ['playlist'], fieldKeys: [] })).toBe(false)
    expect(canWriteElement(access(['screens']), { ...el, presetId: 'live' }, { propertyKeys: ['liveSrc'], fieldKeys: [] })).toBe(false)
    expect(canWriteElement(access(['screens'], 'bp', ['other']), el, { propertyKeys: ['liveSrc'], fieldKeys: [] })).toBe(false)
  })

  it('owner-level access may edit anything', () => {
    const full = { level: 'owner' as const, scopes: new Set<any>(), booking: null }
    expect(canWriteElement(full, { ...el, type: 'model' }, { propertyKeys: ['modelSrc'], fieldKeys: ['name'] })).toBe(true)
  })

  it('diffKeys reports changed, added and removed keys only', () => {
    expect(diffKeys({ a: 1, b: [1], c: 'x' }, { a: 1, b: [2], d: true }).sort()).toEqual(['b', 'c', 'd'])
    expect(diffKeys(null, { a: 1 })).toEqual(['a'])
  })

  it('bookingWindowAt follows setup lead and grace', () => {
    const b = { startsAt: new Date('2026-11-01T20:00:00Z'), endsAt: new Date('2026-11-01T22:00:00Z') }
    expect(bookingWindowAt(b, DEFAULT_VENUE_RULES, new Date('2026-11-01T18:59:59Z'))).toBe('setup')
    expect(bookingWindowAt(b, DEFAULT_VENUE_RULES, new Date('2026-11-01T19:00:00Z'))).toBe('live')
    expect(bookingWindowAt(b, DEFAULT_VENUE_RULES, new Date('2026-11-01T22:14:59Z'))).toBe('live')
    expect(bookingWindowAt(b, DEFAULT_VENUE_RULES, new Date('2026-11-01T22:15:00Z'))).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test test/permissions.test.ts`
Expected: FAIL — cannot find `../src/auth/permissions.js`.

- [ ] **Step 3: Create `apps/server/src/auth/permissions.ts`**

```ts
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import {
  VENUE_SCOPES,
  type BookingWindow,
  type VenueAccessMessage,
  type VenueRole,
  type VenueRules,
  type VenueScope,
} from 'vlm-shared'
import { db } from '../db/connection.js'
import { accessGrants, bookings, orgMembers, sceneCollaborators, scenes, venues } from '../db/schema.js'
import type { Actor } from './actor.js'

export type SceneScope = VenueScope | 'scene.edit' | 'scene.admin'
export type AccessLevel = 'admin' | 'owner' | 'org' | 'editor' | 'viewer' | 'grant' | 'none'

export interface BookingAccess {
  bookingId: string
  grantId: string
  role: VenueRole
  bookingPresetId: string | null
  window: BookingWindow
  validUntil: Date
  rentableElementIds: Set<string>
}

export interface SceneAccess {
  level: AccessLevel
  scopes: Set<SceneScope>
  booking: BookingAccess | null
}

const ALL_SCOPES: SceneScope[] = [...VENUE_SCOPES, 'scene.edit', 'scene.admin']
const EDITOR_SCOPES: SceneScope[] = [...VENUE_SCOPES.filter((s) => s !== 'crew'), 'scene.edit']
const NONE: SceneAccess = { level: 'none', scopes: new Set(), booking: null }

const full = (level: 'admin' | 'owner' | 'org'): SceneAccess => ({ level, scopes: new Set(ALL_SCOPES), booking: null })

export function isFullAccess(access: SceneAccess) {
  return access.level === 'admin' || access.level === 'owner' || access.level === 'org'
}

export function hasScope(access: SceneAccess, scope: SceneScope) {
  return access.scopes.has(scope)
}

const minutes = (n: number) => n * 60_000

export function liveWindowStart(b: { startsAt: Date }, rules: VenueRules) {
  return new Date(b.startsAt.getTime() - minutes(rules.setupLeadMinutes))
}

export function liveWindowEnd(b: { endsAt: Date }, rules: VenueRules) {
  return new Date(b.endsAt.getTime() + minutes(rules.graceMinutes))
}

export function bookingWindowAt(b: { startsAt: Date; endsAt: Date }, rules: VenueRules, at: Date): BookingWindow | null {
  if (at < liveWindowStart(b, rules)) return 'setup'
  if (at < liveWindowEnd(b, rules)) return 'live'
  return null
}

export async function getSceneAccess(actor: Actor, sceneId: string, at = new Date()): Promise<SceneAccess> {
  if (!actor.userId || !actor.verified) return NONE
  if (actor.role === 'admin') return full('admin')

  const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) })
  if (!scene) return NONE
  if (scene.ownerId === actor.userId) return full('owner')

  if (scene.orgId) {
    const member = await db.query.orgMembers.findFirst({
      where: and(eq(orgMembers.orgId, scene.orgId), eq(orgMembers.userId, actor.userId)),
    })
    if (member && (member.role === 'owner' || member.role === 'admin')) return full('org')
  }

  const collab = await db.query.sceneCollaborators.findFirst({
    where: and(eq(sceneCollaborators.sceneId, sceneId), eq(sceneCollaborators.userId, actor.userId)),
  })
  if (collab?.role === 'editor') return { level: 'editor', scopes: new Set(EDITOR_SCOPES), booking: null }

  const subject = actor.wallet
    ? or(eq(accessGrants.userId, actor.userId), eq(accessGrants.walletAddress, actor.wallet))
    : eq(accessGrants.userId, actor.userId)

  // Prefer a booking that is live, then the soonest one.
  const [row] = await db
    .select({ grant: accessGrants, booking: bookings, venue: venues })
    .from(accessGrants)
    .innerJoin(bookings, eq(accessGrants.bookingId, bookings.id))
    .innerJoin(venues, eq(bookings.venueId, venues.id))
    .where(
      and(
        eq(accessGrants.sceneId, sceneId),
        isNull(accessGrants.revokedAt),
        lte(accessGrants.validFrom, at),
        gt(accessGrants.validUntil, at),
        inArray(bookings.status, ['confirmed', 'live']),
        subject,
      ),
    )
    .orderBy(desc(sql`(${bookings.status} = 'live')`), asc(bookings.startsAt))
    .limit(1)

  if (row) {
    const window = bookingWindowAt(row.booking, row.venue.rules, at)
    if (window) {
      return {
        level: 'grant',
        scopes: new Set(row.grant.scopes),
        booking: {
          bookingId: row.booking.id,
          grantId: row.grant.id,
          role: row.grant.role,
          bookingPresetId: row.booking.bookingPresetId,
          window,
          validUntil: row.grant.validUntil,
          rentableElementIds: new Set(row.venue.rentableElementIds),
        },
      }
    }
  }

  if (collab) return { level: 'viewer', scopes: new Set(), booking: null }
  return NONE
}

export async function can(actor: Actor, sceneId: string, scope: SceneScope, at = new Date()) {
  const access = await getSceneAccess(actor, sceneId, at)
  if (!access.scopes.has(scope)) return { ok: false, target: null } as const
  if (access.level !== 'grant') return { ok: true, target: 'live' } as const
  return {
    ok: true,
    target: access.booking!.window === 'live' ? 'live' : 'bookingPreset',
    bookingId: access.booking!.bookingId,
  } as const
}

const PLAYLIST_KEYS = new Set(['playlist', 'playlistIndex'])
const GRANT_FIELD_KEYS = new Set(['enabled'])

/** Scopes a grant holder needs for this change, or null if grant holders may never make it. */
export function scopesForElementChange(type: string, propertyKeys: string[], fieldKeys: string[]): VenueScope[] | null {
  if (fieldKeys.some((k) => !GRANT_FIELD_KEYS.has(k))) return null
  const base: VenueScope | null =
    type === 'video' || type === 'image' || type === 'nft' ? 'screens' : type === 'sound' ? 'audio' : null
  if (!base) return null
  const needed = new Set<VenueScope>()
  for (const k of propertyKeys) needed.add(type === 'video' && PLAYLIST_KEYS.has(k) ? 'playlist' : base)
  if (fieldKeys.length || needed.size === 0) needed.add(base)
  return [...needed]
}

export function canWriteElement(
  access: SceneAccess,
  element: { id: string; presetId: string; clonedFromId: string | null; type: string },
  change: { propertyKeys: string[]; fieldKeys: string[] },
): boolean {
  if (isFullAccess(access) || access.level === 'editor') return true
  if (access.level !== 'grant' || !access.booking) return false
  if (element.presetId !== access.booking.bookingPresetId) return false
  const rentable = access.booking.rentableElementIds
  if (!rentable.has(element.id) && !(element.clonedFromId && rentable.has(element.clonedFromId))) return false
  const needed = scopesForElementChange(element.type, change.propertyKeys, change.fieldKeys)
  return !!needed && needed.every((s) => access.scopes.has(s))
}

export function diffKeys(before: Record<string, unknown> | null | undefined, after: Record<string, unknown>): string[] {
  const prev = before ?? {}
  const keys = new Set([...Object.keys(prev), ...Object.keys(after)])
  return [...keys].filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(after[k]))
}

export function toVenueAccessMessage(access: SceneAccess): VenueAccessMessage {
  if (access.level !== 'grant' || !access.booking) {
    return { bookingId: null, role: null, scopes: [], window: null, validUntil: null }
  }
  return {
    bookingId: access.booking.bookingId,
    role: access.booking.role,
    scopes: [...access.scopes].filter((s): s is VenueScope => !s.startsWith('scene.')),
    window: access.booking.window,
    validUntil: access.booking.validUntil.toISOString(),
  }
}

/** Attach wallet-only grants to the user who just proved that wallet. */
export async function linkWalletGrants(userId: string, wallet: string): Promise<number> {
  const rows = await db
    .update(accessGrants)
    .set({ userId })
    .where(and(eq(accessGrants.walletAddress, wallet.toLowerCase()), isNull(accessGrants.userId)))
    .returning({ id: accessGrants.id })
  return rows.length
}
```

- [ ] **Step 4: Link grants on verified platform login** — in `routes/auth.ts`, import `linkWalletGrants` from `../auth/permissions.js` and, right after `dbUser` is set in the platform route, add:

```ts
      if (verifiedWallet) await linkWalletGrants(dbUser.id, verifiedWallet)
```

- [ ] **Step 5: Run tests**

Run: `pnpm test test/permissions.test.ts test/auth-platform.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server
git commit -m "feat(auth): shared scene permission module with venue access grants"
```

---

### Task 5: Scene REST routes use permissions (spec §4.4)

**Files:**
- Modify: `apps/server/src/routes/scenes.ts` (routes at lines 64, 134, 169, 193, 208, 231, 271, 302, 352, 394, 415, 463, 528, 573)
- Test: `apps/server/test/scene-routes.test.ts`

**Interfaces:**
- Consumes: `getSceneAccess`, `hasScope`, `canWriteElement`, `diffKeys`, `actorFromClaims`.
- Produces: `GET /api/scenes` items gain `relationship: 'owner' | 'editor' | 'viewer'`.

- [ ] **Step 1: Write the failing test `apps/server/test/scene-routes.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { sceneCollaborators } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, createElement, createInstance, tokenFor } from './helpers/factories.js'

describe('scene routes enforce collaborator roles', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(() => app.close())

  async function setup() {
    const owner = await createUser()
    const editor = await createUser()
    const viewer = await createUser()
    const stranger = await createUser()
    const { scene, preset } = await createScene(owner)
    const element = await createElement(preset.id)
    const instance = await createInstance(element.id)
    await db.insert(sceneCollaborators).values([
      { sceneId: scene.id, userId: editor.id, role: 'editor' },
      { sceneId: scene.id, userId: viewer.id, role: 'viewer' },
    ])
    return { owner, editor, viewer, stranger, scene, preset, element, instance }
  }

  const as = (u: any) => ({ authorization: `Bearer ${tokenFor(u)}` })

  it('editor can update an element and instance; viewer and stranger cannot', async () => {
    const s = await setup()
    const put = (u: any) =>
      app.inject({ method: 'PUT', url: `/api/elements/${s.element.id}`, headers: as(u), payload: { properties: { liveSrc: 'x' } } })
    expect((await put(s.editor)).statusCode).toBe(200)
    expect((await put(s.viewer)).statusCode).toBe(403)
    expect((await put(s.stranger)).statusCode).toBe(403)
    const putInst = await app.inject({
      method: 'PUT',
      url: `/api/instances/${s.instance.id}`,
      headers: as(s.editor),
      payload: { position: { x: 2, y: 2, z: 2 } },
    })
    expect(putInst.statusCode).toBe(200)
  })

  it('editor can create presets and elements', async () => {
    const s = await setup()
    const res = await app.inject({
      method: 'POST',
      url: `/api/presets/${s.preset.id}/elements`,
      headers: as(s.editor),
      payload: { type: 'image', name: 'Poster' },
    })
    expect(res.statusCode).toBe(201)
  })

  it('editor cannot delete the scene or manage collaborators', async () => {
    const s = await setup()
    expect((await app.inject({ method: 'DELETE', url: `/api/scenes/${s.scene.id}`, headers: as(s.editor) })).statusCode).toBe(403)
    const add = await app.inject({
      method: 'POST',
      url: `/api/scenes/${s.scene.id}/collaborators`,
      headers: as(s.editor),
      payload: { email: s.stranger.email, role: 'viewer' },
    })
    expect(add.statusCode).toBe(403)
  })

  it('viewer can read the scene; stranger cannot', async () => {
    const s = await setup()
    expect((await app.inject({ method: 'GET', url: `/api/scenes/${s.scene.id}`, headers: as(s.viewer) })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: `/api/scenes/${s.scene.id}`, headers: as(s.stranger) })).statusCode).toBe(403)
  })

  it('GET /api/scenes lists owned and collaborated scenes with relationship', async () => {
    const s = await setup()
    const res = await app.inject({ method: 'GET', url: '/api/scenes', headers: as(s.editor) })
    expect(res.json().scenes).toEqual([expect.objectContaining({ id: s.scene.id, relationship: 'editor' })])
    const own = await app.inject({ method: 'GET', url: '/api/scenes', headers: as(s.owner) })
    expect(own.json().scenes[0].relationship).toBe('owner')
  })

  it('owner keeps full access', async () => {
    const s = await setup()
    expect((await app.inject({ method: 'DELETE', url: `/api/scenes/${s.scene.id}`, headers: as(s.owner) })).statusCode).toBe(204)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test test/scene-routes.test.ts`
Expected: FAIL — editor gets 403 on element update; `relationship` missing.

- [ ] **Step 3: Add a helper at the top of `sceneRoutes`** (after the `addHook`):

```ts
  const accessFor = (request: { user: AuthUser }, sceneId: string) =>
    getSceneAccess(actorFromClaims(request.user), sceneId)
```

Imports to add: `import type { AuthUser } from '../middleware/auth.js'`, `import { actorFromClaims } from '../auth/actor.js'`, `import { getSceneAccess, hasScope, canWriteElement, diffKeys } from '../auth/permissions.js'`, and `inArray` from `drizzle-orm`.

- [ ] **Step 4: Replace each inline owner/admin check**

| Route (line) | Replace the `if (…ownerId !== request.user.id && request.user.role !== 'admin')` with |
|---|---|
| `GET /api/scenes/:sceneId` (158–162: `isOwner`/`isCollaborator` block) | `const access = await accessFor(request, sceneId); if (access.level === 'none') return reply.status(403).send({ error: 'Forbidden' })` |
| `PUT /api/scenes/:sceneId` (177) | `if (!hasScope(await accessFor(request, sceneId), 'scene.edit'))` |
| `DELETE /api/scenes/:sceneId` (198) | `if (!hasScope(await accessFor(request, sceneId), 'scene.admin'))` |
| `POST /api/scenes/:sceneId/presets` (216) | `if (!hasScope(await accessFor(request, sceneId), 'scene.edit'))` |
| `POST /api/presets/:presetId/elements` (247) | `if (!hasScope(await accessFor(request, preset.sceneId), 'scene.edit'))` |
| `POST /api/elements/:elementId/instances` (312) | `if (!hasScope(await accessFor(request, element.preset.sceneId), 'scene.edit'))` |
| `PUT /api/instances/:instanceId` (362) | `if (!hasScope(await accessFor(request, instance.element.preset.sceneId), 'scene.edit'))` |
| `DELETE /api/instances/:instanceId` (404) | same as PUT instance |
| `GET …/collaborators` (423–434: `isOwner` + collab lookup) | `if ((await accessFor(request, sceneId)).level === 'none') return reply.status(403).send({ error: 'Forbidden' })` |
| `POST …/collaborators` (480) | `if (!hasScope(await accessFor(request, sceneId), 'scene.admin'))` |
| `PUT …/collaborators/:userId` (542) | `if (!hasScope(await accessFor(request, sceneId), 'scene.admin'))` |
| `DELETE …/collaborators/:userId` (581–585) | keep the self-removal rule: `const isSelf = userId === request.user.id; if (!isSelf && !hasScope(await accessFor(request, sceneId), 'scene.admin'))` |

Each keeps its existing `return reply.status(403).send({ … })` body.

`PUT /api/elements/:elementId` (281) gets element-level rules, so grant holders can use it too. Replace the check with:

```ts
      const access = await accessFor(request, element.preset.sceneId)
      const propertyKeys =
        request.body.properties !== undefined
          ? diffKeys(element.properties as Record<string, unknown> | null, request.body.properties as Record<string, unknown>)
          : []
      const fieldKeys = (['type', 'name', 'enabled', 'customId', 'customRendering', 'clickEvent'] as const).filter(
        (k) => request.body[k] !== undefined && JSON.stringify(request.body[k]) !== JSON.stringify((element as any)[k]),
      )
      if (!canWriteElement(access, element, { propertyKeys, fieldKeys })) {
        return reply.status(403).send({ error: 'Forbidden' })
      }
```

- [ ] **Step 5: `GET /api/scenes` includes collaborations** — replace the handler body with:

```ts
    const owned = await db.query.scenes.findMany({
      where: eq(scenes.ownerId, request.user.id),
      orderBy: (scenes, { desc }) => [desc(scenes.updatedAt)],
    })
    const collabs = await db.query.sceneCollaborators.findMany({
      where: eq(sceneCollaborators.userId, request.user.id),
    })
    const shared = collabs.length
      ? await db.query.scenes.findMany({
          where: inArray(scenes.id, collabs.map((c) => c.sceneId)),
          orderBy: (scenes, { desc }) => [desc(scenes.updatedAt)],
        })
      : []
    const roleBy = new Map(collabs.map((c) => [c.sceneId, c.role]))
    return reply.send({
      scenes: [
        ...owned.map((s) => ({ ...s, relationship: 'owner' as const })),
        ...shared.map((s) => ({ ...s, relationship: roleBy.get(s.id)! })),
      ],
    })
```

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server
git commit -m "fix(scenes): enforce collaborator roles via shared permission check"
```

---

### Task 6: Venue service and `/api/venues` routes (spec §5.3, §5.5, §5.6)

**Files:**
- Create: `apps/server/src/realtime/bus.ts`, `apps/server/src/venues/service.ts`, `apps/server/src/routes/venues.ts`, `apps/server/test/venues.test.ts`
- Modify: `apps/server/src/app.ts` (register `venueRoutes`)

**Interfaces:**
- Consumes: Task 3 schema, Task 4 permissions.
- Produces:
  - `bus.ts`: `type VenueEvent = { type: 'grants_changed'; sceneId: string } | { type: 'preset_changed'; sceneId: string; presetId: string } | { type: 'booking_ended'; sceneId: string; bookingId: string; reason: 'expired' | 'canceled' }`; `venueTopic(sceneId): string`; `initBus(p: BusPresence): void`; `publishVenueEvent(e: VenueEvent): Promise<void>`; `interface BusPresence { publish(topic: string, data: unknown): unknown }`
  - `service.ts`: `class VenueError extends Error { status: number }`; `normalizeWallet(w: string): string` (throws 400 if not `0x` + 40 hex); `createVenue(input)`, `updateVenue(id, patch)`, `createBooking(input)`, `clonePreset(tx, presetId, name)`, `computeBlockedRange(startsAt, endsAt, bufferMinutes): string`, `addGrant(input)`, `updateGrant(grantId, patch)`, `revokeGrant(grantId)`, `cancelBooking(bookingId)`, `getBookingWithVenue(bookingId)`.
  - Routes as listed in Step 5.

- [ ] **Step 1: Write the failing test `apps/server/test/venues.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { sceneElements, accessGrants, scenes } from '../src/db/schema.js'
import { getSceneAccess } from '../src/auth/permissions.js'
import { actorFromClaims } from '../src/auth/actor.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, createElement, createInstance, tokenFor, randomWallet } from './helpers/factories.js'

const H = 3600_000
const as = (u: any) => ({ authorization: `Bearer ${tokenFor(u)}` })

describe('/api/venues', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(() => app.close())

  async function venueSetup() {
    const admin = await createUser({ role: 'admin' })
    const { scene, preset } = await createScene(admin)
    const screen = await createElement(preset.id, { type: 'video' })
    const wall = await createElement(preset.id, { type: 'model', name: 'Wall' })
    await createInstance(screen.id)
    const res = await app.inject({
      method: 'POST',
      url: '/api/venues',
      headers: as(admin),
      payload: { sceneId: scene.id, name: 'Caldera Lounge', slug: 'caldera', rentableElementIds: [screen.id] },
    })
    expect(res.statusCode).toBe(201)
    return { admin, scene, preset, screen, wall, venue: res.json().venue }
  }

  async function book(s: Awaited<ReturnType<typeof venueSetup>>, renterWallet: string, startInMs = 24 * H, hours = 2) {
    const startsAt = new Date(Date.now() + startInMs)
    return app.inject({
      method: 'POST',
      url: `/api/venues/${s.venue.id}/bookings`,
      headers: as(s.admin),
      payload: {
        renterWallet,
        title: 'Friday Set',
        startsAt: startsAt.toISOString(),
        endsAt: new Date(startsAt.getTime() + hours * H).toISOString(),
      },
    })
  }

  it('creates a venue from the active preset and rejects non-preset rentable ids', async () => {
    const s = await venueSetup()
    expect(s.venue.defaultPresetId).toBe(s.preset.id)
    expect(s.venue.rules.setupLeadMinutes).toBe(60)
    const other = await createScene(s.admin, 'Other')
    const foreign = await createElement(other.preset.id)
    const bad = await app.inject({
      method: 'POST',
      url: '/api/venues',
      headers: as(s.admin),
      payload: { sceneId: other.scene.id, name: 'X', slug: 'x', rentableElementIds: [s.screen.id, foreign.id] },
    })
    expect(bad.statusCode).toBe(400)
  })

  it('a creator cannot turn someone else’s scene into a venue', async () => {
    const s = await venueSetup()
    const creator = await createUser()
    const other = await createScene(s.admin, 'Other')
    const res = await app.inject({
      method: 'POST',
      url: '/api/venues',
      headers: as(creator),
      payload: { sceneId: other.scene.id, name: 'Y', slug: 'y' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('booking clones the preset, creates the host grant and blocks overlaps', async () => {
    const s = await venueSetup()
    const wallet = randomWallet()
    const res = await book(s, wallet)
    expect(res.statusCode).toBe(201)
    const { booking, hostGrant } = res.json()
    expect(booking.status).toBe('confirmed')
    expect(booking.bookingPresetId).not.toBe(s.preset.id)
    expect(hostGrant.role).toBe('host')
    expect(hostGrant.walletAddress).toBe(wallet)
    expect(new Date(hostGrant.validUntil).getTime()).toBe(new Date(booking.endsAt).getTime() + 15 * 60_000)

    const clones = await db.select().from(sceneElements).where(eq(sceneElements.presetId, booking.bookingPresetId))
    expect(clones.map((c) => c.clonedFromId).sort()).toEqual([s.screen.id, s.wall.id].sort())

    const overlap = await book(s, randomWallet(), 24 * H + 30 * 60_000)
    expect(overlap.statusCode).toBe(409)
  })

  it.each([
    ['unparseable date', { startsAt: 'soon', endsAt: 'later' }],
    ['end before start', { startsAt: new Date(Date.now() + 5 * H).toISOString(), endsAt: new Date(Date.now() + 4 * H).toISOString() }],
    ['too long', { startsAt: new Date(Date.now() + 5 * H).toISOString(), endsAt: new Date(Date.now() + 20 * H).toISOString() }],
    ['too short', { startsAt: new Date(Date.now() + 5 * H).toISOString(), endsAt: new Date(Date.now() + 5.5 * H).toISOString() }],
    ['already over', { startsAt: new Date(Date.now() - 5 * H).toISOString(), endsAt: new Date(Date.now() - 3 * H).toISOString() }],
  ])('rejects bad booking times: %s', async (_label, times) => {
    const s = await venueSetup()
    const res = await app.inject({
      method: 'POST',
      url: `/api/venues/${s.venue.id}/bookings`,
      headers: as(s.admin),
      payload: { renterWallet: randomWallet(), title: 'x', ...times },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBeTruthy()
  })

  it('only admins can create bookings for now', async () => {
    const s = await venueSetup()
    const creator = await createUser()
    const res = await app.inject({
      method: 'POST',
      url: `/api/venues/${s.venue.id}/bookings`,
      headers: as(creator),
      payload: { renterWallet: randomWallet(), title: 'x', startsAt: new Date(Date.now() + 5 * H).toISOString(), endsAt: new Date(Date.now() + 7 * H).toISOString() },
    })
    expect(res.statusCode).toBe(403)
  })

  it('host adds crew by checksummed wallet; crew signs in lowercase and gets access', async () => {
    const s = await venueSetup()
    const hostWallet = randomWallet()
    const host = await createUser({ wallet: hostWallet })
    const { booking } = (await book(s, hostWallet)).json()

    const crewWallet = randomWallet()
    const mixedCase = '0x' + crewWallet.slice(2).toUpperCase()
    const add = await app.inject({
      method: 'POST',
      url: `/api/venues/bookings/${booking.id}/grants`,
      headers: as(host),
      payload: { walletAddress: mixedCase, role: 'vj' },
    })
    expect(add.statusCode).toBe(201)
    expect(add.json().grant.walletAddress).toBe(crewWallet)
    expect(add.json().grant.scopes.sort()).toEqual(['playlist', 'schedule', 'screens'])

    const crew = await createUser({ wallet: crewWallet })
    const access = await getSceneAccess(actorFromClaims({ id: crew.id, role: 'creator', wallet: crewWallet, verified: true }), s.scene.id)
    expect(access.level).toBe('grant')
  })

  it('scope tweaks, role reset, and invalid wallet', async () => {
    const s = await venueSetup()
    const hostWallet = randomWallet()
    const host = await createUser({ wallet: hostWallet })
    const { booking } = (await book(s, hostWallet)).json()
    const bad = await app.inject({
      method: 'POST',
      url: `/api/venues/bookings/${booking.id}/grants`,
      headers: as(host),
      payload: { walletAddress: 'not-a-wallet', role: 'vj' },
    })
    expect(bad.statusCode).toBe(400)

    const { grant } = (
      await app.inject({
        method: 'POST',
        url: `/api/venues/bookings/${booking.id}/grants`,
        headers: as(host),
        payload: { walletAddress: randomWallet(), role: 'performer', scopes: ['lights.cue', 'lights.faders'] },
      })
    ).json()
    expect(grant.scopes.sort()).toEqual(['lights.cue', 'lights.faders'])

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/venues/grants/${grant.id}`,
      headers: as(host),
      payload: { role: 'door' },
    })
    expect(patched.json().grant.scopes).toEqual(['moderation'])
  })

  it('crew grants cannot outlast the host grant', async () => {
    const s = await venueSetup()
    const hostWallet = randomWallet()
    const host = await createUser({ wallet: hostWallet })
    const { booking, hostGrant } = (await book(s, hostWallet)).json()
    const res = await app.inject({
      method: 'POST',
      url: `/api/venues/bookings/${booking.id}/grants`,
      headers: as(host),
      payload: {
        walletAddress: randomWallet(),
        role: 'vj',
        validUntil: new Date(new Date(hostGrant.validUntil).getTime() + H).toISOString(),
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('cohost cannot revoke the host; vj cannot manage crew; nobody can create a host grant', async () => {
    const s = await venueSetup()
    const hostWallet = randomWallet()
    const host = await createUser({ wallet: hostWallet })
    const { booking, hostGrant } = (await book(s, hostWallet)).json()
    const cohostWallet = randomWallet()
    const vjWallet = randomWallet()
    const cohost = await createUser({ wallet: cohostWallet })
    const vj = await createUser({ wallet: vjWallet })
    for (const [w, role] of [[cohostWallet, 'cohost'], [vjWallet, 'vj']] as const) {
      await app.inject({ method: 'POST', url: `/api/venues/bookings/${booking.id}/grants`, headers: as(host), payload: { walletAddress: w, role } })
    }
    expect((await app.inject({ method: 'DELETE', url: `/api/venues/grants/${hostGrant.id}`, headers: as(cohost) })).statusCode).toBe(403)
    expect(
      (await app.inject({ method: 'POST', url: `/api/venues/bookings/${booking.id}/grants`, headers: as(vj), payload: { walletAddress: randomWallet(), role: 'door' } })).statusCode,
    ).toBe(403)
    expect(
      (await app.inject({ method: 'POST', url: `/api/venues/bookings/${booking.id}/grants`, headers: as(host), payload: { walletAddress: randomWallet(), role: 'host' } })).statusCode,
    ).toBe(400)
  })

  it('revoke removes access; cancel revokes everything', async () => {
    const s = await venueSetup()
    const hostWallet = randomWallet()
    const host = await createUser({ wallet: hostWallet })
    const { booking } = (await book(s, hostWallet)).json()
    const crewWallet = randomWallet()
    const crew = await createUser({ wallet: crewWallet })
    const { grant } = (
      await app.inject({ method: 'POST', url: `/api/venues/bookings/${booking.id}/grants`, headers: as(host), payload: { walletAddress: crewWallet, role: 'vj' } })
    ).json()
    expect((await app.inject({ method: 'DELETE', url: `/api/venues/grants/${grant.id}`, headers: as(host) })).statusCode).toBe(204)
    const crewActor = actorFromClaims({ id: crew.id, role: 'creator', wallet: crewWallet, verified: true })
    expect((await getSceneAccess(crewActor, s.scene.id)).level).toBe('none')

    const cancel = await app.inject({ method: 'POST', url: `/api/venues/bookings/${booking.id}/cancel`, headers: as(s.admin) })
    expect(cancel.statusCode).toBe(200)
    const hostActor = actorFromClaims({ id: host.id, role: 'creator', wallet: hostWallet, verified: true })
    expect((await getSceneAccess(hostActor, s.scene.id)).level).toBe('none')
    const live = await db.query.scenes.findFirst({ where: eq(scenes.id, s.scene.id) })
    expect(live!.activePresetId).toBe(s.preset.id)
  })

  it('GET /api/venues/bookings/mine lists bookings where I hold an active grant', async () => {
    const s = await venueSetup()
    const hostWallet = randomWallet()
    const host = await createUser({ wallet: hostWallet })
    const { booking } = (await book(s, hostWallet)).json()
    const res = await app.inject({ method: 'GET', url: '/api/venues/bookings/mine', headers: as(host) })
    expect(res.json().bookings.map((b: any) => b.id)).toEqual([booking.id])
    expect(res.json().bookings[0].role).toBe('host')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test test/venues.test.ts`
Expected: FAIL — 404 on `POST /api/venues`.

- [ ] **Step 3: Create `apps/server/src/realtime/bus.ts`**

```ts
/**
 * Venue events fan out to scene rooms through Colyseus presence pub/sub,
 * so REST handlers and the lifecycle sweep reach rooms on any server.
 */
export type VenueEvent =
  | { type: 'grants_changed'; sceneId: string }
  | { type: 'preset_changed'; sceneId: string; presetId: string }
  | { type: 'booking_ended'; sceneId: string; bookingId: string; reason: 'expired' | 'canceled' }

export interface BusPresence {
  publish(topic: string, data: unknown): unknown
}

let presence: BusPresence | null = null

export function initBus(p: BusPresence) {
  presence = p
}

export function venueTopic(sceneId: string) {
  return `venue:${sceneId}`
}

export async function publishVenueEvent(e: VenueEvent) {
  if (!presence) return
  await presence.publish(venueTopic(e.sceneId), e)
}
```

- [ ] **Step 4: Create `apps/server/src/venues/service.ts`**

```ts
import { and, eq, inArray, isNull } from 'drizzle-orm'
import {
  DEFAULT_VENUE_RULES,
  VENUE_ROLE_SCOPES,
  isVenueRole,
  isVenueScope,
  type VenueRole,
  type VenueRules,
  type VenueScope,
} from 'vlm-shared'
import { db } from '../db/connection.js'
import {
  accessGrants,
  bookings,
  sceneElementInstances,
  sceneElements,
  scenePresets,
  scenes,
  userAuthMethods,
  venues,
} from '../db/schema.js'
import { liveWindowEnd } from '../auth/permissions.js'
import { publishVenueEvent } from '../realtime/bus.js'

export class VenueError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export function normalizeWallet(w: unknown): string {
  if (typeof w !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(w)) throw new VenueError(400, 'walletAddress must be 0x followed by 40 hex characters')
  return w.toLowerCase()
}

function parseDate(v: unknown, field: string): Date {
  const d = typeof v === 'string' || v instanceof Date ? new Date(v) : new Date(NaN)
  if (Number.isNaN(d.getTime())) throw new VenueError(400, `${field} must be an ISO date`)
  return d
}

function pgCode(err: any): string | undefined {
  return err?.code ?? err?.cause?.code
}

export function computeBlockedRange(startsAt: Date, endsAt: Date, bufferMinutes: number) {
  const buf = bufferMinutes * 60_000
  return `[${new Date(startsAt.getTime() - buf).toISOString()},${new Date(endsAt.getTime() + buf).toISOString()})`
}

// ── Venues ───────────────────────────────────────────────────────────────

export interface CreateVenueInput {
  sceneId: string
  name: string
  slug: string
  description?: string
  kind?: 'permanent' | 'popup'
  timezone?: string
  rules?: Partial<VenueRules>
  rentableElementIds?: string[]
  isListed?: boolean
}

async function assertRentableInPreset(presetId: string, ids: string[]) {
  if (!ids.length) return
  const rows = await db
    .select({ id: sceneElements.id })
    .from(sceneElements)
    .where(and(eq(sceneElements.presetId, presetId), inArray(sceneElements.id, ids)))
  if (rows.length !== new Set(ids).size) throw new VenueError(400, 'rentableElementIds must all belong to the venue default preset')
}

export async function createVenue(input: CreateVenueInput) {
  if (!input.name || !input.slug) throw new VenueError(400, 'name and slug are required')
  const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, input.sceneId) })
  if (!scene) throw new VenueError(404, 'Scene not found')
  if (!scene.activePresetId) throw new VenueError(400, 'Scene has no active preset to use as the venue default')
  const rentable = input.rentableElementIds ?? []
  await assertRentableInPreset(scene.activePresetId, rentable)
  try {
    const [venue] = await db
      .insert(venues)
      .values({
        sceneId: scene.id,
        orgId: scene.orgId,
        name: input.name,
        slug: input.slug,
        description: input.description ?? null,
        kind: input.kind ?? 'permanent',
        defaultPresetId: scene.activePresetId,
        timezone: input.timezone ?? 'UTC',
        rules: { ...DEFAULT_VENUE_RULES, ...input.rules },
        rentableElementIds: rentable,
        isListed: input.isListed ?? false,
      })
      .returning()
    return venue
  } catch (err) {
    if (pgCode(err) === '23505') throw new VenueError(409, 'That scene is already a venue, or the slug is taken')
    throw err
  }
}

export async function updateVenue(
  id: string,
  patch: Partial<Pick<CreateVenueInput, 'name' | 'description' | 'timezone' | 'rules' | 'rentableElementIds' | 'isListed'>>,
) {
  const venue = await db.query.venues.findFirst({ where: eq(venues.id, id) })
  if (!venue) throw new VenueError(404, 'Venue not found')
  if (patch.rentableElementIds) await assertRentableInPreset(venue.defaultPresetId, patch.rentableElementIds)
  const [updated] = await db
    .update(venues)
    .set({
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.description !== undefined && { description: patch.description }),
      ...(patch.timezone !== undefined && { timezone: patch.timezone }),
      ...(patch.rules !== undefined && { rules: { ...venue.rules, ...patch.rules } }),
      ...(patch.rentableElementIds !== undefined && { rentableElementIds: patch.rentableElementIds }),
      ...(patch.isListed !== undefined && { isListed: patch.isListed }),
      updatedAt: new Date(),
    })
    .where(eq(venues.id, id))
    .returning()
  return updated
}

// ── Preset cloning ───────────────────────────────────────────────────────

export async function clonePreset(tx: Tx, presetId: string, name: string): Promise<string> {
  const source = await tx.query.scenePresets.findFirst({
    where: eq(scenePresets.id, presetId),
    with: { elements: { with: { instances: true } } },
  })
  if (!source) throw new VenueError(400, 'Venue default preset is missing')
  const [copy] = await tx.insert(scenePresets).values({ sceneId: source.sceneId, name, locale: source.locale }).returning()

  const instanceIdMap = new Map<string, string>()
  const pendingParents: { newId: string; oldParent: string }[] = []
  for (const el of source.elements) {
    const [newEl] = await tx
      .insert(sceneElements)
      .values({
        presetId: copy.id,
        type: el.type,
        name: el.name,
        enabled: el.enabled,
        customId: el.customId,
        customRendering: el.customRendering,
        clickEvent: el.clickEvent,
        properties: el.properties,
        clonedFromId: el.id,
      })
      .returning()
    for (const inst of el.instances) {
      const [newInst] = await tx
        .insert(sceneElementInstances)
        .values({
          elementId: newEl.id,
          enabled: inst.enabled,
          customId: inst.customId,
          customRendering: inst.customRendering,
          position: inst.position,
          rotation: inst.rotation,
          scale: inst.scale,
          clickEvent: inst.clickEvent,
          withCollisions: inst.withCollisions,
          properties: inst.properties,
        })
        .returning()
      instanceIdMap.set(inst.id, newInst.id)
      if (inst.parentInstanceId) pendingParents.push({ newId: newInst.id, oldParent: inst.parentInstanceId })
    }
  }
  for (const p of pendingParents) {
    const parent = instanceIdMap.get(p.oldParent)
    if (parent) await tx.update(sceneElementInstances).set({ parentInstanceId: parent }).where(eq(sceneElementInstances.id, p.newId))
  }
  return copy.id
}

// ── Bookings ─────────────────────────────────────────────────────────────

export interface CreateBookingInput {
  venueId: string
  renterUserId?: string
  renterWallet?: string
  title: string
  startsAt: unknown
  endsAt: unknown
  createdByUserId: string
}

async function walletForUser(userId: string): Promise<string | null> {
  const m = await db.query.userAuthMethods.findFirst({
    where: and(eq(userAuthMethods.userId, userId), eq(userAuthMethods.type, 'wallet')),
  })
  return m && /^0x[0-9a-f]{40}$/.test(m.identifier) ? m.identifier : null
}

export async function createBooking(input: CreateBookingInput, now = new Date()) {
  const venue = await db.query.venues.findFirst({ where: eq(venues.id, input.venueId) })
  if (!venue) throw new VenueError(404, 'Venue not found')
  if (!input.title) throw new VenueError(400, 'title is required')
  const startsAt = parseDate(input.startsAt, 'startsAt')
  const endsAt = parseDate(input.endsAt, 'endsAt')
  if (endsAt <= startsAt) throw new VenueError(400, 'endsAt must be after startsAt')
  if (endsAt <= now) throw new VenueError(400, 'Booking has already ended')
  const hours = (endsAt.getTime() - startsAt.getTime()) / 3_600_000
  if (hours < venue.rules.minHours || hours > venue.rules.maxHours) {
    throw new VenueError(400, `Bookings at this venue must be ${venue.rules.minHours}–${venue.rules.maxHours} hours`)
  }
  if (!input.renterUserId && !input.renterWallet) throw new VenueError(400, 'renterUserId or renterWallet is required')
  const renterWallet = input.renterWallet
    ? normalizeWallet(input.renterWallet)
    : await walletForUser(input.renterUserId!)

  try {
    const result = await db.transaction(async (tx) => {
      const [booking] = await tx
        .insert(bookings)
        .values({
          venueId: venue.id,
          renterUserId: input.renterUserId ?? null,
          renterWallet,
          title: input.title,
          startsAt,
          endsAt,
          status: 'confirmed',
          blockedRange: computeBlockedRange(startsAt, endsAt, venue.rules.bufferMinutes),
        })
        .returning()
      const bookingPresetId = await clonePreset(tx, venue.defaultPresetId, `booking:${booking.id}`)
      const [withPreset] = await tx
        .update(bookings)
        .set({ bookingPresetId })
        .where(eq(bookings.id, booking.id))
        .returning()
      const [hostGrant] = await tx
        .insert(accessGrants)
        .values({
          bookingId: booking.id,
          sceneId: venue.sceneId,
          walletAddress: renterWallet,
          userId: input.renterUserId ?? null,
          role: 'host',
          scopes: [...VENUE_ROLE_SCOPES.host],
          validFrom: now,
          validUntil: liveWindowEnd({ endsAt }, venue.rules),
          grantedByUserId: input.createdByUserId,
        })
        .returning()
      return { booking: withPreset, hostGrant }
    })
    await publishVenueEvent({ type: 'grants_changed', sceneId: venue.sceneId })
    return result
  } catch (err) {
    if (pgCode(err) === '23P01') throw new VenueError(409, 'That time overlaps another booking at this venue')
    throw err
  }
}

export async function getBookingWithVenue(bookingId: string) {
  const booking = await db.query.bookings.findFirst({ where: eq(bookings.id, bookingId), with: { venue: true } })
  if (!booking) throw new VenueError(404, 'Booking not found')
  return booking
}

export async function cancelBooking(bookingId: string) {
  const booking = await getBookingWithVenue(bookingId)
  const [updated] = await db
    .update(bookings)
    .set({ status: 'canceled', updatedAt: new Date() })
    .where(and(eq(bookings.id, bookingId), inArray(bookings.status, ['pending', 'confirmed', 'live'])))
    .returning()
  if (!updated) throw new VenueError(409, `Booking is already ${booking.status}`)
  await db
    .update(accessGrants)
    .set({ revokedAt: new Date() })
    .where(and(eq(accessGrants.bookingId, bookingId), isNull(accessGrants.revokedAt)))
  const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, booking.venue.sceneId) })
  if (scene && booking.bookingPresetId && scene.activePresetId === booking.bookingPresetId) {
    await db.update(scenes).set({ activePresetId: booking.venue.defaultPresetId, updatedAt: new Date() }).where(eq(scenes.id, scene.id))
    await publishVenueEvent({ type: 'preset_changed', sceneId: scene.id, presetId: booking.venue.defaultPresetId })
  }
  await publishVenueEvent({ type: 'booking_ended', sceneId: booking.venue.sceneId, bookingId, reason: 'canceled' })
  return updated
}

// ── Grants ───────────────────────────────────────────────────────────────

function resolveScopes(role: VenueRole, scopes: unknown): VenueScope[] {
  if (scopes === undefined) return [...VENUE_ROLE_SCOPES[role]]
  if (!Array.isArray(scopes) || !scopes.every(isVenueScope)) throw new VenueError(400, 'scopes must be venue scopes')
  return [...new Set(scopes)]
}

async function hostGrantFor(bookingId: string) {
  const host = await db.query.accessGrants.findFirst({
    where: and(eq(accessGrants.bookingId, bookingId), eq(accessGrants.role, 'host')),
  })
  if (!host) throw new VenueError(500, 'Booking has no host grant')
  return host
}

export interface AddGrantInput {
  bookingId: string
  walletAddress: unknown
  role: unknown
  scopes?: unknown
  validFrom?: unknown
  validUntil?: unknown
  grantedByUserId: string
}

export async function addGrant(input: AddGrantInput) {
  if (!isVenueRole(input.role)) throw new VenueError(400, 'role must be a venue role')
  if (input.role === 'host') throw new VenueError(400, 'The host grant is created with the booking')
  const wallet = normalizeWallet(input.walletAddress)
  const booking = await getBookingWithVenue(input.bookingId)
  if (!['confirmed', 'live'].includes(booking.status)) throw new VenueError(409, `Booking is ${booking.status}`)
  const host = await hostGrantFor(booking.id)
  const validFrom = input.validFrom === undefined ? new Date() : parseDate(input.validFrom, 'validFrom')
  const validUntil = input.validUntil === undefined ? host.validUntil : parseDate(input.validUntil, 'validUntil')
  if (validUntil <= validFrom) throw new VenueError(400, 'validUntil must be after validFrom')
  if (validFrom < host.validFrom || validUntil > host.validUntil) {
    throw new VenueError(400, "Crew access must fit inside the host's booking window")
  }
  const linked = await db.query.userAuthMethods.findFirst({
    where: and(eq(userAuthMethods.type, 'wallet'), eq(userAuthMethods.identifier, wallet)),
  })
  try {
    const [grant] = await db
      .insert(accessGrants)
      .values({
        bookingId: booking.id,
        sceneId: booking.venue.sceneId,
        walletAddress: wallet,
        userId: linked?.userId ?? null,
        role: input.role,
        scopes: resolveScopes(input.role, input.scopes),
        validFrom,
        validUntil,
        grantedByUserId: input.grantedByUserId,
      })
      .returning()
    await publishVenueEvent({ type: 'grants_changed', sceneId: booking.venue.sceneId })
    return grant
  } catch (err) {
    if (pgCode(err) === '23505') throw new VenueError(409, 'That wallet already has access to this booking')
    throw err
  }
}

export async function getGrant(grantId: string) {
  const grant = await db.query.accessGrants.findFirst({ where: eq(accessGrants.id, grantId) })
  if (!grant) throw new VenueError(404, 'Grant not found')
  return grant
}

export async function updateGrant(grantId: string, patch: { role?: unknown; scopes?: unknown }) {
  const grant = await getGrant(grantId)
  let role = grant.role
  if (patch.role !== undefined) {
    if (!isVenueRole(patch.role) || patch.role === 'host') throw new VenueError(400, 'role must be a non-host venue role')
    if (grant.role === 'host') throw new VenueError(400, "The host's role can't be changed")
    role = patch.role
  }
  const scopes =
    patch.scopes !== undefined
      ? resolveScopes(role, patch.scopes)
      : patch.role !== undefined
        ? [...VENUE_ROLE_SCOPES[role]]
        : grant.scopes
  const [updated] = await db.update(accessGrants).set({ role, scopes }).where(eq(accessGrants.id, grantId)).returning()
  await publishVenueEvent({ type: 'grants_changed', sceneId: grant.sceneId })
  return updated
}

export async function revokeGrant(grantId: string) {
  const grant = await getGrant(grantId)
  if (grant.role === 'host') throw new VenueError(400, 'Cancel the booking to remove the host')
  await db.update(accessGrants).set({ revokedAt: new Date() }).where(eq(accessGrants.id, grantId))
  await publishVenueEvent({ type: 'grants_changed', sceneId: grant.sceneId })
}

export async function listGrants(bookingId: string) {
  return db.select().from(accessGrants).where(and(eq(accessGrants.bookingId, bookingId), isNull(accessGrants.revokedAt)))
}

export async function bookingsForActor(userId: string, wallet: string | null, now = new Date()) {
  const rows = await db.query.accessGrants.findMany({
    where: (g, { and, or, eq, isNull, gt }) =>
      and(isNull(g.revokedAt), gt(g.validUntil, now), wallet ? or(eq(g.userId, userId), eq(g.walletAddress, wallet)) : eq(g.userId, userId)),
    with: { booking: { with: { venue: true } } },
  })
  return rows
    .filter((g) => g.booking.status === 'confirmed' || g.booking.status === 'live')
    .map((g) => ({ ...g.booking, role: g.role, scopes: g.scopes, grantId: g.id }))
}
```

- [ ] **Step 5: Create `apps/server/src/routes/venues.ts`**

```ts
import type { FastifyInstance, FastifyReply } from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { scenes, venues } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess, hasScope, isFullAccess } from '../auth/permissions.js'
import {
  VenueError,
  addGrant,
  bookingsForActor,
  cancelBooking,
  createBooking,
  createVenue,
  getBookingWithVenue,
  getGrant,
  listGrants,
  revokeGrant,
  updateGrant,
  updateVenue,
} from '../venues/service.js'

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof VenueError) return reply.status(err.status).send({ error: err.message })
  throw err
}

export default async function venueRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  const actorOf = (request: { user: any }) => actorFromClaims(request.user)

  /** Admin, or owner of the scene. */
  async function canManageScene(request: { user: any }, sceneId: string) {
    const access = await getSceneAccess(actorOf(request), sceneId)
    return isFullAccess(access)
  }

  /** Crew management: needs `crew`; grant holders only for their own booking; non-hosts can't touch the host grant. */
  async function crewAccess(request: { user: any }, bookingId: string, targetRole?: string) {
    const booking = await getBookingWithVenue(bookingId)
    const access = await getSceneAccess(actorOf(request), booking.venue.sceneId)
    if (!hasScope(access, 'crew')) throw new VenueError(403, 'You cannot manage crew for this booking')
    if (access.level === 'grant') {
      if (access.booking!.bookingId !== bookingId) throw new VenueError(403, 'You cannot manage crew for this booking')
      if (targetRole === 'host' && access.booking!.role !== 'host') throw new VenueError(403, 'Only the host can change the host')
    }
    return booking
  }

  app.post<{ Body: any }>('/api/venues', async (request, reply) => {
    try {
      if (!(await canManageScene(request, request.body?.sceneId))) return reply.status(403).send({ error: 'Forbidden' })
      return reply.status(201).send({ venue: await createVenue(request.body) })
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.get('/api/venues', async (_request, reply) => {
    const listed = await db.query.venues.findMany({ where: eq(venues.isListed, true) })
    return reply.send({ venues: listed })
  })

  app.get('/api/venues/bookings/mine', async (request, reply) => {
    const actor = actorOf(request)
    if (!actor.userId || !actor.verified) return reply.send({ bookings: [] })
    return reply.send({ bookings: await bookingsForActor(actor.userId, actor.wallet) })
  })

  app.get<{ Params: { venueId: string } }>('/api/venues/:venueId', async (request, reply) => {
    const venue = await db.query.venues.findFirst({ where: eq(venues.id, request.params.venueId) })
    if (!venue) return reply.status(404).send({ error: 'Venue not found' })
    return reply.send({ venue })
  })

  app.patch<{ Params: { venueId: string }; Body: any }>('/api/venues/:venueId', async (request, reply) => {
    try {
      const venue = await db.query.venues.findFirst({ where: eq(venues.id, request.params.venueId) })
      if (!venue) return reply.status(404).send({ error: 'Venue not found' })
      if (!(await canManageScene(request, venue.sceneId))) return reply.status(403).send({ error: 'Forbidden' })
      return reply.send({ venue: await updateVenue(venue.id, request.body ?? {}) })
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.post<{ Params: { venueId: string }; Body: any }>('/api/venues/:venueId/bookings', async (request, reply) => {
    // Admin-only until self-serve booking + payments (sub-project 5).
    if (request.user.role !== 'admin') return reply.status(403).send({ error: 'Only admins can create bookings right now' })
    try {
      const result = await createBooking({ ...request.body, venueId: request.params.venueId, createdByUserId: request.user.id })
      return reply.status(201).send(result)
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.post<{ Params: { bookingId: string } }>('/api/venues/bookings/:bookingId/cancel', async (request, reply) => {
    if (request.user.role !== 'admin') return reply.status(403).send({ error: 'Forbidden' })
    try {
      return reply.send({ booking: await cancelBooking(request.params.bookingId) })
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.get<{ Params: { bookingId: string } }>('/api/venues/bookings/:bookingId/grants', async (request, reply) => {
    try {
      await crewAccess(request, request.params.bookingId)
      return reply.send({ grants: await listGrants(request.params.bookingId) })
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.post<{ Params: { bookingId: string }; Body: any }>('/api/venues/bookings/:bookingId/grants', async (request, reply) => {
    try {
      await crewAccess(request, request.params.bookingId)
      const grant = await addGrant({ ...request.body, bookingId: request.params.bookingId, grantedByUserId: request.user.id })
      return reply.status(201).send({ grant })
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.patch<{ Params: { grantId: string }; Body: any }>('/api/venues/grants/:grantId', async (request, reply) => {
    try {
      const grant = await getGrant(request.params.grantId)
      await crewAccess(request, grant.bookingId, grant.role)
      return reply.send({ grant: await updateGrant(grant.id, request.body ?? {}) })
    } catch (err) {
      return fail(reply, err)
    }
  })

  app.delete<{ Params: { grantId: string } }>('/api/venues/grants/:grantId', async (request, reply) => {
    try {
      const grant = await getGrant(request.params.grantId)
      await crewAccess(request, grant.bookingId, grant.role)
      await revokeGrant(grant.id)
      return reply.status(204).send()
    } catch (err) {
      return fail(reply, err)
    }
  })
}
```

Note the cohost→host case: `crewAccess(…, 'host')` returns 403 for a cohost before `revokeGrant` would return 400 — that is the order the test expects.

Register in `app.ts` next to the other routes: `import venueRoutes from './routes/venues.js'` and `await app.register(venueRoutes)`.

- [ ] **Step 6: Run tests and typecheck**

Run: `pnpm test test/venues.test.ts && pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/server
git commit -m "feat(venues): venue, booking and crew grant API with preset cloning"
```

---

### Task 7: Room authentication, message guard, and venue access messages (spec §4.1, §5.4, §5.6)

**Files:**
- Create: `apps/server/src/ws/scene-guard.ts`, `apps/server/test/helpers/game-server.ts`, `apps/server/test/scene-room.test.ts`
- Modify: `apps/server/src/ws/VLMSceneRoom.ts`, `apps/server/src/ws/VLMCommandCenterRoom.ts` (add `onAuth` + guard to its mutating handlers: require `actor.verified && actor.userId`), `apps/server/src/index.ts`

**Interfaces:**
- Consumes: `verifySessionToken`, `actorFromClaims`, `getSceneAccess`, `canWriteElement`, `diffKeys`, `toVenueAccessMessage`, `venueTopic`, `initBus`, `VenueEvent`.
- Produces:
  - `type GuardResult = { ok: true; broadcast: boolean } | { ok: false; code: 'forbidden' | 'not_found' }`
  - `authorizeSceneMessage(access: SceneAccess, sceneId: string, type: string, message: any): Promise<GuardResult>`
  - Room → client messages: `auth_status`, `venue_access`, `access_revoked`, `vlm_error`.
  - Test helpers: `startGameServer(): Promise<{ url: string; stop(): Promise<void> }>`, `joinScene(url, sceneId, token?): Promise<TestClient>` where `TestClient = { room; inbox: { type: string; message: any }[]; waitFor(type: string, ms?: number): Promise<any>; expectNone(type: string, ms?: number): Promise<void> }`.

- [ ] **Step 1: Create `apps/server/test/helpers/game-server.ts`**

```ts
import { createRequire } from 'node:module'
import { Client } from 'colyseus.js'
import { initBus } from '../../src/realtime/bus.js'
import { VLMSceneRoom } from '../../src/ws/VLMSceneRoom.js'

const _require = createRequire(import.meta.url)
const { Server, LocalPresence } = _require('colyseus') as any
const { WebSocketTransport } = _require('@colyseus/ws-transport') as any

export async function startGameServer() {
  const presence = new LocalPresence()
  initBus(presence)
  const server = new Server({ transport: new WebSocketTransport(), presence })
  server.define('vlm_scene', VLMSceneRoom).filterBy(['sceneId'])
  const port = 20000 + Math.floor(Math.random() * 20000)
  await server.listen(port)
  return { url: `ws://localhost:${port}`, stop: () => server.gracefullyShutdown(false) as Promise<void> }
}

export async function joinScene(url: string, sceneId: string, token?: string) {
  const client = new Client(url)
  const inbox: { type: string; message: any }[] = []
  const room = await client.joinOrCreate('vlm_scene', { sceneId, sessionToken: token, clientType: 'analytics' })
  room.onMessage('*', (type: string | number, message: any) => inbox.push({ type: String(type), message }))

  async function waitFor(type: string, ms = 3000) {
    const start = Date.now()
    while (Date.now() - start < ms) {
      const i = inbox.findIndex((m) => m.type === type)
      if (i >= 0) return inbox.splice(i, 1)[0].message
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error(`timed out waiting for ${type}; got ${inbox.map((m) => m.type).join(', ')}`)
  }

  async function expectNone(type: string, ms = 400) {
    await new Promise((r) => setTimeout(r, ms))
    if (inbox.some((m) => m.type === type)) throw new Error(`unexpected ${type}`)
  }

  return { room, inbox, waitFor, expectNone }
}
```

- [ ] **Step 2: Write the failing test `apps/server/test/scene-room.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { sceneElements, sceneCollaborators } from '../src/db/schema.js'
import { createVenue, createBooking, addGrant, revokeGrant } from '../src/venues/service.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, createElement, tokenFor, expiredTokenFor, randomWallet } from './helpers/factories.js'
import { startGameServer, joinScene } from './helpers/game-server.js'

const H = 3600_000
const update = (id: string, props: Record<string, unknown>) => ({
  action: 'update',
  element: 'video',
  elementData: { sk: id, ...props },
})
const propsOf = async (id: string) =>
  (await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, id) }))!.properties as Record<string, unknown>

describe('VLMSceneRoom auth', () => {
  let gs: Awaited<ReturnType<typeof startGameServer>>
  beforeEach(async () => {
    await resetDb()
    gs = await startGameServer()
  })
  afterEach(() => gs.stop())

  async function scene() {
    const owner = await createUser()
    const { scene, preset } = await createScene(owner)
    const screen = await createElement(preset.id)
    return { owner, scene, preset, screen }
  }

  it('anonymous visitor receives init but cannot mutate', async () => {
    const s = await scene()
    const watcher = await joinScene(gs.url, s.scene.id, tokenFor(s.owner))
    await watcher.waitFor('scene_preset_update') // consume init
    const anon = await joinScene(gs.url, s.scene.id)
    expect((await anon.waitFor('auth_status')).authenticated).toBe(false)
    expect((await anon.waitFor('scene_preset_update')).action).toBe('init')

    anon.room.send('scene_preset_update', update(s.screen.id, { liveSrc: 'https://evil/x.m3u8' }))
    expect((await anon.waitFor('vlm_error')).code).toBe('forbidden')
    await watcher.expectNone('scene_preset_update')
    expect((await propsOf(s.screen.id)).liveSrc).toBe('https://old.example/live.m3u8')
  })

  it('owner can mutate; others in the room see the broadcast', async () => {
    const s = await scene()
    const owner = await joinScene(gs.url, s.scene.id, tokenFor(s.owner))
    const visitor = await joinScene(gs.url, s.scene.id)
    await visitor.waitFor('scene_preset_update') // init
    owner.room.send('scene_preset_update', update(s.screen.id, { liveSrc: 'https://new/live.m3u8', playlist: [] }))
    expect((await visitor.waitFor('scene_preset_update')).elementData.liveSrc).toBe('https://new/live.m3u8')
    expect((await propsOf(s.screen.id)).liveSrc).toBe('https://new/live.m3u8')
  })

  it('expired token joins as anonymous and is told so', async () => {
    const s = await scene()
    const c = await joinScene(gs.url, s.scene.id, expiredTokenFor(s.owner))
    expect((await c.waitFor('auth_status')).authenticated).toBe(false)
    c.room.send('scene_change_preset', { presetId: s.preset.id })
    expect((await c.waitFor('vlm_error')).code).toBe('forbidden')
  })

  it('owner of scene A cannot edit scene B elements through room A', async () => {
    const a = await scene()
    const b = await scene()
    await db.insert(sceneCollaborators).values({ sceneId: a.scene.id, userId: b.owner.id, role: 'editor' })
    const c = await joinScene(gs.url, a.scene.id, tokenFor(b.owner))
    c.room.send('scene_preset_update', update(b.screen.id, { liveSrc: 'x' }))
    expect((await c.waitFor('vlm_error')).code).toBe('not_found')
  })

  it('different scenes get different rooms', async () => {
    const a = await scene()
    const b = await scene()
    const ca = await joinScene(gs.url, a.scene.id)
    const cb = await joinScene(gs.url, b.scene.id)
    expect(ca.room.roomId).not.toBe(cb.room.roomId)
  })

  describe('venue grants', () => {
    async function venueWithCrew(startInMs = 24 * H) {
      const admin = await createUser({ role: 'admin' })
      const { scene, preset } = await createScene(admin)
      const screen = await createElement(preset.id)
      const venue = await createVenue({ sceneId: scene.id, name: 'Aurora', slug: `aurora-${crypto.randomUUID()}`, rentableElementIds: [screen.id] })
      const hostWallet = randomWallet()
      const host = await createUser({ wallet: hostWallet })
      const startsAt = new Date(Date.now() + startInMs)
      const { booking } = await createBooking({
        venueId: venue.id,
        renterWallet: hostWallet,
        title: 'Set',
        startsAt,
        endsAt: new Date(startsAt.getTime() + 2 * H),
        createdByUserId: admin.id,
      })
      const crewWallet = randomWallet()
      const crew = await createUser({ wallet: crewWallet })
      const grant = await addGrant({ bookingId: booking.id, walletAddress: crewWallet, role: 'vj', grantedByUserId: host.id })
      const [clone] = await db.select().from(sceneElements).where(eq(sceneElements.presetId, booking.bookingPresetId!))
      return { admin, scene, preset, screen, venue, booking, host, crew, grant, clone }
    }

    it('crew gets venue_access on join', async () => {
      const v = await venueWithCrew()
      const c = await joinScene(gs.url, v.scene.id, tokenFor(v.crew))
      const access = await c.waitFor('venue_access')
      expect(access).toMatchObject({ bookingId: v.booking.id, role: 'vj', window: 'setup' })
      expect(access.scopes.sort()).toEqual(['playlist', 'schedule', 'screens'])
    })

    it('in setup, crew edits the booking clone without broadcasting to the live scene', async () => {
      const v = await venueWithCrew()
      const visitor = await joinScene(gs.url, v.scene.id)
      await visitor.waitFor('scene_preset_update') // init
      const c = await joinScene(gs.url, v.scene.id, tokenFor(v.crew))
      c.room.send('scene_preset_update', update(v.clone.id, { ...(v.clone.properties as object), liveSrc: 'https://dj/live.m3u8' }))
      await c.waitFor('scene_preset_update_ack')
      await visitor.expectNone('scene_preset_update')
      expect((await propsOf(v.clone.id)).liveSrc).toBe('https://dj/live.m3u8')
      expect((await propsOf(v.screen.id)).liveSrc).toBe('https://old.example/live.m3u8')
    })

    it('crew cannot edit the live default preset element', async () => {
      const v = await venueWithCrew()
      const c = await joinScene(gs.url, v.scene.id, tokenFor(v.crew))
      c.room.send('scene_preset_update', update(v.screen.id, { liveSrc: 'x' }))
      expect((await c.waitFor('vlm_error')).code).toBe('forbidden')
    })

    it('crew without moderation cannot send moderator messages', async () => {
      const v = await venueWithCrew()
      const c = await joinScene(gs.url, v.scene.id, tokenFor(v.crew))
      c.room.send('scene_moderator_message', { message: 'hi' })
      expect((await c.waitFor('vlm_error')).code).toBe('forbidden')
    })

    it('revoking a grant takes effect on the very next message and notifies the client', async () => {
      const v = await venueWithCrew()
      const c = await joinScene(gs.url, v.scene.id, tokenFor(v.crew))
      await c.waitFor('venue_access')
      // warm the 10-second cache
      c.room.send('scene_preset_update', update(v.clone.id, { ...(v.clone.properties as object), liveSrc: 'a' }))
      await c.waitFor('scene_preset_update_ack')
      await revokeGrant(v.grant.id)
      expect((await c.waitFor('access_revoked')).reason).toBe('revoked')
      c.room.send('scene_preset_update', update(v.clone.id, { liveSrc: 'b' }))
      expect((await c.waitFor('vlm_error')).code).toBe('forbidden')
    })
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm test test/scene-room.test.ts`
Expected: FAIL — no `auth_status`; anonymous mutation is broadcast.

- [ ] **Step 4: Create `apps/server/src/ws/scene-guard.ts`**

```ts
import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { sceneElementInstances, sceneElements, scenePresets, scenes } from '../db/schema.js'
import { canWriteElement, diffKeys, hasScope, type SceneAccess, type SceneScope } from '../auth/permissions.js'

export type GuardResult = { ok: true; broadcast: boolean } | { ok: false; code: 'forbidden' | 'not_found' }

const OK_BROADCAST: GuardResult = { ok: true, broadcast: true }
const FORBIDDEN: GuardResult = { ok: false, code: 'forbidden' }
const NOT_FOUND: GuardResult = { ok: false, code: 'not_found' }

/** Field keys of an element update message, matching VLMSceneRoom.persistPresetUpdate. */
const ELEMENT_FIELDS = ['name', 'enabled', 'customId', 'clickEvent'] as const

/** Must stay in sync with VLMSceneRoom.extractProperties' structural keys. */
const STRUCTURAL = new Set([
  'sk', 'id', 'pk', 'name', 'enabled', 'customId', 'customRendering', 'clickEvent', 'instances', 'instanceIds',
  'position', 'rotation', 'scale', 'parent', 'withCollisions', 'elementId', 'configId', 'entity', 'services',
  'defaultClickEvent',
])

export function propertiesOf(data: Record<string, unknown>) {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) if (!STRUCTURAL.has(k) && v !== undefined) out[k] = v
  return out
}

/** Grant holders may only use live-scene controls during the live window. */
function liveScope(access: SceneAccess, scope: SceneScope): GuardResult {
  if (!hasScope(access, scope)) return FORBIDDEN
  if (access.level === 'grant' && access.booking?.window !== 'live') return FORBIDDEN
  return OK_BROADCAST
}

const OPEN = new Set([
  'scene_sound_locator', 'session_start', 'session_action', 'session_end', 'user_message', 'get_user_state',
  'set_user_state', 'giveaway_claim', 'request_player_position', 'send_player_position', 'path_segments_add',
])

export async function authorizeSceneMessage(access: SceneAccess, sceneId: string, type: string, message: any): Promise<GuardResult> {
  if (OPEN.has(type)) return OK_BROADCAST
  switch (type) {
    case 'scene_setting_update':
      return hasScope(access, 'scene.edit') ? OK_BROADCAST : FORBIDDEN
    case 'scene_video_update':
      return liveScope(access, 'screens')
    case 'scene_moderator_message':
    case 'scene_moderator_crash':
      return hasScope(access, 'moderation') ? OK_BROADCAST : FORBIDDEN
    case 'scene_change_preset': {
      const presetId = message?.presetId || message?.id
      const preset = presetId && (await db.query.scenePresets.findFirst({ where: eq(scenePresets.id, presetId) }))
      if (!preset || preset.sceneId !== sceneId) return NOT_FOUND
      return liveScope(access, 'presets')
    }
    case 'scene_preset_update':
      return authorizePresetUpdate(access, sceneId, message ?? {})
    default:
      return FORBIDDEN // unknown mutating types are closed by default
  }
}

async function authorizePresetUpdate(access: SceneAccess, sceneId: string, message: any): Promise<GuardResult> {
  const { action, instance, elementData, instanceData, id } = message
  if (action !== 'update' || instance) {
    // create/delete of anything, or any instance change: scene editors only
    if (!hasScope(access, 'scene.edit')) return FORBIDDEN
    if (action === 'create' && !instance) return OK_BROADCAST
    const instanceId = instance ? instanceData?.sk || instanceData?.id || id : null
    const elementId = instance ? instanceData?.elementId || elementData?.sk || elementData?.id : elementData?.sk || elementData?.id || id
    if (instanceId && action !== 'create') {
      const inst = await db.query.sceneElementInstances.findFirst({
        where: eq(sceneElementInstances.id, instanceId),
        with: { element: { with: { preset: true } } },
      })
      if (!inst || inst.element.preset.sceneId !== sceneId) return NOT_FOUND
      return { ok: true, broadcast: await isActive(sceneId, inst.element.presetId) }
    }
    if (!elementId) return NOT_FOUND
    const el = await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, elementId), with: { preset: true } })
    if (!el || el.preset.sceneId !== sceneId) return NOT_FOUND
    return { ok: true, broadcast: await isActive(sceneId, el.presetId) }
  }

  const elementId = elementData?.sk || elementData?.id || id
  if (!elementId) return NOT_FOUND
  const el = await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, elementId), with: { preset: true } })
  if (!el || el.preset.sceneId !== sceneId) return NOT_FOUND
  const data = (elementData ?? {}) as Record<string, unknown>
  const propertyKeys = elementData ? diffKeys(el.properties as Record<string, unknown> | null, propertiesOf(data)) : []
  const fieldKeys = ELEMENT_FIELDS.filter(
    (k) => data[k] !== undefined && JSON.stringify(data[k]) !== JSON.stringify((el as any)[k]),
  )
  if (!canWriteElement(access, el, { propertyKeys, fieldKeys })) return FORBIDDEN
  return { ok: true, broadcast: await isActive(sceneId, el.presetId) }
}

async function isActive(sceneId: string, presetId: string) {
  const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId), columns: { activePresetId: true } })
  return scene?.activePresetId === presetId
}
```

Note: a grant holder's update message for the clone must carry the clone's full current properties plus the change (the room replaces `properties` wholesale), which is what the HUD will send. `diffKeys` makes unchanged keys irrelevant to scope checks.

- [ ] **Step 5: Wire auth and the guard into `VLMSceneRoom.ts`**

Imports to add:

```ts
import { verifySessionToken } from '../auth/tokens.js'
import { actorFromClaims, type Actor } from '../auth/actor.js'
import { getSceneAccess, toVenueAccessMessage, type SceneAccess } from '../auth/permissions.js'
import { authorizeSceneMessage, propertiesOf, type GuardResult } from './scene-guard.js'
import { venueTopic, type VenueEvent } from '../realtime/bus.js'
import type { VenueAccessMessage } from 'vlm-shared'
```

Class fields:

```ts
  private accessCache: Map<string, { access: SceneAccess; at: number }> = new Map()
  private lastAccess: Map<string, VenueAccessMessage> = new Map()
  private onVenueEventBound = (e: VenueEvent) => this.onVenueEvent(e)
  private static ACCESS_TTL_MS = 10_000
```

Add `onAuth` (Colyseus calls it before `onJoin`; its return value becomes `client.auth`):

```ts
  async onAuth(_client: Client, options: JoinOptions): Promise<Actor> {
    return actorFromClaims(verifySessionToken(options?.sessionToken))
  }
```

Add helpers:

```ts
  private async getAccess(client: Client): Promise<SceneAccess> {
    const cached = this.accessCache.get(client.sessionId)
    if (cached && Date.now() - cached.at < VLMSceneRoom.ACCESS_TTL_MS) return cached.access
    const access = await getSceneAccess(client.auth as Actor, this.sceneId)
    this.accessCache.set(client.sessionId, { access, at: Date.now() })
    return access
  }

  /** Register a handler that runs only if the sender is authorized for this message. */
  private guarded(type: string, handler: (client: Client, message: any, result: Extract<GuardResult, { ok: true }>) => unknown) {
    this.onMessage(type, async (client: Client, message: any) => {
      try {
        const result = await authorizeSceneMessage(await this.getAccess(client), this.sceneId, type, message)
        if (!result.ok) {
          client.send('vlm_error', { code: result.code, messageType: type })
          return
        }
        await handler(client, message, result)
      } catch (err) {
        console.error(`[VLMSceneRoom] ${type} failed:`, err)
        client.send('vlm_error', { code: 'server_error', messageType: type })
      }
    })
  }

  private async sendVenueAccess(client: Client) {
    const msg = toVenueAccessMessage(await this.getAccess(client))
    const prev = this.lastAccess.get(client.sessionId)
    this.lastAccess.set(client.sessionId, msg)
    if (prev?.bookingId && !msg.bookingId) return prev
    client.send('venue_access', msg)
    return null
  }

  private async onVenueEvent(e: VenueEvent) {
    if (e.type === 'preset_changed') {
      const preset = await db.query.scenePresets.findFirst({
        where: eq(scenePresets.id, e.presetId),
        with: { elements: { with: { instances: true } } },
      })
      if (preset) this.broadcast('scene_change_preset', { scenePreset: serializePreset(preset), user: null })
      return
    }
    this.accessCache.clear()
    for (const client of this.clients) {
      const lost = await this.sendVenueAccess(client)
      if (lost) {
        const reason = e.type === 'booking_ended' && e.bookingId === lost.bookingId ? e.reason : 'revoked'
        client.send('access_revoked', { bookingId: lost.bookingId, reason })
        client.send('venue_access', this.lastAccess.get(client.sessionId))
      }
    }
  }
```

In `onCreate`, after `this.sceneId = …`, subscribe:

```ts
    if (this.sceneId) this.presence.subscribe(venueTopic(this.sceneId), this.onVenueEventBound)
```

In `onDispose`, add `if (this.sceneId) this.presence.unsubscribe(venueTopic(this.sceneId), this.onVenueEventBound)` and clear both maps. In `onLeave`, delete the client's entries from both maps.

Convert the mutating handlers from `this.onMessage(` to `this.guarded(` with these bodies:

```ts
    this.guarded('scene_preset_update', async (client, message, result) => {
      await this.persistPresetUpdate(message)
      client.send('scene_preset_update_ack', { action: message.action, id: message.elementData?.sk || message.id })
      if (!result.broadcast) return
      this.broadcast('scene_preset_update', message, { except: client })
      if (this.sceneId) {
        dispatchPlatformCallbacks(this.sceneId, {
          action: 'config_update',
          elementId: message.elementData?.sk || message.elementData?.id || message.id,
          element: message.element,
          ...this.extractCompactPayload(message),
        }).catch(() => {})
      }
    })
```

`scene_change_preset`, `scene_setting_update`, `scene_video_update`, `scene_moderator_message`, `scene_moderator_crash`: change `this.onMessage` to `this.guarded` and leave the bodies as they are (the `(client, message)` parameters still match). Remove the old `try { await this.persistPresetUpdate(message) } catch …` wrapper — `guarded` reports errors now. The remaining open handlers keep `this.onMessage`.

Replace `extractProperties`'s body with `return propertiesOf(data)` so the room and guard share one key list.

In `onJoin`, take identity from `client.auth` instead of `options.user`:

```ts
    const actor = client.auth as Actor
    const userId = actor.userId || client.sessionId
```

and after `await this.sendInitData(client)` add:

```ts
    client.send('auth_status', { authenticated: !!actor.userId && actor.verified })
    await this.sendVenueAccess(client)
```

Send `auth_status` and `venue_access` **after** init so existing clients that wait for init are unaffected.

- [ ] **Step 6: Command center room** — in `VLMCommandCenterRoom.ts`, add the same `onAuth` and, at the top of each handler that broadcasts or persists, `if (!(client.auth as Actor)?.userId || !(client.auth as Actor).verified) return client.send('vlm_error', { code: 'forbidden', messageType: '<type>' })`, where `<type>` is that handler's message name.

- [ ] **Step 7: Wire `index.ts`**

Replace the presence block and room definitions:

```ts
  const { LocalPresence } = _require('colyseus') as any
  let presence: any
  let driver: any
  if (config.useRedisPresence && config.redisUrl) {
    const { RedisPresence } = _require('@colyseus/redis-presence') as any
    const { RedisDriver } = _require('@colyseus/redis-driver') as any
    presence = new RedisPresence(config.redisUrl)
    driver = new RedisDriver(config.redisUrl)
    console.log(`[vlm-server] Redis presence enabled`)
  } else {
    presence = new LocalPresence()
    console.log(`[vlm-server] In-memory presence (single instance)`)
  }
  initBus(presence)

  const gameServer = new ColyseusServer({
    transport: new WebSocketTransport({ server: httpServer, pingInterval: 5000, pingMaxRetries: 3 }),
    presence,
    ...(driver ? { driver } : {}),
  })

  gameServer.define('vlm_scene', VLMSceneRoom).filterBy(['sceneId'])
  gameServer.define('vlm_command_center', VLMCommandCenterRoom)
```

Import `initBus` from `./realtime/bus.js`.

- [ ] **Step 8: Run tests**

Run: `pnpm test && pnpm typecheck`
Expected: all PASS.

- [ ] **Step 9: Manual smoke test with the existing test scene**

```bash
cd ~/-VLM/vlm-v2 && pnpm docker:dev && pnpm --filter vlm-server dev
```

Open the dashboard, open a scene, change a video URL: it updates live. In a private window joined as a visitor (or the DCL preview at `test-scenes/dcl-test` with `ALLOW_UNVERIFIED_PLATFORM_AUTH=false`), confirm the scene loads and the HUD's buttons produce `vlm_error` in the server log instead of changes.

- [ ] **Step 10: Commit**

```bash
git add apps/server
git commit -m "fix(ws): authenticate scene rooms and authorize every mutating message"
```

---

### Task 8: Booking lifecycle sweep (spec §5.3, §5.5)

**Files:**
- Create: `apps/server/src/venues/lifecycle.ts`, `apps/server/test/lifecycle.test.ts`
- Modify: `apps/server/src/config.ts`, `apps/server/src/index.ts`

**Interfaces:**
- Consumes: `bookings`, `venues`, `scenes`, `publishVenueEvent`, `liveWindowStart`, `liveWindowEnd`.
- Produces: `runLifecycleSweep(at?: Date): Promise<{ wentLive: string[]; ended: string[]; purgedPresets: number }>`; `startLifecycleSweep(intervalMs: number): () => void`; `config.lifecycleSweepMs: number`.

- [ ] **Step 1: Write the failing test `apps/server/test/lifecycle.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { bookings, scenes, scenePresets } from '../src/db/schema.js'
import { createVenue, createBooking, addGrant } from '../src/venues/service.js'
import { runLifecycleSweep } from '../src/venues/lifecycle.js'
import { initBus } from '../src/realtime/bus.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, createElement, tokenFor, randomWallet } from './helpers/factories.js'
import { startGameServer, joinScene } from './helpers/game-server.js'

const H = 3600_000
const M = 60_000

async function seed() {
  const admin = await createUser({ role: 'admin' })
  const { scene, preset } = await createScene(admin)
  const screen = await createElement(preset.id)
  const venue = await createVenue({ sceneId: scene.id, name: 'Caldera', slug: `c-${crypto.randomUUID()}`, rentableElementIds: [screen.id] })
  const hostWallet = randomWallet()
  const host = await createUser({ wallet: hostWallet })
  const startsAt = new Date(Date.now() + 3 * H)
  const { booking } = await createBooking({
    venueId: venue.id,
    renterWallet: hostWallet,
    title: 'Set',
    startsAt,
    endsAt: new Date(startsAt.getTime() + 2 * H),
    createdByUserId: admin.id,
  })
  return { admin, scene, preset, venue, host, booking }
}

const activePreset = async (sceneId: string) => (await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) }))!.activePresetId
const statusOf = async (id: string) => (await db.query.bookings.findFirst({ where: eq(bookings.id, id) }))!.status

describe('runLifecycleSweep', () => {
  const published: any[] = []
  beforeEach(async () => {
    await resetDb()
    published.length = 0
    initBus({ publish: (_t: string, e: unknown) => void published.push(e) })
  })

  it('does nothing before the live window', async () => {
    const s = await seed()
    const r = await runLifecycleSweep(new Date(s.booking.startsAt.getTime() - 61 * M))
    expect(r.wentLive).toEqual([])
    expect(await activePreset(s.scene.id)).toBe(s.preset.id)
  })

  it('goes live at startsAt − setupLead and swaps in the booking preset', async () => {
    const s = await seed()
    const r = await runLifecycleSweep(new Date(s.booking.startsAt.getTime() - 60 * M))
    expect(r.wentLive).toEqual([s.booking.id])
    expect(await statusOf(s.booking.id)).toBe('live')
    expect(await activePreset(s.scene.id)).toBe(s.booking.bookingPresetId)
    expect(published).toEqual(
      expect.arrayContaining([
        { type: 'preset_changed', sceneId: s.scene.id, presetId: s.booking.bookingPresetId },
        { type: 'grants_changed', sceneId: s.scene.id },
      ]),
    )
  })

  it('ends at endsAt + grace and reverts to the default preset', async () => {
    const s = await seed()
    await runLifecycleSweep(new Date(s.booking.startsAt.getTime() - 60 * M))
    published.length = 0
    const r = await runLifecycleSweep(new Date(s.booking.endsAt.getTime() + 15 * M))
    expect(r.ended).toEqual([s.booking.id])
    expect(await statusOf(s.booking.id)).toBe('ended')
    expect(await activePreset(s.scene.id)).toBe(s.preset.id)
    expect(published).toEqual(
      expect.arrayContaining([{ type: 'booking_ended', sceneId: s.scene.id, bookingId: s.booking.id, reason: 'expired' }]),
    )
  })

  it('a booking that was never swept live still ends cleanly', async () => {
    const s = await seed()
    const r = await runLifecycleSweep(new Date(s.booking.endsAt.getTime() + 20 * M))
    expect(r).toMatchObject({ wentLive: [], ended: [s.booking.id] })
    expect(await activePreset(s.scene.id)).toBe(s.preset.id)
  })

  it('is idempotent: concurrent sweeps (two servers) apply each transition once', async () => {
    const s = await seed()
    const at = new Date(s.booking.startsAt.getTime() - 30 * M)
    const [a, b] = await Promise.all([runLifecycleSweep(at), runLifecycleSweep(at)])
    expect([...a.wentLive, ...b.wentLive]).toEqual([s.booking.id])
    expect(published.filter((e) => e.type === 'preset_changed')).toHaveLength(1)
    published.length = 0
    expect(await runLifecycleSweep(at)).toMatchObject({ wentLive: [], ended: [] })
    expect(published).toEqual([])
  })

  it('deletes booking presets 30 days after the booking ends', async () => {
    const s = await seed()
    await runLifecycleSweep(new Date(s.booking.endsAt.getTime() + 15 * M))
    expect(await db.query.scenePresets.findFirst({ where: eq(scenePresets.id, s.booking.bookingPresetId!) })).toBeTruthy()
    const r = await runLifecycleSweep(new Date(s.booking.endsAt.getTime() + 31 * 24 * H))
    expect(r.purgedPresets).toBe(1)
    expect(await db.query.scenePresets.findFirst({ where: eq(scenePresets.id, s.booking.bookingPresetId!) })).toBeUndefined()
    expect((await db.query.bookings.findFirst({ where: eq(bookings.id, s.booking.id) }))!.bookingPresetId).toBeNull()
  })

  it('does not revert if the owner already switched presets away from the booking', async () => {
    const s = await seed()
    await runLifecycleSweep(new Date(s.booking.startsAt.getTime() - 60 * M))
    const other = (await createScene(s.admin, 'x')).preset // a different preset id
    await db.update(scenes).set({ activePresetId: other.id }).where(eq(scenes.id, s.scene.id))
    await runLifecycleSweep(new Date(s.booking.endsAt.getTime() + 15 * M))
    expect(await activePreset(s.scene.id)).toBe(other.id)
  })
})

describe('lifecycle reaches connected clients', () => {
  let gs: Awaited<ReturnType<typeof startGameServer>>
  beforeEach(async () => {
    await resetDb()
    gs = await startGameServer()
  })
  afterEach(() => gs.stop())

  it('crew sees the preset swap at go-live and access_revoked at the end', async () => {
    const s = await seed()
    const crewWallet = randomWallet()
    const crew = await createUser({ wallet: crewWallet })
    await addGrant({ bookingId: s.booking.id, walletAddress: crewWallet, role: 'vj', grantedByUserId: s.host.id })
    const c = await joinScene(gs.url, s.scene.id, tokenFor(crew))
    await c.waitFor('venue_access')

    await runLifecycleSweep(new Date(s.booking.startsAt.getTime() - 60 * M))
    expect((await c.waitFor('scene_change_preset')).scenePreset).toBeTruthy()

    // Real clock is still before the booking, so the grant is valid but in setup;
    // ending the booking flips status and the room must revoke.
    await runLifecycleSweep(new Date(s.booking.endsAt.getTime() + 15 * M))
    expect((await c.waitFor('access_revoked')).reason).toBe('expired')
    c.room.send('scene_video_update', { sk: 'x', isLive: true })
    expect((await c.waitFor('vlm_error')).code).toBe('forbidden')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test test/lifecycle.test.ts`
Expected: FAIL — cannot find `../src/venues/lifecycle.js`.

- [ ] **Step 3: Add the config value** in `config.ts` (near Limits):

```ts
  // How often the venue booking lifecycle sweep runs (0 disables, used in tests)
  lifecycleSweepMs: parseInt(env('LIFECYCLE_SWEEP_MS') || '5000'),
```

- [ ] **Step 4: Create `apps/server/src/venues/lifecycle.ts`**

```ts
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { bookings, scenes, venues } from '../db/schema.js'
import { publishVenueEvent } from '../realtime/bus.js'

const setupLead = sql`make_interval(mins => (${venues.rules}->>'setupLeadMinutes')::int)`
const grace = sql`make_interval(mins => (${venues.rules}->>'graceMinutes')::int)`

/**
 * Move bookings through confirmed → live → ended. Every transition is a
 * conditional UPDATE … RETURNING, so concurrent sweeps (or servers) can't
 * apply the same transition twice.
 */
export async function runLifecycleSweep(at = new Date()) {
  const wentLive: string[] = []
  const ended: string[] = []

  // ── End: confirmed or live bookings past endsAt + grace ─────────────────
  const due = await db
    .select({ booking: bookings, venue: venues })
    .from(bookings)
    .innerJoin(venues, eq(bookings.venueId, venues.id))
    .where(and(inArray(bookings.status, ['confirmed', 'live']), sql`${bookings.endsAt} + ${grace} <= ${at}`))

  for (const { booking, venue } of due) {
    const [won] = await db
      .update(bookings)
      .set({ status: 'ended', updatedAt: at })
      .where(and(eq(bookings.id, booking.id), inArray(bookings.status, ['confirmed', 'live'])))
      .returning({ id: bookings.id })
    if (!won) continue
    ended.push(booking.id)
    if (booking.bookingPresetId) {
      const reverted = await db
        .update(scenes)
        .set({ activePresetId: venue.defaultPresetId, updatedAt: at })
        .where(and(eq(scenes.id, venue.sceneId), eq(scenes.activePresetId, booking.bookingPresetId)))
        .returning({ id: scenes.id })
      if (reverted.length) await publishVenueEvent({ type: 'preset_changed', sceneId: venue.sceneId, presetId: venue.defaultPresetId })
    }
    await publishVenueEvent({ type: 'booking_ended', sceneId: venue.sceneId, bookingId: booking.id, reason: 'expired' })
  }

  // ── Go live: confirmed bookings inside the live window ─────────────────
  const starting = await db
    .select({ booking: bookings, venue: venues })
    .from(bookings)
    .innerJoin(venues, eq(bookings.venueId, venues.id))
    .where(
      and(
        eq(bookings.status, 'confirmed'),
        sql`${bookings.startsAt} - ${setupLead} <= ${at}`,
        sql`${bookings.endsAt} + ${grace} > ${at}`,
      ),
    )

  for (const { booking, venue } of starting) {
    const [won] = await db
      .update(bookings)
      .set({ status: 'live', updatedAt: at })
      .where(and(eq(bookings.id, booking.id), eq(bookings.status, 'confirmed')))
      .returning({ id: bookings.id })
    if (!won) continue
    wentLive.push(booking.id)
    if (booking.bookingPresetId) {
      await db.update(scenes).set({ activePresetId: booking.bookingPresetId, updatedAt: at }).where(eq(scenes.id, venue.sceneId))
      await publishVenueEvent({ type: 'preset_changed', sceneId: venue.sceneId, presetId: booking.bookingPresetId })
    }
    await publishVenueEvent({ type: 'grants_changed', sceneId: venue.sceneId })
  }

  // ── Purge booking presets 30 days after the booking finished ───────────
  const purged = await db.execute(sql`
    DELETE FROM scene_presets
    WHERE id IN (
      SELECT booking_preset_id FROM bookings
      WHERE status IN ('ended', 'canceled')
        AND booking_preset_id IS NOT NULL
        AND ends_at < ${at}::timestamptz - interval '30 days'
    )
    AND id NOT IN (SELECT active_preset_id FROM scenes WHERE active_preset_id IS NOT NULL)
    RETURNING id
  `)
  const purgedPresets = (purged as unknown as unknown[]).length

  return { wentLive, ended, purgedPresets }
}

export function startLifecycleSweep(intervalMs: number): () => void {
  if (intervalMs <= 0) return () => {}
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      await runLifecycleSweep()
    } catch (err) {
      console.error('[vlm-server] Lifecycle sweep failed:', err)
    } finally {
      running = false
    }
  }, intervalMs)
  return () => clearInterval(timer)
}
```

`${at}` is bound as a timestamp parameter by postgres-js; if Postgres reports `operator does not exist: timestamp with time zone <= text`, write `${at.toISOString()}::timestamptz` in each of the three comparisons.

- [ ] **Step 5: Start the sweep in `index.ts`** after `startHookCrons()`:

```ts
  startLifecycleSweep(config.lifecycleSweepMs)
  console.log(`[vlm-server] Venue lifecycle sweep every ${config.lifecycleSweepMs}ms`)
```

Import `startLifecycleSweep` from `./venues/lifecycle.js`.

- [ ] **Step 6: Make the room react to `booking_ended` for grant holders whose cached window is now gone**

`getSceneAccess` already ignores bookings whose status is `ended`, and `onVenueEvent` clears the cache on `booking_ended`, so no extra room code is needed. Run the test to confirm.

- [ ] **Step 7: Run tests and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/server
git commit -m "feat(venues): booking lifecycle sweep swaps presets at go-live and end"
```

---

### Task 9: Config, docs, and rollout checks

**Files:**
- Modify: `.env.example`, `apps/docs/src/content/docs/dashboard/in-world-hud.md`, `README.md` (Testing section)
- Create: `apps/docs/src/content/docs/dashboard/venues.md`

- [ ] **Step 1: `.env.example`** — under the Auth section add:

```
# Accept unverified Decentraland logins (local preview only). Never set in production.
# ALLOW_UNVERIFIED_PLATFORM_AUTH=false
```

and under Limits:

```
# Venue booking lifecycle sweep interval in ms (0 disables)
# LIFECYCLE_SWEEP_MS=5000
```

- [ ] **Step 2: Docs page `apps/docs/src/content/docs/dashboard/venues.md`**

```md
---
title: Venues & Bookings
description: Rent time-boxed control of a VLM scene to an organizer and their crew.
---

A **venue** is a scene whose owner lets others control parts of it for a booked time slot.

## Make a scene a venue
`POST /api/venues` with `sceneId`, `name`, `slug`, and `rentableElementIds` (the screens, posters and sounds renters may change). The scene's current active preset becomes the venue default.

## Bookings
Admins create bookings with `POST /api/venues/:venueId/bookings` (`renterWallet` or `renterUserId`, `title`, `startsAt`, `endsAt`). Each booking gets its own copy of the default preset. Overlapping bookings (including the venue's buffer) are rejected.

- **Setup window** — from booking until `setupLeadMinutes` before start: renters and crew edit the booking's copy; the live venue is untouched.
- **Live window** — until `graceMinutes` after the end: the copy is the live scene.
- At the end, the venue switches back to its default preset and access ends.

## Crew
The renter (host) adds crew by wallet with a role — `cohost`, `vj`, `lighting`, `performer`, `door` — and can toggle individual scopes. Crew don't need a VLM account; access attaches when their wallet signs in from Decentraland.
```

- [ ] **Step 3: In `in-world-hud.md`**, add a short section: "The management HUD and all scene-changing messages now require a signed-in, verified user with permission for that scene. Visitors still receive scene updates. Clients receive `auth_status`, `venue_access` and `access_revoked` messages, and `vlm_error { code, messageType }` when a message is rejected."

- [ ] **Step 4: README Testing section**

```md
## Testing

nvm use 20
pnpm docker:dev          # Postgres on :5432
pnpm --filter vlm-server test
```

- [ ] **Step 5: Production data review (manual, before deploying)**

Before deploying Task 2 to any running VLM instance, list wallet users who got `admin` from the old auto-promote bug, for the owner to review by hand:

```sql
SELECT u.id, u.display_name, u.created_at, m.identifier, m.metadata->>'verified' AS verified
FROM users u JOIN user_auth_methods m ON m.user_id = u.id AND m.type = 'wallet'
WHERE u.role = 'admin'
ORDER BY u.created_at;
```

Don't change any rows; report the list to the user.

- [ ] **Step 6: Full verification**

Run: `cd ~/-VLM/vlm-v2 && pnpm --filter vlm-shared build && pnpm --filter vlm-server test && pnpm typecheck`
Expected: all tests pass; typecheck clean across the monorepo.

- [ ] **Step 7: Commit**

```bash
git add .env.example README.md apps/docs
git commit -m "docs: venues, crew access, and room auth messages"
```
