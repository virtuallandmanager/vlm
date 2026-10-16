# VLM Analytics Dashboard (D1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-location analytics dashboard on vlm.gg built on the existing `/api/analytics/locations/*` read API, reachable in one press from the in-world HUD.

**Architecture:** The server grows the locations list (four fields) and gains a single-use sign-in hand-off (`POST /api/auth/handoff` + `/exchange`, table `auth_handoff_codes`). The web app gets pure helper modules (unit-tested with vitest), hand-written SVG chart components, and one static page `/analytics/` driven by query parameters (`?location=` / `?scene=`). The HUD gets a **Stats** tab that creates a hand-off code and opens `/auth/handoff/?code=…&next=/analytics/?scene=…` through Decentraland's `openExternalUrl` (plain `/analytics/?scene=` link if that fails), so the browser is signed in as the same wallet.

**Tech Stack:** Fastify 5 + Drizzle + vitest (real Postgres `vlm_test`) on the server; Next 15 (static export in production) + React 19 + Tailwind in `apps/web`; SDK7 React-ECS in `vlm-adapter-dcl`; vitest in `vlm-core`.

**Spec:** `docs/superpowers/specs/2026-10-16-vlm-analytics-dashboard-d1-design.md`

## Global Constraints

- Node 20: prefix commands with `export PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH`.
- Work only in this worktree (`.worktrees/analytics-d1`, branch `feature/analytics-dashboard`).
- Server tests: `cd apps/server && npx vitest run <file>` (real Postgres `vlm_test`; the dev Postgres must be up: `docker compose -p vlm-dev -f docker-compose.dev.yml up -d postgres` from the repo root).
- No chart library and no new runtime dependency in `apps/web`. `vitest` is the only new dev dependency (version `3.2.7`, matching `vlm-core`).
- The read API is unchanged except `GET /api/analytics/locations` rows gaining `vlmSceneId`, `baseParcel`, `parcels`, `canManage`.
- The only schema change is the new table `auth_handoff_codes`; it must be created by `drizzle-kit push` (as run by `apps/server/entrypoint.sh`) without prompts.
- Hand-off codes are secrets: never log them, never store them unhashed, never put them anywhere but the one opened URL.
- Production web build is a static export (`output: 'export'` when `NODE_ENV=production`) served with an index.html fallback for unknown paths: **no new dynamic route segments**; the dashboard is `/analytics/` with query parameters.
- Styling follows the existing dark dashboard (`bg-gray-900` cards, `bg-gray-800` inputs, `text-gray-400` secondary text, `blue-500/600` accents, `rounded-lg`/`rounded-xl`). The site has no light mode today; charts must still use tokens (CSS variables) so a light mode can be added later.
- Times shown in the browser's local time; day buckets are UTC days and labelled "(UTC days)".
- Wallet/name are shown only when the session row carries them (the server stores them only when wallet visibility was on).
- Commit after each task with a message ending in:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

## Review Focus

1. **Deep links in production:** `/analytics/?scene=<uuid>` loaded cold (from the HUD) must render the dashboard after sign-in, not the home page. Covered by Task 5 (`next`) + Task 8 (query-param page) + Task 10 (static build check, `next` round trip).
2. **Open redirect:** `?next=` must never send the user off-site (`//evil.com`, `https://…`, `/\evil`). Task 3 tests.
3. **Ended tenure readers** (a previous host): the locations row must still resolve (their `vlmSceneId` is their tenure's scene) and live data is empty. Task 1 test.
4. **Empty locations** (no rollups yet, no parcels on a World): every section renders a "No visits recorded yet" state; the map fits data or shows a single 16 m tile. Task 4 tests + Task 8.
5. **Hand-off code reuse or leakage:** a code must work once, within 60 s, and disappear from the address bar before the exchange request is sent; a used/expired code falls back to normal sign-in with the same destination. Task 2 + Task 5 tests.
6. **Viewer role:** sees everything except the wallet-visibility toggle; the HUD Stats tab shows for viewers too. Task 1 (`canManage`) + Task 9.

---

### Task 1: Locations rows carry `vlmSceneId`, `baseParcel`, `parcels`, `canManage`

**Files:**
- Modify: `apps/server/src/analytics/access.ts`
- Modify: `apps/server/src/routes/analytics-read.ts` (the `GET /api/analytics/locations` handler)
- Test: `apps/server/test/analytics-read.test.ts`

**Interfaces:**
- Produces: `AnalyticsAccess.vlmSceneId?: string` — the VLM scene of the tenure that granted read access (active setup's `vlmSceneId`, or the ended setup's). Admins: `scene.vlmSceneId ?? undefined`.
- Produces (HTTP): each `scenes[]` row of `GET /api/analytics/locations` adds `vlmSceneId: string | null`, `baseParcel: string | null`, `parcels: string[]`, `canManage: boolean`.

- [ ] **Step 1: Write the failing tests** — add to `analytics-read.test.ts` inside the `describe`:

```ts
  it('locations rows carry the tenure scene id, parcels and whether the reader may manage', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const s = await createAnalyticsScene({ baseParcel: '10,20', parcels: ['10,20', '11,20'] })
    await createSetup(s.id, scene.id)
    const [row] = (await get(owner, '/api/analytics/locations')).json().scenes
    expect(row).toMatchObject({ id: s.id, vlmSceneId: scene.id, baseParcel: '10,20', parcels: ['10,20', '11,20'], canManage: true })
  })

  it('a viewer role reads the location but may not manage it', async () => {
    const { owner, s } = await owned()
    const viewer = await createUser({ walletAddress: '0x' + 'b'.repeat(40) })
    const setupScene = (await db.select().from(locationSetups).where(eq(locationSetups.analyticsSceneId, s.id)))[0].vlmSceneId
    await db.insert(sceneRoles).values({ sceneId: setupScene, walletAddress: '0x' + 'b'.repeat(40), userId: viewer.id, role: 'viewer', grantedByUserId: owner.id })
    const [row] = (await get(viewer, '/api/analytics/locations')).json().scenes
    expect(row).toMatchObject({ id: s.id, canManage: false })
  })
```

Before writing these, read `test/helpers/factories.ts` and `test/helpers/setups.ts` and adapt to their real signatures (`createUser` options, whether `tokenFor` yields a verified wallet actor, how existing role tests insert `scene_roles` — copy that pattern, e.g. from `test/scene-roles*.test.ts` or `test/analytics-tenure.test.ts`). Add the imports `locationSetups`, `sceneRoles` from `../src/db/schema.js` if used. Also extend the existing ended-tenure test (`"an ended tenure's host only sees data from inside that tenure, and live is empty"`) with one assertion: the ended host's locations row has `vlmSceneId` equal to their own (ended) setup's scene and `canManage: false`.

- [ ] **Step 2: Run to verify they fail**

Run: `cd apps/server && npx vitest run test/analytics-read.test.ts`
Expected: the new tests FAIL (`vlmSceneId`/`canManage` undefined).

- [ ] **Step 3: Implement**

In `access.ts` add `vlmSceneId?: string` to `AnalyticsAccess`, return `vlmSceneId: active.vlmSceneId` from the active branch, `vlmSceneId: s.vlmSceneId` from the ended branch, and `vlmSceneId: scene.vlmSceneId ?? undefined` for admins.

In the locations handler, keep `access` per row and map:

```ts
      readable.push({ s, since: access.since, until: access.until, vlmSceneId: access.vlmSceneId, canManage: access.canManage })
      …
        vlmSceneId: vlmSceneId ?? null,
        baseParcel: s.baseParcel,
        parcels: s.parcels,
        canManage,
```

- [ ] **Step 4: Run the file, then the whole server suite**

Run: `cd apps/server && npx vitest run test/analytics-read.test.ts test/analytics-tenure.test.ts && npx vitest run`
Expected: all pass.

- [ ] **Step 5: Commit** — `feat(analytics): locations list carries scene id, parcels and manage flag`

---

### Task 2: In-world sign-in hand-off (server)

**Files:**
- Modify: `apps/server/src/db/schema.ts` (new table `authHandoffCodes`)
- Create: `apps/server/src/auth/sessions.ts` (shared session issuing)
- Modify: `apps/server/src/routes/wallet-auth.ts` (use the shared helper; behaviour unchanged)
- Create: `apps/server/src/routes/auth-handoff.ts`; register it in `apps/server/src/app.ts` next to `walletAuthRoutes`
- Modify: `apps/server/src/analytics/jobs.ts` (daily purge, next to `wallet-challenge-purge`)
- Modify: `apps/server/src/app.ts` (`Referrer-Policy: no-referrer` on `/auth/handoff` dashboard responses)
- Test: `apps/server/test/auth-handoff.test.ts`

**Interfaces:**
- Produces (schema):

```ts
export const authHandoffCodes = pgTable('auth_handoff_codes', {
  codeHash: text('code_hash').primaryKey(), // sha256(code) hex; the code itself is never stored
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  wallet: text('wallet').notNull(), // lowercased verified wallet from the HUD's token
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  usedAt: timestamp('used_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
})
```

  A brand-new table with a single-column text primary key: `drizzle-kit push` (run by `apps/server/entrypoint.sh` on deploy) creates it with plain `CREATE TABLE`, no prompts. Do **not** touch any existing table in this task. If `npx drizzle-kit push` against the local dev DB prompts or errors, stop and report it instead of working around it.
- Produces: `issueWalletSession(app: FastifyInstance, user: { id: string; email: string | null; role: string; activeOrgId: string | null; displayName: string | null }, wallet: string): { user: {...}; accessToken: string; refreshToken: string }` in `auth/sessions.ts` — exactly the claims and response the wallet sign-in builds today (`{ id, email, role, orgId, wallet, verified: true }`, `config.jwtAccessExpiry` / `config.jwtRefreshExpiry`). `wallet-auth.ts` calls it instead of building the response inline.
- Produces (HTTP):
  - `POST /api/auth/handoff` (preHandler `authenticate`) → `200 { code, expiresAt }`. Requires a non-refresh, non-guest token whose actor is `verified` with a `wallet` claim (the HUD's token from `POST /api/auth/platform` with a verified signed fetch); otherwise `401 { error: 'Sign-in hand-off needs a verified wallet' }`. Code = `randomBytes(32).toString('base64url')`; stored as `sha256(code)` hex with `expiresAt = now + 60 s`. Rate limit: `TokenBucketLimiter` (from `../analytics/limiter.js`), key `handoff:<userId>`, capacity 5, refill 5 per 60 s → `429 { error: 'rate_limited', retryAfter }`. On insert, also delete this user's rows that expired (`expires_at < now()`).
  - `POST /api/auth/handoff/exchange` `{ code }` (no auth) → `200` = `issueWalletSession(...)` for the code's user and wallet. Single use, atomically: `update auth_handoff_codes set used_at = now() where code_hash = $1 and used_at is null and expires_at > now() returning user_id, wallet`. No row (unknown, used, expired) or a malformed code → `410 { error: 'This sign-in link has expired' }`. Then `linkWalletGrants(user.id, wallet)` as the wallet sign-in does. Rate limit per IP (capacity 20, refill 20 per 60 s).
  - Daily job `auth-handoff-purge`: delete rows with `expires_at < now() - interval '1 day'`.

- [ ] **Step 1: Failing tests** — `apps/server/test/auth-handoff.test.ts`. Read `test/analytics-claims-signed.test.ts` (or whichever test exercises `POST /api/auth/platform`) and `test/helpers/factories.ts` to mint tokens the way real clients get them; for a verified-wallet bearer you can sign claims directly with the app's JWT (`app.jwt.sign({ id: user.id, email: null, role: user.role, orgId: null, wallet: '0x…', verified: true })`) if a factory doesn't exist — check `tokenFor` first. Cases:

```ts
  it('a verified wallet token gets a single-use code that exchanges for a session of the same user', async () => {
    // POST /api/auth/handoff with the verified token → 200 { code, expiresAt }; expiresAt ≈ now + 60 s
    // the DB row's code_hash = sha256(code) and no column contains the code itself
    // POST /api/auth/handoff/exchange { code } → 200; jwt.verify(accessToken) has id = user.id, wallet, verified: true
    // refreshToken verifies with refresh: true
    // second exchange with the same code → 410
  })
  it('unverified, guest and refresh tokens are refused', async () => { /* each → 401; no auth → 401 */ })
  it('expired and unknown codes are refused', async () => {
    // insert a row with expires_at = now - 1 s (hash of a known code) → exchange 410
    // random code → 410; missing/non-string code → 410 (or 400 — pick 410 for all, matching the spec)
  })
  it('limits code creation per user', async () => { /* 6th request within a minute → 429 */ })
```

  Write them as real tests (no comments left as bodies).

- [ ] **Step 2: Run to verify they fail** — `cd apps/server && npx vitest run test/auth-handoff.test.ts` → FAIL (404 routes, missing table). The test DB schema comes from the same Drizzle schema the other tests use (see `test/helpers/db.ts` / the vitest global setup) — add the table to `schema.ts` first if the harness needs it to compile.

- [ ] **Step 3: Implement** — schema table; `auth/sessions.ts`; refactor `wallet-auth.ts` to use it; routes; job; and in `app.ts`, in the dashboard `fastifyStatic` registration, add `setHeaders: (res, path) => { if (path.includes('/auth/handoff')) res.setHeader('Referrer-Policy', 'no-referrer') }` (the static export writes `auth/handoff/index.html`). The page also carries `<meta name="referrer" content="no-referrer">` (Task 5).

- [ ] **Step 4: Run** — `cd apps/server && npx vitest run test/auth-handoff.test.ts test/wallet-auth*.test.ts && npx vitest run`; then from `apps/server` with the local dev `DATABASE_URL`: `npx drizzle-kit push` → creates `auth_handoff_codes` with no prompts.

- [ ] **Step 5: Commit** — `feat(auth): single-use in-world sign-in hand-off codes`

---

### Task 3: Web test setup + range, next-path, breakdown and label helpers

**Files:**
- Modify: `apps/web/package.json` (devDependency `"vitest": "3.2.7"`, script `"test": "vitest run"`)
- Create: `apps/web/vitest.config.ts`
- Create: `apps/web/src/lib/analytics/range.ts`, `apps/web/src/lib/next-path.ts`, `apps/web/src/lib/analytics/breakdown.ts`, `apps/web/src/lib/analytics/labels.ts`
- Test: `apps/web/src/lib/analytics/range.test.ts`, `apps/web/src/lib/next-path.test.ts`, `apps/web/src/lib/analytics/breakdown.test.ts`, `apps/web/src/lib/analytics/labels.test.ts`

**Interfaces:**
- Produces:
  - `type RangeKey = '24h' | '7d' | '30d' | 'custom'`
  - `rangeQuery(key: RangeKey, now: Date, custom?: { from: string; to: string }): { from: string; to: string; bucket: 'hour' | 'day' } | { error: string }` — ISO strings; custom `from`/`to` are `YYYY-MM-DD` (local dates, inclusive: from 00:00 local to 23:59:59.999 local of `to`).
  - `safeNextPath(raw: string | null | undefined): string | null`
  - `topWithOther(counts: Record<string, number>, n = 8): Array<{ key: string; value: number }>`
  - `visitorLabel(s: { walletAddress: string | null; displayName: string | null; userId: string }): string`
  - `formatDuration(sec: number): string`

- [ ] **Step 1: Set up vitest**

`apps/web/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
})
```

Add `"test": "vitest run"` to scripts and `"vitest": "3.2.7"` to devDependencies; run `pnpm install` from the worktree root. Make sure `tsc --noEmit` (the `typecheck` script) still passes — if Next's tsconfig picks up `vitest.config.ts` or test files and fails, add them to `exclude` in `apps/web/tsconfig.json`.

- [ ] **Step 2: Write the failing tests**

`range.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { rangeQuery } from './range'

const now = new Date('2026-10-16T12:00:00Z')

describe('rangeQuery', () => {
  it('24h and 7d use hourly buckets ending now', () => {
    expect(rangeQuery('24h', now)).toEqual({ from: '2026-10-15T12:00:00.000Z', to: '2026-10-16T12:00:00.000Z', bucket: 'hour' })
    expect(rangeQuery('7d', now)).toMatchObject({ from: '2026-10-09T12:00:00.000Z', bucket: 'hour' })
  })
  it('30d uses daily buckets', () => {
    expect(rangeQuery('30d', now)).toMatchObject({ from: '2026-09-16T12:00:00.000Z', bucket: 'day' })
  })
  it('custom ranges are whole local days; over 7 days → daily buckets', () => {
    const r = rangeQuery('custom', now, { from: '2026-10-01', to: '2026-10-10' }) as any
    expect(new Date(r.from).getTime()).toBe(new Date(2026, 9, 1, 0, 0, 0, 0).getTime())
    expect(new Date(r.to).getTime()).toBe(new Date(2026, 9, 10, 23, 59, 59, 999).getTime())
    expect(r.bucket).toBe('day')
    expect((rangeQuery('custom', now, { from: '2026-10-14', to: '2026-10-15' }) as any).bucket).toBe('hour')
  })
  it('refuses inverted, missing and over-400-day custom ranges', () => {
    expect(rangeQuery('custom', now, { from: '2026-10-10', to: '2026-10-01' })).toHaveProperty('error')
    expect(rangeQuery('custom', now)).toHaveProperty('error')
    expect(rangeQuery('custom', now, { from: '2025-01-01', to: '2026-10-01' })).toHaveProperty('error')
  })
})
```

`next-path.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { safeNextPath } from './next-path'

describe('safeNextPath', () => {
  it('accepts same-origin paths with query strings', () => {
    expect(safeNextPath('/analytics/?scene=abc')).toBe('/analytics/?scene=abc')
    expect(safeNextPath('/scenes')).toBe('/scenes')
  })
  it('rejects anything that could leave the site', () => {
    for (const bad of ['//evil.com', '/\\evil.com', 'https://evil.com', 'javascript:alert(1)', 'analytics', '', null, undefined, '/%2F%2Fevil.com'.replace('%2F%2F', '//')]) {
      expect(safeNextPath(bad as any)).toBeNull()
    }
  })
})
```

`breakdown.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { topWithOther } from './breakdown'

describe('topWithOther', () => {
  it('sorts descending, keeps the top n and sums the rest as Other', () => {
    const counts = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i + 1]))
    const out = topWithOther(counts, 8)
    expect(out).toHaveLength(9)
    expect(out[0]).toEqual({ key: 'k9', value: 10 })
    expect(out.at(-1)).toEqual({ key: 'Other', value: 1 + 2 })
  })
  it('no Other row when everything fits; empty input → empty list; zero counts dropped', () => {
    expect(topWithOther({ a: 2, b: 1 })).toEqual([{ key: 'a', value: 2 }, { key: 'b', value: 1 }])
    expect(topWithOther({})).toEqual([])
    expect(topWithOther({ a: 0, b: 3 })).toEqual([{ key: 'b', value: 3 }])
  })
})
```

`labels.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { visitorLabel, formatDuration } from './labels'

describe('visitorLabel', () => {
  it('prefers a display name, then a short wallet, then the hash prefix', () => {
    expect(visitorLabel({ displayName: 'Ana', walletAddress: '0xabcdef0123456789abcdef0123456789abcdef01', userId: 'f00dbabe12345678' })).toBe('Ana')
    expect(visitorLabel({ displayName: null, walletAddress: '0xabcdef0123456789abcdef0123456789abcdef01', userId: 'f00dbabe12345678' })).toBe('0xabcd…ef01')
    expect(visitorLabel({ displayName: null, walletAddress: null, userId: 'f00dbabe12345678' })).toBe('Visitor f00dbabe')
  })
})

describe('formatDuration', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatDuration(42)).toBe('42s')
    expect(formatDuration(125)).toBe('2m 5s')
    expect(formatDuration(3720)).toBe('1h 2m')
    expect(formatDuration(0)).toBe('0s')
  })
})
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd apps/web && npx vitest run`
Expected: FAIL (modules not found).

- [ ] **Step 4: Implement**

`range.ts`:

```ts
export type RangeKey = '24h' | '7d' | '30d' | 'custom'
export type RangeQuery = { from: string; to: string; bucket: 'hour' | 'day' }

const DAY = 86_400_000
const MAX_DAYS = 400
const PRESET: Record<Exclude<RangeKey, 'custom'>, { days: number; bucket: 'hour' | 'day' }> = {
  '24h': { days: 1, bucket: 'hour' },
  '7d': { days: 7, bucket: 'hour' },
  '30d': { days: 30, bucket: 'day' },
}

function localDay(s: string, end: boolean): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  const d = end ? new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999) : new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0)
  return Number.isNaN(d.getTime()) ? null : d
}

export function rangeQuery(key: RangeKey, now: Date, custom?: { from: string; to: string }): RangeQuery | { error: string } {
  if (key !== 'custom') {
    const p = PRESET[key]
    return { from: new Date(now.getTime() - p.days * DAY).toISOString(), to: now.toISOString(), bucket: p.bucket }
  }
  const from = custom && localDay(custom.from, false)
  const to = custom && localDay(custom.to, true)
  if (!from || !to) return { error: 'Pick a start and end date' }
  if (from > to) return { error: 'The start date must be before the end date' }
  if (to.getTime() - from.getTime() > MAX_DAYS * DAY) return { error: 'Pick a range of at most 400 days' }
  return { from: from.toISOString(), to: to.toISOString(), bucket: to.getTime() - from.getTime() > 7 * DAY ? 'day' : 'hour' }
}
```

`next-path.ts`:

```ts
/** A post-sign-in destination: same-origin absolute paths only (no `//host`, no `/\host`, no schemes). */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw || raw[0] !== '/' || raw[1] === '/' || raw[1] === '\\') return null
  if (/[\u0000-\u001f]/.test(raw)) return null
  try {
    const u = new URL(raw, 'https://vlm.invalid')
    if (u.origin !== 'https://vlm.invalid') return null
    return u.pathname + u.search + u.hash
  } catch {
    return null
  }
}
```

`breakdown.ts`:

```ts
export function topWithOther(counts: Record<string, number>, n = 8): Array<{ key: string; value: number }> {
  const sorted = Object.entries(counts ?? {})
    .map(([key, value]) => ({ key, value: Number(value) }))
    .filter((x) => x.value > 0)
    .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key))
  if (sorted.length <= n) return sorted
  const rest = sorted.slice(n).reduce((a, x) => a + x.value, 0)
  return [...sorted.slice(0, n), { key: 'Other', value: rest }]
}
```

`labels.ts`:

```ts
export function visitorLabel(s: { walletAddress: string | null; displayName: string | null; userId: string }): string {
  if (s.displayName) return s.displayName
  if (s.walletAddress) return `${s.walletAddress.slice(0, 6)}…${s.walletAddress.slice(-4)}`
  return `Visitor ${s.userId.slice(0, 8)}`
}

export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}
```

(`topWithOther` test expectation: k0..k9 have values 1..10; top 8 are k9..k2, Other = k1 + k0 = 2 + 1 = 3 — the test writes `1 + 2`.)

- [ ] **Step 5: Run to verify they pass; typecheck**

Run: `cd apps/web && npx vitest run && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit** — `test(web): vitest; analytics range, next-path, breakdown and label helpers`

---

### Task 4: Parcel-map geometry and chart scales

**Files:**
- Create: `apps/web/src/lib/analytics/parcel-map.ts`, `apps/web/src/lib/analytics/scale.ts`
- Test: `apps/web/src/lib/analytics/parcel-map.test.ts`, `apps/web/src/lib/analytics/scale.test.ts`

**Coordinate convention (verified in code):** the DCL probe records `Transform` of `engine.PlayerEntity` (`packages/vlm-adapter-dcl/src/analytics.ts`), which in SDK7 is scene-relative metres: origin at the south-west corner of the scene's **base parcel**, +x east, +z north. Heatmap cells are `floor(x)`, `floor(z)` (1 m). Parcel `"px,py"` therefore covers local `x ∈ [(px−bx)·16, (px−bx)·16+16)`, `z ∈ [(py−by)·16, (py−by)·16+16)`, where `"bx,by"` is `baseParcel`.

**Interfaces:**
- Produces:
  - `type MapBounds = { minX: number; minZ: number; maxX: number; maxZ: number }` (local metres)
  - `parcelRects(parcels: string[], baseParcel: string | null): Array<{ label: string; x: number; z: number; size: 16 }>`
  - `mapBounds(parcels: string[], baseParcel: string | null, points: Array<{ x: number; z: number }>): MapBounds` — parcel extent when parcels exist; otherwise the data extent padded and snapped out to 16 m; nothing at all → one tile `{0,0,16,16}`.
  - `toSvg(b: MapBounds, width: number): { height: number; px: (x: number) => number; py: (z: number) => number }` — north up (larger z → smaller SVG y), aspect preserved.
  - `linearScale(domain: [number, number], range: [number, number]): (v: number) => number`
  - `niceTicks(max: number, count = 4): number[]` — 0-based, "nice" steps (1, 2, 5 × 10ⁿ), last tick ≥ max; `max <= 0` → `[0, 1]`.

- [ ] **Step 1: Write the failing tests**

`parcel-map.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parcelRects, mapBounds, toSvg } from './parcel-map'

describe('parcel map geometry', () => {
  it('places parcels relative to the base parcel in 16 m tiles', () => {
    expect(parcelRects(['10,20', '11,20', '10,21'], '10,20')).toEqual([
      { label: '10,20', x: 0, z: 0, size: 16 },
      { label: '11,20', x: 16, z: 0, size: 16 },
      { label: '10,21', x: 0, z: 16, size: 16 },
    ])
  })
  it('handles a base parcel that is not the south-west-most parcel', () => {
    expect(parcelRects(['5,5', '4,5'], '5,5').map((r) => r.x)).toEqual([0, -16])
  })
  it('bounds cover all parcels', () => {
    expect(mapBounds(['10,20', '11,21'], '10,20', [])).toEqual({ minX: 0, minZ: 0, maxX: 32, maxZ: 32 })
  })
  it('a location without parcels fits the data, snapped to 16 m', () => {
    expect(mapBounds([], null, [{ x: 3, z: 40 }, { x: 20, z: 2 }])).toEqual({ minX: 0, minZ: 0, maxX: 32, maxZ: 48 })
  })
  it('no parcels and no data → one tile', () => {
    expect(mapBounds([], null, [])).toEqual({ minX: 0, minZ: 0, maxX: 16, maxZ: 16 })
  })
  it('toSvg keeps aspect and puts north up', () => {
    const t = toSvg({ minX: 0, minZ: 0, maxX: 32, maxZ: 16 }, 320)
    expect(t.height).toBe(160)
    expect(t.px(0)).toBe(0)
    expect(t.px(32)).toBe(320)
    expect(t.py(16)).toBe(0)
    expect(t.py(0)).toBe(160)
  })
})
```

`scale.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { linearScale, niceTicks } from './scale'

describe('scales', () => {
  it('linearScale maps domain to range', () => {
    const s = linearScale([0, 10], [100, 0])
    expect(s(0)).toBe(100)
    expect(s(5)).toBe(50)
    expect(s(10)).toBe(0)
  })
  it('linearScale with an empty domain maps to the range start', () => {
    expect(linearScale([3, 3], [0, 50])(3)).toBe(0)
  })
  it('niceTicks picks 1/2/5 steps covering the max', () => {
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8])
    expect(niceTicks(100)).toEqual([0, 50, 100])
    expect(niceTicks(0)).toEqual([0, 1])
    expect(niceTicks(3)).toEqual([0, 1, 2, 3])
  })
})
```

(`niceTicks(100)` with count 4: raw step 25 → nice step 50 → `[0, 50, 100]`. `niceTicks(7)`: raw 1.75 → 2 → `[0,2,4,6,8]`. `niceTicks(3)`: raw 0.75 → 1 → `[0,1,2,3]`. Implement so these hold: nice step = smallest of {1,2,5}×10ⁿ that is ≥ raw step.)

- [ ] **Step 2: Run to verify they fail** — `cd apps/web && npx vitest run src/lib/analytics` → FAIL.

- [ ] **Step 3: Implement**

`parcel-map.ts`:

```ts
export type MapBounds = { minX: number; minZ: number; maxX: number; maxZ: number }
const TILE = 16

function parse(p: string | null): [number, number] | null {
  const m = p ? /^(-?\d+),(-?\d+)$/.exec(p.trim()) : null
  return m ? [Number(m[1]), Number(m[2])] : null
}

export function parcelRects(parcels: string[], baseParcel: string | null) {
  const base = parse(baseParcel) ?? parse(parcels[0] ?? null)
  if (!base) return []
  return parcels.flatMap((label) => {
    const p = parse(label)
    return p ? [{ label, x: (p[0] - base[0]) * TILE, z: (p[1] - base[1]) * TILE, size: TILE as 16 }] : []
  })
}

export function mapBounds(parcels: string[], baseParcel: string | null, points: Array<{ x: number; z: number }>): MapBounds {
  const rects = parcelRects(parcels, baseParcel)
  if (rects.length) {
    return {
      minX: Math.min(...rects.map((r) => r.x)),
      minZ: Math.min(...rects.map((r) => r.z)),
      maxX: Math.max(...rects.map((r) => r.x + TILE)),
      maxZ: Math.max(...rects.map((r) => r.z + TILE)),
    }
  }
  if (!points.length) return { minX: 0, minZ: 0, maxX: TILE, maxZ: TILE }
  const snapDown = (v: number) => Math.floor(v / TILE) * TILE
  const snapUp = (v: number) => (Math.floor(v / TILE) + 1) * TILE
  return {
    minX: snapDown(Math.min(...points.map((p) => p.x))),
    minZ: snapDown(Math.min(...points.map((p) => p.z))),
    maxX: snapUp(Math.max(...points.map((p) => p.x))),
    maxZ: snapUp(Math.max(...points.map((p) => p.z))),
  }
}

export function toSvg(b: MapBounds, width: number) {
  const w = b.maxX - b.minX
  const h = b.maxZ - b.minZ
  const k = width / w
  return { height: h * k, px: (x: number) => (x - b.minX) * k, py: (z: number) => (b.maxZ - z) * k }
}
```

Note: the data-fit example `[{3,40},{20,2}]` → `minX 0, minZ 0, maxX 32, maxZ 48` (20 → 32, 40 → 48).

`scale.ts`:

```ts
export function linearScale([d0, d1]: [number, number], [r0, r1]: [number, number]) {
  const span = d1 - d0
  return (v: number) => (span === 0 ? r0 : r0 + ((v - d0) / span) * (r1 - r0))
}

export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1]
  const raw = max / count
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw)!
  const ticks: number[] = []
  for (let t = 0; t < max + step; t += step) {
    ticks.push(Number(t.toPrecision(12)))
    if (t >= max) break
  }
  return ticks
}
```

- [ ] **Step 4: Run to verify they pass** — `cd apps/web && npx vitest run && npx tsc --noEmit` → PASS.

- [ ] **Step 5: Commit** — `feat(web): parcel-map geometry and chart scales for analytics`

---

### Task 5: Sign-in returns to the page you came from; hand-off page

**Files:**
- Modify: `apps/web/src/app/(dashboard)/layout.tsx`
- Modify: `apps/web/src/app/page.tsx`
- Modify: `apps/web/src/app/auth/callback/page.tsx`
- Create: `apps/web/src/lib/handoff.ts`, `apps/web/src/lib/handoff.test.ts`, `apps/web/src/app/auth/handoff/page.tsx`

**Interfaces:**
- Consumes: `safeNextPath` (Task 3, `@/lib/next-path`).
- Produces: signed-out visits to any dashboard page go to `/?next=<encoded path+query>`; after sign-in (email, wallet, or OAuth callback) the user lands on `safeNextPath(next) ?? '/scenes'`. OAuth: the home page stores the sanitised `next` in `sessionStorage['vlm_next']` before redirecting to the provider; the callback reads and clears it.

- [ ] **Step 1: Layout redirect** — in `layout.tsx` replace `router.push('/')` with:

```ts
    if (!loading && !user) {
      const here = window.location.pathname + window.location.search
      router.push(`/?next=${encodeURIComponent(here)}`)
    }
```

- [ ] **Step 2: Home page** — read `next` once with `useSearchParams` (wrap the page body in `<Suspense>` as other pages using `useSearchParams` do, because the static export requires it) and compute `const dest = safeNextPath(searchParams.get('next')) ?? '/scenes'`. Replace all three `router.push('/scenes')` with `router.push(dest)`. Find the OAuth (Google/Discord) buttons in this file; in their click handlers, before navigating, run `try { if (dest !== '/scenes') sessionStorage.setItem('vlm_next', dest) } catch {}`.

- [ ] **Step 3: OAuth callback** — replace `window.location.href = '/scenes'` with:

```ts
      let dest = '/scenes'
      try {
        dest = safeNextPath(sessionStorage.getItem('vlm_next')) ?? '/scenes'
        sessionStorage.removeItem('vlm_next')
      } catch {}
      window.location.href = dest
```

- [ ] **Step 4: Verify** — `cd apps/web && npx tsc --noEmit && npx vitest run`. Then manual: `pnpm dev` in `apps/web` (with the local server on 3010), sign out, open `http://localhost:3000/analytics/?scene=x` → lands on `/?next=%2Fanalytics%2F%3Fscene%3Dx`; sign in → back on `/analytics/?scene=x`. Open `http://localhost:3000/?next=//example.com`, sign in → `/scenes`.

- [ ] **Step 5: Hand-off page — failing test first.** Create `apps/web/src/lib/handoff.ts` with a pure, injectable runner and `apps/web/src/lib/handoff.test.ts`:

```ts
// handoff.ts
import { safeNextPath } from './next-path'

export interface HandoffDeps {
  href: string                                   // window.location.href at load
  replaceUrl: (url: string) => void              // history.replaceState(null, '', url)
  exchange: (code: string) => Promise<{ status: number; body?: { accessToken: string; refreshToken: string; user: unknown } }>
  saveSession: (s: { token: string; refresh: string; user: unknown }) => void // localStorage 'vlm_auth', same shape as auth/callback
  go: (url: string) => void                      // window.location.href = url (full load so AuthProvider reads the session)
}

/** Strips the code from the URL before anything else, exchanges it once, then goes to `next` (signed in) or to sign-in with `next`. */
export async function runHandoff(d: HandoffDeps): Promise<'signed-in' | 'fallback'> {
  const u = new URL(d.href)
  const code = u.searchParams.get('code')
  const next = safeNextPath(u.searchParams.get('next')) ?? '/analytics/'
  u.searchParams.delete('code')
  d.replaceUrl(u.pathname + (u.searchParams.toString() ? `?${u.searchParams}` : ''))
  if (code) {
    try {
      const r = await d.exchange(code)
      if (r.status === 200 && r.body) {
        d.saveSession({ token: r.body.accessToken, refresh: r.body.refreshToken, user: r.body.user })
        d.go(next)
        return 'signed-in'
      }
    } catch {
      /* network error → normal sign-in */
    }
  }
  d.go(`/?next=${encodeURIComponent(next)}`)
  return 'fallback'
}
```

```ts
// handoff.test.ts
import { describe, it, expect, vi } from 'vitest'
import { runHandoff } from './handoff'

const base = 'https://vlm.gg/auth/handoff/?code=SECRET&next=%2Fanalytics%2F%3Fscene%3Dabc'

function deps(status: number) {
  const calls: string[] = []
  return {
    calls,
    d: {
      href: base,
      replaceUrl: vi.fn((u: string) => calls.push(`replace:${u}`)),
      exchange: vi.fn(async (c: string) => { calls.push(`exchange:${c}`); return status === 200 ? { status, body: { accessToken: 'a', refreshToken: 'r', user: { id: 'u' } } } : { status } }),
      saveSession: vi.fn(),
      go: vi.fn((u: string) => calls.push(`go:${u}`)),
    },
  }
}

describe('runHandoff', () => {
  it('removes the code from the URL before exchanging, then signs in and goes to next', async () => {
    const { calls, d } = deps(200)
    expect(await runHandoff(d)).toBe('signed-in')
    expect(calls[0]).toBe('replace:/auth/handoff/?next=%2Fanalytics%2F%3Fscene%3Dabc')
    expect(calls[1]).toBe('exchange:SECRET')
    expect(d.saveSession).toHaveBeenCalledWith({ token: 'a', refresh: 'r', user: { id: 'u' } })
    expect(calls.at(-1)).toBe('go:/analytics/?scene=abc')
  })
  it('a used or expired code (410) falls back to sign-in with the same next', async () => {
    const { calls, d } = deps(410)
    expect(await runHandoff(d)).toBe('fallback')
    expect(d.saveSession).not.toHaveBeenCalled()
    expect(calls.at(-1)).toBe(`go:/?next=${encodeURIComponent('/analytics/?scene=abc')}`)
  })
  it('an off-site next is ignored', async () => {
    const { d } = deps(200)
    d.href = 'https://vlm.gg/auth/handoff/?code=X&next=%2F%2Fevil.com'
    await runHandoff(d)
    expect(d.go).toHaveBeenLastCalledWith('/analytics/')
  })
})
```

  Run `cd apps/web && npx vitest run src/lib/handoff.test.ts` → FAIL first, then add `handoff.ts` → PASS.

- [ ] **Step 6: Hand-off page** — `apps/web/src/app/auth/handoff/page.tsx` (client component, `<Suspense>` wrapper like `auth/callback`): renders "Signing you in…" and `<meta name="referrer" content="no-referrer" />`; in a `useEffect` that runs once (guard with a ref so React strict mode can't exchange twice) calls `runHandoff` with `href: window.location.href`, `replaceUrl: (u) => history.replaceState(null, '', u)`, `exchange: (code) => fetch(`${API_URL}/api/auth/handoff/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) }).then(async (r) => ({ status: r.status, body: r.ok ? await r.json() : undefined }))`, `saveSession: (s) => localStorage.setItem('vlm_auth', JSON.stringify(s))` (exactly the shape `auth/callback` writes — check it), `go: (u) => { window.location.href = u }`. Nothing is exchanged during render (static export: there is no server render at all; the exchange only happens in the effect).
  If a user is already signed in when the page loads, still run the hand-off (the in-world wallet wins; it replaces the stored session).

- [ ] **Step 7: Verify** — `cd apps/web && npx vitest run && npx tsc --noEmit`.

- [ ] **Step 8: Commit** — `feat(web): return to the requested page after sign-in; in-world hand-off page`


---

### Task 6: Analytics API client and error status

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Create: `apps/web/src/lib/analytics/types.ts`

**Interfaces:**
- Produces in `types.ts` (mirror the server responses in `apps/server/src/routes/analytics-read.ts` exactly):

```ts
export interface AnalyticsLocation {
  id: string; locationKey: string; kind: 'parcels' | 'world' | string; title: string | null
  walletVisibility: boolean; verifiedSessionShare: number; since: string | null; until: string | null
  vlmSceneId: string | null; baseParcel: string | null; parcels: string[]; canManage: boolean
}
export interface AnalyticsSummary {
  sessions: number; uniqueVisitors: number; newVisitors: number; returningVisitors: number
  peakConcurrency: number; dwellAvgSec: number; verifiedShare: number
  interactions: Record<string, number>; emotes: Record<string, number>; countries: Record<string, number>; platforms: Record<string, number>
}
export interface TimeseriesPoint { t: string; sessions: number; uniqueVisitors: number; peakConcurrency: number; dwellAvgSec: number }
export interface LiveData { count: number; positions: Array<{ x: number; z: number }> }
export interface HeatCell { x: number; z: number; dwell: number; visits: number }
export interface AnalyticsSession {
  id: string; userId: string; walletAddress: string | null; displayName: string | null
  platform: string | null; country: string | null; startedAt: string; endedAt: string | null; durationSec: number; isReturning: boolean; verified: boolean
}
```

  Read the real `kind` enum values (`analyticsSceneKindEnum` in `apps/server/src/db/schema.ts`) and the heatmap response key (the handler's `reply.send` — e.g. `{ cells }`) and match them.
- Produces in `useApi()`: `getAnalyticsLocations()`, `getAnalyticsSummary(id, q)`, `getAnalyticsTimeseries(id, q)` (q includes `bucket`), `getAnalyticsLive(id)`, `getAnalyticsHeatmap(id, q)`, `getAnalyticsSessions(id, cursor?)` (limit 50), `setAnalyticsWalletVisibility(id, on)` — paths `/api/analytics/locations…`, query strings built with `URLSearchParams`.
- Produces: errors thrown by `apiFetch` carry `status: number` (`Object.assign(new Error(msg), { status: res.status })`) so pages can tell 403/404 from network failures.
- This task only adds. The legacy `getSceneAnalyticsRecent` / `getSceneAnalyticsSessions` are removed in Task 8 together with the old page that uses them.

- [ ] **Step 1: Add the types file and the methods.**
- [ ] **Step 2: `cd apps/web && npx tsc --noEmit`** → passes.
- [ ] **Step 3: Commit** — `feat(web): analytics location API client`

---

### Task 7: Chart components (SVG)

**Before starting:** load the `dataviz` skill and follow it for colour tokens, axes, gridlines, tooltips, number formatting and accessibility. Define chart colours as CSS variables in `apps/web/src/app/globals.css` (e.g. `--chart-1`, `--chart-grid`, `--chart-axis`, `--heat-0…--heat-5`) under `:root` (the site is dark) so a light theme can override them later.

**Files:**
- Create: `apps/web/src/components/analytics/StatCard.tsx`, `TimeSeriesChart.tsx`, `BarList.tsx`, `ParcelMap.tsx`, `Section.tsx`
- Modify: `apps/web/src/app/globals.css` (chart tokens)

**Interfaces:**
- Consumes: `linearScale`, `niceTicks` (Task 4), `parcelRects`, `mapBounds`, `toSvg` (Task 4), `topWithOther` (Task 3), types (Task 6).
- Produces (props):
  - `StatCard({ label, value, hint? }: { label: string; value: string; hint?: string })`
  - `TimeSeriesChart({ points, series, bucket }: { points: TimeseriesPoint[]; series: 'uniqueVisitors' | 'sessions' | 'peakConcurrency'; bucket: 'hour' | 'day' })` — responsive width (`viewBox` + `width="100%"`), area + line, y ticks from `niceTicks`, ~6 x labels (local time; day buckets labelled with the UTC date and the axis caption "(UTC days)"), hover/focus tooltip showing the bucket and value. Missing buckets are drawn as zero (the API omits empty hours/days: fill the gaps from `from` to `to` at the bucket step before drawing — put that gap-filler in `apps/web/src/lib/analytics/fill.ts` with a unit test: 3 hourly points with a 2-hour gap → 5 points, gaps zero).
  - `BarList({ title, counts }: { title: string; counts: Record<string, number> })` — uses `topWithOther`, horizontal bars with values; empty → "None yet".
  - `ParcelMap({ parcels, baseParcel, cells, metric, live }: { parcels: string[]; baseParcel: string | null; cells?: HeatCell[]; metric?: 'dwell' | 'visits'; live?: LiveData['positions'] })` — parcel tiles with labels (`label` from `parcelRects`), heat cells as 1 m rects shaded on a 6-step sequential scale by `metric` (quantised against the max), live positions as dots; one SVG used by both the Heatmap and Here-now sections; bounds from `mapBounds(parcels, baseParcel, [...cells, ...live])`.
  - `Section({ title, action?, state, onRetry, children })` where `state: 'loading' | 'error' | 'empty' | 'ready'` renders "Loading…", "Couldn't load — Retry", "No visits recorded yet", or children.

- [ ] **Step 1: Write the `fill.ts` test first** (`apps/web/src/lib/analytics/fill.test.ts`):

```ts
import { describe, it, expect } from 'vitest'
import { fillBuckets } from './fill'

describe('fillBuckets', () => {
  it('adds zero points for missing hourly buckets', () => {
    const pts = [
      { t: '2026-10-16T00:00:00.000Z', sessions: 1, uniqueVisitors: 1, peakConcurrency: 1, dwellAvgSec: 10 },
      { t: '2026-10-16T03:00:00.000Z', sessions: 2, uniqueVisitors: 2, peakConcurrency: 1, dwellAvgSec: 10 },
      { t: '2026-10-16T04:00:00.000Z', sessions: 1, uniqueVisitors: 1, peakConcurrency: 1, dwellAvgSec: 10 },
    ]
    const out = fillBuckets(pts, '2026-10-16T00:00:00.000Z', '2026-10-16T04:30:00.000Z', 'hour')
    expect(out.map((p) => p.sessions)).toEqual([1, 0, 0, 2, 1])
  })
  it('day buckets step in UTC days', () => {
    const out = fillBuckets([], '2026-10-14T10:00:00.000Z', '2026-10-16T10:00:00.000Z', 'day')
    expect(out.map((p) => p.t)).toEqual(['2026-10-14T00:00:00.000Z', '2026-10-15T00:00:00.000Z', '2026-10-16T00:00:00.000Z'])
  })
})
```

  Implement `fillBuckets(points, from, to, bucket)`: start at `from` truncated to the UTC hour/day, step 1 h / 1 day while `≤ to`, emit the existing point (matched by timestamp ms) or a zero point. Run `npx vitest run` → PASS.

- [ ] **Step 2: Build the components** per the props above. Keep each file focused (< ~200 lines). No component state beyond hover.
- [ ] **Step 3: `cd apps/web && npx tsc --noEmit && npx vitest run`** → passes.
- [ ] **Step 4: Commit** — `feat(web): analytics chart components`

---

### Task 8: The Analytics page

**Files:**
- Rewrite: `apps/web/src/app/(dashboard)/analytics/page.tsx` (remove the legacy page entirely)
- Create: `apps/web/src/app/(dashboard)/analytics/LocationList.tsx`, `apps/web/src/app/(dashboard)/analytics/Dashboard.tsx`
- Modify: `apps/web/src/lib/api.ts` (remove `getSceneAnalyticsRecent`, `getSceneAnalyticsSessions`)

**Interfaces:**
- Consumes: everything from Tasks 3–7.
- URL contract (static page, query parameters only):
  - `/analytics/` → location list; if exactly one location, `router.replace('/analytics/?location=<id>')`.
  - `/analytics/?location=<id>` → dashboard for that location (row looked up in `getAnalyticsLocations()`; not in the list → "You don't have access to this scene's analytics" + link to `/analytics/`).
  - `/analytics/?scene=<vlmSceneId>` → find the row with that `vlmSceneId`, `router.replace('/analytics/?location=<id>')`; none → list with the note "This scene has no analytics you can see yet."

- [ ] **Step 1: Page shell** — `page.tsx` is a client component wrapped in `<Suspense>`; reads `location` / `scene` via `useSearchParams`, loads `getAnalyticsLocations()` once, and renders `LocationList` or `Dashboard`. Delete the legacy code and the two legacy `api.ts` methods.
- [ ] **Step 2: `LocationList`** — cards: title (fallback: location key), "Genesis City" or "World" (from `kind`), location key, and "Data from <since> to <until>" when `until` is set. Empty → "No analytics yet. Analytics start as soon as a scene with `vlm-dcl` gets visitors; set the scene up in-world from the VLM HUD to see them here."
- [ ] **Step 3: `Dashboard`** — sections in the spec's order (§3 Dashboard contents 1–8):
  - Header: title, location key, range picker (buttons 24 h / 7 d / 30 d / Custom; Custom shows two `<input type="date">`; errors from `rangeQuery` shown inline and no request is made), "Data updates hourly", verified share badge (`Math.round(verifiedShare*100)% verified wallets`).
  - Summary cards (`summary`): Visitors (`uniqueVisitors`), New / returning, Sessions, Peak at once (`peakConcurrency`), Avg. time (`formatDuration(dwellAvgSec)`).
  - Visitors over time: `TimeSeriesChart` with a series switch (Visitors / Sessions / Peak at once) on `fillBuckets(points, q.from, q.to, q.bucket)`.
  - Here now: `getAnalyticsLive` polled every 15 s via `setTimeout` chaining; skip while `document.visibilityState === 'hidden'` (resume on `visibilitychange`); after an error wait 60 s; clear on unmount and when the location changes. Shows "N here now" + `ParcelMap` with `live`. Hidden when the location's `until` is set (ended tenure).
  - Heatmap: `ParcelMap` with `cells` and a Dwell / Visits toggle.
  - Breakdowns: four `BarList`s (Interactions, Emotes, Countries, Platforms) in a responsive grid.
  - Sessions: table (Started (local), Duration, Visitor via `visitorLabel`, Platform, Country, Returning) + "Load more" using `nextCursor`; on phones the table scrolls horizontally inside its own container (no page scroll).
  - Settings: only when `canManage`: a checkbox "Record visitor wallets and names" bound to `walletVisibility`, calling `setAnalyticsWalletVisibility`, with "Applies to new visits. Visitors see a notice while this is on. Turning it off removes stored wallets and names." and optimistic update with rollback on error.
  - Each section owns its own loading/error state via `Section`; one failing request doesn't blank the page. `summary`, `timeseries`, `heatmap` reload when the range changes; `sessions` does not depend on the range (the API pages by most recent) — label it "Recent visits".
  - Error mapping: `err.status === 403 || 404` → the no-access message; anything else → the section's retry state.
- [ ] **Step 4: Layout** — `max-w-6xl`, cards in `grid grid-cols-2 md:grid-cols-5 gap-3`, sections `rounded-xl bg-gray-900 p-4`. At 375 px width there is no horizontal page scroll (check in the browser's responsive mode).
- [ ] **Step 5: Verify** — `cd apps/web && npx tsc --noEmit && npx vitest run && NODE_ENV=production npx next build` (the static export must succeed; `/analytics/index.html` exists in `out/`).
- [ ] **Step 6: Commit** — `feat(web): analytics dashboard on the location read API`

---

### Task 9: HUD **Stats** tab opens the dashboard

**Files:**
- Create: `packages/vlm-core/src/dashboard-url.ts`; export it from `packages/vlm-core/src/index.ts`
- Test: `packages/vlm-core/test/dashboard-url.test.ts`
- Modify: `packages/vlm-adapter-dcl/src/DclHUDRenderer.tsx` (NavBar)
- Modify: `packages/vlm-adapter-dcl/src/index.ts` (scene action handler)
- Modify: `packages/vlm-client/src/http.ts` (`createHandoff`)

**Interfaces:**
- Produces: `dashboardUrlFor(apiUrl: string): string` — the website origin for an API URL:
  - `https://api.vlm.gg` → `https://vlm.gg`
  - `https://staging-api.vlm.gg` → `https://staging.vlm.gg`
  - `http://localhost:3010` / `http://127.0.0.1:3010` → `http://localhost:3000` (the web dev server)
  - anything else → the API URL's own origin (self-hosted servers serve the dashboard themselves)
  - invalid → `https://vlm.gg`
- Produces: `analyticsUrlFor(apiUrl: string, sceneId: string): string` = `${dashboardUrlFor(apiUrl)}/analytics/?scene=${encodeURIComponent(sceneId)}`.
- Produces: `handoffUrlFor(apiUrl: string, code: string, next: string): string` = `${dashboardUrlFor(apiUrl)}/auth/handoff/?code=${encodeURIComponent(code)}&next=${encodeURIComponent(next)}`.
- Produces: `VLMHttpClient.createHandoff(): Promise<{ code: string; expiresAt: string }>` — `POST /api/auth/handoff` with the client's current bearer token (via `_fetch`).
- Produces: scene action `'open_analytics'` handled for every connected role.

- [ ] **Step 1: Failing test** (`dashboard-url.test.ts`):

```ts
import { describe, it, expect } from 'vitest'
import { dashboardUrlFor, analyticsUrlFor, handoffUrlFor } from '../src/dashboard-url.js'

describe('dashboardUrlFor', () => {
  it('maps known API hosts to the website', () => {
    expect(dashboardUrlFor('https://api.vlm.gg')).toBe('https://vlm.gg')
    expect(dashboardUrlFor('https://api.vlm.gg/')).toBe('https://vlm.gg')
    expect(dashboardUrlFor('https://staging-api.vlm.gg')).toBe('https://staging.vlm.gg')
    expect(dashboardUrlFor('http://localhost:3010')).toBe('http://localhost:3000')
    expect(dashboardUrlFor('http://127.0.0.1:3010')).toBe('http://localhost:3000')
  })
  it('self-hosted servers serve their own dashboard', () => {
    expect(dashboardUrlFor('https://vlm.example.com:8443/base')).toBe('https://vlm.example.com:8443')
  })
  it('falls back to vlm.gg for garbage', () => {
    expect(dashboardUrlFor('not a url')).toBe('https://vlm.gg')
  })
  it('builds the analytics deep link', () => {
    expect(analyticsUrlFor('https://api.vlm.gg', 'abc-123')).toBe('https://vlm.gg/analytics/?scene=abc-123')
  })
  it('builds the hand-off link with the code and next encoded', () => {
    expect(handoffUrlFor('https://api.vlm.gg', 'a+b/c', '/analytics/?scene=abc')).toBe('https://vlm.gg/auth/handoff/?code=a%2Bb%2Fc&next=%2Fanalytics%2F%3Fscene%3Dabc')
  })
})
```

Run `cd packages/vlm-core && npx vitest run test/dashboard-url.test.ts` → FAIL.

- [ ] **Step 2: Implement** `dashboard-url.ts`:

```ts
export function dashboardUrlFor(apiUrl: string): string {
  let u: URL
  try {
    u = new URL(apiUrl)
  } catch {
    return 'https://vlm.gg'
  }
  if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return 'http://localhost:3000'
  if (u.hostname.startsWith('api.')) return `${u.protocol}//${u.hostname.slice(4)}${u.port ? `:${u.port}` : ''}`
  if (u.hostname.includes('-api.')) return `${u.protocol}//${u.hostname.replace('-api.', '.')}${u.port ? `:${u.port}` : ''}`
  return u.origin
}

export function analyticsUrlFor(apiUrl: string, sceneId: string): string {
  return `${dashboardUrlFor(apiUrl)}/analytics/?scene=${encodeURIComponent(sceneId)}`
}

export function handoffUrlFor(apiUrl: string, code: string, next: string): string {
  return `${dashboardUrlFor(apiUrl)}/auth/handoff/?code=${encodeURIComponent(code)}&next=${encodeURIComponent(next)}`
}
```

Export all three from `src/index.ts`. Run the test → PASS; run `npx vitest run` (all core tests) → PASS.

- [ ] **Step 3: NavBar tab** — in `DclHUDRenderer.tsx` `NavBar`, append `{ type: 'stats' as any, label: 'Stats' }` as an **action tab** for every role (the HUD only renders the NavBar for connected role holders): pressing it calls `onSceneAction?.('open_analytics')` and does **not** change `state.activePanel`. Implement it as a separate entry type rather than a `HUDPanelType` (e.g. `const ACTION_STATS = '__stats'` and check `p.type === ACTION_STATS` first in `onMouseDown`); keep the equal-width layout and the font size rule (`hasRoles ? 10 : 11`, now based on the tab count: `tabs.length > 7 ? 10 : 11`).
- [ ] **Step 4: Handler** — add `createHandoff()` to `VLMHttpClient` (`return this._fetch('/api/auth/handoff', { method: 'POST', body: '{}' })`). In `index.ts` `installConnectedHandler`, at the top of the `setSceneActionHandler` callback (before role checks):

```ts
        if (action === 'open_analytics') {
          const apiUrl = resolveApiUrl(config ?? {})
          const next = `/analytics/?scene=${encodeURIComponent(sceneId)}`
          // Signs the browser in as this wallet; any failure (guest, unverified, rate limit, network) opens the plain link
          vlm.httpClient
            .createHandoff()
            .then(({ code }) => adapter.openUrl(handoffUrlFor(apiUrl, code, next)))
            .catch(() => adapter.openUrl(analyticsUrlFor(apiUrl, sceneId)))
          return
        }
```

  Import `analyticsUrlFor`, `handoffUrlFor`, `resolveApiUrl` from `vlm-core` (check the existing import line). If the `config?.sceneId` path (line ~142) installs a different handler, add the same branch there. The hand-off code is created only on the press (never ahead of time) and is never logged.

- [ ] **Step 5: Build** — `cd packages/vlm-adapter-dcl && npx tsc --noEmit`; then build the smart-item bundle and the test scene to make sure it compiles: `cd packages/vlm-smart-item-dcl && pnpm run bundle` and `cd test-scenes/dcl-smart-item-test && npx sdk-commands build` (must end with "Type checking completed without errors"). Do not commit `test-scenes/*/bin/index.js`.
- [ ] **Step 6: Commit** — `feat(hud): Stats tab opens the scene's analytics dashboard`

---

### Task 10: Local seed data, manual check, docs

**Files:**
- Create: `apps/server/scripts/seed-analytics-demo.mjs`
- Modify: `apps/docs/src/content/docs/dashboard/analytics.md` (replace the "Status" section)

**Interfaces:**
- Produces: `node apps/server/scripts/seed-analytics-demo.mjs --scene <vlmSceneId>` — **local dev only**: refuses to run unless `DATABASE_URL`'s host is `localhost` or `127.0.0.1` (print "Refusing: seed is for a local database" and exit 1). Creates (or reuses, by `location_key = 'gc:-150,-150'`) an `analytics_scenes` row with `baseParcel '-150,-150'`, `parcels ['-150,-150','-149,-150','-150,-149','-149,-149']`, an active `location_setups` row pointing at `--scene` (the scene must exist and its owner is the host), then inserts for the last 30 days: ~600 `analytics_sessions` (random visitor hashes, ~20% repeat visitors, platforms/countries mix, a few with `wallet`/`display_name`), matching `analytics_rollup_hourly` rows (sessions, unique/new/returning, peak, dwell avg, count maps for interactions/emotes/countries/platforms), `analytics_heatmap_daily` cells concentrated around two hot spots inside the 32×32 m area, and 3 live sessions (`last_seen_at = now`) each with one `analytics_positions` row. Read the real column names in `apps/server/src/db/schema.ts` (`analyticsPositions`, `analyticsHeatmapDaily`, `locationSetups`) and use the `postgres` package like `scripts/unwrap-nested-properties.mjs`. `--reset` deletes and recreates that location's rows.

- [ ] **Step 1: Write the script**, run it against the local dev DB with a scene owned by your local test user (`select id, owner_id from scenes limit 5` to pick one), and re-run with `--reset` to confirm it is repeatable.
- [ ] **Step 2: Manual check** (record results in the task report):
  1. Local server on 3010 and `apps/web` `pnpm dev` on 3000; sign in as the scene's owner.
  2. `/analytics/` → the seeded location; open it. Every section has data: cards, chart (switch series; 24 h / 7 d / 30 d / custom), here now shows 3 dots on the 2×2 parcel map, heatmap shows two hot spots (toggle Dwell/Visits), four breakdowns, recent visits (Load more works), settings toggle (on/off; off clears names in the table after reload).
  3. `/analytics/?scene=<sceneId>` redirects to the location. Signed out, the same URL returns after sign-in.
  4. A second local user with no role → "You don't have access…" for `?location=<id>`.
  5. Browser responsive mode at 375 px: no horizontal page scroll.
  6. `NODE_ENV=production npx next build` in `apps/web` succeeds.
  7. Hand-off without Decentraland: mint a verified-wallet token for the scene owner (as in the Task 2 tests, e.g. a one-off `node -e` using the server's `JWT_SECRET` from `.env` — never print the secret), `curl -X POST http://localhost:3010/api/auth/handoff -H 'Authorization: Bearer <token>'`, open `http://localhost:3000/auth/handoff/?code=<code>&next=%2Fanalytics%2F%3Fscene%3D<sceneId>` in a signed-out browser → lands on the dashboard signed in; reopen the same URL → normal sign-in page with the same `next`.
  8. In-world (optional, the user's step): in the `dcl-smart-item-test` preview against the local server, press **Stats** → Decentraland's open-link prompt shows `http://localhost:3000/auth/handoff/?code=…`. (A preview whose signed fetch isn't verified gets the plain `/analytics/?scene=` link — that's the fallback working.)
- [ ] **Step 3: Docs** — replace the "Status" section of `analytics.md` with "## The dashboard": where to find it (vlm.gg → Analytics, or **Stats** in the in-world HUD), what each section shows (one line each), that data updates hourly (here now: every 15 s), and who sees what (host/co-host/editor/viewer; only host and co-hosts change wallet visibility). Remove the stale "Claims" bullet (claims were replaced by in-world setup).
- [ ] **Step 4: Full verification** — from the worktree root: `cd apps/server && npx vitest run`, `cd apps/web && npx vitest run && npx tsc --noEmit`, `cd packages/vlm-core && npx vitest run`, `pnpm turbo typecheck`.
- [ ] **Step 5: Commit** — `chore(analytics): local demo seed; docs for the dashboard`

---

## Rulings recorded while planning

1. **No dynamic route (`/analytics/[locationId]`).** The production web build is a static export served with an `index.html` fallback, so a cold deep link to a dynamic segment would render the home page. The dashboard is one static page using `?location=` / `?scene=`. Cost if wrong: none functional; URLs are slightly less pretty.
2. **`vlmSceneId` is the reader's tenure scene**, not `analytics_scenes.vlm_scene_id`: an ended-tenure host still resolves their own scene, and the HUD link (current setup) matches the active tenure. Needs `getAnalyticsAccess` to return it.
3. **HUD tab label "Stats"**, not "Analytics" (the spec says an Analytics button): the toolbar already has 7–8 equal-width tabs at 10 px; "Analytics" doesn't fit.
4. **Dashboard web origin from the API URL** (`api.` → apex, `-api.` → `.`, localhost → `:3000`, else same origin): `vlm-dcl` only knows the API URL. Cost if wrong for some self-hosted layout: the button opens the API origin, which serves the dashboard when the dashboard directory exists.
5. **Recent visits ignore the range picker**: the sessions endpoint pages by most recent with a cursor and has no range filter; changing the read API is out of scope.
6. **Light mode**: the site is dark-only today; charts use CSS tokens so a light theme can be added later, but D1 ships dark only.
7. **Positions are scene-relative metres with the base parcel's south-west corner at the origin** (probe reads `Transform(engine.PlayerEntity)`; SDK7 transforms are scene-relative). Confirmed, no spec change.
8. **Hand-off `next` is `/analytics/?scene=…`** (trailing slash, matching `trailingSlash: true` and the static export), not the spec's `/analytics?scene=`.
9. **`Referrer-Policy: no-referrer`** comes from the dashboard static server (`setHeaders` for `/auth/handoff`) plus a `<meta name="referrer">` in the page, because a static export can't set per-page headers itself.
10. **Hand-off session shape** reuses the wallet sign-in's claims through a new shared `issueWalletSession` (extracted from `wallet-auth.ts`), so the session grants exactly what wallet sign-in grants. Malformed codes return 410 like unknown ones.
