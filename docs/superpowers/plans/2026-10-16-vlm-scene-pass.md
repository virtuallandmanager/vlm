# VLM Scene Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In-world tokens only ever act as the player inside the scene that asked for them; each scene gets one shared media library stored in its owner's account.

**Architecture:** `POST /api/auth/platform` verifies Decentraland's signed scene metadata with `@dcl/crypto-middleware` 6.3.0, binds the request to the analytics location (signed `parcel` / World name) and its active location setup, and issues a **scene pass** JWT (`kind: 'scene'`, `sceneId`, `locationId`). Every other token gets `kind: 'account'`; kind-less tokens are refused. `authenticate` refuses a scene pass on any route that doesn't declare `config.scenePass.sceneFrom`, or whose resolved scene differs. Rooms downgrade a mismatched pass to an anonymous visitor. The D1 hand-off carries the pass's binding to the website. A new `scene_library` table links media/models to scenes; uploads with a pass land in the owner's (or, during a booking, the renter's) account.

**Tech Stack:** Fastify 5, @fastify/jwt, fast-jwt, Drizzle + Postgres, Colyseus, vitest (server: real Postgres), Next 15 static export (web), Decentraland SDK7 adapter.

**Spec:** `docs/superpowers/specs/2026-10-16-vlm-scene-pass-design.md`

## Global Constraints

- Node 20 for every command: `export PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH`. Dev Postgres: `docker compose -p vlm-dev -f docker-compose.dev.yml up -d postgres` (from the repo root). Server tests: `cd apps/server && pnpm vitest run <file>`.
- Worktree: `/Users/unknower/-VLM/vlm-v2/.worktrees/scene-pass`, branch `feature/scene-pass`. Install once with `pnpm install --frozen-lockfile`.
- **Lockfile hazard:** `pnpm add` can re-resolve the lockfile and upgrade `@dcl/*` (7.22 → 7.30.1, whose CLI needs Node 22). After any `pnpm add`, run `git diff --stat pnpm-lock.yaml` and `git diff pnpm-lock.yaml | grep -E '^[-+].*@dcl/(sdk|js-runtime|ecs|sdk-commands)'`; if that grep prints anything, `git checkout pnpm-lock.yaml` and add only the new package's importer and package entries by hand.
- `@dcl/crypto-middleware` pinned exactly to `6.3.0` (published 2026-08-25; 6.3.1/6.4.0 are under two weeks old).
- Scene signer value: `decentraland-kernel-scene`. Canonical metadata keys: `signer`, `sceneId`, `parcel`, `realm.serverName`, `realm.hostname`, `isGuest`, `hashPayload`.
- Token claim `kind`: exactly `'account'` or `'scene'`. Scene pass claims: `{ id, email: null, role, orgId: null, wallet, verified: true, kind: 'scene', sceneId: string | null, locationId: string | null }`.
- Error strings, verbatim: `403 { error: 'scene_pass_not_allowed' }`; `401 { error: 'Unauthorized', message: 'Session expired — sign in again' }` for kind-less tokens; `413 { error: 'storage_limit_reached', message: "The scene owner's storage is full" }`.
- Website banner text, verbatim: `Signed in from {scene title} — sign in for full access` (link text `sign in for full access`).
- Never touch billing routes (`routes/billing.ts`). Never print `.env` secrets.
- Commit after every task with a `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` trailer. Don't push.
- **Spec clarification (ruling):** the spec says a room "refuses" a pass for another scene; implement it as **downgrade to an anonymous visitor** (content still renders, no editing). Same security, no broken content for scenes whose code declares a different `sceneId`. Task 7 updates the spec line.

## Review Focus

- A **visitor pass** (`sceneId: null`) on any `scenePass` route must get `403 scene_pass_not_allowed`, never fall through to normal access (test in Task 5).
- A `sceneFrom` resolver that finds no row (unknown element/instance/preset id) must yield `403`, not `500` or a pass-through (test in Task 5).
- API keys (`Bearer vlm_…`) carry no `kind` and must keep working everywhere (test in Task 1).
- An old kind-less session in the browser's `localStorage` must be dropped on load and send the user to sign-in once, not loop between `/` and the dashboard (test in Task 10).
- Genesis City realm names (`main`, `realm-1`, `hela`) must never be treated as Worlds; only `serverName` ending in `.eth` is a World, and World names are lowercased (test in Task 3).

---

### Task 1: Token kinds (`account`) and refusal of kind-less tokens

**Files:**
- Modify: `apps/server/src/auth/tokens.ts`
- Modify: `apps/server/src/middleware/auth.ts`
- Modify: `apps/server/src/auth/sessions.ts`
- Modify: `apps/server/src/routes/auth.ts` (register ~76-84, login ~132-140, refresh ~149-190, Google ~222-228, Discord ~397-405 and ~550-558)
- Modify: `apps/server/src/routes/wallet-auth.ts` (~74, optional bearer)
- Modify: `apps/server/test/helpers/factories.ts` (`tokenFor`, `expiredTokenFor`)
- Test: `apps/server/test/token-kinds.test.ts`

**Interfaces:**
- Produces: `export type TokenKind = 'account' | 'scene'`; `SessionClaims` gains `kind?: TokenKind; sceneId?: string | null; locationId?: string | null`; `AuthUser` gains the same three optional fields. `verifySessionToken` returns `null` for a kind-less token. `tokenFor(user, extra)` signs `kind: 'account'` by default.

- [ ] **Step 1: Write the failing test** — `apps/server/test/token-kinds.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createSigner } from 'fast-jwt'
import { createHash } from 'node:crypto'
import { db } from '../src/db/connection.js'
import { apiKeys } from '../src/db/schema.js'
import { verifySessionToken } from '../src/auth/tokens.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor } from './helpers/factories.js'

const sign = createSigner({ key: 'test-secret', expiresIn: 15 * 60 * 1000 })

describe('token kinds', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { await app.close() })

  it('refuses a kind-less access token on REST with the session-expired message', async () => {
    const u = await createUser()
    const legacy = sign({ id: u.id, email: u.email, role: u.role, orgId: null, wallet: null, verified: true })
    const res = await app.inject({ method: 'GET', url: '/api/scenes', headers: { authorization: `Bearer ${legacy}` } })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'Unauthorized', message: 'Session expired — sign in again' })
  })

  it('verifySessionToken rejects kind-less tokens and accepts account tokens', async () => {
    const u = await createUser()
    expect(verifySessionToken(sign({ id: u.id, role: 'user' }))).toBeNull()
    expect(verifySessionToken(tokenFor(u))?.kind).toBe('account')
  })

  it('email login and refresh carry kind account; a kind-less refresh token is refused', async () => {
    await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'k@x.io', password: 'password123', displayName: 'K' } })
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'k@x.io', password: 'password123' } })
    const { accessToken, refreshToken } = login.json()
    expect(verifySessionToken(accessToken)?.kind).toBe('account')
    const r = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { authorization: `Bearer ${refreshToken}` } })
    expect(verifySessionToken(r.json().accessToken)?.kind).toBe('account')
    const u = await createUser()
    const legacyRefresh = sign({ id: u.id, role: 'user', refresh: true })
    const r2 = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { authorization: `Bearer ${legacyRefresh}` } })
    expect(r2.statusCode).toBe(401)
  })

  it('API keys still authenticate (they have no kind)', async () => {
    const u = await createUser()
    const key = 'vlm_' + 'a'.repeat(40)
    await db.insert(apiKeys).values({ userId: u.id, name: 't', keyHash: createHash('sha256').update(key).digest('hex'), keyPrefix: key.slice(0, 8) } as any)
    const res = await app.inject({ method: 'GET', url: '/api/scenes', headers: { authorization: `Bearer ${key}` } })
    expect(res.statusCode).toBe(200)
  })
})
```

(If `apiKeys` has other required columns, read `db/schema.ts` and fill them; keep the assertion.)

- [ ] **Step 2: Run it — expect FAIL** (`kind-less` gets 200; `kind` undefined).

Run: `cd apps/server && pnpm vitest run test/token-kinds.test.ts`

- [ ] **Step 3: Implement**

`auth/tokens.ts` — add to `SessionClaims` and the verifier:

```ts
export type TokenKind = 'account' | 'scene'
export interface SessionClaims {
  id: string
  email: string | null
  role: string
  orgId?: string | null
  wallet?: string | null
  verified?: boolean
  guest?: boolean
  refresh?: boolean
  kind?: TokenKind
  sceneId?: string | null
  locationId?: string | null
}

/** Verify an access token outside Fastify (e.g. Colyseus onAuth). Refresh and kind-less (pre-scene-pass) tokens are rejected; guest tokens pass (they carry guest: true). */
export function verifySessionToken(token: string | undefined | null): SessionClaims | null {
  if (!token) return null
  try {
    const claims = verifier(token) as SessionClaims
    if (claims.refresh) return null
    if (!claims.guest && claims.kind !== 'account' && claims.kind !== 'scene') return null
    return claims
  } catch {
    return null
  }
}
```

`middleware/auth.ts` — add `kind?: 'account' | 'scene'; sceneId?: string | null; locationId?: string | null` to `AuthUser` and to the `FastifyJWT.payload` type; after the `decoded.guest` check:

```ts
    if (decoded.kind !== 'account' && decoded.kind !== 'scene') {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Session expired — sign in again' })
    }
```

`auth/sessions.ts` — `const claims = { id: user.id, email: user.email, role: user.role, orgId: user.activeOrgId || null, wallet, verified: true, kind: 'account' as const }`.

`routes/auth.ts`:
- register, login, Google callback, both Discord callbacks: add `kind: 'account'` to the access claims object and to the refresh claims object of each.
- `/api/auth/refresh`: after `if (!decoded.refresh)`, add `if (decoded.kind !== 'account' && decoded.kind !== 'scene') return reply.status(401).send({ error: 'Invalid or expired refresh token' })`. For `decoded.kind === 'account'` add `kind: 'account'` to the new access claims. (`kind === 'scene'` is handled in Task 4; until then, treat it like account but keep `kind/sceneId/locationId` from `decoded`: add `...(decoded.kind === 'scene' ? { kind: 'scene', sceneId: decoded.sceneId ?? null, locationId: decoded.locationId ?? null, orgId: null } : { kind: 'account' })` after the existing fields.)
- `/api/auth/platform` verified path: add `kind: 'account'` to `claims` for now (Task 4 replaces this with the scene pass).

`routes/wallet-auth.ts` optional bearer: accept the bearer only when `decoded.kind === 'account'` (otherwise ignore it as if absent — a scene pass must never link a wallet).

`test/helpers/factories.ts`: `tokenFor` signs `{ id, email, role, orgId: null, wallet: user.wallet, verified: true, kind: 'account', ...extra }`; same `kind` in `expiredTokenFor`.

- [ ] **Step 4: Run the new test, then the whole server suite**

Run: `cd apps/server && pnpm vitest run test/token-kinds.test.ts && pnpm vitest run`
Expected: all PASS. Fix any test that hand-signs tokens without `kind` by adding `kind: 'account'`.

- [ ] **Step 5: Commit** — `git add -A apps/server && git commit -m "feat(auth): token kinds; refuse kind-less sessions"`

---

### Task 2: Scene-signed request verification with @dcl/crypto-middleware 6.3.0

**Files:**
- Modify: `apps/server/package.json` (add `"@dcl/crypto-middleware": "6.3.0"`, `"@dcl/crypto"` as devDependency at the version 6.3.0 depends on: `"3.7.0"`)
- Modify: `apps/server/src/middleware/dcl-auth.ts`
- Create: `apps/server/test/helpers/dcl-sign.ts`
- Test: `apps/server/test/dcl-scene-verify.test.ts`

**Interfaces:**
- Produces:
```ts
export interface SceneRequestContext { sceneId: string; parcel: string; realm: { hostname: string; serverName: string }; isGuest: boolean }
export async function verifyDclSceneRequest(method: string, path: string, headers: Record<string, string | string[] | undefined>, rawBody: string | null): Promise<{ wallet: string; scene: SceneRequestContext }>
```
Throws on any failure. `verifyDclSignedFetch` keeps its signature (used by setup/ingest/claims) but now uses the new library with `canonicalMetadataKeys`.
- Produces (tests): `signedSceneHeaders(opts: { method: string; path: string; body?: string; metadata?: Record<string, unknown>; rawMetadata?: string; wallet?: 'a' | 'b' }): Promise<{ headers: Record<string, string>; wallet: string }>` in `test/helpers/dcl-sign.ts`.

- [ ] **Step 1: Add the dependency** (see the lockfile hazard in Global Constraints)

```bash
cd apps/server && pnpm add @dcl/crypto-middleware@6.3.0 && pnpm add -D @dcl/crypto@3.7.0
cd ../.. && git diff pnpm-lock.yaml | grep -E '^[-+].*@dcl/(sdk|js-runtime|ecs|sdk-commands)' || echo "lockfile clean"
```
Expected: `lockfile clean`.

- [ ] **Step 2: Write the signing helper** — `test/helpers/dcl-sign.ts`. It builds a real auth chain (wallet → ephemeral) and signs the 6.x payload. Verify the export names against `node_modules/@dcl/crypto/dist/index.d.ts` and `dist/crypto.d.ts` before relying on them (`Authenticator.initializeAuthChain`, `Authenticator.signPayload`, `createUnsafeIdentity`).

```ts
import { createHash } from 'node:crypto'
import { Authenticator } from '@dcl/crypto'
import { createUnsafeIdentity } from '@dcl/crypto/dist/crypto'
import { createPayload, createAuthChainHeaders } from '@dcl/crypto-middleware'

const wallets = { a: createUnsafeIdentity(), b: createUnsafeIdentity() }

export const SCENE_META = {
  sceneId: 'bafkreiscenea',
  parcel: '10,20',
  tld: 'org',
  network: 'mainnet',
  isGuest: false,
  signer: 'decentraland-kernel-scene',
  realm: { hostname: 'peer.decentraland.org', protocol: 'v3', serverName: 'main' },
}

export async function signedSceneHeaders(opts: { method: string; path: string; body?: string; metadata?: Record<string, unknown>; rawMetadata?: string; wallet?: 'a' | 'b' }) {
  const w = wallets[opts.wallet ?? 'a']
  const ephemeral = createUnsafeIdentity()
  const chain = await Authenticator.initializeAuthChain(w.address, ephemeral, 10, async (msg) => Authenticator.createSignature(w, msg))
  const meta: Record<string, unknown> = { ...SCENE_META, ...(opts.metadata ?? {}) }
  if (opts.body !== undefined && !('hashPayload' in (opts.metadata ?? {}))) meta.hashPayload = createHash('sha256').update(opts.body, 'utf8').digest('hex')
  const rawMetadata = opts.rawMetadata ?? JSON.stringify(meta)
  const ts = Date.now()
  const payload = createPayload(opts.method, opts.path, String(ts), rawMetadata)
  const signed = Authenticator.signPayload({ ephemeralIdentity: ephemeral, expiration: new Date(Date.now() + 600_000), authChain: chain.authChain } as any, payload)
  const headers = createAuthChainHeaders(signed, ts, {})
  headers['x-identity-metadata'] = rawMetadata
  return { headers, wallet: w.address.toLowerCase() }
}
```

If `Authenticator.createSignature` / `initializeAuthChain` signatures differ in 3.7.0, adapt the helper (keep its exported signature).

- [ ] **Step 3: Write the failing tests** — `test/dcl-scene-verify.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { verifyDclSceneRequest } from '../src/middleware/dcl-auth.js'
import { signedSceneHeaders, SCENE_META } from './helpers/dcl-sign.js'

const PATH = '/api/auth/platform'
const BODY = JSON.stringify({ user: { displayName: 'A' } })

describe('verifyDclSceneRequest', () => {
  it('accepts a correct scene request and returns wallet + context', async () => {
    const { headers, wallet } = await signedSceneHeaders({ method: 'POST', path: PATH, body: BODY })
    const r = await verifyDclSceneRequest('POST', PATH, headers, BODY)
    expect(r.wallet).toBe(wallet)
    expect(r.scene).toEqual({ sceneId: SCENE_META.sceneId, parcel: '10,20', realm: { hostname: 'peer.decentraland.org', serverName: 'main' }, isGuest: false })
  })

  it.each([
    ['Signer', { signer: undefined, Signer: 'decentraland-kernel-scene' }],
    ['SceneId', { sceneId: undefined, SceneId: 'bafkreiscenea' }],
    ['Parcel', { parcel: undefined, Parcel: '10,20' }],
  ])('refuses a respelled %s key', async (_k, override) => {
    const meta = { ...SCENE_META, ...override } as Record<string, unknown>
    for (const k of Object.keys(meta)) if (meta[k] === undefined) delete meta[k]
    const { headers } = await signedSceneHeaders({ method: 'POST', path: PATH, body: BODY, rawMetadata: JSON.stringify({ ...meta, hashPayload: undefined }) })
    await expect(verifyDclSceneRequest('POST', PATH, headers, BODY)).rejects.toThrow()
  })

  it('refuses a missing parcel', async () => {
    const { headers } = await signedSceneHeaders({ method: 'POST', path: PATH, body: BODY, metadata: { parcel: undefined } })
    await expect(verifyDclSceneRequest('POST', PATH, headers, BODY)).rejects.toThrow()
  })

  it('refuses a body that does not match hashPayload', async () => {
    const { headers } = await signedSceneHeaders({ method: 'POST', path: PATH, body: BODY })
    await expect(verifyDclSceneRequest('POST', PATH, headers, JSON.stringify({ user: { displayName: 'Evil' } }))).rejects.toThrow()
  })

  it('refuses a wallet-signed (non-scene) request', async () => {
    const { headers } = await signedSceneHeaders({ method: 'POST', path: PATH, body: BODY, metadata: { signer: 'dcl:explorer' } })
    await expect(verifyDclSceneRequest('POST', PATH, headers, BODY)).rejects.toThrow()
  })

  it('refuses a signature made for another path', async () => {
    const { headers } = await signedSceneHeaders({ method: 'POST', path: '/elsewhere', body: BODY })
    await expect(verifyDclSceneRequest('POST', PATH, headers, BODY)).rejects.toThrow()
  })
})
```

(The `JSON.stringify` drops `undefined` values, which is how the "missing" and "respelled" variants are produced. For the respelled case `hashPayload` is dropped too, so the request also exercises the legacy-key guard; the test only asserts refusal.)

- [ ] **Step 4: Run — expect FAIL** (`verifyDclSceneRequest` not exported).

- [ ] **Step 5: Implement** — replace `middleware/dcl-auth.ts` body (keep `hasDclAuthHeaders`):

```ts
import { createHash } from 'node:crypto'
import { verify, requireSigner } from '@dcl/crypto-middleware'

const SCENE_SIGNER = 'decentraland-kernel-scene'
const CANONICAL_KEYS = ['signer', 'sceneId', 'parcel', 'realm.serverName', 'realm.hostname', 'isGuest', 'hashPayload']
const EXPIRATION_MS = 120_000

export interface DclAuthResult { walletAddress: string; metadata: Record<string, any> }
export interface SceneRequestContext { sceneId: string; parcel: string; realm: { hostname: string; serverName: string }; isGuest: boolean }

const own = (o: unknown, k: string) => !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k)
const str = (o: any, k: string) => (own(o, k) && typeof o[k] === 'string' && o[k].length > 0 ? (o[k] as string) : null)

/** Any Decentraland signed fetch (scene or not). Used by setup, ingest and claims. */
export async function verifyDclSignedFetch(method: string, path: string, headers: Record<string, string | string[] | undefined>): Promise<DclAuthResult> {
  const r = await verify(method, path, headers, { expiration: EXPIRATION_MS, canonicalMetadataKeys: CANONICAL_KEYS })
  return { walletAddress: r.auth.toLowerCase(), metadata: r.authMetadata || {} }
}

/** A request the explorer signed on a scene's behalf (ADR-289), with its unforgeable scene context. Throws on anything else. */
export async function verifyDclSceneRequest(
  method: string,
  path: string,
  headers: Record<string, string | string[] | undefined>,
  rawBody: string | null,
): Promise<{ wallet: string; scene: SceneRequestContext }> {
  const r = await verify(method, path, headers, { expiration: EXPIRATION_MS, canonicalMetadataKeys: CANONICAL_KEYS, metadataValidator: requireSigner(SCENE_SIGNER) })
  const m = r.authMetadata as Record<string, unknown>
  const sceneId = str(m, 'sceneId')
  const parcel = str(m, 'parcel')
  const realm = own(m, 'realm') ? (m.realm as Record<string, unknown>) : null
  const serverName = str(realm, 'serverName')
  const hostname = str(realm, 'hostname') ?? ''
  if (!sceneId || !parcel || !serverName) throw new Error('scene metadata incomplete')
  if (rawBody !== null && rawBody.length > 0) {
    const want = createHash('sha256').update(rawBody, 'utf8').digest('hex')
    if (str(m, 'hashPayload') !== want) throw new Error('body does not match signed hash')
  }
  return { wallet: r.auth.toLowerCase(), scene: { sceneId, parcel, realm: { hostname, serverName }, isGuest: own(m, 'isGuest') && m.isGuest === true } }
}

export function hasDclAuthHeaders(headers: Record<string, string | string[] | undefined>): boolean {
  return !!headers['x-identity-auth-chain-0']
}
```

Remove the `decentraland-crypto-middleware` dependency from `apps/server/package.json` only if nothing else imports it (`grep -rn "decentraland-crypto-middleware" apps/server/src`); otherwise leave it.

- [ ] **Step 6: Run the new test and the server suite** — `pnpm vitest run test/dcl-scene-verify.test.ts && pnpm vitest run`. Expected: PASS (other suites mock `dcl-auth.js`).

- [ ] **Step 7: Commit** — `git commit -am "feat(auth): verify scene-signed requests with @dcl/crypto-middleware 6.3.0"` (include the new files with `git add`).

---

### Task 3: Bind a scene request to its location and setup

**Files:**
- Create: `apps/server/src/auth/scene-binding.ts`
- Test: `apps/server/test/scene-binding.test.ts`

**Interfaces:**
- Consumes: `SceneRequestContext` (Task 2); `getActiveSetup`, `releaseIfRedeployed` (`setup/setups.ts`); `DirectoryUnavailableError` (`analytics/dcl-directory.ts`); `analyticsScenes` schema.
- Produces:
```ts
export interface SceneBinding { locationId: string | null; sceneId: string | null }
export function locationKeyForContext(ctx: SceneRequestContext, wallet: string, preview: boolean): string
export async function bindSceneRequest(ctx: SceneRequestContext, wallet: string, opts?: { preview?: boolean }): Promise<SceneBinding>
```

- [ ] **Step 1: Write the failing tests** — `test/scene-binding.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { resetDb } from './helpers/db.js'
import { createUser, createScene } from './helpers/factories.js'
import { createAnalyticsScene } from './helpers/analytics.js'
import { createSetup } from './helpers/setups.js'
import { FakeDclDirectory } from './helpers/fake-dcl.js'
import { setDclDirectory } from '../src/analytics/dcl-directory.js'
import { bindSceneRequest, locationKeyForContext } from '../src/auth/scene-binding.js'

const ctx = (o: Partial<{ sceneId: string; parcel: string; serverName: string; hostname: string }> = {}) => ({
  sceneId: o.sceneId ?? 'bafyA',
  parcel: o.parcel ?? '10,20',
  realm: { hostname: o.hostname ?? 'peer.decentraland.org', serverName: o.serverName ?? 'main' },
  isGuest: false,
})

describe('scene binding', () => {
  beforeEach(async () => { await resetDb(); setDclDirectory(new FakeDclDirectory()) })

  it('location keys: Genesis City realms are never Worlds; World names are lowercased', () => {
    for (const serverName of ['main', 'realm-1', 'hela']) expect(locationKeyForContext(ctx({ serverName }), '0xa', false)).toBe('gc:10,20')
    expect(locationKeyForContext(ctx({ serverName: 'MyWorld.dcl.eth' }), '0xa', false)).toBe('world:myworld.dcl.eth')
    expect(locationKeyForContext(ctx(), '0xA', true)).toBe('preview:0xa:10,20')
  })

  it('binds a Genesis City parcel to the active setup of its location', async () => {
    const owner = await createUser({ wallet: '0x00000000000000000000000000000000000000a1' })
    const { scene } = await createScene(owner)
    const loc = await createAnalyticsScene({ locationKey: 'gc:10,20', baseParcel: '10,20', parcels: ['10,20', '10,21'], activeEntityId: 'bafyA' } as any)
    await createSetup(loc.id, scene.id)
    expect(await bindSceneRequest(ctx(), owner.wallet!)).toEqual({ locationId: loc.id, sceneId: scene.id })
  })

  it('finds the location by any of its parcels when the base key misses', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const loc = await createAnalyticsScene({ locationKey: 'gc:10,19', baseParcel: '10,19', parcels: ['10,19', '10,20'] } as any)
    await createSetup(loc.id, scene.id)
    expect((await bindSceneRequest(ctx(), '0xa')).sceneId).toBe(scene.id)
  })

  it('binds a World by name', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const loc = await createAnalyticsScene({ kind: 'world', locationKey: 'world:myworld.dcl.eth', worldName: 'myworld.dcl.eth', baseParcel: '0,0', parcels: ['0,0'] } as any)
    await createSetup(loc.id, scene.id)
    expect((await bindSceneRequest(ctx({ serverName: 'myworld.dcl.eth', parcel: '0,0' }), '0xa')).sceneId).toBe(scene.id)
  })

  it('no location, or a location with no active setup → visitor binding', async () => {
    expect(await bindSceneRequest(ctx(), '0xa')).toEqual({ locationId: null, sceneId: null })
    const loc = await createAnalyticsScene({ locationKey: 'gc:10,20', baseParcel: '10,20', parcels: ['10,20'] } as any)
    expect(await bindSceneRequest(ctx(), '0xa')).toEqual({ locationId: loc.id, sceneId: null })
  })

  it('directory down while checking a changed deployment → visitor binding', async () => {
    const owner = await createUser()
    const { scene } = await createScene(owner)
    const loc = await createAnalyticsScene({ locationKey: 'gc:10,20', baseParcel: '10,20', parcels: ['10,20'], activeEntityId: 'bafyOld' } as any)
    await createSetup(loc.id, scene.id)
    const dir = new FakeDclDirectory(); dir.down = true; setDclDirectory(dir)
    expect(await bindSceneRequest(ctx({ sceneId: 'bafyNew' }), '0xa')).toEqual({ locationId: loc.id, sceneId: null })
  })
})
```

Read `test/helpers/analytics.ts`, `setups.ts` and `fake-dcl.ts` first and adjust option names (e.g. `kind`, `worldName`) to what they accept; keep the assertions. If `createSetup` doesn't set `deploymentEntityId`, the "changed deployment" test sets it with a direct `db.update(locationSetups)` to `'bafyOld'`.

- [ ] **Step 2: Run — expect FAIL** (module missing).

- [ ] **Step 3: Implement** — `src/auth/scene-binding.ts`:

```ts
import { and, eq, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { analyticsScenes } from '../db/schema.js'
import type { SceneRequestContext } from '../middleware/dcl-auth.js'
import { getActiveSetup, releaseIfRedeployed } from '../setup/setups.js'
import { DirectoryUnavailableError } from '../analytics/dcl-directory.js'

export interface SceneBinding { locationId: string | null; sceneId: string | null }
const VISITOR: SceneBinding = { locationId: null, sceneId: null }

const isWorld = (ctx: SceneRequestContext) => ctx.realm.serverName.toLowerCase().endsWith('.eth')

/** Same keys as vlm-shared locationKeyFor, built only from the signed context. */
export function locationKeyForContext(ctx: SceneRequestContext, wallet: string, preview: boolean): string {
  const place = isWorld(ctx) ? ctx.realm.serverName.toLowerCase() : ctx.parcel
  if (preview) return `preview:${wallet.toLowerCase()}:${place}`
  return isWorld(ctx) ? `world:${place}` : `gc:${place}`
}

/** The VLM scene a signed scene request may act on: the active setup at its location. Anything uncertain → visitor. */
export async function bindSceneRequest(ctx: SceneRequestContext, wallet: string, opts: { preview?: boolean } = {}): Promise<SceneBinding> {
  const key = locationKeyForContext(ctx, wallet, !!opts.preview)
  let loc = await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.locationKey, key) })
  if (!loc && !isWorld(ctx) && !opts.preview) {
    loc = await db.query.analyticsScenes.findFirst({
      where: and(eq(analyticsScenes.kind, 'parcels'), sql`${analyticsScenes.parcels} @> ARRAY[${ctx.parcel}]::text[]`),
    })
  }
  if (!loc) return VISITOR
  let setup = await getActiveSetup(loc.id)
  if (!setup) return { locationId: loc.id, sceneId: null }
  if (!opts.preview && setup.deploymentEntityId && setup.deploymentEntityId !== ctx.sceneId) {
    try {
      setup = await releaseIfRedeployed(setup, loc)
    } catch (err) {
      if (err instanceof DirectoryUnavailableError) return { locationId: loc.id, sceneId: null }
      throw err
    }
    if (!setup) return { locationId: loc.id, sceneId: null }
  }
  return { locationId: loc.id, sceneId: setup.vlmSceneId }
}
```

(If the parcels column's array type rejects `::text[]`, use `sql\`${ctx.parcel} = ANY(${analyticsScenes.parcels})\``.)

- [ ] **Step 4: Run — expect PASS.** `pnpm vitest run test/scene-binding.test.ts`

- [ ] **Step 5: Commit** — `git add -A apps/server && git commit -m "feat(auth): bind signed scene requests to their location setup"`

---

### Task 4: Platform sign-in issues a scene pass; refresh keeps it bound

**Files:**
- Modify: `apps/server/src/routes/auth.ts` (`/api/auth/platform` ~196-278, `/api/auth/refresh`)
- Modify: `apps/server/src/app.ts` (raw body capture for `/api/auth/platform`)
- Create: `apps/server/src/auth/scene-pass.ts`
- Modify: `apps/server/test/auth-platform.test.ts`
- Test: `apps/server/test/scene-pass-issue.test.ts`

**Interfaces:**
- Consumes: `verifyDclSceneRequest` (Task 2), `bindSceneRequest` (Task 3).
- Produces:
```ts
export function sceneClaims(user: { id: string; role: string }, wallet: string, b: SceneBinding): SessionClaims // kind 'scene'
export function issueScenePass(app: FastifyInstance, user: SessionUser, wallet: string, b: SceneBinding): { user; accessToken; refreshToken; scene: SceneBinding }
```
Platform response: `{ user, accessToken, refreshToken, verified: true, scene: { sceneId, locationId } }` (guest response unchanged).

- [ ] **Step 1: Raw body for hash checks.** The body hash must be computed over the bytes the client sent. In `app.ts`, before the auth routes scope is registered, add a content-type parser override for `application/json` only on the auth scope that keeps the raw string:

```ts
    scope.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      ;(req as any).rawBody = body
      if (body === '' ) return done(null, {})
      try { done(null, JSON.parse(body as string)) } catch (e) { done(e as Error, undefined) }
    })
```

Add it inside the existing `app.register(async (scope) => { ... })` that registers `authRoutes`, before `scope.register(authRoutes)`.

- [ ] **Step 2: Write the failing tests** — `test/scene-pass-issue.test.ts` (mock only `verifyDclSceneRequest` and `hasDclAuthHeaders`; real binding and DB):

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { verifySessionToken } from '../src/auth/tokens.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene } from './helpers/factories.js'
import { createAnalyticsScene } from './helpers/analytics.js'
import { createSetup } from './helpers/setups.js'

const W = '0x00000000000000000000000000000000000000a1'
vi.mock('../src/middleware/dcl-auth.js', () => ({
  hasDclAuthHeaders: (h: Record<string, unknown>) => !!h['x-identity-auth-chain-0'],
  verifyDclSignedFetch: async () => { throw new Error('unused') },
  verifyDclSceneRequest: async (_m: string, _p: string, h: Record<string, string>) => {
    const v = h['x-identity-auth-chain-0']
    if (v !== 'valid') throw new Error('bad')
    return { wallet: W, scene: { sceneId: h['x-test-entity'] ?? 'bafyA', parcel: h['x-test-parcel'] ?? '10,20', realm: { hostname: 'peer.decentraland.org', serverName: 'main' }, isGuest: false } }
  },
}))

describe('platform sign-in → scene pass', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { await app.close() })

  const signIn = (headers: Record<string, string> = {}, payload: unknown = { user: { displayName: 'A' } }) =>
    app.inject({ method: 'POST', url: '/api/auth/platform', headers: { 'x-identity-auth-chain-0': 'valid', ...headers }, payload: payload as any })

  it('binds to the set-up scene at the signed parcel', async () => {
    const owner = await createUser({ wallet: W })
    const { scene } = await createScene(owner)
    const loc = await createAnalyticsScene({ locationKey: 'gc:10,20', baseParcel: '10,20', parcels: ['10,20'] } as any)
    await createSetup(loc.id, scene.id)
    const res = await signIn()
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.scene).toEqual({ sceneId: scene.id, locationId: loc.id })
    const c = verifySessionToken(body.accessToken)!
    expect(c).toMatchObject({ kind: 'scene', sceneId: scene.id, locationId: loc.id, wallet: W, verified: true, orgId: null })
  })

  it('ignores a body sceneId that disagrees with the setup', async () => {
    const owner = await createUser({ wallet: W })
    const { scene } = await createScene(owner)
    const other = (await createScene(owner, 'Other')).scene
    const loc = await createAnalyticsScene({ locationKey: 'gc:10,20', baseParcel: '10,20', parcels: ['10,20'] } as any)
    await createSetup(loc.id, scene.id)
    const res = await signIn({}, { sceneId: other.id, user: {} })
    expect(res.json().scene.sceneId).toBe(scene.id)
  })

  it('no setup at the parcel → visitor pass', async () => {
    const res = await signIn({ 'x-test-parcel': '99,99' })
    expect(res.json().scene).toEqual({ sceneId: null, locationId: null })
    expect(verifySessionToken(res.json().accessToken)).toMatchObject({ kind: 'scene', sceneId: null })
  })

  it('a bad signature still gets a guest token', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/platform', headers: { 'x-identity-auth-chain-0': 'forged' }, payload: {} })
    expect(res.json().guest).toBe(true)
  })

  it('refresh keeps the pass bound and never upgrades it', async () => {
    const owner = await createUser({ wallet: W })
    const { scene } = await createScene(owner)
    const loc = await createAnalyticsScene({ locationKey: 'gc:10,20', baseParcel: '10,20', parcels: ['10,20'] } as any)
    await createSetup(loc.id, scene.id)
    const { refreshToken } = (await signIn()).json()
    const r = await app.inject({ method: 'POST', url: '/api/auth/refresh', headers: { authorization: `Bearer ${refreshToken}` } })
    expect(verifySessionToken(r.json().accessToken)).toMatchObject({ kind: 'scene', sceneId: scene.id, locationId: loc.id, orgId: null })
  })
})
```

Update `test/auth-platform.test.ts`'s `vi.mock` to export `verifyDclSceneRequest` (map `valid:<wallet>` to `{ wallet, scene: { sceneId: 'bafyX', parcel: '0,0', realm: { hostname: 'peer.decentraland.org', serverName: 'main' }, isGuest: false } }`, otherwise throw), and change its "verified signed fetch" test to expect `claims.kind === 'scene'`.

- [ ] **Step 3: Run — expect FAIL.**

- [ ] **Step 4: Implement**

`src/auth/scene-pass.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import type { SessionClaims } from './tokens.js'
import type { SessionUser } from './sessions.js'
import type { SceneBinding } from './scene-binding.js'

export function sceneClaims(user: { id: string; role: string }, wallet: string, b: SceneBinding): SessionClaims {
  return { id: user.id, email: null, role: user.role, orgId: null, wallet, verified: true, kind: 'scene', sceneId: b.sceneId, locationId: b.locationId }
}

/** A scene pass: acts as the wallet's user only inside the bound scene (sceneId null = visitor). */
export function issueScenePass(app: FastifyInstance, user: SessionUser, wallet: string, b: SceneBinding) {
  const claims = sceneClaims(user, wallet, b)
  return {
    user: { id: user.id, displayName: user.displayName, email: null, role: user.role },
    accessToken: app.jwt.sign(claims, { expiresIn: config.jwtAccessExpiry }),
    refreshToken: app.jwt.sign({ ...claims, refresh: true }, { expiresIn: config.jwtRefreshExpiry }),
    scene: b,
  }
}
```

`routes/auth.ts` `/api/auth/platform` verified path: replace the `verifyDclSignedFetch` block with

```ts
      let binding: SceneBinding | null = null
      if (hasDclAuthHeaders(request.headers as Record<string, string | string[] | undefined>)) {
        try {
          const raw = ((request as any).rawBody as string | undefined) ?? null
          const signed = await verifyDclSceneRequest(request.method, request.url.split('?')[0], request.headers as Record<string, string | string[] | undefined>, raw)
          if (!signed.scene.isGuest) {
            verifiedWallet = signed.wallet
            binding = await bindSceneRequest(signed.scene, signed.wallet)
          }
        } catch (err) {
          request.log.warn({ err: (err as Error).message }, 'DCL scene signed fetch refused')
        }
      }
```

and at the end, for `verifiedWallet`, return `reply.send({ ...issueScenePass(app, dbUser, verifiedWallet, binding ?? { sceneId: null, locationId: null }), verified: true })` instead of the account claims.

**Local preview** (verified signed fetch on a non-cloud server whose realm is local): call `bindSceneRequest(signed.scene, signed.wallet, { preview: config.mode !== 'cloud' && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(signed.scene.realm.hostname) })` — the same `config.mode === 'cloud'` rule `routes/setup.ts` uses for preview setups.

**Unverified preview path** (`allowUnverifiedPlatformAuth`, local dev only, no verified wallet): identities are self-declared there by design, so bind to the body's `sceneId` when it names an existing scene: claims `{ …existing, kind: 'scene', sceneId: <body sceneId if a scenes row exists, else null>, locationId: null }`. This keeps the local test-scene HUD working; production never takes this path (`allowUnverifiedPlatformAuth` is refused in cloud mode — confirm in `config.ts`, and if it isn't, add `&& config.mode !== 'cloud'` to the branch).

`/api/auth/refresh`: when `decoded.kind === 'scene'`, sign the new access token with `sceneClaims({ id: user.id, role: user.role }, decoded.wallet!, { sceneId: decoded.sceneId ?? null, locationId: decoded.locationId ?? null })` (replacing the Task 1 interim spread).

- [ ] **Step 5: Run the two tests and the suite.** `pnpm vitest run test/scene-pass-issue.test.ts test/auth-platform.test.ts && pnpm vitest run`. Other suites that call `/api/auth/platform` through mocks may need the mock updated as in Step 2.

- [ ] **Step 6: Commit** — `git add -A apps/server && git commit -m "feat(auth): platform sign-in issues a scene pass bound to its location"`

---

### Task 5: Default-deny guard and scene-scoped routes

**Files:**
- Create: `apps/server/src/auth/scene-from.ts`
- Modify: `apps/server/src/middleware/auth.ts` (scene pass check inside `authenticate`)
- Modify: `apps/server/src/routes/scenes.ts`, `routes/scene-roles.ts`, `routes/analytics-read.ts`, `routes/companion-upload.ts`, `routes/auth-handoff.ts`
- Test: `apps/server/test/scene-pass-guard.test.ts`

**Interfaces:**
- Produces:
```ts
export type SceneFrom = (request: FastifyRequest) => Promise<string | null> | string | null
declare module 'fastify' { interface FastifyContextConfig { scenePass?: { sceneFrom: SceneFrom } } }
export const fromParam: (name: string) => SceneFrom          // params[name] is a scenes.id
export const fromPreset: SceneFrom                            // params.presetId → scene_presets.scene_id
export const fromElement: SceneFrom                           // params.elementId → preset → scene
export const fromInstance: SceneFrom                          // params.instanceId → element → preset → scene
export const fromAnalyticsLocation: SceneFrom                 // params.id (analytics_scenes.id) → analytics_scenes.vlm_scene_id
export const fromBody: (name: string) => SceneFrom            // body[name]
export const boundScene: SceneFrom                            // the pass's own sceneId (list routes that self-filter)
export const isScenePass: (u: { kind?: string } | undefined) => boolean
```

Route declarations (exact):

| Route | `sceneFrom` |
|---|---|
| `GET /api/scenes` | `boundScene` (handler returns only the bound scene for a pass) |
| `GET /api/scenes/:sceneId`, `PUT /api/scenes/:sceneId` | `fromParam('sceneId')` |
| `POST /api/presets/:presetId/elements` | `fromPreset` |
| `PUT/DELETE /api/elements/:elementId`, `POST /api/elements/:elementId/instances` | `fromElement` |
| `PUT/DELETE /api/instances/:instanceId` | `fromInstance` |
| all four in `scene-roles.ts` | `fromParam('sceneId')` |
| `GET /api/analytics/locations` | `boundScene` (handler filters to the pass's `locationId`) |
| `GET …/locations/:id/{summary,timeseries,live,heatmap,sessions}`, `PATCH …/locations/:id` | `fromAnalyticsLocation` |
| `POST /api/upload-tokens` | `fromBody('sceneId')` |
| `POST /api/auth/handoff` | `boundScene` |

Everything else stays undeclared → refused for passes.

- [ ] **Step 1: Write the failing tests** — `test/scene-pass-guard.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, createElement, createInstance, tokenFor } from './helpers/factories.js'
import { createAnalyticsScene } from './helpers/analytics.js'
import { createSetup } from './helpers/setups.js'

const pass = (u: any, sceneId: string | null, locationId: string | null = null) => tokenFor(u, { kind: 'scene', sceneId, locationId, orgId: null })

describe('scene pass guard', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { await app.close() })

  // Routes that never read a bearer token (signed fetch, webhook keys, codes, public browse, static).
  // A new public route must be added here deliberately, with its reason.
  const PUBLIC_ROUTES = [
    'POST /api/auth/register', 'POST /api/auth/login', 'POST /api/auth/refresh', 'POST /api/auth/platform', 'GET /api/auth/providers',
    'GET /api/auth/google', 'GET /api/auth/discord', 'POST /api/auth/forgot-password', 'POST /api/auth/reset-password',
    'POST /api/auth/wallet/challenge', 'POST /api/auth/wallet/verify', 'POST /api/auth/handoff/exchange',
    'POST /api/setup', 'GET /api/setup', 'POST /api/ingest', 'POST /api/analytics/claims/check-signed',
    'POST /api/streaming/authorize', 'GET /api/streaming/live-keys', 'POST /api/streaming/webhook', 'POST /api/billing/webhook',
    'GET /api/upload/', 'POST /api/upload/', 'GET /hook/', 'POST /hook/', 'GET /api/health', 'GET /metrics', 'GET /api/docs',
    'GET /uploads/', 'GET /*', 'GET /', 'GET /api/assets', // GET /api/assets, /api/assets/:id, /api/assets/categories are public browse
  ]
  const isPublic = (method: string, url: string) => PUBLIC_ROUTES.some((p) => `${method} ${url}`.startsWith(p))

  it('every route without scenePass config refuses a scene pass (route walk)', async () => {
    const owner = await createUser({ wallet: '0x00000000000000000000000000000000000000a1' })
    const { scene } = await createScene(owner)
    const t = pass(owner, scene.id)
    // Collected by the onRoute hook installed in app.ts (Step 3).
    const all = (app as any).registeredRoutes as Array<{ method: string; url: string; scenePass: boolean }>
    expect(all.length).toBeGreaterThan(50)
    const offenders: string[] = []
    for (const r of all.filter((r) => !r.scenePass && !isPublic(r.method, r.url))) {
      const url = r.url.replace(/:sceneId/g, scene.id).replace(/:[A-Za-z]+/g, '00000000-0000-0000-0000-000000000000')
      const res = await app.inject({ method: r.method as any, url, headers: { authorization: `Bearer ${t}` }, payload: {} })
      if (res.statusCode !== 403 || res.json().error !== 'scene_pass_not_allowed') offenders.push(`${r.method} ${r.url} → ${res.statusCode}`)
    }
    expect(offenders).toEqual([])
  })

  it('a pass for scene A is refused on scene B for each allowed route', async () => {
    const owner = await createUser()
    const a = await createScene(owner, 'A')
    const b = await createScene(owner, 'B')
    const el = await createElement(b.preset.id)
    const inst = await createInstance(el.id)
    const t = pass(owner, a.scene.id)
    const h = { authorization: `Bearer ${t}` }
    const reqs: Array<[string, string]> = [
      ['GET', `/api/scenes/${b.scene.id}`], ['PUT', `/api/scenes/${b.scene.id}`],
      ['POST', `/api/presets/${b.preset.id}/elements`], ['PUT', `/api/elements/${el.id}`], ['DELETE', `/api/elements/${el.id}`],
      ['POST', `/api/elements/${el.id}/instances`], ['PUT', `/api/instances/${inst.id}`], ['DELETE', `/api/instances/${inst.id}`],
      ['GET', `/api/scenes/${b.scene.id}/roles`], ['POST', `/api/scenes/${b.scene.id}/roles`],
      ['DELETE', `/api/scenes/${b.scene.id}/roles/0xabc`], ['POST', `/api/scenes/${b.scene.id}/transfer-host`],
    ]
    for (const [method, url] of reqs) {
      const res = await app.inject({ method: method as any, url, headers: h, payload: {} })
      expect([method, url, res.statusCode]).toEqual([method, url, 403])
      expect(res.json().error).toBe('scene_pass_not_allowed')
    }
    const up = await app.inject({ method: 'POST', url: '/api/upload-tokens', headers: h, payload: { sceneId: b.scene.id } })
    expect(up.statusCode).toBe(403)
  })

  it('a visitor pass (sceneId null) is refused on every allowed route', async () => {
    const owner = await createUser()
    const a = await createScene(owner, 'A')
    const res = await app.inject({ method: 'GET', url: `/api/scenes/${a.scene.id}`, headers: { authorization: `Bearer ${pass(owner, null)}` } })
    expect(res.statusCode).toBe(403)
    const list = await app.inject({ method: 'GET', url: '/api/scenes', headers: { authorization: `Bearer ${pass(owner, null)}` } })
    expect(list.statusCode).toBe(403)
  })

  it('unknown element id under a pass → 403, not 500', async () => {
    const owner = await createUser()
    const a = await createScene(owner, 'A')
    const res = await app.inject({ method: 'PUT', url: '/api/elements/00000000-0000-0000-0000-000000000000', headers: { authorization: `Bearer ${pass(owner, a.scene.id)}` }, payload: {} })
    expect(res.statusCode).toBe(403)
  })

  it('GET /api/scenes with a pass returns only the bound scene', async () => {
    const owner = await createUser()
    const a = await createScene(owner, 'A')
    await createScene(owner, 'B')
    const res = await app.inject({ method: 'GET', url: '/api/scenes', headers: { authorization: `Bearer ${pass(owner, a.scene.id)}` } })
    expect(res.json().scenes.map((s: any) => s.id)).toEqual([a.scene.id])
  })

  it('the bound scene still works with normal role checks', async () => {
    const owner = await createUser()
    const a = await createScene(owner, 'A')
    const res = await app.inject({ method: 'GET', url: `/api/scenes/${a.scene.id}`, headers: { authorization: `Bearer ${pass(owner, a.scene.id)}` } })
    expect(res.statusCode).toBe(200)
  })

  it('analytics locations list is filtered to the pass location', async () => {
    const owner = await createUser()
    const a = await createScene(owner, 'A')
    const b = await createScene(owner, 'B')
    const la = await createAnalyticsScene({ locationKey: 'gc:1,1', baseParcel: '1,1', parcels: ['1,1'] } as any)
    const lb = await createAnalyticsScene({ locationKey: 'gc:2,2', baseParcel: '2,2', parcels: ['2,2'] } as any)
    await createSetup(la.id, a.scene.id); await createSetup(lb.id, b.scene.id)
    const res = await app.inject({ method: 'GET', url: '/api/analytics/locations', headers: { authorization: `Bearer ${pass(owner, a.scene.id, la.id)}` } })
    expect(res.json().scenes.map((s: any) => s.id)).toEqual([la.id])
    const other = await app.inject({ method: 'GET', url: `/api/analytics/locations/${lb.id}/summary`, headers: { authorization: `Bearer ${pass(owner, a.scene.id, la.id)}` } })
    expect(other.statusCode).toBe(403)
  })
})
```

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement**

`src/auth/scene-from.ts`:

```ts
import type { FastifyRequest } from 'fastify'
import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { analyticsScenes, sceneElementInstances, sceneElements, scenePresets } from '../db/schema.js'

export type SceneFrom = (request: FastifyRequest) => Promise<string | null> | string | null
declare module 'fastify' {
  interface FastifyContextConfig { scenePass?: { sceneFrom: SceneFrom } }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const param = (r: FastifyRequest, n: string) => { const v = (r.params as Record<string, unknown>)?.[n]; return typeof v === 'string' && UUID.test(v) ? v : null }

export const isScenePass = (u: { kind?: string } | undefined) => u?.kind === 'scene'
export const fromParam = (name: string): SceneFrom => (r) => param(r, name)
export const fromBody = (name: string): SceneFrom => (r) => { const v = (r.body as Record<string, unknown> | undefined)?.[name]; return typeof v === 'string' && UUID.test(v) ? v : null }
export const boundScene: SceneFrom = (r) => r.user?.sceneId ?? null
export const fromPreset: SceneFrom = async (r) => {
  const id = param(r, 'presetId'); if (!id) return null
  const p = await db.query.scenePresets.findFirst({ where: eq(scenePresets.id, id), columns: { sceneId: true } })
  return p?.sceneId ?? null
}
export const fromElement: SceneFrom = async (r) => {
  const id = param(r, 'elementId'); if (!id) return null
  const e = await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, id), with: { preset: { columns: { sceneId: true } } } })
  return e?.preset?.sceneId ?? null
}
export const fromInstance: SceneFrom = async (r) => {
  const id = param(r, 'instanceId'); if (!id) return null
  const i = await db.query.sceneElementInstances.findFirst({ where: eq(sceneElementInstances.id, id), with: { element: { with: { preset: { columns: { sceneId: true } } } } } })
  return i?.element?.preset?.sceneId ?? null
}
export const fromAnalyticsLocation: SceneFrom = async (r) => {
  const id = param(r, 'id'); if (!id) return null
  const l = await db.query.analyticsScenes.findFirst({ where: eq(analyticsScenes.id, id), columns: { vlmSceneId: true } })
  return l?.vlmSceneId ?? null
}
```

(Check the relation names `preset` / `element` against `db/schema.ts` relations; the route agent confirmed `with: { preset: ... }` and `with: { element: ... }` work.)

`middleware/auth.ts`, at the end of the JWT branch, replace `request.user = decoded` with:

```ts
    request.user = decoded
    if (decoded.kind === 'scene') {
      const sceneFrom = request.routeOptions.config?.scenePass?.sceneFrom
      const target = sceneFrom ? await sceneFrom(request) : null
      if (!decoded.sceneId || !target || target !== decoded.sceneId) {
        return reply.status(403).send({ error: 'scene_pass_not_allowed' })
      }
    }
```

Note `authenticate` wraps everything in `try/catch` that replies 401; a resolver throwing would become 401. Keep that, but make sure the 403 `return` happens before the catch can swallow it (it does — `reply.send` returns normally).

Route declarations: add `config: { scenePass: { sceneFrom: … } }` to each route in the table. For routes defined as `app.get(path, handler)`, change to `app.get(path, { config: { scenePass: { sceneFrom: fromParam('sceneId') } } }, handler)`. For `/api/upload-tokens` and `/api/auth/handoff`, merge into their existing options object (`{ preHandler: [authenticate], config: { scenePass: { sceneFrom: fromBody('sceneId') } } }`). The auth scope's `onRoute` hook in `app.ts` spreads `routeOptions.config` before adding `rateLimit`, so the handoff `config.scenePass` survives.

Handlers:
- `GET /api/scenes`: at the top, `if (isScenePass(request.user)) { const s = await db.query.scenes.findFirst({ where: eq(scenes.id, request.user.sceneId!) }); const access = await accessFor(request, request.user.sceneId!); return reply.send({ scenes: s && access.level !== 'none' ? [{ ...s, relationship: access.level === 'owner' ? 'owner' : access.level }] : [] }) }`.
- `GET /api/analytics/locations`: when `isScenePass(request.user)`, set `candidate = eq(analyticsScenes.id, request.user.locationId ?? '00000000-0000-0000-0000-000000000000')` (skip the reachable-scenes query).
- `POST /api/upload-tokens`: also fix the existing hole for every caller — when `body.sceneId` is set, require `hasScope(await getSceneAccess(actorFromClaims(request.user), body.sceneId), 'scene.edit')`, else `403 { error: 'forbidden' }`. With a pass, `sceneId` is required (the guard already refuses a missing one).

Route walk support in `app.ts`: immediately after `registerJwt(...)` and before any route plugin registers, add

```ts
  const registeredRoutes: Array<{ method: string; url: string; scenePass: boolean }> = []
  app.addHook('onRoute', (r) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method]
    for (const m of methods) if (m !== 'HEAD' && m !== 'OPTIONS') registeredRoutes.push({ method: m, url: r.url, scenePass: !!(r.config as any)?.scenePass })
  })
  app.decorate('registeredRoutes', registeredRoutes)
```

The rule the walk enforces: every route without `scenePass` answers a scene pass with `403 scene_pass_not_allowed`, unless it's in `PUBLIC_ROUTES` (never reads a bearer). `POST /api/auth/wallet/verify` reads an optional bearer but Task 1 makes it ignore non-account tokens, so it's listed as public. If the walk flags `GET /api/assets/:id` and `/api/assets/categories`, they're covered by the `GET /api/assets` prefix already.

- [ ] **Step 4: Run the guard test and the suite.** `pnpm vitest run test/scene-pass-guard.test.ts && pnpm vitest run`. For any route the walk flags, either it is genuinely public (add to `PUBLIC_ROUTES` with a reason) or it reads the bearer without `authenticate` — then route it through `authenticate`.

- [ ] **Step 5: Commit** — `git add -A apps/server && git commit -m "feat(auth): scene passes are refused outside their scene (default deny)"`

---

### Task 6: Rooms: a pass for another scene joins as an anonymous visitor

**Files:**
- Modify: `apps/server/src/ws/VLMSceneRoom.ts` (`onAuth`)
- Modify: `apps/server/src/ws/VLMCommandCenterRoom.ts` (`onAuth`)
- Test: `apps/server/test/scene-pass-room.test.ts`

**Interfaces:**
- Consumes: `verifySessionToken` (Task 1), `ANONYMOUS` / `actorFromClaims` (`auth/actor.ts`).

- [ ] **Step 1: Failing test** — `test/scene-pass-room.test.ts` (pattern from `test/scene-room.test.ts`; read it first for how host-only messages are asserted, e.g. a `scene_preset_update` that a host gets an ack for and an anonymous client gets an error for):

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, tokenFor } from './helpers/factories.js'
import { startGameServer, joinScene, serverRoom } from './helpers/game-server.js'

describe('scene pass in rooms', () => {
  let gs: Awaited<ReturnType<typeof startGameServer>>
  beforeAll(async () => { gs = await startGameServer() })
  afterAll(async () => { await gs.stop() })
  beforeEach(async () => { await resetDb() })

  it('a pass for its own scene keeps the user identity', async () => {
    const owner = await createUser()
    const a = await createScene(owner, 'A')
    const c = await joinScene(gs.url, a.scene.id, tokenFor(owner, { kind: 'scene', sceneId: a.scene.id, orgId: null }))
    const room = serverRoom(c.room.roomId)
    const actor = [...(room as any).clientMeta.values()][0].actor
    expect(actor.userId).toBe(owner.id)
    c.room.leave()
  })

  it('a pass for another scene, or a visitor pass, joins as anonymous', async () => {
    const owner = await createUser()
    const a = await createScene(owner, 'A')
    const b = await createScene(owner, 'B')
    for (const sceneId of [a.scene.id, null]) {
      const c = await joinScene(gs.url, b.scene.id, tokenFor(owner, { kind: 'scene', sceneId, orgId: null }))
      const room = serverRoom(c.room.roomId)
      const actor = [...(room as any).clientMeta.values()].at(-1).actor
      expect(actor.userId).toBeNull()
      c.room.leave()
    }
  })
})
```

Adjust how the actor is read to what `VLMSceneRoom` actually stores (search for `clientMeta` / `auth` in the room; Colyseus also exposes `client.auth`). Keep the two assertions.

- [ ] **Step 2: Run — expect FAIL** (actor is the owner for scene B).

- [ ] **Step 3: Implement**

```ts
  async onAuth(_client: Client, options: JoinOptions): Promise<Actor> {
    const claims = verifySessionToken(options?.sessionToken)
    // A scene pass acts as its user only in its own scene; anywhere else it's an anonymous visitor.
    if (claims?.kind === 'scene' && (!claims.sceneId || claims.sceneId !== (options?.sceneId || this.sceneId))) return ANONYMOUS
    return actorFromClaims(claims)
  }
```

`VLMCommandCenterRoom.onAuth`: `if (claims?.kind === 'scene') return ANONYMOUS` before `actorFromClaims`.

- [ ] **Step 4: Run test + room suites.** `pnpm vitest run test/scene-pass-room.test.ts test/scene-room.test.ts test/command-center-room.test.ts`

- [ ] **Step 5: Commit** — `git commit -am "feat(rooms): scene passes downgrade to anonymous outside their scene"` (add the new test file).

---

### Task 7: Hand-off carries the pass to the website

**Files:**
- Modify: `apps/server/src/db/schema.ts` (`authHandoffCodes`: add `kind`, `sceneId`, `locationId`)
- Modify: `apps/server/src/routes/auth-handoff.ts`
- Modify: `apps/server/entrypoint.sh` (fallback `ALTER TABLE auth_handoff_codes ADD COLUMN IF NOT EXISTS …`)
- Modify: `docs/superpowers/specs/2026-10-16-vlm-scene-pass-design.md` (§3.1 Rooms line → "downgrades to an anonymous visitor")
- Modify: `apps/server/test/auth-handoff.test.ts`

**Interfaces:**
- Consumes: `issueScenePass` (Task 4), `isScenePass` (Task 5).
- Produces: exchange response for a pass-minted code: `{ user, accessToken, refreshToken, scene: { sceneId, locationId } }` with `kind: 'scene'` tokens; account-minted codes unchanged.

- [ ] **Step 1: Failing tests** — append to `test/auth-handoff.test.ts`:

```ts
  it('a code minted with a scene pass exchanges for the same scene pass, never an account session', async () => {
    const u = await createUser({ wallet: '0x00000000000000000000000000000000000000c1' })
    const { scene } = await createScene(u)
    const t = tokenFor(u, { kind: 'scene', sceneId: scene.id, locationId: null, orgId: null })
    const { code } = (await app.inject({ method: 'POST', url: '/api/auth/handoff', headers: { authorization: `Bearer ${t}` } })).json()
    const ex = await app.inject({ method: 'POST', url: '/api/auth/handoff/exchange', payload: { code } })
    expect(ex.statusCode).toBe(200)
    expect(verifySessionToken(ex.json().accessToken)).toMatchObject({ kind: 'scene', sceneId: scene.id })
    expect(ex.json().scene).toEqual({ sceneId: scene.id, locationId: null })
  })

  it('a visitor pass cannot mint a hand-off code', async () => {
    const u = await createUser({ wallet: '0x00000000000000000000000000000000000000c2' })
    const t = tokenFor(u, { kind: 'scene', sceneId: null, orgId: null })
    const res = await app.inject({ method: 'POST', url: '/api/auth/handoff', headers: { authorization: `Bearer ${t}` } })
    expect(res.statusCode).toBe(403)
  })
```

Update the file's existing tests: tokens from `tokenFor` are account tokens and keep the D1 behaviour (`kind: 'account'` in the exchanged token).

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement**

Schema:

```ts
  kind: text('kind').notNull().default('account'), // 'account' | 'scene' — what the exchange issues
  sceneId: uuid('scene_id').references(() => scenes.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').references(() => analyticsScenes.id, { onDelete: 'cascade' }),
```

`/api/auth/handoff` insert: `{ …, kind: isScenePass(request.user) ? 'scene' : 'account', sceneId: request.user.sceneId ?? null, locationId: request.user.locationId ?? null }`. `/exchange`: return the new columns in `.returning(...)`; when `claimed.kind === 'scene'` respond `issueScenePass(app, user, claimed.wallet, { sceneId: claimed.sceneId, locationId: claimed.locationId })`, else the existing `issueWalletSession`. Skip `linkWalletGrants` for scene codes.

`entrypoint.sh`, in the fallback block next to the D1 `CREATE TABLE IF NOT EXISTS auth_handoff_codes`, add:

```js
        await sql`ALTER TABLE auth_handoff_codes ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'account'`;
        await sql`ALTER TABLE auth_handoff_codes ADD COLUMN IF NOT EXISTS scene_id UUID REFERENCES scenes(id) ON DELETE CASCADE`;
        await sql`ALTER TABLE auth_handoff_codes ADD COLUMN IF NOT EXISTS location_id UUID REFERENCES analytics_scenes(id) ON DELETE CASCADE`;
```

(match the surrounding try/catch + `console.log` style).

Spec edit, §3.1 **Rooms** bullet: `VLMSceneRoom.onAuth` treats a scene pass whose `sceneId` isn't the room's scene, or a visitor pass, as an anonymous visitor (content only). `VLMCommandCenterRoom` treats every scene pass as anonymous.

- [ ] **Step 4: Run** `pnpm vitest run test/auth-handoff.test.ts && pnpm vitest run`.

- [ ] **Step 5: Commit** — `git add -A apps/server docs && git commit -m "feat(auth): hand-off codes carry the scene pass to the website"`

---

### Task 8: Scene library — table, list/add/remove, backfill

**Files:**
- Modify: `apps/server/src/db/schema.ts` (`sceneLibrary` + relations)
- Create: `apps/server/src/library/scene-library.ts`
- Create: `apps/server/src/routes/scene-library.ts`
- Modify: `apps/server/src/app.ts` (register routes; call backfill once at startup)
- Modify: `apps/server/entrypoint.sh` (fallback `CREATE TABLE IF NOT EXISTS scene_library …`)
- Test: `apps/server/test/scene-library.test.ts`

**Interfaces:**
- Produces:
```ts
export interface LibraryItem { id: string; kind: 'media' | 'model'; name: string; contentType: string | null; url: string; sizeBytes: number; addedBy: string | null; bookingId: string | null; createdAt: string }
export async function listSceneLibrary(sceneId: string): Promise<LibraryItem[]>
export async function linkToScene(sceneId: string, item: { mediaAssetId?: string; assetItemId?: string }, addedBy: string | null, bookingId?: string | null): Promise<string> // returns scene_library.id; idempotent
export async function backfillSceneLibrary(): Promise<number>
```
Routes: `GET /api/scenes/:sceneId/library` → `{ items: LibraryItem[] }` (viewer and above — any access level except `none`); `POST /api/scenes/:sceneId/library { mediaAssetId?, assetItemId? }` (account token only; caller owns the item; `scene.edit`) → `201 { id }`; `DELETE /api/scenes/:sceneId/library/:id` (host/co-host any; editor own `added_by`) → `204`. GET and DELETE declare `scenePass: { sceneFrom: fromParam('sceneId') }`; POST does not (account-only).

- [ ] **Step 1: Schema**

```ts
export const sceneLibrary = pgTable(
  'scene_library',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sceneId: uuid('scene_id').notNull().references(() => scenes.id, { onDelete: 'cascade' }),
    mediaAssetId: uuid('media_asset_id').references(() => mediaAssets.id, { onDelete: 'cascade' }),
    assetItemId: uuid('asset_item_id').references(() => assetLibraryItems.id, { onDelete: 'cascade' }),
    addedBy: uuid('added_by').references(() => users.id, { onDelete: 'set null' }),
    bookingId: uuid('booking_id').references(() => bookings.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    oneItem: check('scene_library_one_item', sql`(${t.mediaAssetId} IS NULL) <> (${t.assetItemId} IS NULL)`),
    mediaUq: uniqueIndex('scene_library_media_uq').on(t.sceneId, t.mediaAssetId).where(sql`${t.mediaAssetId} IS NOT NULL`),
    assetUq: uniqueIndex('scene_library_asset_uq').on(t.sceneId, t.assetItemId).where(sql`${t.assetItemId} IS NOT NULL`),
    byScene: index('scene_library_scene_idx').on(t.sceneId),
  }),
)
```

(Import `check` from `drizzle-orm/pg-core` if not yet imported; match how other tables in the file declare checks.)

- [ ] **Step 2: Failing tests** — `test/scene-library.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { mediaAssets, sceneElements, sceneLibrary, sceneRoles, assetLibraryItems } from '../src/db/schema.js'
import { backfillSceneLibrary, listSceneLibrary, linkToScene } from '../src/library/scene-library.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, createElement, tokenFor } from './helpers/factories.js'

const media = async (ownerId: string, url = `https://cdn/x-${Math.random()}.png`) =>
  (await db.insert(mediaAssets).values({ ownerId, filename: 'x.png', contentType: 'image/png', sizeBytes: 10, storageKey: url, publicUrl: url }).returning())[0]

describe('scene library', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { await app.close() })

  it('lists only items linked to the scene', async () => {
    const owner = await createUser()
    const a = await createScene(owner, 'A'); const b = await createScene(owner, 'B')
    const m1 = await media(owner.id); const m2 = await media(owner.id)
    await linkToScene(a.scene.id, { mediaAssetId: m1.id }, owner.id)
    await linkToScene(b.scene.id, { mediaAssetId: m2.id }, owner.id)
    expect((await listSceneLibrary(a.scene.id)).map((i) => i.id)).toHaveLength(1)
    const res = await app.inject({ method: 'GET', url: `/api/scenes/${a.scene.id}/library`, headers: { authorization: `Bearer ${tokenFor(owner, { kind: 'scene', sceneId: a.scene.id, orgId: null })}` } })
    expect(res.json().items.map((i: any) => i.url)).toEqual([m1.publicUrl])
  })

  it('linking is idempotent', async () => {
    const owner = await createUser(); const a = await createScene(owner)
    const m = await media(owner.id)
    const x = await linkToScene(a.scene.id, { mediaAssetId: m.id }, owner.id)
    const y = await linkToScene(a.scene.id, { mediaAssetId: m.id }, owner.id)
    expect(x).toBe(y)
  })

  it('owner adds from own library with an account token; a scene pass cannot', async () => {
    const owner = await createUser(); const a = await createScene(owner)
    const m = await media(owner.id)
    const pass = await app.inject({ method: 'POST', url: `/api/scenes/${a.scene.id}/library`, headers: { authorization: `Bearer ${tokenFor(owner, { kind: 'scene', sceneId: a.scene.id, orgId: null })}` }, payload: { mediaAssetId: m.id } })
    expect(pass.statusCode).toBe(403)
    const acct = await app.inject({ method: 'POST', url: `/api/scenes/${a.scene.id}/library`, headers: { authorization: `Bearer ${tokenFor(owner)}` }, payload: { mediaAssetId: m.id } })
    expect(acct.statusCode).toBe(201)
  })

  it("can't add someone else's file", async () => {
    const owner = await createUser(); const other = await createUser(); const a = await createScene(owner)
    const m = await media(other.id)
    const res = await app.inject({ method: 'POST', url: `/api/scenes/${a.scene.id}/library`, headers: { authorization: `Bearer ${tokenFor(owner)}` }, payload: { mediaAssetId: m.id } })
    expect(res.statusCode).toBe(403)
  })

  it('unlinking keeps the file; editors remove only their own', async () => {
    const owner = await createUser(); const ed = await createUser({ wallet: '0x00000000000000000000000000000000000000e1' })
    const a = await createScene(owner)
    await db.insert(sceneRoles).values({ sceneId: a.scene.id, userId: ed.id, walletAddress: ed.wallet!, role: 'editor' } as any)
    const m = await media(owner.id)
    const id = await linkToScene(a.scene.id, { mediaAssetId: m.id }, owner.id)
    const edRes = await app.inject({ method: 'DELETE', url: `/api/scenes/${a.scene.id}/library/${id}`, headers: { authorization: `Bearer ${tokenFor(ed)}` } })
    expect(edRes.statusCode).toBe(403)
    const ownRes = await app.inject({ method: 'DELETE', url: `/api/scenes/${a.scene.id}/library/${id}`, headers: { authorization: `Bearer ${tokenFor(owner)}` } })
    expect(ownRes.statusCode).toBe(204)
    expect(await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.id, m.id) })).toBeTruthy()
  })

  it('backfill links media and models already placed in a scene, once', async () => {
    const owner = await createUser(); const a = await createScene(owner)
    const m = await media(owner.id, 'https://cdn/placed.png')
    const [model] = await db.insert(assetLibraryItems).values({ name: 'Duck', storageKey: 'k', cdnUrl: 'https://cdn/duck.glb', uploadedBy: owner.id, isPublic: false } as any).returning()
    await createElement(a.preset.id, { type: 'image', properties: { textureSrc: 'https://cdn/placed.png' } })
    await createElement(a.preset.id, { type: 'model', properties: { modelSrc: 'https://cdn/duck.glb' } })
    expect(await backfillSceneLibrary()).toBe(2)
    expect(await backfillSceneLibrary()).toBe(0)
    const rows = await db.select().from(sceneLibrary).where(eq(sceneLibrary.sceneId, a.scene.id))
    expect(rows.map((r) => r.mediaAssetId ?? r.assetItemId).sort()).toEqual([m.id, model.id].sort())
  })
})
```

(Fill required columns for `scene_roles` / `asset_library_items` from `schema.ts` if the inserts fail on NOT NULL.)

- [ ] **Step 3: Run — expect FAIL.**

- [ ] **Step 4: Implement** — `src/library/scene-library.ts`:

```ts
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { assetLibraryItems, bookings, mediaAssets, sceneLibrary } from '../db/schema.js'

export interface LibraryItem { id: string; kind: 'media' | 'model'; name: string; contentType: string | null; url: string; sizeBytes: number; addedBy: string | null; bookingId: string | null; createdAt: string }

const ACTIVE_BOOKING = sql`(${sceneLibrary.bookingId} IS NULL OR EXISTS (SELECT 1 FROM ${bookings} b WHERE b.id = ${sceneLibrary.bookingId} AND b.status IN ('confirmed','live') AND b.ends_at > now()))`

export async function listSceneLibrary(sceneId: string): Promise<LibraryItem[]> {
  const rows = await db
    .select({ l: sceneLibrary, m: mediaAssets, a: assetLibraryItems })
    .from(sceneLibrary)
    .leftJoin(mediaAssets, eq(mediaAssets.id, sceneLibrary.mediaAssetId))
    .leftJoin(assetLibraryItems, eq(assetLibraryItems.id, sceneLibrary.assetItemId))
    .where(and(eq(sceneLibrary.sceneId, sceneId), ACTIVE_BOOKING))
    .orderBy(sql`${sceneLibrary.createdAt} desc`)
  return rows.flatMap(({ l, m, a }) => {
    const base = { id: l.id, addedBy: l.addedBy, bookingId: l.bookingId, createdAt: l.createdAt.toISOString() }
    if (m) return [{ ...base, kind: 'media' as const, name: m.filename, contentType: m.contentType, url: m.publicUrl ?? '', sizeBytes: m.sizeBytes }]
    if (a) return [{ ...base, kind: 'model' as const, name: a.name, contentType: 'model/gltf-binary', url: a.cdnUrl ?? '', sizeBytes: a.fileSizeBytes }]
    return []
  })
}

export async function linkToScene(sceneId: string, item: { mediaAssetId?: string; assetItemId?: string }, addedBy: string | null, bookingId: string | null = null): Promise<string> {
  const values = { sceneId, mediaAssetId: item.mediaAssetId ?? null, assetItemId: item.assetItemId ?? null, addedBy, bookingId }
  const [row] = await db.insert(sceneLibrary).values(values).onConflictDoNothing().returning({ id: sceneLibrary.id })
  if (row) return row.id
  const existing = await db.query.sceneLibrary.findFirst({
    where: and(eq(sceneLibrary.sceneId, sceneId), item.mediaAssetId ? eq(sceneLibrary.mediaAssetId, item.mediaAssetId) : eq(sceneLibrary.assetItemId, item.assetItemId!)),
    columns: { id: true },
  })
  return existing!.id
}

const SRC_KEYS = ['textureSrc', 'modelSrc', 'audioSrc', 'offImageSrc', 'imgSrc', 'kioskImgSrc']

/** Link every media file / model already placed in a scene (by URL in element or instance properties). Idempotent; returns rows added. */
export async function backfillSceneLibrary(): Promise<number> {
  const urlsExpr = SRC_KEYS.map((k) => `p.props->>'${k}'`).join(', ')
  const placed = sql.raw(`
    SELECT DISTINCT sp.scene_id, u.url FROM (
      SELECT e.preset_id, e.properties AS props FROM scene_elements e
      UNION ALL SELECT e.preset_id, i.properties FROM scene_element_instances i JOIN scene_elements e ON e.id = i.element_id
    ) p JOIN scene_presets sp ON sp.id = p.preset_id
    CROSS JOIN LATERAL unnest(ARRAY[${urlsExpr}]) AS u(url) WHERE u.url IS NOT NULL`)
  const media = await db.execute(sql`
    INSERT INTO scene_library (scene_id, media_asset_id, added_by)
    SELECT pl.scene_id, m.id, s.owner_id FROM (${placed}) pl JOIN media_assets m ON m.public_url = pl.url JOIN scenes s ON s.id = pl.scene_id
    ON CONFLICT DO NOTHING RETURNING id`)
  const models = await db.execute(sql`
    INSERT INTO scene_library (scene_id, asset_item_id, added_by)
    SELECT pl.scene_id, a.id, s.owner_id FROM (${placed}) pl JOIN asset_library_items a ON a.cdn_url = pl.url JOIN scenes s ON s.id = pl.scene_id
    ON CONFLICT DO NOTHING RETURNING id`)
  return (media as any).length + (models as any).length
}
```

(`db.execute` returns an array-like with the postgres-js driver; if it returns `{ rows }`, use `.rows.length`. Verify column names `scene_element_instances.element_id`, `scene_elements.preset_id`, `scene_presets.scene_id` in `schema.ts`. Partial unique indexes need `ON CONFLICT DO NOTHING` without a target — that works.)

`src/routes/scene-library.ts`:

```ts
import type { FastifyInstance } from 'fastify'
import { and, eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { assetLibraryItems, mediaAssets, sceneLibrary } from '../db/schema.js'
import { authenticate } from '../middleware/auth.js'
import { actorFromClaims } from '../auth/actor.js'
import { getSceneAccess, hasScope, isFullAccess } from '../auth/permissions.js'
import { fromParam, isScenePass } from '../auth/scene-from.js'
import { linkToScene, listSceneLibrary } from '../library/scene-library.js'

export default async function sceneLibraryRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  const access = (request: any, sceneId: string) => getSceneAccess(actorFromClaims(request.user), sceneId)

  app.get<{ Params: { sceneId: string } }>('/api/scenes/:sceneId/library', { config: { scenePass: { sceneFrom: fromParam('sceneId') } } }, async (request, reply) => {
    if ((await access(request, request.params.sceneId)).level === 'none') return reply.status(403).send({ error: 'forbidden' })
    return reply.send({ items: await listSceneLibrary(request.params.sceneId) })
  })

  app.post<{ Params: { sceneId: string }; Body: { mediaAssetId?: string; assetItemId?: string } }>('/api/scenes/:sceneId/library', async (request, reply) => {
    const { sceneId } = request.params
    const { mediaAssetId, assetItemId } = request.body ?? {}
    if (!!mediaAssetId === !!assetItemId) return reply.status(400).send({ error: 'Give exactly one of mediaAssetId or assetItemId' })
    if (!hasScope(await access(request, sceneId), 'scene.edit')) return reply.status(403).send({ error: 'forbidden' })
    const owns = mediaAssetId
      ? await db.query.mediaAssets.findFirst({ where: and(eq(mediaAssets.id, mediaAssetId), eq(mediaAssets.ownerId, request.user.id)) })
      : await db.query.assetLibraryItems.findFirst({ where: and(eq(assetLibraryItems.id, assetItemId!), eq(assetLibraryItems.uploadedBy, request.user.id)) })
    if (!owns) return reply.status(403).send({ error: 'forbidden' })
    return reply.status(201).send({ id: await linkToScene(sceneId, { mediaAssetId, assetItemId }, request.user.id) })
  })

  app.delete<{ Params: { sceneId: string; id: string } }>('/api/scenes/:sceneId/library/:id', { config: { scenePass: { sceneFrom: fromParam('sceneId') } } }, async (request, reply) => {
    const { sceneId, id } = request.params
    const row = await db.query.sceneLibrary.findFirst({ where: and(eq(sceneLibrary.id, id), eq(sceneLibrary.sceneId, sceneId)) })
    if (!row) return reply.status(404).send({ error: 'Not found' })
    const a = await access(request, sceneId)
    const allowed = isFullAccess(a) || (hasScope(a, 'scene.edit') && row.addedBy === request.user.id)
    if (!allowed) return reply.status(403).send({ error: 'forbidden' })
    await db.delete(sceneLibrary).where(eq(sceneLibrary.id, id))
    return reply.status(204).send()
  })
}
```

(`isScenePass` import unused here unless needed — drop it if lint complains.) Register in `app.ts` after `sceneRoleRoutes`. In `app.ts` `buildApp` (not in tests), after routes are registered and only when `opts.backfill !== false`, run `backfillSceneLibrary().catch((e) => app.log.warn({ err: e }, 'scene library backfill failed'))` once; `testApp()` passes `backfill: false` (add the option to `buildApp`'s opts type and to `test/helpers/factories.ts` `testApp`).

`entrypoint.sh` fallback: `CREATE TABLE IF NOT EXISTS scene_library (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), scene_id UUID NOT NULL REFERENCES scenes(id) ON DELETE CASCADE, media_asset_id UUID REFERENCES media_assets(id) ON DELETE CASCADE, asset_item_id UUID REFERENCES asset_library_items(id) ON DELETE CASCADE, added_by UUID REFERENCES users(id) ON DELETE SET NULL, booking_id UUID REFERENCES bookings(id) ON DELETE CASCADE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), CONSTRAINT scene_library_one_item CHECK ((media_asset_id IS NULL) <> (asset_item_id IS NULL)))` plus the two partial unique indexes and the scene index with `CREATE … IF NOT EXISTS`.

- [ ] **Step 5: Run** `pnpm vitest run test/scene-library.test.ts && pnpm vitest run` (the Task 5 route walk will now include the POST library route — it must refuse passes, which it does because it has no `scenePass` config).

- [ ] **Step 6: Commit** — `git add -A apps/server && git commit -m "feat(library): per-scene library with backfill"`

---

### Task 9: Uploads into the scene library (owner's or renter's account)

**Files:**
- Create: `apps/server/src/media/store.ts` (shared upload logic extracted from `routes/media.ts`)
- Modify: `apps/server/src/routes/media.ts` (use `storeMedia`)
- Modify: `apps/server/src/routes/scene-library.ts` (add `POST /api/scenes/:sceneId/library/upload`)
- Modify: `apps/server/src/routes/companion-upload.ts` (`POST /api/upload/:code`: link to the token's scene)
- Test: `apps/server/test/scene-library-upload.test.ts`

**Interfaces:**
- Produces:
```ts
export class StoreMediaError extends Error { constructor(public status: number, public body: Record<string, unknown>) }
export async function storeMedia(ownerId: string, file: { filename: string; contentType: string; data: Buffer }, opts?: { quotaMessage?: string; quotaStatus?: number }): Promise<typeof mediaAssets.$inferSelect>
export async function uploadDestination(actor: Actor, sceneId: string): Promise<{ ownerId: string; bookingId: string | null } | null> // null = not allowed
```
`POST /api/scenes/:sceneId/library/upload { filename, contentType, data (base64) }` (same body as `/api/media/upload`) → `201 { item: LibraryItem }`; declares `scenePass: { sceneFrom: fromParam('sceneId') }`.

- [ ] **Step 1: Failing tests** — `test/scene-library-upload.test.ts`. Read `test/media-upload.test.ts` first and reuse its storage setup (local storage dir, tiny PNG base64) and how it forces quota (it likely sets a subscription tier or `config.allFeaturesUnlocked = false`).

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { mediaAssets, sceneLibrary } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, createScene, tokenFor } from './helpers/factories.js'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

describe('scene library uploads', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { await app.close() })

  const upload = (token: string, sceneId: string) => app.inject({ method: 'POST', url: `/api/scenes/${sceneId}/library/upload`, headers: { authorization: `Bearer ${token}` }, payload: { filename: 'a.png', contentType: 'image/png', data: PNG } })

  it("an editor's upload lands in the owner's account and the scene library", async () => {
    const owner = await createUser(); const ed = await createUser({ wallet: '0x00000000000000000000000000000000000000e2' })
    const { scene } = await createScene(owner)
    await db.insert((await import('../src/db/schema.js')).sceneRoles).values({ sceneId: scene.id, userId: ed.id, walletAddress: ed.wallet!, role: 'editor' } as any)
    const res = await upload(tokenFor(ed, { kind: 'scene', sceneId: scene.id, orgId: null }), scene.id)
    expect(res.statusCode).toBe(201)
    const m = await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.publicUrl, res.json().item.url) })
    expect(m!.ownerId).toBe(owner.id)
    const link = await db.query.sceneLibrary.findFirst({ where: eq(sceneLibrary.mediaAssetId, m!.id) })
    expect(link!.addedBy).toBe(ed.id)
  })

  it('a viewer cannot upload', async () => {
    const owner = await createUser(); const v = await createUser({ wallet: '0x00000000000000000000000000000000000000e3' })
    const { scene } = await createScene(owner)
    await db.insert((await import('../src/db/schema.js')).sceneRoles).values({ sceneId: scene.id, userId: v.id, walletAddress: v.wallet!, role: 'viewer' } as any)
    expect((await upload(tokenFor(v), scene.id)).statusCode).toBe(403)
  })

  it("owner over quota → 413 with the owner's-storage message", async () => {
    // Force the owner's quota to be exceeded the same way media-upload.test.ts does (e.g. insert a media row with a huge sizeBytes and unlock-off config).
    const owner = await createUser(); const { scene } = await createScene(owner)
    await db.insert(mediaAssets).values({ ownerId: owner.id, filename: 'big', contentType: 'image/png', sizeBytes: 2_000_000_000, storageKey: 'big', publicUrl: 'https://cdn/big' })
    const res = await upload(tokenFor(owner), scene.id)
    expect(res.statusCode).toBe(413)
    expect(res.json()).toEqual(expect.objectContaining({ error: 'storage_limit_reached', message: "The scene owner's storage is full" }))
  })

  it("a renter's upload during a booking lands in the renter's account with the booking and hides after it ends", async () => {
    const H = 3600_000
    const admin = await createUser({ role: 'admin' })
    const { scene, preset } = await createScene(admin)
    const screen = await createElement(preset.id, { type: 'video' })
    const v = await app.inject({ method: 'POST', url: '/api/venues', headers: { authorization: `Bearer ${tokenFor(admin)}` }, payload: { sceneId: scene.id, name: 'Lounge', slug: 'lounge', rentableElementIds: [screen.id] } })
    const renter = await createUser({ wallet: '0x00000000000000000000000000000000000000f1' })
    const startsAt = new Date(Date.now() - 10 * 60_000)
    const b = await app.inject({
      method: 'POST', url: `/api/venues/${v.json().venue.id}/bookings`, headers: { authorization: `Bearer ${tokenFor(admin)}` },
      payload: { renterWallet: renter.wallet, title: 'Set', startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 2 * H).toISOString() },
    })
    expect(b.statusCode).toBe(201)
    const bookingId = b.json().booking.id
    const res = await upload(tokenFor(renter), scene.id)
    expect(res.statusCode).toBe(201)
    const m = await db.query.mediaAssets.findFirst({ where: eq(mediaAssets.publicUrl, res.json().item.url) })
    expect(m!.ownerId).toBe(renter.id)
    expect((await db.query.sceneLibrary.findFirst({ where: eq(sceneLibrary.mediaAssetId, m!.id) }))!.bookingId).toBe(bookingId)
    const list = (t: string) => app.inject({ method: 'GET', url: `/api/scenes/${scene.id}/library`, headers: { authorization: `Bearer ${t}` } })
    expect((await list(tokenFor(admin))).json().items.map((i: any) => i.url)).toContain(m!.publicUrl)
    await db.update(bookings).set({ status: 'ended' }).where(eq(bookings.id, bookingId))
    expect((await list(tokenFor(admin))).json().items.map((i: any) => i.url)).not.toContain(m!.publicUrl)
  })
})
```

Add `createElement` to the factories import and `bookings` to the schema import. If the booking route returns the booking under another key than `booking`, or the booking's window doesn't make the grant active (check `bookingWindowAt` and the venue rules' setup lead time in `venues/`), adjust `startsAt` so "now" is inside the live window — the four expectations stay. The quota test must set whatever config the existing media test uses to enable quota (`config.allFeaturesUnlocked = false`, restored in `afterEach`).

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement**

`src/media/store.ts`: move the body of `POST /api/media/upload` (classify, quota, storage upload, insert) into `storeMedia(ownerId, file, opts)`. On quota exceeded throw `new StoreMediaError(opts.quotaStatus ?? 403, { error: 'storage_limit_reached', message: opts.quotaMessage ?? <the existing message>, …existing fields })`; on a refused file type throw with the existing status/body. `routes/media.ts` calls it with `request.user.id` and maps `StoreMediaError` to `reply.status(e.status).send(e.body)` — its responses stay byte-identical (`test/media-upload.test.ts` must still pass unchanged).

`uploadDestination(actor, sceneId)` in `src/library/scene-library.ts`:

```ts
export async function uploadDestination(actor: Actor, sceneId: string): Promise<{ ownerId: string; bookingId: string | null } | null> {
  const access = await getSceneAccess(actor, sceneId)
  if (access.level === 'grant' && access.booking && [...access.scopes].length > 0) return { ownerId: actor.userId!, bookingId: access.booking.id }
  if (!hasScope(access, 'scene.edit')) return null
  const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId), columns: { ownerId: true } })
  return scene ? { ownerId: scene.ownerId, bookingId: null } : null
}
```

(Imports: `getSceneAccess`, `hasScope` from `../auth/permissions.js`, `scenes` from the schema, `type Actor` from `../auth/actor.js`. Check `BookingAccess` exposes the booking id as `id`; if it's `bookingId`, use that.)

Upload route in `routes/scene-library.ts`:

```ts
  app.post<{ Params: { sceneId: string }; Body: { filename?: string; contentType?: string; data?: string } }>(
    '/api/scenes/:sceneId/library/upload',
    { config: { scenePass: { sceneFrom: fromParam('sceneId') } }, bodyLimit: 60 * 1024 * 1024 },
    async (request, reply) => {
      const { sceneId } = request.params
      const { filename, contentType, data } = request.body ?? {}
      if (!filename || !contentType || !data) return reply.status(400).send({ error: 'filename, contentType and data are required' })
      const dest = await uploadDestination(actorFromClaims(request.user), sceneId)
      if (!dest) return reply.status(403).send({ error: 'forbidden' })
      try {
        const m = await storeMedia(dest.ownerId, { filename, contentType, data: Buffer.from(data, 'base64') }, { quotaStatus: 413, quotaMessage: dest.bookingId ? undefined : "The scene owner's storage is full" })
        await linkToScene(sceneId, { mediaAssetId: m.id }, request.user.id, dest.bookingId)
        const item = (await listSceneLibrary(sceneId)).find((i) => i.url === m.publicUrl)
        return reply.status(201).send({ item })
      } catch (e) {
        if (e instanceof StoreMediaError) return reply.status(e.status).send(e.body)
        throw e
      }
    },
  )
```

(Use the same `bodyLimit` that `routes/media.ts` uses for uploads, if it sets one.)

`routes/companion-upload.ts` `POST /api/upload/:code`: after inserting the `assetLibraryItems` row, when `token.sceneId` is set: `const dest = await uploadDestination(actorFromClaims({ id: token.userId, role: 'user', verified: true, kind: 'account' } as any), token.sceneId); if (dest) await linkToScene(token.sceneId, { assetItemId: item.id }, token.userId, dest.bookingId)`.

- [ ] **Step 4: Run** `pnpm vitest run test/scene-library-upload.test.ts test/media-upload.test.ts && pnpm vitest run`.

- [ ] **Step 5: Commit** — `git add -A apps/server && git commit -m "feat(library): uploads go to the scene owner's (or renter's) account"`

---

### Task 10: Website — kind-aware sessions, scene-pass guard and banner

**Files:**
- Create: `apps/web/src/lib/session.ts` (pure)
- Test: `apps/web/src/lib/session.test.ts`
- Modify: `apps/web/src/lib/auth.tsx` (load: drop kind-less; expose `scenePass`)
- Modify: `apps/web/src/app/(dashboard)/layout.tsx` (guard + banner + hide nav for passes)
- Modify: `apps/web/src/app/page.tsx` (a scene pass doesn't count as signed in)

**Interfaces:**
- Produces:
```ts
export interface ScenePass { sceneId: string; locationId: string | null }
export function readSession(token: string, now: number): { ok: false } | { ok: true; scenePass: ScenePass | null }
export function scenePassAllows(pathname: string, search: string, pass: ScenePass): boolean
```
`useAuth()` gains `scenePass: ScenePass | null`.

- [ ] **Step 1: Failing tests** — `apps/web/src/lib/session.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readSession, scenePassAllows } from './session'

const tok = (p: Record<string, unknown>) => `x.${Buffer.from(JSON.stringify(p)).toString('base64url')}.y`
const NOW = 1_800_000_000_000
const exp = NOW / 1000 + 600

describe('readSession', () => {
  it('drops kind-less and expired tokens', () => {
    expect(readSession(tok({ exp }), NOW)).toEqual({ ok: false })
    expect(readSession(tok({ exp: NOW / 1000 - 1, kind: 'account' }), NOW)).toEqual({ ok: false })
    expect(readSession('garbage', NOW)).toEqual({ ok: false })
  })
  it('account tokens have no scene pass; scene tokens do; a visitor pass is dropped', () => {
    expect(readSession(tok({ exp, kind: 'account' }), NOW)).toEqual({ ok: true, scenePass: null })
    expect(readSession(tok({ exp, kind: 'scene', sceneId: 's1', locationId: 'l1' }), NOW)).toEqual({ ok: true, scenePass: { sceneId: 's1', locationId: 'l1' } })
    expect(readSession(tok({ exp, kind: 'scene', sceneId: null }), NOW)).toEqual({ ok: false })
  })
})

describe('scenePassAllows', () => {
  const pass = { sceneId: 's1', locationId: 'l1' }
  it('allows only its own scene analytics', () => {
    expect(scenePassAllows('/analytics/', '?scene=s1', pass)).toBe(true)
    expect(scenePassAllows('/analytics/', '?location=l1', pass)).toBe(true)
    expect(scenePassAllows('/analytics/', '?scene=s2', pass)).toBe(false)
    expect(scenePassAllows('/analytics/', '', pass)).toBe(false)
    expect(scenePassAllows('/scenes/', '', pass)).toBe(false)
    expect(scenePassAllows('/settings/', '', pass)).toBe(false)
  })
})
```

- [ ] **Step 2: Run — expect FAIL.** `cd apps/web && pnpm vitest run src/lib/session.test.ts`

- [ ] **Step 3: Implement** — `apps/web/src/lib/session.ts`:

```ts
export interface ScenePass { sceneId: string; locationId: string | null }

function payloadOf(token: string): Record<string, unknown> | null {
  const part = token.split('.')[1]
  if (!part) return null
  try {
    const json = typeof atob === 'function' ? atob(part.replace(/-/g, '+').replace(/_/g, '/')) : Buffer.from(part, 'base64url').toString()
    return JSON.parse(json)
  } catch { return null }
}

/** A stored session is usable only if unexpired and of a known kind. Visitor passes (no scene) are never kept. */
export function readSession(token: string, now: number): { ok: false } | { ok: true; scenePass: ScenePass | null } {
  const p = payloadOf(token)
  if (!p || typeof p.exp !== 'number' || p.exp * 1000 <= now) return { ok: false }
  if (p.kind === 'account') return { ok: true, scenePass: null }
  if (p.kind === 'scene' && typeof p.sceneId === 'string') return { ok: true, scenePass: { sceneId: p.sceneId, locationId: typeof p.locationId === 'string' ? p.locationId : null } }
  return { ok: false }
}

/** Pages a scene pass may open: that scene's analytics. Extend here when HUD links to more scene pages. */
export function scenePassAllows(pathname: string, search: string, pass: ScenePass): boolean {
  if (!pathname.startsWith('/analytics')) return false
  const q = new URLSearchParams(search)
  return q.get('scene') === pass.sceneId || (!!pass.locationId && q.get('location') === pass.locationId)
}
```

`lib/auth.tsx`: replace the mount-time `exp` check with `const s = readSession(data.token, Date.now()); if (s.ok) { setUser(data.user); setScenePass(s.scenePass) } else localStorage.removeItem('vlm_auth')`. Add `scenePass` state (set to `null` on login/register/wallet login/logout) and expose it on the context.

`app/(dashboard)/layout.tsx`: after the existing redirect effect, add an effect: `if (!loading && user && scenePass && !scenePassAllows(window.location.pathname, window.location.search, scenePass)) router.push('/?next=' + encodeURIComponent(window.location.pathname + window.location.search))`. When `scenePass` is set, render no nav items and show above `children`:

```tsx
<div className="mb-4 rounded-lg border border-gray-800 bg-gray-900 px-4 py-2 text-sm text-gray-300">
  Signed in from {sceneTitle} — <Link className="underline" href={`/?next=${encodeURIComponent(here)}`} onClick={logout}>sign in for full access</Link>
</div>
```

`sceneTitle`: when `scenePass` is set, the layout calls `apiFetch('/api/scenes')` once (a pass gets exactly its bound scene back, Task 5) and uses `scenes[0]?.name ?? 'this scene'`; until it resolves, show `this scene`. (Keep the verbatim text from Global Constraints.)

`app/page.tsx`: the redirect `if (!loading && user) router.push(dest)` becomes `if (!loading && user && !scenePass) router.push(dest)`, and `if (user) return null` becomes `if (user && !scenePass) return null`, so a pass holder sees the sign-in form; a successful sign-in replaces the session (login handlers already overwrite `vlm_auth`).

- [ ] **Step 4: Run web tests and typecheck.** `cd apps/web && pnpm vitest run && pnpm exec tsc --noEmit`

- [ ] **Step 5: Commit** — `git add -A apps/web && git commit -m "feat(web): scene-pass sessions, page guard and sign-in banner"`

---

### Task 11: In-world client uses the binding and the scene library

**Files:**
- Modify: `packages/vlm-client/src/http.ts` (`authenticateWithPlatform` returns `scene`; `getSceneLibrary`, `uploadToSceneLibrary`)
- Modify: `packages/vlm-adapter-dcl/src/index.ts` (`refreshMedia` → scene library; `place` uses item URL)
- Modify: `packages/vlm-hud/src/panels/AssetBrowserPanel.ts` (upload token request sends `sceneId`)
- Modify: `packages/vlm-core/src/VLM.ts` (keep `authResponse.scene` as `this._binding`)
- Test: `packages/vlm-core/test/*` or `packages/vlm-client` tests where `http.ts` is tested (follow existing test locations; `pnpm --filter vlm-core test` runs 96 tests today)

**Interfaces:**
- Consumes: `GET /api/scenes/:sceneId/library` → `{ items: LibraryItem[] }` (Task 8); `POST /api/scenes/:sceneId/library/upload` (Task 9); platform response `scene: { sceneId, locationId }` (Task 4).
- Produces: `VLMHttpClient.getSceneLibrary(sceneId: string): Promise<{ items: SceneLibraryItem[] }>`; `type SceneLibraryItem = { id: string; kind: 'media' | 'model'; name: string; contentType: string | null; url: string; sizeBytes: number }`.

- [ ] **Step 1: Failing test** — next to the existing `http.ts` tests, assert `getSceneLibrary('s1')` fetches `/api/scenes/s1/library` with the bearer header and returns `items` (use the same fetch-mock pattern the existing tests use).

- [ ] **Step 2: Run — expect FAIL.**

- [ ] **Step 3: Implement**
- `http.ts`: add the type and `getSceneLibrary(sceneId) { return this._fetch(\`/api/scenes/${encodeURIComponent(sceneId)}/library\`) }`. Keep `getMedia()` for other callers.
- `vlm-adapter-dcl/src/index.ts` `refreshMedia`: call `vlm.httpClient.getSceneLibrary(sceneId)` and map each item to `HUDMediaItem { id: item.id, name: item.name, kind: item.kind === 'model' ? 'model' : mediaKindOf(item.contentType, item.url) }` (reuse the existing `mediaKind` logic on `contentType`/`url`; skip items it returns null for). `place(assetId)`: look the item up in the last fetched library list by `id` and use `item.url` for `textureSrc`/`modelSrc`.
- `AssetBrowserPanel.ts` upload-token request: include `sceneId` (the panel's current scene id — follow how it gets the scene; if it has none, pass it in from the adapter when constructing the panel).
- `VLM.ts authenticate()`: store `authResponse.scene` (if present) on the instance as `binding`; no behaviour change otherwise.

- [ ] **Step 4: Run** `pnpm --filter vlm-client test; pnpm --filter vlm-core test; pnpm turbo typecheck` (all green).

- [ ] **Step 5: Commit** — `git add -A packages && git commit -m "feat(dcl): HUD uses the scene library and the signed binding"`

---

### Task 12: Docs, deploy fallbacks check, full verification

**Files:**
- Modify: `apps/docs/src/content/docs/dashboard/analytics.md` (Stats sign-in now opens a scene pass: that scene only, banner, full sign-in for the rest)
- Create: `apps/docs/src/content/docs/security/scene-pass.md` (short page: what a scene can and can't do with a visitor's VLM identity; one forced re-sign-in on upgrade; scene library ownership rules; renters)
- Modify: `apps/docs` sidebar config if pages are listed explicitly (check `astro.config.*`)

- [ ] **Step 1: Write the docs pages** in the style of the existing `dashboard/*.md` pages (frontmatter `title`, `description`; second person; short sections).

- [ ] **Step 2: Full verification**

```bash
export PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH
cd apps/server && pnpm vitest run && cd ../..
pnpm --filter web exec vitest run
pnpm --filter vlm-core test
pnpm turbo typecheck
bash -n apps/server/entrypoint.sh
```
Expected: everything green; `bash -n` prints nothing.

- [ ] **Step 3: Build the test scene against the branch's vlm-dcl** in a scratch copy (as for D1): copy `test-scenes/dcl-test` to the scratchpad, point its `vlm-dcl` dependency at `packages/vlm-smart-item-dcl` (`pnpm run bundle` there first), run its build. Expected: builds.

- [ ] **Step 4: Commit** — `git add -A apps/docs && git commit -m "docs: scene pass and scene library"`

- [ ] **Step 5: Manual in-world checklist (for the user after deploy)** — record in the final report, don't run:
  1. Own scene: HUD connects, media list shows the scene library, place an image, Stats opens analytics signed in with the banner; any other dashboard page asks for sign-in.
  2. Another parcel with no setup: no HUD; visiting doesn't create anything.
  3. Copy of the test scene deployed elsewhere with `sceneId` set to the real scene: content shows (anonymous visitor), no editing, Stats unavailable.
  4. Website: existing sessions are signed out once; signing in works.
