# VLM In-World Setup and Scene Roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A land controller presses "Set up VLM here" in the in-world HUD and becomes the host of a VLM scene linked to that location's analytics; the host assigns co-host / editor / viewer roles to wallet addresses.

**Architecture:** Two new tables (`scene_roles`, `location_setups`). A signed-fetch setup API resolves the location exactly like ingest does, checks control with the existing `controls()`, and creates account + scene + setup in one transaction. `getSceneAccess` learns wallet-addressed scene roles; analytics access is driven by setups (tenure-scoped) instead of claims. The DCL adapter replaces its "pick or auto-create one of your scenes" flow with setup status → Setup card → connect; the HUD gains a Roles panel; the dashboard gains a Roles tab.

**Tech Stack:** Fastify 5, Drizzle 0.38 + Postgres, vitest (real Postgres `vlm_test`, `FakeDclDirectory`), colyseus.js, DCL SDK7 react-ecs, Next.js 15 (static export).

**Spec:** `docs/superpowers/specs/2026-10-05-vlm-in-world-setup-design.md`

## Global Constraints

- Node 20 (`export PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH`), pnpm 9; dev Postgres must be up (`docker compose -p vlm-dev -f docker-compose.dev.yml up -d postgres`).
- Server tests: `cd apps/server && npx vitest run <file>`; full suite `pnpm --filter vlm-server test`. Tests use the real `vlm_test` DB; Decentraland is always faked via `setDclDirectory(new FakeDclDirectory())`; signed fetch is mocked with `vi.mock('../src/middleware/dcl-auth.js', …)` exactly as in `test/analytics-claims-signed.test.ts`.
- No new dependencies.
- Wallet addresses are stored and compared lowercased.
- Roles: `host` (= `scenes.ownerId`, never a `scene_roles` row), `cohost`, `editor`, `viewer`.
- Co-host: everything except remove/change the host, transfer host, delete analytics data, delete the scene.
- Setup is always free: never blocked by plan scene limits.
- Host is final: only the host transfers it; a redeploy by anyone outside host+co-hosts releases the setup.
- A host sees analytics only from their setup's `started_at` (and only until `ended_at` once it ends).
- Do not change billing routes. Do not print secrets from `.env`.
- Commit after each task with the message given; end every commit message with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.

## Review Focus

1. A visitor (no control) calling `POST /api/setup` directly gets 403 and nothing is created — pinned in Task 3.
2. Two controllers pressing Setup at the same moment produce exactly one active setup — pinned in Task 3 (unique partial index + concurrent test).
3. A co-host trying to remove the host, demote themselves into host, or transfer host gets 403 — pinned in Task 4.
4. After a takeover (release + new setup), the new host's summary/sessions endpoints return none of the old tenure's sessions — pinned in Task 5.
5. A wallet-addressed role assigned before that person ever used VLM grants access the first time they sign in with that wallet (in-world platform auth or SIWE) — pinned in Task 1.

---

### Task 1: Schema and wallet-addressed scene roles in `getSceneAccess`

**Files:**
- Modify: `apps/server/src/db/schema.ts` (append after `accessGrants`)
- Modify: `apps/server/src/auth/permissions.ts` (`getSceneAccess`, `isFullAccess`, `linkWalletGrants`, `AccessLevel`)
- Create: `apps/server/src/auth/scene-roles.ts`
- Test: `apps/server/test/scene-roles-access.test.ts`

**Interfaces:**
- Produces: tables `sceneRoles`, `locationSetups` (Drizzle), enum `sceneRoleEnum` (`cohost|editor|viewer`), enum `setupEndReasonEnum` (`redeployed|deleted`).
- Produces: `AccessLevel` gains `'cohost'`; `isFullAccess(access)` is true for `admin|owner|org|cohost`; new `isHostAccess(access)` true for `admin|owner` only.
- Produces: `sceneRoleFor(sceneId: string, actor: Actor): Promise<'cohost'|'editor'|'viewer'|null>` in `auth/scene-roles.ts`.
- Produces: new scopes `'analytics.view' | 'roles.manage'` added to `SceneScope`.

- [ ] **Step 1: Add the tables to `schema.ts`** (append after the `accessGrants` table; `pgEnum`, `uniqueIndex`, `index`, `sql` are already imported there):

```ts
export const sceneRoleEnum = pgEnum('scene_role', ['cohost', 'editor', 'viewer'])
export const setupEndReasonEnum = pgEnum('setup_end_reason', ['redeployed', 'deleted'])

/** Permanent per-scene roles, addressed to a wallet (attached to a user once that wallet signs in). The host is scenes.ownerId, never a row here. */
export const sceneRoles = pgTable(
  'scene_roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sceneId: uuid('scene_id').notNull().references(() => scenes.id, { onDelete: 'cascade' }),
    walletAddress: text('wallet_address').notNull(), // lowercased
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    role: sceneRoleEnum('role').notNull(),
    grantedByUserId: uuid('granted_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    activeWallet: uniqueIndex('scene_roles_active_wallet_uq').on(t.sceneId, t.walletAddress).where(sql`${t.revokedAt} IS NULL`),
    byWallet: index('scene_roles_wallet_idx').on(t.walletAddress),
    byUser: index('scene_roles_user_idx').on(t.userId),
  }),
)

/** One tenure of a location being set up in VLM. At most one active (ended_at IS NULL) per location. */
export const locationSetups = pgTable(
  'location_setups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    analyticsSceneId: uuid('analytics_scene_id').notNull().references(() => analyticsScenes.id, { onDelete: 'cascade' }),
    vlmSceneId: uuid('vlm_scene_id').notNull().references(() => scenes.id, { onDelete: 'cascade' }),
    hostUserId: uuid('host_user_id').references(() => users.id, { onDelete: 'set null' }),
    deploymentEntityId: text('deployment_entity_id'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endReason: setupEndReasonEnum('end_reason'),
  },
  (t) => ({
    oneActive: uniqueIndex('location_setups_one_active_uq').on(t.analyticsSceneId).where(sql`${t.endedAt} IS NULL`),
    byScene: index('location_setups_vlm_scene_idx').on(t.vlmSceneId),
  }),
)
```

- [ ] **Step 2: Write the failing access test** `apps/server/test/scene-roles-access.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { sceneRoles } from '../src/db/schema.js'
import { getSceneAccess, isFullAccess, isHostAccess, hasScope } from '../src/auth/permissions.js'
import { linkWalletGrants } from '../src/auth/permissions.js'
import { actorFromClaims } from '../src/auth/actor.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, randomWallet } from './helpers/factories.js'

const actorOf = (u: { id: string; role: string; wallet: string | null }) => actorFromClaims({ id: u.id, role: u.role, wallet: u.wallet, verified: true } as any)

describe('getSceneAccess with scene roles', () => {
  beforeEach(resetDb)

  it('host / cohost / editor / viewer / none', async () => {
    const host = await createUser({ wallet: randomWallet() })
    const scene = await createScene(host)
    const [co, ed, vi, none] = await Promise.all([1, 2, 3, 4].map(() => createUser({ wallet: randomWallet() })))
    await db.insert(sceneRoles).values([
      { sceneId: scene.id, walletAddress: co.wallet!, role: 'cohost' },
      { sceneId: scene.id, walletAddress: ed.wallet!, role: 'editor' },
      { sceneId: scene.id, walletAddress: vi.wallet!, role: 'viewer' },
    ])
    const h = await getSceneAccess(actorOf(host), scene.id)
    expect(isHostAccess(h)).toBe(true)
    const c = await getSceneAccess(actorOf(co), scene.id)
    expect(c.level).toBe('cohost')
    expect(isFullAccess(c)).toBe(true)
    expect(isHostAccess(c)).toBe(false)
    expect(hasScope(c, 'roles.manage')).toBe(true)
    const e = await getSceneAccess(actorOf(ed), scene.id)
    expect(e.level).toBe('editor')
    expect(hasScope(e, 'scene.edit')).toBe(true)
    expect(hasScope(e, 'analytics.view')).toBe(true)
    expect(hasScope(e, 'roles.manage')).toBe(false)
    const v = await getSceneAccess(actorOf(vi), scene.id)
    expect(v.level).toBe('viewer')
    expect([...v.scopes]).toEqual(['analytics.view'])
    expect((await getSceneAccess(actorOf(none), scene.id)).level).toBe('none')
  })

  it('a revoked role grants nothing', async () => {
    const host = await createUser()
    const scene = await createScene(host)
    const u = await createUser({ wallet: randomWallet() })
    await db.insert(sceneRoles).values({ sceneId: scene.id, walletAddress: u.wallet!, role: 'cohost', revokedAt: new Date() })
    expect((await getSceneAccess(actorOf(u), scene.id)).level).toBe('none')
  })

  it('a role assigned to a wallet before it used VLM attaches on first wallet sign-in', async () => {
    const host = await createUser()
    const scene = await createScene(host)
    const wallet = randomWallet()
    await db.insert(sceneRoles).values({ sceneId: scene.id, walletAddress: wallet, role: 'editor' })
    const newcomer = await createUser({ wallet })
    await linkWalletGrants(newcomer.id, wallet)
    const row = await db.query.sceneRoles.findFirst({ where: eq(sceneRoles.walletAddress, wallet) })
    expect(row!.userId).toBe(newcomer.id)
    // access by user id alone (e.g. an email session after linking)
    const access = await getSceneAccess(actorFromClaims({ id: newcomer.id, role: 'creator', verified: true } as any), scene.id)
    expect(access.level).toBe('editor')
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd apps/server && npx vitest run test/scene-roles-access.test.ts`
Expected: FAIL (`isHostAccess` is not exported / level `none`).

- [ ] **Step 4: Create `apps/server/src/auth/scene-roles.ts`:**

```ts
import { and, eq, isNull, or } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { sceneRoles } from '../db/schema.js'
import type { Actor } from './actor.js'

export type SceneRole = 'cohost' | 'editor' | 'viewer'

/** The actor's active scene role, matched by user id or by their verified wallet. Host is not a role (see scenes.ownerId). */
export async function sceneRoleFor(sceneId: string, actor: Actor): Promise<SceneRole | null> {
  if (!actor.userId || !actor.verified) return null
  const subject = actor.wallet
    ? or(eq(sceneRoles.userId, actor.userId), eq(sceneRoles.walletAddress, actor.wallet))
    : eq(sceneRoles.userId, actor.userId)
  const rows = await db.select({ role: sceneRoles.role }).from(sceneRoles).where(and(eq(sceneRoles.sceneId, sceneId), isNull(sceneRoles.revokedAt), subject))
  if (rows.some((r) => r.role === 'cohost')) return 'cohost'
  if (rows.some((r) => r.role === 'editor')) return 'editor'
  return rows.length ? 'viewer' : null
}
```

- [ ] **Step 5: Update `apps/server/src/auth/permissions.ts`:**

1. Change the type lines:
```ts
export type SceneScope = VenueScope | 'scene.edit' | 'scene.admin' | 'analytics.view' | 'roles.manage'
export type AccessLevel = 'admin' | 'owner' | 'org' | 'cohost' | 'editor' | 'viewer' | 'grant' | 'none'
```
2. Replace the scope constants and `full`/`isFullAccess`:
```ts
const ALL_SCOPES: SceneScope[] = [...VENUE_SCOPES, 'scene.edit', 'scene.admin', 'analytics.view', 'roles.manage']
const EDITOR_SCOPES: SceneScope[] = [...VENUE_SCOPES.filter((s) => s !== 'crew'), 'scene.edit', 'analytics.view']
const NONE: SceneAccess = { level: 'none', scopes: new Set(), booking: null }

const full = (level: 'admin' | 'owner' | 'org' | 'cohost'): SceneAccess => ({ level, scopes: new Set(ALL_SCOPES), booking: null })

/** Everything a scene allows, including role management. Co-hosts included; see isHostAccess for host-only actions. */
export function isFullAccess(access: SceneAccess) {
  return access.level === 'admin' || access.level === 'owner' || access.level === 'org' || access.level === 'cohost'
}

/** Host-only actions: transfer host, delete the scene, delete analytics data. */
export function isHostAccess(access: SceneAccess) {
  return access.level === 'admin' || access.level === 'owner'
}
```
3. In `getSceneAccess`, directly after the `collab?.role === 'editor'` line insert:
```ts
  const role = await sceneRoleFor(sceneId, actor)
  if (role === 'cohost') return full('cohost')
  if (role === 'editor') return { level: 'editor', scopes: new Set(EDITOR_SCOPES), booking: null }
```
and replace the final two lines (`if (collab) return …viewer…; return NONE`) with:
```ts
  if (collab || role === 'viewer') return { level: 'viewer', scopes: new Set<SceneScope>(['analytics.view']), booking: null }
  return NONE
```
4. Add `import { sceneRoleFor } from './scene-roles.js'` and add `sceneRoles` to the schema import.
5. In `linkWalletGrants(userId, wallet)` add, before its `return`, an update that attaches scene roles and include it in the returned count:
```ts
  const roles = await db
    .update(sceneRoles)
    .set({ userId })
    .where(and(eq(sceneRoles.walletAddress, wallet.toLowerCase()), isNull(sceneRoles.userId)))
    .returning({ id: sceneRoles.id })
```
(If `linkWalletGrants` returns a number, return `<existing count> + roles.length`.)

- [ ] **Step 6: Find callers that treated `level === 'viewer'` as "no scopes" or compare levels by string, and keep them compiling**

Run: `cd apps/server && grep -rn "level ===\|isFullAccess\|READ_LEVELS" src | grep -v test`
Expected: `routes/analytics.ts` `READ_LEVELS` — add `'cohost'` to it. Venue/room code using `isFullAccess` now also admits co-hosts (intended). Then `npx tsc --noEmit` — Expected: no errors.

- [ ] **Step 7: Push schema and run tests**

Run: `cd apps/server && npx vitest run test/scene-roles-access.test.ts` (global setup re-pushes the schema)
Expected: PASS (3 tests). Then `pnpm --filter vlm-server test` — Expected: all pass.

- [ ] **Step 8: Commit**

```bash
git add apps/server/src/db/schema.ts apps/server/src/auth/scene-roles.ts apps/server/src/auth/permissions.ts apps/server/src/routes/analytics.ts apps/server/test/scene-roles-access.test.ts
git commit -m "feat(server): wallet-addressed scene roles (cohost/editor/viewer) and location setups schema"
```

---

### Task 2: Setup domain logic — eligibility (incl. World deployers), release on redeploy, create setup

**Files:**
- Modify: `apps/server/src/analytics/dcl-directory.ts` (interface + HTTP impl: `getWorldDeployers`)
- Modify: `apps/server/test/helpers/fake-dcl.ts` (`worldDeployers` map + method)
- Modify: `apps/server/src/analytics/claims.ts` (`controls()` World branch)
- Create: `apps/server/src/setup/setups.ts`
- Test: `apps/server/test/setups.test.ts`

**Interfaces:**
- Consumes: `locationSetups`, `sceneRoles` (Task 1); `controls(scene, wallet, dir)`, `verifiedWalletsOf(userId)` from `analytics/claims.ts`; `resolveVerifiedWalletUser(wallet, displayName)` from `auth/wallet-users.ts`.
- Produces (all in `setup/setups.ts`):
  - `getActiveSetup(analyticsSceneId: string): Promise<LocationSetupRow | null>`
  - `teamWallets(vlmSceneId: string): Promise<string[]>` — host's verified wallets + active co-host wallets, lowercased
  - `currentDeployment(scene: AnalyticsSceneRow, dir?): Promise<{ entityId: string | null; deployer: string | null }>`
  - `releaseIfRedeployed(setup: LocationSetupRow, scene: AnalyticsSceneRow, dir?, now?): Promise<LocationSetupRow | null>` — returns the still-active setup or `null` if it was ended
  - `setUpLocation(scene: AnalyticsSceneRow, wallet: string, now?): Promise<{ setup: LocationSetupRow; vlmSceneId: string; userId: string }>` — throws `SetupError(409,'already_set_up')` if an active setup exists
  - `class SetupError extends Error { constructor(public status: number, public code: string) }`
  - `type LocationSetupRow = typeof locationSetups.$inferSelect`
- Produces: `DclDirectory.getWorldDeployers(name: string): Promise<string[]>`

- [ ] **Step 1: Directory additions.** In `dcl-directory.ts` add to the `DclDirectory` interface `getWorldDeployers(name: string): Promise<string[]>` and to the HTTP class:

```ts
  async getWorldDeployers(name: string): Promise<string[]> {
    const body = (await getJson(`${this.worlds}/world/${encodeURIComponent(name.toLowerCase())}/permissions`)) as
      | { permissions?: { deployment?: { type?: string; wallets?: unknown } } }
      | null
    const d = body?.permissions?.deployment
    return d?.type === 'allow-list' ? lowerList(d.wallets) : []
  }
```
In `test/helpers/fake-dcl.ts` add `worldDeployers = new Map<string, string[]>()` and
`async getWorldDeployers(name: string) { this.hit(); return this.worldDeployers.get(name.toLowerCase()) ?? [] }`.

- [ ] **Step 2: `controls()` World branch** in `analytics/claims.ts`, replace the `if (scene.kind === 'world') …` line with:

```ts
  if (scene.kind === 'world') {
    if ((await dir.getWorldOwner(scene.worldName!)) === w) return true
    return (await dir.getWorldDeployers(scene.worldName!)).includes(w)
  }
```

- [ ] **Step 3: Write the failing test** `apps/server/test/setups.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { analyticsScenes, locationSetups, sceneRoles, scenes, scenePresets } from '../src/db/schema.js'
import { setDclDirectory } from '../src/analytics/dcl-directory.js'
import { controls } from '../src/analytics/claims.js'
import { getActiveSetup, releaseIfRedeployed, setUpLocation, SetupError } from '../src/setup/setups.js'
import { resetDb } from './helpers/db.js'
import { createAnalyticsScene } from './helpers/analytics.js'
import { FakeDclDirectory } from './helpers/fake-dcl.js'
import { randomWallet } from './helpers/factories.js'

const rights = (o: Record<string, unknown> = {}) => ({ owner: null, operator: null, updateOperator: null, updateManagers: [], approvedForAll: [], ...o })

describe('setup domain', () => {
  let dir: FakeDclDirectory
  beforeEach(async () => {
    await resetDb()
    dir = new FakeDclDirectory()
    setDclDirectory(dir)
  })
  afterEach(() => setDclDirectory(null))

  it('World deployers on the allow-list control the World', async () => {
    const w = randomWallet()
    const s = await createAnalyticsScene({ locationKey: 'world:x.dcl.eth', kind: 'world', worldName: 'x.dcl.eth', parcels: [] })
    dir.worldOwners.set('x.dcl.eth', randomWallet())
    dir.worldDeployers.set('x.dcl.eth', [w])
    expect(await controls(s, w, dir)).toBe(true)
    expect(await controls(s, randomWallet(), dir)).toBe(false)
  })

  it('setUpLocation creates the user, scene (with default preset), setup and link in one go; second call is 409', async () => {
    const w = randomWallet()
    const s = await createAnalyticsScene({ locationKey: 'gc:1,1', parcels: ['1,1'], title: 'My Venue', activeEntityId: 'bafyA' })
    const r = await setUpLocation(s, w)
    const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, r.vlmSceneId) })
    expect(scene).toMatchObject({ ownerId: r.userId, name: 'My Venue' })
    expect(scene!.activePresetId).toBeTruthy()
    expect(await db.query.scenePresets.findFirst({ where: eq(scenePresets.sceneId, r.vlmSceneId) })).toBeTruthy()
    expect(r.setup).toMatchObject({ analyticsSceneId: s.id, vlmSceneId: r.vlmSceneId, hostUserId: r.userId, deploymentEntityId: 'bafyA', endedAt: null })
    expect((await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.id, s.id) }))!.vlmSceneId).toBe(r.vlmSceneId)
    await expect(setUpLocation(s, randomWallet())).rejects.toMatchObject({ status: 409, code: 'already_set_up' })
  })

  it('concurrent setUpLocation calls produce exactly one active setup', async () => {
    const s = await createAnalyticsScene({ locationKey: 'gc:2,2', parcels: ['2,2'] })
    const results = await Promise.allSettled([setUpLocation(s, randomWallet()), setUpLocation(s, randomWallet())])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(rejected.reason).toBeInstanceOf(SetupError)
    expect(await db.select().from(locationSetups)).toHaveLength(1)
  })

  it('a redeploy by the host or a co-host keeps the setup (and records the new entity)', async () => {
    const host = randomWallet()
    const co = randomWallet()
    const s = await createAnalyticsScene({ locationKey: 'gc:3,3', parcels: ['3,3'], baseParcel: '3,3', activeEntityId: 'bafyA' })
    const { setup, vlmSceneId } = await setUpLocation(s, host)
    await db.insert(sceneRoles).values({ sceneId: vlmSceneId, walletAddress: co, role: 'cohost' })
    dir.addScene({ entityId: 'bafyB', base: '3,3', parcels: ['3,3'] }, co)
    const kept = await releaseIfRedeployed(setup, s, dir)
    expect(kept).toMatchObject({ id: setup.id, deploymentEntityId: 'bafyB', endedAt: null })
  })

  it('a redeploy by anyone else ends the setup and the location can be set up again', async () => {
    const s = await createAnalyticsScene({ locationKey: 'gc:4,4', parcels: ['4,4'], baseParcel: '4,4', activeEntityId: 'bafyA' })
    const { setup } = await setUpLocation(s, randomWallet())
    dir.addScene({ entityId: 'bafyC', base: '4,4', parcels: ['4,4'] }, randomWallet())
    expect(await releaseIfRedeployed(setup, s, dir)).toBeNull()
    const ended = await db.query.locationSetups.findFirst({ where: eq(locationSetups.id, setup.id) })
    expect(ended).toMatchObject({ endReason: 'redeployed' })
    expect(ended!.endedAt).toBeInstanceOf(Date)
    expect(await getActiveSetup(s.id)).toBeNull()
    await expect(setUpLocation(s, randomWallet())).resolves.toBeTruthy()
  })

  it('same deployment entity: nothing changes and no deployer lookup is needed', async () => {
    const s = await createAnalyticsScene({ locationKey: 'gc:5,5', parcels: ['5,5'], baseParcel: '5,5', activeEntityId: 'bafyA' })
    const { setup } = await setUpLocation(s, randomWallet())
    dir.addScene({ entityId: 'bafyA', base: '5,5', parcels: ['5,5'] }, randomWallet())
    expect(await releaseIfRedeployed(setup, s, dir)).toMatchObject({ id: setup.id, endedAt: null })
  })

  it('World: a new version keeps the setup only if host/co-host is the owner or an allowed deployer', async () => {
    const host = randomWallet()
    const s = await createAnalyticsScene({ locationKey: 'world:y.dcl.eth', kind: 'world', worldName: 'y.dcl.eth', parcels: [], activeEntityId: 'bafyA' })
    const { setup } = await setUpLocation(s, host)
    dir.worlds.set('y.dcl.eth', { sceneUrns: ['urn:decentraland:entity:bafyW2?=&baseUrl=x'] })
    dir.worldOwners.set('y.dcl.eth', host)
    expect(await releaseIfRedeployed(setup, s, dir)).toMatchObject({ deploymentEntityId: 'bafyW2', endedAt: null })
    dir.worlds.set('y.dcl.eth', { sceneUrns: ['urn:decentraland:entity:bafyW3'] })
    dir.worldOwners.set('y.dcl.eth', randomWallet())
    expect(await releaseIfRedeployed((await getActiveSetup(s.id))!, s, dir)).toBeNull()
  })
})
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd apps/server && npx vitest run test/setups.test.ts`
Expected: FAIL (`Cannot find module '../src/setup/setups.js'`).

- [ ] **Step 5: Implement `apps/server/src/setup/setups.ts`:**

```ts
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { analyticsScenes, locationSetups, sceneRoles, scenePresets, scenes } from '../db/schema.js'
import { getDclDirectory, type DclDirectory } from '../analytics/dcl-directory.js'
import { verifiedWalletsOf } from '../analytics/claims.js'
import { resolveVerifiedWalletUser } from '../auth/wallet-users.js'
import type { AnalyticsSceneRow } from '../analytics/registry.js'

export type LocationSetupRow = typeof locationSetups.$inferSelect

export class SetupError extends Error {
  constructor(public status: number, public code: string) {
    super(code)
  }
}

export async function getActiveSetup(analyticsSceneId: string): Promise<LocationSetupRow | null> {
  return (await db.query.locationSetups.findFirst({ where: and(eq(locationSetups.analyticsSceneId, analyticsSceneId), isNull(locationSetups.endedAt)) })) ?? null
}

/** Host's verified wallets plus active co-hosts' wallets (lowercased). */
export async function teamWallets(vlmSceneId: string): Promise<string[]> {
  const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, vlmSceneId) })
  const host = scene ? await verifiedWalletsOf(scene.ownerId) : []
  const co = await db
    .select({ w: sceneRoles.walletAddress })
    .from(sceneRoles)
    .where(and(eq(sceneRoles.sceneId, vlmSceneId), eq(sceneRoles.role, 'cohost'), isNull(sceneRoles.revokedAt)))
  return [...new Set([...host, ...co.map((r) => r.w)].map((w) => w.toLowerCase()))]
}

const entityFromUrn = (urn: string | undefined) => urn?.match(/^urn:decentraland:entity:([^?]+)/)?.[1] ?? null

/** What is deployed at the location right now. Worlds don't expose the deployer (null). */
export async function currentDeployment(scene: AnalyticsSceneRow, dir: DclDirectory = getDclDirectory()) {
  if (scene.kind === 'world') {
    const w = await dir.getWorldScene(scene.worldName!)
    return { entityId: entityFromUrn(w?.sceneUrns?.[0]), deployer: null as string | null }
  }
  const base = scene.baseParcel ?? scene.parcels[0]
  if (!base) return { entityId: null, deployer: null }
  const active = await dir.getActiveSceneAt(base)
  if (!active) return { entityId: null, deployer: null }
  return { entityId: active.entityId, deployer: await dir.getActiveDeployer(base) }
}

/**
 * Host is final, but a new deployment by someone outside the host + co-hosts releases the location.
 * Returns the (possibly updated) active setup, or null if it ended. Unknown current deployment = keep.
 */
export async function releaseIfRedeployed(
  setup: LocationSetupRow,
  scene: AnalyticsSceneRow,
  dir: DclDirectory = getDclDirectory(),
  now = new Date(),
): Promise<LocationSetupRow | null> {
  const current = await currentDeployment(scene, dir)
  if (!current.entityId || current.entityId === setup.deploymentEntityId) return setup
  const team = await teamWallets(setup.vlmSceneId)
  let keep: boolean
  if (scene.kind === 'world') {
    const allowed = new Set([(await dir.getWorldOwner(scene.worldName!)) ?? '', ...(await dir.getWorldDeployers(scene.worldName!))])
    keep = team.some((w) => allowed.has(w))
  } else {
    keep = !!current.deployer && team.includes(current.deployer.toLowerCase())
  }
  if (keep) {
    const [row] = await db.update(locationSetups).set({ deploymentEntityId: current.entityId }).where(eq(locationSetups.id, setup.id)).returning()
    return row
  }
  await db.transaction(async (tx) => {
    await tx.update(locationSetups).set({ endedAt: now, endReason: 'redeployed' }).where(eq(locationSetups.id, setup.id))
    await tx.update(analyticsScenes).set({ vlmSceneId: null, updatedAt: now }).where(eq(analyticsScenes.id, scene.id))
  })
  return null
}

/** Create (or reuse) the wallet's user, a VLM scene with a default preset, and the active setup. Free: no plan limits. */
export async function setUpLocation(scene: AnalyticsSceneRow, wallet: string, now = new Date()) {
  const w = wallet.toLowerCase()
  if (await getActiveSetup(scene.id)) throw new SetupError(409, 'already_set_up')
  const user = await resolveVerifiedWalletUser(w, `${w.slice(0, 6)}…${w.slice(-4)}`)
  try {
    return await db.transaction(async (tx) => {
      const [created] = await tx.insert(scenes).values({ ownerId: user.id, name: scene.title || scene.locationKey }).returning()
      const [preset] = await tx.insert(scenePresets).values({ sceneId: created.id, name: 'Default' }).returning()
      await tx.update(scenes).set({ activePresetId: preset.id }).where(eq(scenes.id, created.id))
      const [setup] = await tx
        .insert(locationSetups)
        .values({ analyticsSceneId: scene.id, vlmSceneId: created.id, hostUserId: user.id, deploymentEntityId: scene.activeEntityId ?? null, startedAt: now })
        .returning()
      await tx.update(analyticsScenes).set({ vlmSceneId: created.id, updatedAt: now }).where(eq(analyticsScenes.id, scene.id))
      return { setup, vlmSceneId: created.id, userId: user.id }
    })
  } catch (err) {
    // The partial unique index (one active setup per location) loses the race for the second presser.
    if ((err as { code?: string }).code === '23505') throw new SetupError(409, 'already_set_up')
    throw err
  }
}
```

Note: if `analyticsScenes` has no `activeEntityId` column under that name, use the column the registry writes in `upsert()` (it is read as `scene.activeEntityId` in `registry.ts`).

- [ ] **Step 6: Run tests**

Run: `cd apps/server && npx vitest run test/setups.test.ts test/analytics-claims.test.ts test/analytics-claims-signed.test.ts`
Expected: PASS. (If the concurrency test reports the error wrapped by drizzle, read `err.cause?.code` as well as `err.code`.)

- [ ] **Step 7: Commit**

```bash
git add apps/server/src/analytics/dcl-directory.ts apps/server/src/analytics/claims.ts apps/server/src/setup/setups.ts apps/server/test/helpers/fake-dcl.ts apps/server/test/setups.test.ts
git commit -m "feat(server): location setup domain — World deployers, release on redeploy, one-press setup"
```

---

### Task 3: Signed setup API — `POST /api/setup/status` and `POST /api/setup`

**Files:**
- Create: `apps/server/src/routes/setup.ts`
- Modify: `apps/server/src/app.ts` (register next to `analyticsClaimSignedRoutes`)
- Test: `apps/server/test/setup-routes.test.ts`

**Interfaces:**
- Consumes: `resolveAnalyticsScene(ref, signer)` (`analytics/registry.ts`), `controls`, `getActiveSetup`, `releaseIfRedeployed`, `setUpLocation`, `SetupError`, `sceneRoleFor`, `verifiedWalletsOf`, `verifyDclSignedFetch`/`hasDclAuthHeaders` (`middleware/dcl-auth.ts`), `TokenBucketLimiter`/`checkRequesterLimits` (same usage as `analytics-claims.ts`).
- Produces HTTP:
  - `POST /api/setup/status` body `{ scene: AnalyticsSceneRef }` → `200 { state: 'eligible' } | { state: 'member', sceneId, role: 'host'|'cohost'|'editor'|'viewer' } | { state: 'taken', host: string /* 0x12ab…cdef */ } | { state: 'none' } | { state: 'unavailable' }`
  - `POST /api/setup` body `{ scene: AnalyticsSceneRef }` → `200 { sceneId }`; `401` unsigned/bad signature; `403 { error: 'not_eligible' }`; `409 { error: 'already_set_up', host }`; `503 { error: 'upstream_unavailable', retryAfter: 30 }`; `422` unknown scene (from resolver).

- [ ] **Step 1: Write the failing test** `apps/server/test/setup-routes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { count } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { locationSetups, sceneRoles, scenes, users } from '../src/db/schema.js'
import { setDclDirectory } from '../src/analytics/dcl-directory.js'
import { clearRegistryCache } from '../src/analytics/registry.js'
import { setSetupLimiter } from '../src/routes/setup.js'
import { TokenBucketLimiter } from '../src/analytics/limiter.js'
import { resetDb } from './helpers/db.js'
import { testApp } from './helpers/factories.js'
import { FakeDclDirectory } from './helpers/fake-dcl.js'

vi.mock('../src/middleware/dcl-auth.js', () => ({
  hasDclAuthHeaders: (h: Record<string, unknown>) => !!h['x-identity-auth-chain-0'],
  verifyDclSignedFetch: async (_m: string, _p: string, h: Record<string, string>) => {
    const v = h['x-identity-auth-chain-0']
    if (typeof v === 'string' && v.startsWith('valid:')) return { walletAddress: v.slice(6), metadata: {} }
    throw new Error('bad signature')
  },
}))

const OWNER = '0x00000000000000000000000000000000000000aa'
const OP = '0x00000000000000000000000000000000000000bb'
const VISITOR = '0x00000000000000000000000000000000000000cc'
const signed = (w: string) => ({ 'x-identity-auth-chain-0': `valid:${w}` })
const rights = (o: Record<string, unknown> = {}) => ({ owner: null, operator: null, updateOperator: null, updateManagers: [], approvedForAll: [], ...o })
const REF = { realm: 'main', isWorld: false, isPreview: false, baseParcel: '1,1', parcels: ['1,1'], entityId: 'bafyA', title: 'Venue' }

describe('setup routes', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  let dir: FakeDclDirectory
  beforeEach(async () => {
    await resetDb()
    clearRegistryCache()
    app = await testApp()
    dir = new FakeDclDirectory()
    dir.addScene({ entityId: 'bafyA', base: '1,1', parcels: ['1,1'], title: 'Venue' }, OWNER)
    dir.rights.set('1,1', rights({ owner: OWNER, operator: OP }))
    setDclDirectory(dir)
    setSetupLimiter(new TokenBucketLimiter())
  })
  afterEach(async () => {
    setDclDirectory(null)
    await app.close()
  })
  const status = (w: string | null) =>
    app.inject({ method: 'POST', url: '/api/setup/status', payload: { scene: REF }, headers: w ? signed(w) : {} })
  const setup = (w: string | null) => app.inject({ method: 'POST', url: '/api/setup', payload: { scene: REF }, headers: w ? signed(w) : {} })

  it('controller sees eligible; visitor sees none; unsigned sees none', async () => {
    expect((await status(OWNER)).json()).toEqual({ state: 'eligible' })
    expect((await status(VISITOR)).json()).toEqual({ state: 'none' })
    expect((await status(null)).json()).toEqual({ state: 'none' })
  })

  it('a visitor calling setup directly is rejected and nothing is created', async () => {
    const res = await setup(VISITOR)
    expect(res.statusCode).toBe(403)
    expect((await db.select({ n: count() }).from(scenes))[0].n).toBe(0)
    expect((await db.select({ n: count() }).from(users))[0].n).toBe(0)
    expect((await setup(null)).statusCode).toBe(401)
  })

  it('operator presses setup → becomes host; owner then sees taken; host sees member/host', async () => {
    const res = await setup(OP)
    expect(res.statusCode).toBe(200)
    const { sceneId } = res.json()
    expect((await status(OP)).json()).toEqual({ state: 'member', sceneId, role: 'host' })
    expect((await status(OWNER)).json()).toEqual({ state: 'taken', host: '0x0000…00bb' })
    expect((await setup(OWNER)).statusCode).toBe(409)
  })

  it('a wallet with a scene role sees member with that role', async () => {
    const { sceneId } = (await setup(OWNER)).json()
    await db.insert(sceneRoles).values({ sceneId, walletAddress: VISITOR, role: 'editor' })
    expect((await status(VISITOR)).json()).toEqual({ state: 'member', sceneId, role: 'editor' })
  })

  it('two controllers pressing at once → exactly one setup', async () => {
    const [a, b] = await Promise.all([setup(OWNER), setup(OP)])
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409])
    expect(await db.select().from(locationSetups)).toHaveLength(1)
  })

  it('Decentraland down → 503 and nothing created', async () => {
    dir.down = true
    const res = await setup(OWNER)
    expect(res.statusCode).toBe(503)
    expect((await status(OWNER)).json()).toEqual({ state: 'unavailable' })
    expect(await db.select().from(locationSetups)).toHaveLength(0)
  })

  it('after a foreign redeploy the location is offered again', async () => {
    await setup(OP)
    dir.addScene({ entityId: 'bafyNEW', base: '1,1', parcels: ['1,1'], title: 'Venue' }, OWNER)
    clearRegistryCache()
    expect((await status(OWNER)).json()).toEqual({ state: 'eligible' })
    expect((await setup(OWNER)).statusCode).toBe(200)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/server && npx vitest run test/setup-routes.test.ts`
Expected: FAIL (`Cannot find module '../src/routes/setup.js'`).

- [ ] **Step 3: Implement `apps/server/src/routes/setup.ts`:**

```ts
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { validateSceneRef, type AnalyticsSceneRef } from 'vlm-shared'
import { db } from '../db/connection.js'
import { scenes } from '../db/schema.js'
import { hasDclAuthHeaders, verifyDclSignedFetch } from '../middleware/dcl-auth.js'
import { resolveAnalyticsScene } from '../analytics/registry.js'
import { DirectoryUnavailableError } from '../analytics/dcl-directory.js'
import { controls, verifiedWalletsOf } from '../analytics/claims.js'
import { TokenBucketLimiter, checkRequesterLimits } from '../analytics/limiter.js'
import { getActiveSetup, releaseIfRedeployed, setUpLocation, SetupError } from '../setup/setups.js'
import { sceneRoleFor } from '../auth/scene-roles.js'
import { actorFromClaims } from '../auth/actor.js'

let limiter = new TokenBucketLimiter()
/** Test hook. */
export function setSetupLimiter(l: TokenBucketLimiter): void {
  limiter = l
}

const short = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`

async function signer(request: FastifyRequest): Promise<string | null> {
  const headers = request.headers as Record<string, string | string[] | undefined>
  if (!hasDclAuthHeaders(headers)) return null
  try {
    return (await verifyDclSignedFetch(request.method, request.url.split('?')[0], headers)).walletAddress.toLowerCase()
  } catch {
    return null
  }
}

/** Location + (possibly released) active setup for a signed request. Throws DirectoryUnavailableError upstream. */
async function locate(ref: AnalyticsSceneRef, wallet: string) {
  const resolved = await resolveAnalyticsScene(ref, wallet)
  if (!resolved.ok) return { resolved, scene: null, setup: null }
  const scene = resolved.scene
  let setup = await getActiveSetup(scene.id)
  if (setup) setup = await releaseIfRedeployed(setup, scene)
  return { resolved, scene, setup }
}

async function roleOf(sceneId: string, wallet: string): Promise<'host' | 'cohost' | 'editor' | 'viewer' | null> {
  const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) })
  if (scene && (await verifiedWalletsOf(scene.ownerId)).includes(wallet)) return 'host'
  // Wallet-only actor (no user id needed for the wallet match).
  return sceneRoleFor(sceneId, actorFromClaims({ id: 'wallet-only', role: 'viewer', wallet, verified: true } as any))
}

async function hostShort(sceneId: string): Promise<string> {
  const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId) })
  const w = scene ? (await verifiedWalletsOf(scene.ownerId))[0] : undefined
  return w ? short(w) : 'someone else'
}

/** Signed-fetch routes (no JWT): the in-world HUD asks what to show, and sets the location up. */
export default async function setupRoutes(app: FastifyInstance) {
  app.post<{ Body: { scene?: unknown } }>('/api/setup/status', async (request, reply) => {
    const ref = validateSceneRef(request.body?.scene)
    const wallet = await signer(request)
    if (!ref || !wallet) return reply.send({ state: 'none' })
    if (!checkRequesterLimits(limiter, { requesterKey: `w:${wallet}`, verified: true, eventCount: 1 }).ok) {
      return reply.status(429).send({ error: 'rate_limited' })
    }
    try {
      const { scene, setup } = await locate(ref, wallet)
      if (!scene) return reply.send({ state: 'none' })
      if (setup) {
        const role = await roleOf(setup.vlmSceneId, wallet)
        if (role) return reply.send({ state: 'member', sceneId: setup.vlmSceneId, role })
        return reply.send((await controls(scene, wallet)) ? { state: 'taken', host: await hostShort(setup.vlmSceneId) } : { state: 'none' })
      }
      return reply.send({ state: (await controls(scene, wallet)) ? 'eligible' : 'none' })
    } catch (err) {
      if (err instanceof DirectoryUnavailableError) return reply.send({ state: 'unavailable' })
      throw err
    }
  })

  app.post<{ Body: { scene?: unknown } }>('/api/setup', async (request, reply) => {
    const wallet = await signer(request)
    if (!wallet) return reply.status(401).send({ error: 'signed_request_required' })
    const ref = validateSceneRef(request.body?.scene)
    if (!ref) return reply.status(400).send({ error: 'scene is required' })
    if (!checkRequesterLimits(limiter, { requesterKey: `w:${wallet}`, verified: true, eventCount: 1 }).ok) {
      return reply.status(429).send({ error: 'rate_limited' })
    }
    try {
      const { resolved, scene, setup } = await locate(ref, wallet)
      if (!scene) return reply.status((resolved as { status: number }).status).send({ error: (resolved as { error: string }).error })
      if (setup) return reply.status(409).send({ error: 'already_set_up', host: await hostShort(setup.vlmSceneId) })
      if (!(await controls(scene, wallet))) return reply.status(403).send({ error: 'not_eligible' })
      const created = await setUpLocation(scene, wallet)
      return reply.send({ sceneId: created.vlmSceneId })
    } catch (err) {
      if (err instanceof DirectoryUnavailableError) return reply.status(503).send({ error: 'upstream_unavailable', retryAfter: 30 })
      if (err instanceof SetupError) {
        const active = await getActiveSetup((await resolveAnalyticsScene(ref, wallet).then((r) => (r.ok ? r.scene.id : ''))) || '')
        return reply.status(err.status).send({ error: err.code, host: active ? await hostShort(active.vlmSceneId) : undefined })
      }
      throw err
    }
  })
}
```

Notes for the implementer:
- `validateSceneRef` — use whatever `vlm-shared` exports to validate an `AnalyticsSceneRef` for ingest (search `packages/vlm-shared/src/analytics.ts` for the function `ingest.ts` uses on `batch.scene`). If ingest validates the whole batch only, add `export function validateSceneRef(v: unknown): AnalyticsSceneRef | null` to `vlm-shared/src/analytics.ts` built from that same logic, and export it from the package index.
- `resolveAnalyticsScene` returns 503/422 results rather than throwing; map `status === 503` to `{ state: 'unavailable' }` in status and `503` in setup (add that branch where `scene` is null).
- The `roleOf` wallet-only actor: `sceneRoleFor` filters by `userId = 'wallet-only'` OR wallet; since `'wallet-only'` is not a uuid, change `sceneRoleFor` to skip the user-id clause when `actor.userId` is not a uuid **or** add an optional third parameter `opts: { walletOnly?: boolean }`. Pick the parameter (clearer), and update the call here to `sceneRoleFor(sceneId, actor, { walletOnly: true })`.

- [ ] **Step 4: Register** in `app.ts` right after `await app.register(analyticsClaimSignedRoutes)`: `await app.register(setupRoutes)` (import `setupRoutes from './routes/setup.js'`).

- [ ] **Step 5: Run tests**

Run: `cd apps/server && npx vitest run test/setup-routes.test.ts test/setups.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/setup.ts apps/server/src/app.ts apps/server/src/auth/scene-roles.ts apps/server/test/setup-routes.test.ts packages/vlm-shared/src
git commit -m "feat(server): signed in-world setup API (status + one-press setup)"
```

---

### Task 4: Roles API — list, add, remove, transfer host

**Files:**
- Create: `apps/server/src/routes/scene-roles.ts`
- Modify: `apps/server/src/app.ts` (register after `sceneRoutes`)
- Test: `apps/server/test/scene-roles-routes.test.ts`

**Interfaces:**
- Consumes: `getSceneAccess`, `isFullAccess`, `isHostAccess` (Task 1), `verifiedWalletsOf`, `authenticate` middleware, `actorFromClaims`.
- Produces HTTP (JWT, `authenticate`):
  - `GET /api/scenes/:sceneId/roles` (full access) → `{ host: { userId, displayName, wallets: string[] }, roles: { wallet, role, userId, displayName|null, createdAt }[] }`
  - `POST /api/scenes/:sceneId/roles` `{ wallet, role: 'cohost'|'editor'|'viewer' }` (full access) → `201 { role }`; existing active row for that wallet is updated in place; `400` bad wallet/role; `409 { error: 'is_host' }` if the wallet is the host's
  - `DELETE /api/scenes/:sceneId/roles/:wallet` (full access) → `204`; `403` if the wallet is the host's
  - `POST /api/scenes/:sceneId/transfer-host` `{ wallet }` (host only) → `200 { host: userId }`; target must be an active co-host whose row has a `userId` (`409 { error: 'not_a_signed_in_cohost' }`); previous host gets an active `cohost` row for their first verified wallet

- [ ] **Step 1: Write the failing test** `apps/server/test/scene-roles-routes.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { sceneRoles, scenes } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor, randomWallet } from './helpers/factories.js'

describe('scene roles API', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(() => app.close())
  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, token: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as any, headers: { authorization: `Bearer ${token}` } })

  it('host adds, lists, changes and removes roles', async () => {
    const host = await createUser({ wallet: randomWallet() })
    const scene = await createScene(host)
    const w = randomWallet()
    expect((await call('POST', `/api/scenes/${scene.id}/roles`, tokenFor(host), { wallet: w.toUpperCase().replace('0X', '0x'), role: 'editor' })).statusCode).toBe(201)
    expect((await call('POST', `/api/scenes/${scene.id}/roles`, tokenFor(host), { wallet: w, role: 'cohost' })).statusCode).toBe(201)
    const list = (await call('GET', `/api/scenes/${scene.id}/roles`, tokenFor(host))).json()
    expect(list.host.wallets).toEqual([host.wallet])
    expect(list.roles).toMatchObject([{ wallet: w, role: 'cohost' }])
    expect((await call('DELETE', `/api/scenes/${scene.id}/roles/${w}`, tokenFor(host))).statusCode).toBe(204)
    expect((await call('GET', `/api/scenes/${scene.id}/roles`, tokenFor(host))).json().roles).toEqual([])
  })

  it('rejects bad input and the host wallet as a role target', async () => {
    const host = await createUser({ wallet: randomWallet() })
    const scene = await createScene(host)
    expect((await call('POST', `/api/scenes/${scene.id}/roles`, tokenFor(host), { wallet: 'nope', role: 'editor' })).statusCode).toBe(400)
    expect((await call('POST', `/api/scenes/${scene.id}/roles`, tokenFor(host), { wallet: randomWallet(), role: 'host' })).statusCode).toBe(400)
    expect((await call('POST', `/api/scenes/${scene.id}/roles`, tokenFor(host), { wallet: host.wallet, role: 'viewer' })).statusCode).toBe(409)
  })

  it('a co-host manages roles but cannot remove the host or transfer host', async () => {
    const host = await createUser({ wallet: randomWallet() })
    const scene = await createScene(host)
    const co = await createUser({ wallet: randomWallet() })
    await db.insert(sceneRoles).values({ sceneId: scene.id, walletAddress: co.wallet!, userId: co.id, role: 'cohost' })
    expect((await call('POST', `/api/scenes/${scene.id}/roles`, tokenFor(co), { wallet: randomWallet(), role: 'viewer' })).statusCode).toBe(201)
    expect((await call('DELETE', `/api/scenes/${scene.id}/roles/${host.wallet}`, tokenFor(co))).statusCode).toBe(403)
    expect((await call('POST', `/api/scenes/${scene.id}/transfer-host`, tokenFor(co), { wallet: co.wallet })).statusCode).toBe(403)
    expect((await db.query.scenes.findFirst({ where: eq(scenes.id, scene.id) }))!.ownerId).toBe(host.id)
  })

  it('editors and strangers cannot manage roles', async () => {
    const host = await createUser({ wallet: randomWallet() })
    const scene = await createScene(host)
    const ed = await createUser({ wallet: randomWallet() })
    await db.insert(sceneRoles).values({ sceneId: scene.id, walletAddress: ed.wallet!, userId: ed.id, role: 'editor' })
    const stranger = await createUser({ wallet: randomWallet() })
    for (const u of [ed, stranger]) {
      expect((await call('GET', `/api/scenes/${scene.id}/roles`, tokenFor(u))).statusCode).toBe(403)
      expect((await call('POST', `/api/scenes/${scene.id}/roles`, tokenFor(u), { wallet: randomWallet(), role: 'viewer' })).statusCode).toBe(403)
    }
  })

  it('host transfers to a signed-in co-host; previous host becomes co-host', async () => {
    const host = await createUser({ wallet: randomWallet() })
    const scene = await createScene(host)
    const co = await createUser({ wallet: randomWallet() })
    const pending = randomWallet()
    await db.insert(sceneRoles).values([
      { sceneId: scene.id, walletAddress: co.wallet!, userId: co.id, role: 'cohost' },
      { sceneId: scene.id, walletAddress: pending, role: 'cohost' },
    ])
    expect((await call('POST', `/api/scenes/${scene.id}/transfer-host`, tokenFor(host), { wallet: pending })).json()).toEqual({ error: 'not_a_signed_in_cohost' })
    const res = await call('POST', `/api/scenes/${scene.id}/transfer-host`, tokenFor(host), { wallet: co.wallet })
    expect(res.statusCode).toBe(200)
    expect((await db.query.scenes.findFirst({ where: eq(scenes.id, scene.id) }))!.ownerId).toBe(co.id)
    const rows = await db.select().from(sceneRoles).where(and(eq(sceneRoles.sceneId, scene.id), isNull(sceneRoles.revokedAt)))
    expect(rows.find((r) => r.walletAddress === co.wallet)).toBeUndefined()
    expect(rows.find((r) => r.walletAddress === host.wallet)).toMatchObject({ role: 'cohost', userId: host.id })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd apps/server && npx vitest run test/scene-roles-routes.test.ts`
Expected: FAIL (404s).

- [ ] **Step 3: Implement `apps/server/src/routes/scene-roles.ts`:**

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { sceneRoles, scenes, users } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess, isFullAccess, isHostAccess } from '../auth/permissions.js'
import { verifiedWalletsOf } from '../analytics/claims.js'

const WALLET_RE = /^0x[0-9a-f]{40}$/
const ROLES = new Set(['cohost', 'editor', 'viewer'])

export default async function sceneRoleRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  async function guard(request: FastifyRequest<{ Params: { sceneId: string } }>, reply: FastifyReply, hostOnly = false) {
    const access = await getSceneAccess(actorFromClaims(request.user), request.params.sceneId)
    if (!(hostOnly ? isHostAccess(access) : isFullAccess(access))) {
      reply.status(403).send({ error: 'Forbidden' })
      return null
    }
    const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, request.params.sceneId) })
    if (!scene) {
      reply.status(404).send({ error: 'Not found' })
      return null
    }
    return scene
  }

  const activeRow = (sceneId: string, wallet: string) =>
    db.query.sceneRoles.findFirst({ where: and(eq(sceneRoles.sceneId, sceneId), eq(sceneRoles.walletAddress, wallet), isNull(sceneRoles.revokedAt)) })

  app.get<{ Params: { sceneId: string } }>('/api/scenes/:sceneId/roles', async (request, reply) => {
    const scene = await guard(request, reply)
    if (!scene) return
    const owner = await db.query.users.findFirst({ where: eq(users.id, scene.ownerId) })
    const rows = await db
      .select({ wallet: sceneRoles.walletAddress, role: sceneRoles.role, userId: sceneRoles.userId, displayName: users.displayName, createdAt: sceneRoles.createdAt })
      .from(sceneRoles)
      .leftJoin(users, eq(users.id, sceneRoles.userId))
      .where(and(eq(sceneRoles.sceneId, scene.id), isNull(sceneRoles.revokedAt)))
      .orderBy(sceneRoles.createdAt)
    return reply.send({
      host: { userId: scene.ownerId, displayName: owner?.displayName ?? null, wallets: await verifiedWalletsOf(scene.ownerId) },
      roles: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    })
  })

  app.post<{ Params: { sceneId: string }; Body: { wallet?: string; role?: string } }>('/api/scenes/:sceneId/roles', async (request, reply) => {
    const scene = await guard(request, reply)
    if (!scene) return
    const wallet = request.body?.wallet?.toLowerCase() ?? ''
    const role = request.body?.role ?? ''
    if (!WALLET_RE.test(wallet) || !ROLES.has(role)) return reply.status(400).send({ error: 'wallet (0x…) and role (cohost, editor or viewer) are required' })
    if ((await verifiedWalletsOf(scene.ownerId)).includes(wallet)) return reply.status(409).send({ error: 'is_host' })
    const existing = await activeRow(scene.id, wallet)
    const linked = await db.query.userAuthMethods.findFirst({ where: (m, { and, eq }) => and(eq(m.type, 'wallet'), eq(m.identifier, wallet)) })
    const userId = linked && (linked.metadata as { verified?: boolean } | null)?.verified ? linked.userId : null
    const [row] = existing
      ? await db.update(sceneRoles).set({ role: role as 'cohost', userId: existing.userId ?? userId }).where(eq(sceneRoles.id, existing.id)).returning()
      : await db.insert(sceneRoles).values({ sceneId: scene.id, walletAddress: wallet, role: role as 'cohost', userId, grantedByUserId: request.user.id }).returning()
    return reply.status(201).send({ role: { wallet: row.walletAddress, role: row.role, userId: row.userId } })
  })

  app.delete<{ Params: { sceneId: string; wallet: string } }>('/api/scenes/:sceneId/roles/:wallet', async (request, reply) => {
    const scene = await guard(request, reply)
    if (!scene) return
    const wallet = request.params.wallet.toLowerCase()
    if ((await verifiedWalletsOf(scene.ownerId)).includes(wallet)) return reply.status(403).send({ error: 'The host cannot be removed' })
    await db.update(sceneRoles).set({ revokedAt: new Date() }).where(and(eq(sceneRoles.sceneId, scene.id), eq(sceneRoles.walletAddress, wallet), isNull(sceneRoles.revokedAt)))
    return reply.status(204).send()
  })

  app.post<{ Params: { sceneId: string }; Body: { wallet?: string } }>('/api/scenes/:sceneId/transfer-host', async (request, reply) => {
    const scene = await guard(request, reply, true)
    if (!scene) return
    const wallet = request.body?.wallet?.toLowerCase() ?? ''
    const target = WALLET_RE.test(wallet) ? await activeRow(scene.id, wallet) : undefined
    if (!target || target.role !== 'cohost' || !target.userId) return reply.status(409).send({ error: 'not_a_signed_in_cohost' })
    const previousWallet = (await verifiedWalletsOf(scene.ownerId))[0]
    const now = new Date()
    await db.transaction(async (tx) => {
      await tx.update(scenes).set({ ownerId: target.userId!, updatedAt: now }).where(eq(scenes.id, scene.id))
      await tx.update(sceneRoles).set({ revokedAt: now }).where(eq(sceneRoles.id, target.id))
      if (previousWallet) {
        await tx.update(sceneRoles).set({ revokedAt: now }).where(and(eq(sceneRoles.sceneId, scene.id), eq(sceneRoles.walletAddress, previousWallet), isNull(sceneRoles.revokedAt)))
        await tx.insert(sceneRoles).values({ sceneId: scene.id, walletAddress: previousWallet, userId: scene.ownerId, role: 'cohost', grantedByUserId: scene.ownerId })
      }
    })
    return reply.send({ host: target.userId })
  })
}
```
(If `scenes` has no `updatedAt`, drop that key.)

- [ ] **Step 4: Register** in `app.ts` after `await app.register(sceneRoutes)`: `await app.register(sceneRoleRoutes)` (import from `./routes/scene-roles.js`).

- [ ] **Step 5: Run tests**

Run: `cd apps/server && npx vitest run test/scene-roles-routes.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/routes/scene-roles.ts apps/server/src/app.ts apps/server/test/scene-roles-routes.test.ts
git commit -m "feat(server): scene roles API — list, assign, remove, transfer host"
```

---

### Task 5: Analytics access by setup tenure; retire claims

**Files:**
- Modify: `apps/server/src/analytics/access.ts` (rewrite)
- Modify: `apps/server/src/routes/analytics-read.ts` (`caps`, `guard`, `/locations`, endpoints that use `caps`/`until`)
- Modify: `apps/server/src/routes/analytics.ts` (`locate`)
- Modify: `apps/server/src/analytics/jobs.ts` (`retentionDaysFor`, remove `claim-reverify` registration)
- Modify: `apps/server/src/analytics/claims.ts` (delete `claimScene`, `ClaimError`, `reverifyClaims`, `controlsAny` if unused; keep `controls`, `verifiedWalletsOf`, `purgeWalletChallenges`)
- Modify: `apps/server/src/routes/analytics-claims.ts` (delete the JWT routes `/api/analytics/claims`, `/check`, `/eligible`; keep `analyticsClaimSignedRoutes` for vlm-dcl 2.0.0)
- Modify: `apps/server/src/app.ts` (stop registering the default export of `analytics-claims.ts`)
- Modify tests: `test/analytics-claims.test.ts` (keep only the `wallet sign-in` describe block; delete claim tests), `test/analytics-read.test.ts`, `test/analytics-schema.test.ts`, `test/analytics-jobs.test.ts` (replace `claimedByUserId/claimStatus` fixtures with setups)
- Create: `apps/server/test/helpers/setups.ts`
- Test: `apps/server/test/analytics-tenure.test.ts`

**Interfaces:**
- Consumes: `locationSetups` (Task 1), `getSceneAccess`, `isFullAccess`, `isHostAccess`, `hasScope`.
- Produces: `getAnalyticsAccess(actor, analyticsSceneId, now?) → { canRead, canManage, canDelete, scene, since?: Date, until?: Date }`.
- Produces test helper: `createSetup(analyticsSceneId: string, vlmSceneId: string, opts?: { startedAt?: Date; endedAt?: Date | null }): Promise<LocationSetupRow>`.

- [ ] **Step 1: Test helper** `apps/server/test/helpers/setups.ts`:

```ts
import { eq } from 'drizzle-orm'
import { db } from '../../src/db/connection.js'
import { analyticsScenes, locationSetups } from '../../src/db/schema.js'

export async function createSetup(analyticsSceneId: string, vlmSceneId: string, opts: { startedAt?: Date; endedAt?: Date | null } = {}) {
  const [row] = await db
    .insert(locationSetups)
    .values({ analyticsSceneId, vlmSceneId, startedAt: opts.startedAt ?? new Date(Date.now() - 30 * 86400_000), endedAt: opts.endedAt ?? null, endReason: opts.endedAt ? 'redeployed' : null })
    .returning()
  if (!opts.endedAt) await db.update(analyticsScenes).set({ vlmSceneId }).where(eq(analyticsScenes.id, analyticsSceneId))
  return row
}
```

- [ ] **Step 2: Write the failing tenure test** `apps/server/test/analytics-tenure.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { sceneRoles } from '../src/db/schema.js'
import { getAnalyticsAccess } from '../src/analytics/access.js'
import { actorFromClaims } from '../src/auth/actor.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor, randomWallet } from './helpers/factories.js'
import { createAnalyticsScene, insertSession } from './helpers/analytics.js'
import { createSetup } from './helpers/setups.js'

const DAY = 86400_000
const actorOf = (u: any) => actorFromClaims({ id: u.id, role: u.role, wallet: u.wallet, verified: true } as any)

describe('analytics access by setup tenure', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(() => app.close())

  it('host, co-host, editor, viewer and strangers', async () => {
    const host = await createUser({ wallet: randomWallet() })
    const vlm = await createScene(host)
    const loc = await createAnalyticsScene({ locationKey: 'gc:1,1', parcels: ['1,1'] })
    await createSetup(loc.id, vlm.id)
    const [co, vi, st] = await Promise.all([1, 2, 3].map(() => createUser({ wallet: randomWallet() })))
    await db.insert(sceneRoles).values([
      { sceneId: vlm.id, walletAddress: co.wallet!, role: 'cohost' },
      { sceneId: vlm.id, walletAddress: vi.wallet!, role: 'viewer' },
    ])
    expect(await getAnalyticsAccess(actorOf(host), loc.id)).toMatchObject({ canRead: true, canManage: true, canDelete: true })
    expect(await getAnalyticsAccess(actorOf(co), loc.id)).toMatchObject({ canRead: true, canManage: true, canDelete: false })
    expect(await getAnalyticsAccess(actorOf(vi), loc.id)).toMatchObject({ canRead: true, canManage: false, canDelete: false })
    expect((await getAnalyticsAccess(actorOf(st), loc.id)).canRead).toBe(false)
  })

  it("a new host never sees the previous tenure's sessions; the previous host keeps read-only access to theirs", async () => {
    const oldHost = await createUser({ wallet: randomWallet() })
    const newHost = await createUser({ wallet: randomWallet() })
    const oldScene = await createScene(oldHost)
    const newScene = await createScene(newHost)
    const loc = await createAnalyticsScene({ locationKey: 'gc:2,2', parcels: ['2,2'] })
    const switchAt = new Date(Date.now() - 5 * DAY)
    await createSetup(loc.id, oldScene.id, { startedAt: new Date(Date.now() - 20 * DAY), endedAt: switchAt })
    await createSetup(loc.id, newScene.id, { startedAt: switchAt })
    await insertSession(loc.id, { startedAt: new Date(Date.now() - 10 * DAY), lastSeenAt: new Date(Date.now() - 10 * DAY) })
    await insertSession(loc.id, { startedAt: new Date(Date.now() - 1 * DAY), lastSeenAt: new Date(Date.now() - 1 * DAY) })

    const sessionsFor = async (u: any) =>
      (await app.inject({ method: 'GET', url: `/api/analytics/locations/${loc.id}/sessions`, headers: { authorization: `Bearer ${tokenFor(u)}` } })).json()
    const mine = await sessionsFor(newHost)
    expect(mine.sessions).toHaveLength(1)
    const theirs = await sessionsFor(oldHost)
    expect(theirs.sessions).toHaveLength(1)
    expect(new Date(theirs.sessions[0].startedAt).getTime()).toBeLessThan(switchAt.getTime())
    const oldAccess = await getAnalyticsAccess(actorOf(oldHost), loc.id)
    expect(oldAccess).toMatchObject({ canRead: true, canManage: false })
    expect(oldAccess.until?.getTime()).toBe(switchAt.getTime())

    const summary = (await app.inject({ method: 'GET', url: `/api/analytics/locations/${loc.id}/summary?from=${new Date(Date.now() - 30 * DAY).toISOString()}`, headers: { authorization: `Bearer ${tokenFor(newHost)}` } })).json()
    expect(JSON.stringify(summary)).not.toContain('"sessions":2')

    const list = (await app.inject({ method: 'GET', url: '/api/analytics/locations', headers: { authorization: `Bearer ${tokenFor(newHost)}` } })).json()
    expect(list.scenes.map((s: any) => s.id)).toEqual([loc.id])
  })
})
```
(Adjust the sessions response key — `sessions` — to whatever `/api/analytics/locations/:id/sessions` returns today; read the route before running.)

- [ ] **Step 3: Run to verify it fails**

Run: `cd apps/server && npx vitest run test/analytics-tenure.test.ts`
Expected: FAIL (`canDelete` undefined; strangers/roles not resolved through setups).

- [ ] **Step 4: Rewrite `apps/server/src/analytics/access.ts`:**

```ts
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { analyticsScenes, locationSetups } from '../db/schema.js'
import type { Actor } from '../auth/actor.js'
import { getSceneAccess, hasScope, isFullAccess, isHostAccess } from '../auth/permissions.js'

export interface AnalyticsAccess {
  canRead: boolean
  canManage: boolean
  /** Host-only: delete this location's analytics data. */
  canDelete: boolean
  scene: typeof analyticsScenes.$inferSelect | null
  /** Only data from this instant on (the reader's setup tenure start). */
  since?: Date
  /** Only data before this instant (an ended tenure). */
  until?: Date
}

const NONE = (scene: AnalyticsAccess['scene']): AnalyticsAccess => ({ canRead: false, canManage: false, canDelete: false, scene })

/** Analytics belong to setup tenures: a VLM scene's team reads the data recorded while its setup was active. */
export async function getAnalyticsAccess(actor: Actor, analyticsSceneId: string, now = new Date()): Promise<AnalyticsAccess> {
  const scene = (await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.id, analyticsSceneId) })) ?? null
  if (!scene || !actor.userId || !actor.verified) return NONE(scene)
  if (actor.role === 'admin') return { canRead: true, canManage: true, canDelete: true, scene }

  const active = await db.query.locationSetups.findFirst({ where: and(eq(locationSetups.analyticsSceneId, scene.id), isNull(locationSetups.endedAt)) })
  if (active) {
    const access = await getSceneAccess(actor, active.vlmSceneId, now)
    if (hasScope(access, 'analytics.view')) {
      return { canRead: true, canManage: isFullAccess(access), canDelete: isHostAccess(access), scene, since: active.startedAt }
    }
  }
  const ended = await db.query.locationSetups.findMany({
    where: and(eq(locationSetups.analyticsSceneId, scene.id), isNotNull(locationSetups.endedAt)),
    orderBy: [desc(locationSetups.endedAt)],
  })
  for (const s of ended) {
    const access = await getSceneAccess(actor, s.vlmSceneId, now)
    if (hasScope(access, 'analytics.view')) return { canRead: true, canManage: false, canDelete: false, scene, since: s.startedAt, until: s.endedAt! }
  }
  return NONE(scene)
}
```

- [ ] **Step 5: Read routes.** In `routes/analytics-read.ts`:
1. `caps(until)` → `caps(until, since)` returning also `fromHour`, `fromDay`, `startedFrom`:
```ts
function caps(until: Date | undefined, since?: Date) {
  return {
    hour: until ? new Date(until.getTime() - HOUR) : null,
    day: until ? new Date(until.getTime() - DAY).toISOString().slice(0, 10) : null,
    started: until ?? null,
    fromHour: since ? new Date(Math.ceil(since.getTime() / HOUR) * HOUR) : null,
    fromDay: since ? new Date(Math.ceil(since.getTime() / DAY) * DAY).toISOString().slice(0, 10) : null,
    startedFrom: since ?? null,
  }
}
```
2. `guard` returns `{ ...access.scene, until: access.until, since: access.since, canDelete: access.canDelete }`.
3. Every query that applies `cap.hour` / `cap.day` / `cap.started` as an upper bound gets the matching lower bound (`gte(<hour col>, cap.fromHour)`, `gte(<day col>, cap.fromDay)`, `gte(analyticsSessions.startedAt, cap.startedFrom)`) when non-null. The `/sessions` list's `where` adds `scene.since ? gte(analyticsSessions.startedAt, scene.since) : undefined`. `/live` is unchanged except it keeps returning nothing for an `until` reader.
4. `/api/analytics/locations`: replace the `candidate` query with: all analytics scene ids that have any `location_setups` row whose `vlm_scene_id` the user can reach (owner, collaborator, org member, `scene_roles` by user id or verified wallet, booking grants); keep the final `getAnalyticsAccess(...).canRead` filter. Drop `claimStatus` from the response and add `since`/`until` from the access.
5. Any data-deletion endpoint that used `canManage` for deleting location data uses `canDelete`.

- [ ] **Step 6: Legacy route** `routes/analytics.ts` `locate()`: replace the claim check with
```ts
    const scene = await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.vlmSceneId, vlmSceneId) })
    const active = scene ? await db.query.locationSetups.findFirst({ where: and(eq(locationSetups.analyticsSceneId, scene.id), isNull(locationSetups.endedAt)) }) : null
    if (scene && active?.vlmSceneId !== vlmSceneId && actor.role !== 'admin') return { allowed: false as const }
    return { allowed: true as const, scene, since: active?.startedAt }
```
and add `gte(analyticsSessions.startedAt, since)` to its queries when `since` is set.

- [ ] **Step 7: Jobs.** `retentionDaysFor(scene)`: find the active setup; no setup → 30; else `getSubscription(<that setup's VLM scene ownerId>)` with the existing logic. Remove `registerDailyJob('claim-reverify', reverifyClaims)` and the import.

- [ ] **Step 8: Retire claim routes/code** per the Files list. Then update the existing tests that build claimed fixtures: replace `createAnalyticsScene({ claimedByUserId: u.id, claimStatus: 'active' })` with `createAnalyticsScene(...)` + `createScene(u)` + `createSetup(loc.id, scene.id)`; "lapsed" fixtures become ended setups (`endedAt`). Delete tests that only exercised `claimScene`/`reverifyClaims`/`/claims/eligible`/`/claims/check`.

- [ ] **Step 9: Run the full server suite**

Run: `pnpm --filter vlm-server test`
Expected: all pass, including `analytics-tenure.test.ts`. `cd apps/server && npx tsc --noEmit` — no errors.

- [ ] **Step 10: Commit**

```bash
git add -A apps/server
git commit -m "feat(server): analytics access follows setup tenures; retire scene claims"
```

---

### Task 6: Scenes list includes role scenes

**Files:**
- Modify: `apps/server/src/routes/scenes.ts` (`GET /api/scenes`)
- Test: `apps/server/test/scenes-list-roles.test.ts`

**Interfaces:**
- Produces: each scene in `GET /api/scenes` has `relationship: 'owner' | 'editor' | 'viewer' | 'cohost'` (role scenes deduped against owned/collab scenes; owner wins, then cohost, editor, viewer).

- [ ] **Step 1: Failing test** `apps/server/test/scenes-list-roles.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { sceneRoles } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor, randomWallet } from './helpers/factories.js'

describe('GET /api/scenes with scene roles', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(() => app.close())

  it('lists scenes where the user has a role (by wallet or user id), once, with the role as relationship', async () => {
    const host = await createUser()
    const a = await createScene(host, 'A')
    const b = await createScene(host, 'B')
    const me = await createUser({ wallet: randomWallet() })
    await db.insert(sceneRoles).values([
      { sceneId: a.id, walletAddress: me.wallet!, role: 'cohost' },
      { sceneId: b.id, walletAddress: randomWallet(), userId: me.id, role: 'viewer' },
      { sceneId: b.id, walletAddress: me.wallet!, role: 'viewer', revokedAt: new Date() },
    ])
    const res = await app.inject({ method: 'GET', url: '/api/scenes', headers: { authorization: `Bearer ${tokenFor(me)}` } })
    const got = res.json().scenes.map((s: any) => [s.name, s.relationship]).sort()
    expect(got).toEqual([['A', 'cohost'], ['B', 'viewer']])
  })
})
```

- [ ] **Step 2: Run** `cd apps/server && npx vitest run test/scenes-list-roles.test.ts` — Expected: FAIL (empty list).

- [ ] **Step 3: Implement** in `GET /api/scenes`, after `collabs`:

```ts
    const actorWallet = actor.wallet
    const roleRows = await db
      .select({ sceneId: sceneRoles.sceneId, role: sceneRoles.role })
      .from(sceneRoles)
      .where(
        and(
          isNull(sceneRoles.revokedAt),
          actorWallet ? or(eq(sceneRoles.userId, actor.userId), eq(sceneRoles.walletAddress, actorWallet)) : eq(sceneRoles.userId, actor.userId),
        ),
      )
    const rank = { cohost: 3, editor: 2, viewer: 1 } as const
    const roleBy = new Map<string, 'cohost' | 'editor' | 'viewer'>()
    for (const r of roleRows) if (!roleBy.has(r.sceneId) || rank[r.role] > rank[roleBy.get(r.sceneId)!]) roleBy.set(r.sceneId, r.role)
```
Then fetch scenes for `roleBy` keys not already in `owned`/`shared`, and append them with `relationship: roleBy.get(id)`; for scenes in both `shared` and `roleBy`, use the higher of the collaborator role and the scene role (`cohost` > `editor` > `viewer`). Import `sceneRoles`, `isNull`, `or`, `and`.

- [ ] **Step 4: Run** the test and `pnpm --filter vlm-server test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/routes/scenes.ts apps/server/test/scenes-list-roles.test.ts
git commit -m "feat(server): scenes list includes scenes shared through scene roles"
```

---

### Task 7: Client SDK — setup and roles calls; HUD panel enum

**Files:**
- Modify: `packages/vlm-shared/src/enums/index.ts` (`HUDPanelType.ROLES = 'roles'`)
- Modify: `packages/vlm-client/src/http.ts`
- Test: `packages/vlm-core/test/setup-client.test.ts`

**Interfaces:**
- Produces on `VLMHttpClient`:
  - `getSetupStatus(scene: AnalyticsSceneRef, adapter: VLMPlatformAdapter): Promise<SetupStatus>`
  - `setUpHere(scene: AnalyticsSceneRef, adapter: VLMPlatformAdapter): Promise<{ sceneId: string } | { error: string; host?: string; status: number }>`
  - `getSceneRoles(sceneId)`, `addSceneRole(sceneId, wallet, role)`, `removeSceneRole(sceneId, wallet)`, `transferHost(sceneId, wallet)` (JWT `_fetch`)
  - `export type SetupStatus = { state: 'eligible' } | { state: 'member'; sceneId: string; role: 'host'|'cohost'|'editor'|'viewer' } | { state: 'taken'; host: string } | { state: 'none' } | { state: 'unavailable' }`
- Produces: `HUDPanelType.ROLES`.

- [ ] **Step 1: Failing test** `packages/vlm-core/test/setup-client.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { VLMHttpClient } from 'vlm-client'

const REF = { realm: 'main', isWorld: false, isPreview: false, baseParcel: '1,1', parcels: ['1,1'] }

describe('VLMHttpClient setup calls', () => {
  it('getSetupStatus posts the scene ref through the signed request and parses the state', async () => {
    const signedRequest = vi.fn(async () => ({ status: 200, body: JSON.stringify({ state: 'member', sceneId: 's1', role: 'host' }) }))
    const client = new VLMHttpClient('https://api.example')
    const res = await client.getSetupStatus(REF as any, { signedRequest } as any)
    expect(res).toEqual({ state: 'member', sceneId: 's1', role: 'host' })
    expect(signedRequest).toHaveBeenCalledWith('https://api.example/api/setup/status', { method: 'POST', body: JSON.stringify({ scene: REF }) })
  })

  it('getSetupStatus treats failures as none, and adapters without signed requests as none', async () => {
    const client = new VLMHttpClient('https://api.example')
    expect(await client.getSetupStatus(REF as any, { signedRequest: async () => { throw new Error('x') } } as any)).toEqual({ state: 'none' })
    expect(await client.getSetupStatus(REF as any, {} as any)).toEqual({ state: 'none' })
  })

  it('setUpHere returns the scene id, or the error with status', async () => {
    const client = new VLMHttpClient('https://api.example')
    expect(await client.setUpHere(REF as any, { signedRequest: async () => ({ status: 200, body: '{"sceneId":"s9"}' }) } as any)).toEqual({ sceneId: 's9' })
    expect(await client.setUpHere(REF as any, { signedRequest: async () => ({ status: 409, body: '{"error":"already_set_up","host":"0xab…cd"}' }) } as any)).toEqual({
      error: 'already_set_up', host: '0xab…cd', status: 409,
    })
  })
})
```

- [ ] **Step 2: Run** `pnpm --filter vlm-core exec vitest run test/setup-client.test.ts` — Expected: FAIL (`getSetupStatus` is not a function).

- [ ] **Step 3: Implement** in `packages/vlm-client/src/http.ts` (next to `checkAnalyticsClaimSigned`):

```ts
  /** What the in-world HUD should offer this signed-in wallet at this location. Failures count as "none". */
  async getSetupStatus(scene: AnalyticsSceneRef, adapter: VLMPlatformAdapter): Promise<SetupStatus> {
    if (!adapter.signedRequest) return { state: 'none' }
    try {
      const res = await adapter.signedRequest(`${this.baseUrl}/api/setup/status`, { method: 'POST', body: JSON.stringify({ scene }) })
      if (res.status < 200 || res.status >= 300) return { state: 'none' }
      return JSON.parse(res.body) as SetupStatus
    } catch {
      return { state: 'none' }
    }
  }

  /** One-press setup: the signed-in wallet becomes host of a new VLM scene for this location. */
  async setUpHere(scene: AnalyticsSceneRef, adapter: VLMPlatformAdapter): Promise<{ sceneId: string } | { error: string; host?: string; status: number }> {
    if (!adapter.signedRequest) return { error: 'signed_request_unavailable', status: 0 }
    try {
      const res = await adapter.signedRequest(`${this.baseUrl}/api/setup`, { method: 'POST', body: JSON.stringify({ scene }) })
      const data = res.body ? JSON.parse(res.body) : {}
      if (res.status >= 200 && res.status < 300) return { sceneId: data.sceneId }
      return { error: data.error || 'setup_failed', host: data.host, status: res.status }
    } catch (err) {
      return { error: String(err), status: 0 }
    }
  }

  async getSceneRoles(sceneId: string): Promise<{ host: { userId: string; displayName: string | null; wallets: string[] }; roles: SceneRoleEntry[] }> {
    return this._fetch(`/api/scenes/${sceneId}/roles`)
  }

  async addSceneRole(sceneId: string, wallet: string, role: 'cohost' | 'editor' | 'viewer'): Promise<{ role: SceneRoleEntry }> {
    return this._fetch(`/api/scenes/${sceneId}/roles`, { method: 'POST', body: JSON.stringify({ wallet, role }) })
  }

  async removeSceneRole(sceneId: string, wallet: string): Promise<void> {
    await this._fetch(`/api/scenes/${sceneId}/roles/${wallet}`, { method: 'DELETE' })
  }

  async transferHost(sceneId: string, wallet: string): Promise<{ host: string }> {
    return this._fetch(`/api/scenes/${sceneId}/transfer-host`, { method: 'POST', body: JSON.stringify({ wallet }) })
  }
```
and at module level:
```ts
export type SetupStatus =
  | { state: 'eligible' }
  | { state: 'member'; sceneId: string; role: 'host' | 'cohost' | 'editor' | 'viewer' }
  | { state: 'taken'; host: string }
  | { state: 'none' }
  | { state: 'unavailable' }
export interface SceneRoleEntry { wallet: string; role: 'cohost' | 'editor' | 'viewer'; userId: string | null; displayName?: string | null; createdAt?: string }
```
Export `SetupStatus` and `SceneRoleEntry` from `packages/vlm-client/src/index.ts`. If `_fetch` throws on 204 bodies, make `removeSceneRole` tolerate an empty body (check how `_fetch` parses; follow its existing pattern for DELETE). Add `ROLES = 'roles'` to `HUDPanelType`.

- [ ] **Step 4: Build and test**

Run: `pnpm --filter vlm-shared build && pnpm --filter vlm-client build && pnpm --filter vlm-core exec vitest run`
Expected: PASS (existing 55 + 3 new).

- [ ] **Step 5: Commit**

```bash
git add packages/vlm-shared/src packages/vlm-client/src packages/vlm-core/test/setup-client.test.ts
git commit -m "feat(client): setup status / setup-here / scene roles calls; HUDPanelType.ROLES"
```

---

### Task 8: In-world flow — Setup card and Roles panel (DCL adapter)

**Files:**
- Modify: `packages/vlm-adapter-dcl/src/index.ts` (no-sceneId branch of `createVLM`)
- Modify: `packages/vlm-adapter-dcl/src/DclHUDRenderer.tsx` (state, `SetupOfferScreen`, `RolesPanel`, NavBar button, renderer methods)
- Create: `packages/vlm-adapter-dcl/src/players.ts`

**Interfaces:**
- Consumes: `getSetupStatus`, `setUpHere`, `getSceneRoles`, `addSceneRole`, `removeSceneRole`, `transferHost` (Task 7); `getAnalyticsSceneRef()` (adapter `analytics.ts`); `setSceneActionHandler` (renderer).
- Produces renderer methods: `showSetupOffer(message?: string)`, `setSceneRole(role: 'host'|'cohost'|'editor'|'viewer')`, `setRoles(data: { hostWallets: string[]; roles: SceneRoleEntry[] })`, `setRolesError(msg: string | null)`; scene actions `setup_here`, `roles_refresh`, `roles_add {wallet, role}`, `roles_remove {wallet}`, `roles_transfer {wallet}`.
- Produces `nearbyPlayers(): { address: string; name: string }[]` in `players.ts`.

- [ ] **Step 1: `players.ts`:**

```ts
import { engine, PlayerIdentityData, AvatarBase } from '@dcl/sdk/ecs'

/** People currently in the scene (excluding guests without an address), for the Roles picker. */
export function nearbyPlayers(): { address: string; name: string }[] {
  const out: { address: string; name: string }[] = []
  for (const [entity, identity] of engine.getEntitiesWith(PlayerIdentityData)) {
    if (identity.isGuest || !identity.address) continue
    const name = AvatarBase.getOrNull(entity)?.name || `${identity.address.slice(0, 6)}…${identity.address.slice(-4)}`
    out.push({ address: identity.address.toLowerCase(), name })
  }
  return out
}
```

- [ ] **Step 2: Replace the no-sceneId flow in `createVLM`** (from `// No sceneId — do the two-phase flow` through the end of `setupOwnerHud`) with a status-driven flow:

```ts
  // No sceneId: ask the server what this wallet gets here (nothing / Set up / member of the setup)
  const sceneRef = await getAnalyticsSceneRef()
  const user = await adapter.getPlatformUser()
  const probe = new VLMHttpClient(resolveApiUrl(config ?? {}))
  if (user.isGuest) return vlm

  const connectAs = async (sceneId: string, role: 'host' | 'cohost' | 'editor' | 'viewer') => {
    await vlm.authenticate({ env: 'prod', ...config })
    ensureRenderer()
    renderer?.setSceneRole(role)
    renderer?.updateConnectionState('connecting', { sceneId })
    renderer?.setCurrentScene(sceneId, sceneRef.title || 'Scene')
    await vlm.connectToScene(sceneId)
    if (renderer) {
      await vlm.initHUD(renderer)
      installRolesHandler(sceneId, role)
    }
    return vlm
  }

  const installRolesHandler = (sceneId: string, role: string) => {
    if (role !== 'host' && role !== 'cohost') return
    const refresh = async () => {
      try {
        const data = await vlm.httpClient.getSceneRoles(sceneId)
        renderer?.setRoles({ hostWallets: data.host.wallets, roles: data.roles })
        renderer?.setRolesError(null)
      } catch (err) {
        renderer?.setRolesError(String(err))
      }
    }
    setSceneActionHandler(async (action: string, data?: any) => {
      try {
        if (action === 'roles_refresh') await refresh()
        if (action === 'roles_add') { await vlm.httpClient.addSceneRole(sceneId, data.wallet, data.role); await refresh() }
        if (action === 'roles_remove') { await vlm.httpClient.removeSceneRole(sceneId, data.wallet); await refresh() }
        if (action === 'roles_transfer' && role === 'host') { await vlm.httpClient.transferHost(sceneId, data.wallet); renderer?.setSceneRole('cohost'); await refresh() }
      } catch (err) {
        renderer?.setRolesError(String(err))
      }
    })
    void refresh()
  }

  let status = await probe.getSetupStatus(sceneRef, adapter)
  for (const delay of OWNER_CHECK_BACKOFF_MS) {
    if (status.state !== 'unavailable') break
    await new Promise((r) => setTimeout(r, delay))
    status = await probe.getSetupStatus(sceneRef, adapter)
  }
  if (status.state === 'member') return connectAs(status.sceneId, status.role)
  if (status.state !== 'eligible') {
    console.log('[VLM] Analytics running; VLM setup is only offered to this land\'s owners, operators and deployer')
    return vlm
  }

  ensureRenderer()
  renderer?.showSetupOffer()
  return new Promise<VLM>((resolve) => {
    setSceneActionHandler(async (action: string) => {
      if (action !== 'setup_here') return
      renderer?.updateConnectionState('connecting')
      const res = await probe.setUpHere(sceneRef, adapter)
      if ('sceneId' in res) {
        resolve(await connectAs(res.sceneId, 'host'))
        return
      }
      const msg =
        res.error === 'already_set_up' ? `Already set up by ${res.host ?? 'someone else'}`
        : res.status === 503 ? "Decentraland's servers aren't answering — try again in a minute"
        : res.status === 403 ? 'Only this land\'s owner, operators or deployer can set up VLM here'
        : `Setup failed (${res.error})`
      renderer?.showSetupOffer(msg)
    })
  })
```
Keep the `config.sceneId` branch unchanged above it. Remove now-unused imports (`locationKeyFor`, `checkAnalyticsClaimSigned` usage). Keep `OWNER_CHECK_BACKOFF_MS`.

- [ ] **Step 3: Renderer state and methods** (`DclHUDRenderer.tsx`): add to the `state` object type and initial value:
```ts
  setupOffer: boolean            // false
  setupMessage: string | null    // null
  sceneRole: 'host' | 'cohost' | 'editor' | 'viewer' | null   // null
  roles: { hostWallets: string[]; roles: { wallet: string; role: string; displayName?: string | null }[] }  // { hostWallets: [], roles: [] }
  rolesError: string | null      // null
  roleDraftWallet: string        // ''
  roleDraftRole: 'cohost' | 'editor' | 'viewer'  // 'editor'
  confirmTransfer: string | null // null
```
Methods on the renderer class:
```ts
  showSetupOffer(message?: string) { state.setupOffer = true; state.setupMessage = message ?? null; state.connectionState = 'idle'; state.hudVisible = true }
  setSceneRole(role: 'host' | 'cohost' | 'editor' | 'viewer') { state.sceneRole = role; state.setupOffer = false }
  setRoles(data: { hostWallets: string[]; roles: { wallet: string; role: string; displayName?: string | null }[] }) { state.roles = data }
  setRolesError(msg: string | null) { state.rolesError = msg }
```

- [ ] **Step 4: `SetupOfferScreen`** (render it in `VLMHUD` when `state.setupOffer && state.hudVisible`, before the connection-state screens). Use the file's existing `Button`, `PanelHeader`, colour constants `C` and layout conventions (same container position/width as `SceneSetupScreen`):
```tsx
function SetupOfferScreen() {
  return (
    <UiEntity uiTransform={{ positionType: 'absolute', position: { right: 12, top: 62 }, width: 340, flexDirection: 'column', padding: 12 }} uiBackground={{ color: C.bg }}>
      <PanelHeader title="Set up VLM here" onClose={() => { state.hudVisible = false }} />
      <Label value="Manage this scene's screens, streams and events from here, see its visitor analytics, and invite your crew. You'll be the host." fontSize={13} color={C.text} textAlign="top-left" uiTransform={{ width: '100%', height: 64, margin: { bottom: 8 } }} />
      {state.setupMessage && <Label value={state.setupMessage} fontSize={12} color={C.warning ?? C.text} uiTransform={{ width: '100%', height: 32 }} />}
      <Button label="Set up VLM here" onPress={() => sceneActionHandler?.('setup_here')} width={316} height={40} />
    </UiEntity>
  )
}
```
(`sceneActionHandler` is the module variable set by `setSceneActionHandler`; use whatever name the file uses. If `C.warning` doesn't exist, use the closest existing accent colour.)

- [ ] **Step 5: NavBar + `RolesPanel`.** In `NavBar`, when `state.sceneRole === 'host' || state.sceneRole === 'cohost'`, add a **Roles** button setting `state.activePanel = HUDPanelType.ROLES` and calling `sceneActionHandler?.('roles_refresh')`. In the panel switch inside `VLMHUD` add `{state.activePanel === HUDPanelType.ROLES && <RolesPanel />}`. `RolesPanel`:
```tsx
function RolesPanel() {
  const short = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`
  const assigned = new Set([...state.roles.hostWallets, ...state.roles.roles.map((r) => r.wallet)])
  const here = nearbyPlayers().filter((p) => !assigned.has(p.address))
  const add = (wallet: string) => sceneActionHandler?.('roles_add', { wallet, role: state.roleDraftRole })
  return (
    <UiEntity uiTransform={{ flexDirection: 'column', width: '100%', padding: 8 }}>
      <PanelHeader title="Roles" onClose={() => { state.activePanel = null }} />
      {state.rolesError && <Label value={state.rolesError} fontSize={11} color={C.text} uiTransform={{ height: 28 }} />}
      {state.roles.hostWallets.slice(0, 1).map((w) => (
        <Label key={w} value={`${short(w)} — Host`} fontSize={13} color={C.text} uiTransform={{ height: 24 }} />
      ))}
      {state.roles.roles.map((r) => (
        <UiEntity key={r.wallet} uiTransform={{ flexDirection: 'row', height: 30, alignItems: 'center' }}>
          <Label value={`${r.displayName || short(r.wallet)} — ${r.role === 'cohost' ? 'Co-host' : r.role === 'editor' ? 'Editor' : 'Viewer'}`} fontSize={13} color={C.text} uiTransform={{ width: 190 }} />
          <Button label="Remove" onPress={() => sceneActionHandler?.('roles_remove', { wallet: r.wallet })} width={64} height={24} fontSize={11} />
          {state.sceneRole === 'host' && r.role === 'cohost' && (
            state.confirmTransfer === r.wallet
              ? <Button label="Confirm" onPress={() => { state.confirmTransfer = null; sceneActionHandler?.('roles_transfer', { wallet: r.wallet }) }} width={64} height={24} fontSize={11} />
              : <Button label="Make host" onPress={() => { state.confirmTransfer = r.wallet }} width={64} height={24} fontSize={11} />
          )}
        </UiEntity>
      ))}
      <Divider />
      <UiEntity uiTransform={{ flexDirection: 'row', height: 30 }}>
        {(['cohost', 'editor', 'viewer'] as const).map((role) => (
          <Button key={role} label={role === 'cohost' ? 'Co-host' : role === 'editor' ? 'Editor' : 'Viewer'} color={state.roleDraftRole === role ? C.accent : undefined}
            onPress={() => { state.roleDraftRole = role }} width={98} height={26} fontSize={12} />
        ))}
      </UiEntity>
      <Label value="People here" fontSize={12} color={C.text} uiTransform={{ height: 22 }} />
      {here.slice(0, 6).map((p) => (
        <UiEntity key={p.address} uiTransform={{ flexDirection: 'row', height: 28, alignItems: 'center' }}>
          <Label value={p.name} fontSize={12} color={C.text} uiTransform={{ width: 240 }} />
          <Button label="Add" onPress={() => add(p.address)} width={60} height={24} fontSize={11} />
        </UiEntity>
      ))}
      <Input placeholder="or paste a wallet address (0x…)" onChange={(v) => { state.roleDraftWallet = v.trim() }} fontSize={12} uiTransform={{ width: '100%', height: 30, margin: { top: 6 } }} />
      <Button label="Add address" onPress={() => { if (/^0x[0-9a-fA-F]{40}$/.test(state.roleDraftWallet)) add(state.roleDraftWallet.toLowerCase()); else state.rolesError = 'That is not a wallet address' }} width={316} height={30} />
    </UiEntity>
  )
}
```
Import `Input` from `@dcl/sdk/react-ecs` and `nearbyPlayers` from `./players.js`. Match the existing `Button` prop names (`label`, `color`, `textColor`, `onPress`, `width`, `height`, `fontSize`) — `color` undefined must fall back to its default.

- [ ] **Step 5b: In `VLMHUD`, the connected toolbar (no active panel) branch from commit 49b1848 stays; ensure `SetupOfferScreen` takes precedence only when `state.setupOffer` is true.**

- [ ] **Step 6: Build + typecheck**

Run: `pnpm --filter vlm-adapter-dcl build && pnpm --filter vlm-adapter-dcl typecheck && cd packages/vlm-smart-item-dcl && pnpm run bundle && pnpm run typecheck`
Expected: no errors; `Built dist/index.js`.

- [ ] **Step 7: Scene build check**

Run: `cd test-scenes/dcl-smart-item-test && npx sdk-commands build`
Expected: `Bundle saved bin/index.js`, `Type checking completed without errors`.

- [ ] **Step 8: Commit**

```bash
git add packages/vlm-adapter-dcl/src packages/vlm-smart-item-dcl/dist
git commit -m "feat(dcl): one-press in-world setup and Roles panel in the HUD"
```
(If `dist` is git-ignored, omit it.)

---

### Task 9: Dashboard — Roles tab on the scene page; role labels on Scenes list

**Files:**
- Create: `apps/web/src/app/(dashboard)/scenes/[sceneId]/SceneRoles.tsx`
- Modify: `apps/web/src/app/(dashboard)/scenes/[sceneId]/client.tsx` (add `'roles'` tab)
- Modify: `apps/web/src/lib/api.ts` (`getSceneRoles`, `addSceneRole`, `removeSceneRole`, `transferHost`)
- Modify: `apps/web/src/app/(dashboard)/scenes/page.tsx` (show `relationship` badge for non-owner scenes) — read the file to find where each scene card renders its name

**Interfaces:**
- Consumes: Task 4 endpoints; `useApi`, `useAuth`.

- [ ] **Step 1: API methods** in `apps/web/src/lib/api.ts` returned object:
```ts
    getSceneRoles: (sceneId: string) =>
      apiFetch<{ host: { userId: string; displayName: string | null; wallets: string[] }; roles: { wallet: string; role: 'cohost' | 'editor' | 'viewer'; userId: string | null; displayName: string | null; createdAt: string }[] }>(`/api/scenes/${sceneId}/roles`),
    addSceneRole: (sceneId: string, wallet: string, role: 'cohost' | 'editor' | 'viewer') =>
      apiFetch(`/api/scenes/${sceneId}/roles`, { method: 'POST', body: JSON.stringify({ wallet, role }) }),
    removeSceneRole: (sceneId: string, wallet: string) => apiFetch(`/api/scenes/${sceneId}/roles/${wallet}`, { method: 'DELETE' }),
    transferHost: (sceneId: string, wallet: string) =>
      apiFetch<{ host: string }>(`/api/scenes/${sceneId}/transfer-host`, { method: 'POST', body: JSON.stringify({ wallet }) }),
```

- [ ] **Step 2: `SceneRoles.tsx`:**
```tsx
'use client'
import { useEffect, useState } from 'react'
import { useApi } from '@/lib/api'
import { useAuth } from '@/lib/auth'

type Role = 'cohost' | 'editor' | 'viewer'
const LABEL: Record<Role, string> = { cohost: 'Co-host', editor: 'Editor', viewer: 'Viewer' }
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/** Host and co-hosts manage who can run this scene. Roles go to wallet addresses. */
export function SceneRoles({ sceneId }: { sceneId: string }) {
  const { token, user } = useAuth()
  const api = useApi()
  const [data, setData] = useState<Awaited<ReturnType<typeof api.getSceneRoles>> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [wallet, setWallet] = useState('')
  const [role, setRole] = useState<Role>('editor')
  const [busy, setBusy] = useState(false)

  const load = async () => {
    try {
      setData(await api.getSceneRoles(sceneId))
      setError(null)
    } catch (err: any) {
      setError(err.message === 'Forbidden' ? 'Only the host and co-hosts can manage roles.' : err.message)
    }
  }
  // useApi() returns new functions every render; reload when the scene or session changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [sceneId, token])

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try { await fn(); await load() } catch (err: any) { setError(err.message) } finally { setBusy(false) }
  }
  const isHost = !!data && data.host.userId === user?.id

  return (
    <div className="rounded-xl border border-gray-800 bg-gray-900 p-6">
      <h3 className="text-sm font-medium text-gray-300 mb-1">Roles</h3>
      <p className="text-xs text-gray-500 mb-4">Co-hosts can do everything except change the host. Editors manage content. Viewers see analytics.</p>
      {error && <div className="mb-3 rounded-lg bg-red-900/50 border border-red-700 px-4 py-2 text-sm text-red-300">{error}</div>}
      {data && (
        <>
          <ul className="mb-4 space-y-2">
            <li className="flex items-center justify-between rounded-lg bg-gray-800 px-4 py-2 text-sm">
              <span className="text-gray-200">{data.host.displayName || (data.host.wallets[0] ? short(data.host.wallets[0]) : 'Host')}</span>
              <span className="text-xs text-orange-400">Host</span>
            </li>
            {data.roles.map((r) => (
              <li key={r.wallet} className="flex items-center justify-between rounded-lg bg-gray-800 px-4 py-2 text-sm">
                <span className="font-mono text-gray-200" title={r.wallet}>{r.displayName || short(r.wallet)}</span>
                <span className="flex items-center gap-2">
                  <select value={r.role} disabled={busy} onChange={(e) => run(() => api.addSceneRole(sceneId, r.wallet, e.target.value as Role))}
                    className="rounded bg-gray-700 px-2 py-1 text-xs text-white">
                    {(Object.keys(LABEL) as Role[]).map((k) => <option key={k} value={k}>{LABEL[k]}</option>)}
                  </select>
                  {isHost && r.role === 'cohost' && r.userId && (
                    <button disabled={busy} onClick={() => { if (confirm(`Make ${r.displayName || short(r.wallet)} the host? You'll become a co-host.`)) run(() => api.transferHost(sceneId, r.wallet)) }}
                      className="text-xs text-orange-400 hover:underline">Make host</button>
                  )}
                  <button disabled={busy} onClick={() => run(() => api.removeSceneRole(sceneId, r.wallet))} className="text-xs text-red-400 hover:underline">Remove</button>
                </span>
              </li>
            ))}
          </ul>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); run(async () => { await api.addSceneRole(sceneId, wallet.trim(), role); setWallet('') }) }}>
            <input value={wallet} onChange={(e) => setWallet(e.target.value)} placeholder="Wallet address (0x…)" pattern="^0x[0-9a-fA-F]{40}$" required
              className="flex-1 rounded-lg bg-gray-800 px-4 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-blue-500" />
            <select value={role} onChange={(e) => setRole(e.target.value as Role)} className="rounded-lg bg-gray-800 px-3 py-2 text-sm text-white">
              {(Object.keys(LABEL) as Role[]).map((k) => <option key={k} value={k}>{LABEL[k]}</option>)}
            </select>
            <button type="submit" disabled={busy} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50">Add</button>
          </form>
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Tab.** In `client.tsx`: `type TabKey = ElementType | 'moderation' | 'roles'`; append `{ key: 'roles', label: 'Roles' }` to `TABS`; render `{activeTab === 'roles' && <SceneRoles sceneId={sceneId} />}` next to the moderation block; exclude `'roles'` from the element-list branch (`activeTab !== 'moderation' && activeTab !== 'widget' && activeTab !== 'roles'`) and from `filteredElements` (treat like `'moderation'`). Use the scene id variable name already used in `client.tsx`.

- [ ] **Step 4: Scenes list badge.** Where each scene card renders its name in `scenes/page.tsx`, add `{scene.relationship && scene.relationship !== 'owner' && <span className="ml-2 rounded bg-gray-800 px-2 py-0.5 text-xs text-gray-400">{({ cohost: 'Co-host', editor: 'Editor', viewer: 'Viewer' } as Record<string, string>)[scene.relationship] ?? scene.relationship}</span>}`.

- [ ] **Step 5: Build**

Run: `pnpm --filter vlm-web exec tsc --noEmit && pnpm --filter vlm-web build`
Expected: no type errors; `✓ Compiled successfully`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): Roles tab on the scene page; role badges on the Scenes list"
```

---

### Task 10: End-to-end verification, release and deploy

**Files:**
- Modify: `packages/vlm-smart-item-dcl/package.json` (`version` → `2.1.0`)
- Modify: `packages/vlm-smart-item-dcl/README.md` (one paragraph: "Setting up your scene")

- [ ] **Step 1: Full test suites**

Run: `pnpm turbo test`
Expected: all packages green.

- [ ] **Step 2: Local in-world check.** Restart the local server (it runs from source with `tsx`), rebuild the adapter/bundle, reload `test-scenes/dcl-smart-item-test` (preview realm). The server's preview-realm handling: `locationKeyFor` gives `preview:<wallet>:…` keys and `controls()` treats the previewing wallet as controller, so the Setup card must appear for the previewer. Verify in the server log: `POST /api/setup/status` → `eligible`; after pressing: `POST /api/setup` 200, then `/api/auth/platform`, Colyseus join. Verify in Postgres:
```sql
select s.started_at, s.ended_at, a.location_key, sc.name from location_setups s join analytics_scenes a on a.id = s.analytics_scene_id join scenes sc on sc.id = s.vlm_scene_id;
```
Expected: one active row for the preview location. Ask the user to open the Roles panel and add a wallet; verify a `scene_roles` row.

- [ ] **Step 3: README paragraph** (after "## From code"):
```md
## Setting up your scene

Deploy, then walk into your scene with the wallet that owns, operates or deployed it. The VLM HUD
(top right) shows **Set up VLM here**: one press makes you the scene's host — no account or email
needed. Open **Roles** in the HUD (or the scene's Roles tab on vlm.gg) to make others co-hosts,
editors or viewers by wallet address.
```
Bump `version` to `2.1.0`. Commit:
```bash
git add packages/vlm-smart-item-dcl/package.json packages/vlm-smart-item-dcl/README.md
git commit -m "chore(vlm-dcl): 2.1.0 — in-world setup and roles"
```

- [ ] **Step 4: Deploy the server** (production is Railway service `vlm-server`, deployed by upload):
```bash
git push origin main
railway up -s vlm-server --ci
```
Expected: `Deploy complete`; `curl https://api.vlm.gg/api/health` → `{"status":"ok","mode":"cloud",…}`; the deploy log shows drizzle-kit push creating `scene_roles` and `location_setups`.

- [ ] **Step 5: Publish vlm-dcl 2.1.0** — needs the user's passkey: pack (`cd packages/vlm-smart-item-dcl && pnpm run bundle && pnpm pack --pack-destination /tmp/claude-501`), install the tarball into `test-scenes/dcl-smart-item-test` and `npx sdk-commands build` as a smoke test, then ask the user to run in their own terminal:
```sh
cd /tmp/claude-501 && PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH npx -y npm@11 publish ./vlm-dcl-2.1.0.tgz --access public
```
Verify with `curl -s https://registry.npmjs.org/vlm-dcl | python3 -c "import json,sys;print(json.load(sys.stdin)['dist-tags']['latest'])"` → `2.1.0`.
