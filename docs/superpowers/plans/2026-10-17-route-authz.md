# Route Authorization Sweep Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every Critical, High and Medium finding in the route audit, delete the legacy code it lists, and add a cross-account route walk so a new unguarded route fails the suite.

**Architecture:** Each fix uses the existing permission helpers (`getSceneAccess`, `isFullAccess`, `hasScope` in `apps/server/src/auth/permissions.ts`) at the route, not new middleware. Two small new modules: an outbound-URL guard (`src/net/public-url.ts`) shared by platform hooks and the deploy target check, and a storage quota helper shared by every upload path. The route walk reuses the route list `app.ts` already collects for `test/scene-pass-guard.test.ts`.

**Tech Stack:** Fastify 5, Drizzle + Postgres, Colyseus 0.15, vitest (real Postgres), Next 15 web, TypeScript.

**Spec:** `.superpowers/route-authz-audit.md` (the audit; finding rows are cited as `audit:<line>`). Decisions taken with the user on 2026-10-17:
- Fix the billing webhook signature bypass; touch no other billing code.
- Keep `/hook/register` and the `/hook/*` reads public (scene content is public in-world). Fix it by stripping stream keys, refusing private/internal callback addresses, and capping hooks per scene.
- No compat shims: nobody but the owner uses VLM.

## Global Constraints

- Run tests with Node 20: `export PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH`. The default `node` (v16) breaks vitest.
- Server tests: `cd apps/server && npx vitest run <file>`. Never run two server vitest processes at once (they share one database).
- Billing: change only the `POST /api/billing/webhook` handler and the parser it needs. Leave every other billing route, `requireFeature` usage and `services/stripe` untouched.
- Refusals for another account's resource return **404** when the resource is looked up by id and the caller has no access at all (do not confirm it exists), and **403** when the caller can see the scene but lacks the scope. Match the route's existing error shape `{ error: string }`.
- No compat paths, no deprecation shims, no feature flags for removed code.
- Do not use bare `git stash`. Commit with the attribution line from the session.
- Do not deploy or push; the controller asks the user.

## Review Focus

1. **Admin role** — every new check must still let a `role: 'admin'` account through where the old owner-only check did (`getSceneAccess` returns `admin`; hand-rolled event/giveaway checks keep `|| role === 'admin'`).
2. **Cohost access to deploys** — a cohost (full access) of a scene must be able to deploy and read that scene's deployments; replacing `ownerId ===` with `isFullAccess` is the point, not a side effect.
3. **Hook address check at send time** — a hostname that resolved public at registration and private later (DNS rebinding) must be refused at dispatch, not only at register.
4. **Phone upload keeps working** — `apps/web/src/app/u/[code]/client.tsx` reads `data.asset` from `POST /api/upload/:code`; after the move to `storeMedia` the page must still list the uploaded file and the file must appear in the scene library.
5. **Real signed Stripe events** — the webhook must verify against the exact raw body bytes; a correctly signed event must succeed, not only forged ones fail.

---

### Task 1: Billing webhook refuses unsigned events and verifies the raw body

audit:222. Today the signature check runs only `if (webhookSecret && sig)`, and the route sits outside the scope that keeps `rawBody`, so real signed events cannot verify either.

**Files:**
- Create: `apps/server/src/billing/webhook-verify.ts`
- Modify: `apps/server/src/routes/billing.ts:144-175` (webhook handler only)
- Modify: `apps/server/src/app.ts:113-134` (raw JSON parser scope)
- Test: `apps/server/test/billing-webhook.test.ts`

**Interfaces:**
- Produces: `verifyWebhookEvent(rawBody: string | undefined, sig: string | undefined, opts: { secret: string | undefined; stripeKey: string; mode: VLMMode; nodeEnv: string | undefined }): Promise<{ ok: true; event: unknown } | { ok: false; status: number; error: string }>`
- Produces: `withRawJson(scope: FastifyInstance): void` exported from `apps/server/src/app.ts` region, or a small `src/http/raw-json.ts` — installs the existing `parseAs: 'string'` parser that sets `request.rawBody`.

Rules for `verifyWebhookEvent`:
- secret set, sig missing → `{ ok:false, status:400, error:'Missing Stripe signature' }`
- secret set, sig present → `stripe.webhooks.constructEvent(rawBody, sig, secret)`; throws → `{ ok:false, status:400, error:'Webhook signature verification failed' }`; rawBody undefined → same 400 (never fall back to the parsed body)
- secret unset and (`mode === 'cloud'` or `nodeEnv === 'production'`) → `{ ok:false, status:503, error:'Webhook secret not configured' }`
- secret unset otherwise (local dev) → `{ ok:true, event: JSON.parse(rawBody) }`

- [ ] **Step 1: Write failing unit tests** in `test/billing-webhook.test.ts` for `verifyWebhookEvent`: the four rules above, plus a correctly signed event (build the header with `stripe.webhooks.generateTestHeaderString({ payload, secret })`) returning `ok:true` with `event.type === 'customer.subscription.updated'`, and a signed header over a *different* payload returning 400.
- [ ] **Step 2: Run** `npx vitest run test/billing-webhook.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** `verifyWebhookEvent`; replace the handler's verification block with it; move billing route registration into a scope that calls `withRawJson` (the auth scope's parser, extracted so both scopes share it — the auth scope's rate-limit hook stays on the auth scope only).
- [ ] **Step 4: Add one route-level test**: with the app built, `POST /api/billing/webhook` without `stripe-signature` does not reach `handleWebhookEvent`. If `config.billingEnabled` is false in tests the route 404s first; in that case assert the unit tests cover it and note it in the report rather than mutating config.
- [ ] **Step 5: Run** the file and `test/scene-pass-guard.test.ts` — expect PASS.
- [ ] **Step 6: Commit** `fix(billing): refuse unsigned Stripe webhooks and verify the raw body`.

---

### Task 2: Platform hooks: public addresses only, no stream keys, capped per scene

audit:93, 133-135. Hooks stay public by design.

**Files:**
- Create: `apps/server/src/net/public-url.ts`
- Modify: `apps/server/src/routes/hooks.ts` (register; `GET /api/hooks` and `DELETE /api/hooks/:hookId` use `isFullAccess`)
- Modify: `apps/server/src/integrations/platform-hooks.ts:36-60` (check at send time)
- Modify: `apps/server/src/routes/streaming.ts:280-325` (drop `streamKey` from callback payloads)
- Modify: `apps/server/src/config.ts` (new flag)
- Test: `apps/server/test/public-url.test.ts`, extend `apps/server/test/rest-platform-callbacks.test.ts`

**Interfaces:**
- Produces: `class UnsafeUrlError extends Error`; `assertPublicHttpUrl(url: string, opts?: { allowPrivate?: boolean; lookup?: (host: string) => Promise<string[]> }): Promise<URL>` — throws `UnsafeUrlError` unless the scheme is `http:`/`https:` and **every** resolved address is public. Refused ranges: IPv4 `0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16, 224/4, 240/4, 255.255.255.255`; IPv6 `::, ::1, fc00::/7, fe80::/10, ff00::/8`, and IPv4-mapped forms of the IPv4 ranges. Hostnames `localhost`, `*.localhost`, `*.internal`, `*.railway.internal` refused without lookup.
- Produces: `config.allowPrivateCallbackUrls: boolean` from `ALLOW_PRIVATE_CALLBACK_URLS === 'true'` (default false). Tests that post to a local listener set it via the `allowPrivate` option path the route reads from config.
- Produces: `MAX_CALLBACKS_PER_SCENE = 20` exported from `hooks.ts`.

- [ ] **Step 1: Failing tests** in `public-url.test.ts` with an injected `lookup`: `http://10.0.0.5/x`, `http://[::1]/`, `http://[::ffff:127.0.0.1]/`, `http://foo.railway.internal/`, `ftp://example.com/`, a host resolving to `['93.184.216.34','10.0.0.1']` all throw; `https://example.com/cb` resolving to `['93.184.216.34']` returns a URL; `allowPrivate: true` accepts `http://127.0.0.1:9999/`.
- [ ] **Step 2: Failing route tests** in `rest-platform-callbacks.test.ts`: register with `callbackUrl: 'http://169.254.169.254/latest'` → 400 `{ error: 'callback_url_not_allowed' }` and no row; the 21st distinct callback on one scene → 429 `{ error: 'too_many_callbacks' }`; a `video_status` dispatch payload contains no `streamKey` key; dispatch to a row whose URL is private (insert the row directly) makes no request and counts as a failure.
- [ ] **Step 3: Run both files** — expect FAIL.
- [ ] **Step 4: Implement**: register calls `assertPublicHttpUrl(body.callbackUrl, { allowPrivate: config.allowPrivateCallbackUrls })` before the upsert, and counts the scene's callbacks before inserting a new one (re-registering an existing URL is not counted); dispatch calls the same check per callback and treats `UnsafeUrlError` like a failed delivery; fetch uses `redirect: 'manual'` so a redirect can't reach an internal address; remove `streamKey` from both payloads in `streaming.ts`. Existing tests that call back to a local listener: set `config.allowPrivateCallbackUrls = true` in their `beforeAll` and restore it after.
- [ ] **Step 5: Run** the two files plus `stream-live.test.ts`, `live-updates.test.ts` — expect PASS.
- [ ] **Step 6: Commit** `fix(hooks): refuse internal callback addresses, cap hooks, strip stream keys`.

---

### Task 3: Deploy routes check scene access and wallet ownership

audit:62-73. Critical: `walletId` decrypts anyone's key.

**Files:**
- Modify: `apps/server/src/routes/deploy.ts` (every route)
- Modify: `apps/server/src/services/dcl/deployer.ts:378-392` (`executeDCLDeploy`)
- Test: `apps/server/test/deploy-routes.test.ts` (create)

**Interfaces:**
- Consumes: `assertPublicHttpUrl` (Task 2).
- Produces: in `deploy.ts`, `deploymentForCaller(request, id: string, need: 'read' | 'manage'): Promise<Deployment | null>` — loads the deployment, then `getSceneAccess(actorFromClaims(request.user), deployment.sceneId)`; `read` needs `hasScope(access,'scene.edit')`, `manage` needs `isFullAccess(access)`; returns null (route sends 404) otherwise.
- Produces: `publicDeployment(d: Deployment): Deployment` — returns a copy whose `target` has no `adminCode`.
- Changes: `executeDCLDeploy(deploymentId: string, walletId?: string)` loads the wallet with `and(eq(deploymentWallets.id, walletId), eq(deploymentWallets.userId, deployment.deployedBy))`; not found → status `failed`, message `'Deployment wallet not found or has no private key'` (unchanged text).

Route rules:
| Route | Rule |
|---|---|
| `POST /api/deploy` | `isFullAccess` on `body.sceneId` (replaces owner-only); if `walletId` given it must be the caller's wallet, else 404 `{ error: 'Wallet not found' }` before any deployment row is created; DCL `target.contentServer` must pass `assertPublicHttpUrl` and be `https:`, else 400 `{ error: 'invalid_content_server' }` |
| `GET /api/deploy/:id`, `GET /api/deploy/hyperfy/:id/status` | `read`; responses go through `publicDeployment` |
| `GET /api/deploy/scene/:sceneId` | `hasScope(scene.edit)` on the param, else 404; rows through `publicDeployment` |
| `POST /api/deploy/:id/cancel`, `/redeploy`, `/hyperfy/:id/destroy`, `GET /hyperfy/:id/logs` | `manage` |
| `POST /api/deploy/hyperfy/provision` | `isFullAccess` (replaces owner-only) |

- [ ] **Step 1: Failing tests**: users A and B, B's scene and B's deployment wallet; A with A's own scene posting `walletId` = B's wallet → 404 and no `deployments` row; every route in the table called by A on B's deployment → 404; B (owner) and a cohost of B's scene → success on read and cancel; `GET /api/deploy/:id` for a Hyperfy deployment whose `target.adminCode` is set → body has no `adminCode`; `contentServer: 'http://127.0.0.1:1'` → 400. Call `executeDCLDeploy(depId, bWalletId)` directly for a deployment `deployedBy` A → status `failed`, and spy that `decryptPrivateKey` was not called.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** the helpers and rules above.
- [ ] **Step 4: Run** the file — expect PASS.
- [ ] **Step 5: Commit** `fix(deploy): scene access on every deploy route, caller's own wallet only`.

---

### Task 4: Events, command center and streaming check the linked scene

audit:79-82, 88, 104-105.

**Files:**
- Modify: `apps/server/src/routes/events.ts:134-190` (link-scene, link-giveaway)
- Modify: `apps/server/src/routes/command-center.ts` (status, broadcast)
- Modify: `apps/server/src/ws/VLMCommandCenterRoom.ts` (`onAuth`, `onJoin`, `cross_world_update`)
- Modify: `apps/server/src/index.ts:66` and `apps/server/test/helpers/game-server.ts` (room `filterBy(['eventId'])`)
- Modify: `apps/server/src/routes/streaming.ts:49-100` (provision)
- Test: `apps/server/test/events-links.test.ts` (create), extend `command-center-room.test.ts`, `streaming-routes.test.ts`

**Interfaces:**
- Produces: `accessibleSceneIds(actor: Actor, sceneIds: string[]): Promise<string[]>` in `command-center.ts` — keeps ids where `isFullAccess(getSceneAccess(actor, id))`. Both broadcast paths (REST and room) fan out only to these.

Rules:
- `link-scene`: `sceneId` must be a UUID (400 otherwise) and `isFullAccess` for the caller, else 404 `{ error: 'Scene not found' }`.
- `link-giveaway`: giveaway `ownerId === caller` or admin, else 404.
- `GET /api/command-center/:eventId/status`: event `ownerId === caller` or admin, else 404.
- Room: `onAuth` throws (rejects the join) unless the token is a verified account (`kind === 'account'`, not a scene pass, not anonymous); `onJoin` throws unless the actor owns `options.eventId` or is admin; room defined with `.filterBy(['eventId'])`.
- `POST /api/streaming/provision`: if `sceneId` given it must be a UUID with `hasScope(access,'scene.edit')`, else 404 `{ error: 'Scene not found' }`; `type` is always stored as `'shared'` (ignore the body value).

- [ ] **Step 1: Failing tests**: A links B's scene → 404; A links B's giveaway → 404; A reads B's event status → 404; A's broadcast with an event that (via direct DB insert) links B's scene sends nothing to B's callbacks; anonymous and scene-pass joins to `vlm_command_center` are rejected; A joining with B's `eventId` is rejected; two owners with different events land in different rooms; A provisions a stream with B's `sceneId` → 404; `type: 'dedicated'` stored as `'shared'`.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** the rules.
- [ ] **Step 4: Run** the three files — expect PASS.
- [ ] **Step 5: Commit** `fix(events): access checks on linked scenes, giveaways, command center and stream provisioning`.

---

### Task 5: Uploads go through the hardened storage path; asset and giveaway IDORs

audit:113, 125-126, 130, 132.

**Files:**
- Create: `apps/server/src/media/quota.ts`
- Modify: `apps/server/src/media/store.ts` (use the quota helper)
- Modify: `apps/server/src/routes/assets.ts` (`GET /api/assets/:id`, `POST /api/assets`)
- Modify: `apps/server/src/routes/companion-upload.ts` (`POST /api/upload/:code`, clamp token limits)
- Modify: `apps/server/src/routes/giveaways.ts:157-173`
- Modify: `apps/web/src/app/u/[code]/client.tsx` only if the fields it reads from `data.asset` change
- Test: extend `apps/server/test/media-upload.test.ts`; create `apps/server/test/assets-routes.test.ts`, `apps/server/test/giveaways.test.ts`

**Interfaces:**
- Produces: `assertStorageQuota(ownerId: string, addBytes: number, opts?: { quotaMessage?: string; quotaStatus?: number }): Promise<void>` — throws `StoreMediaError` with the existing `storage_limit_reached` body; usage = sum of `mediaAssets.sizeBytes` by `ownerId` **plus** `assetLibraryItems.fileSizeBytes` by `uploadedBy`. Skipped when `config.allFeaturesUnlocked` (as today).
- `POST /api/upload/:code` now calls `storeMedia(token.userId, …)` and links with `linkToScene(sceneId, { mediaAssetId })`. Response stays `{ asset, remainingUploads }` where `asset` is the stored media row; a `StoreMediaError` returns its own status and body and does **not** increment `uploadCount`.
- `POST /api/assets`: `classifyUpload(filename, contentType, size)` must be ok and its kind must be `model` (the asset library is 3D models), else 400 with the verdict's error; storage key `assets/${userId}/${randomUUID()}.${extensionFor(verdict.contentType)}`; stored content type is the verdict's; `assertStorageQuota` before upload; `isPublic` defaults to `false`.
- `GET /api/assets/:id`: optional bearer (decode if present, never 401); return 404 unless `isPublic`, or `uploadedBy === caller`, or caller is admin. Keep it in `PUBLIC_EXACT` in `scene-pass-guard.test.ts` (it still never requires a bearer).
- Giveaway item delete: `where(and(eq(giveawayItems.id, itemId), eq(giveawayItems.giveawayId, giveawayId)))`, 404 `{ error: 'Item not found' }` when no row was deleted.
- Upload-token create: clamp `maxUploads` to 1..50 and `expiresInMinutes` to 1..60.

- [ ] **Step 1: Failing tests**: `POST /api/assets` with `filename: '../../evil.glb'` stores under `assets/<userId>/` (no `..` in `storageKey`); `contentType: 'text/html'` → 400; result `isPublic === false` by default; quota exceeded (seed media rows near the limit with billing on, or stub `getSubscription`) → 403 `storage_limit_reached`; `GET /api/assets/:id` of a private asset → 404 anonymous and for another user, 200 for the uploader; phone upload with `filename: '../x.png'` and an HTML content type → refused, `uploadCount` unchanged; a valid PNG phone upload → 201, `asset.contentType === 'image/png'`, scene library has a row with `mediaAssetId`; owner of giveaway G1 deleting an item of G2 through `/api/giveaways/G1/items/<G2 item>` → 404 and the item still exists.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement**; then read `apps/web/src/app/u/[code]/client.tsx` and adjust it if it reads a field the media row doesn't have (`name` → `filename`, `cdnUrl` → `publicUrl`).
- [ ] **Step 4: Run** the server files plus `scene-library-upload.test.ts`, `scene-library.test.ts`, `scene-pass-guard.test.ts`, and `cd apps/web && npx vitest run` — expect PASS.
- [ ] **Step 5: Commit** `fix(uploads): route every upload through classify, server keys and quota; close asset and giveaway IDORs`.

---

### Task 6: Org roles, venue crew scopes, API keys, JWT secret guard

audit:146, 149-150, 178-179, 244-245.

**Files:**
- Modify: `apps/server/src/routes/organizations.ts` (invite, remove member)
- Modify: `apps/server/src/routes/venues.ts` and/or `apps/server/src/venues/service.ts` (grant create/patch)
- Modify: `apps/server/src/routes/api-keys.ts`, `apps/server/src/middleware/auth.ts:49-95`, `apps/server/src/auth/actor.ts:12-19`
- Modify: `apps/server/src/config.ts`, `apps/server/src/index.ts`
- Modify: `apps/web/src/lib/api.ts:147` (drop `scopes` argument) and its caller
- Test: create `apps/server/test/orgs.test.ts`, `apps/server/test/api-keys.test.ts`, `apps/server/test/config-guard.test.ts`; extend `venues.test.ts`

**Interfaces:**
- Produces: `assertProductionSecrets(c: { mode: VLMMode; nodeEnv?: string; jwtSecret: string }): void` in `config.ts` — throws `Error('JWT_SECRET must be set in production')` when (`mode === 'cloud'` or `nodeEnv === 'production'`) and the secret is empty or `'dev-secret-change-me'`. Called first thing in `src/index.ts` startup (not in `buildApp`, so tests are unaffected).
- API key sessions set `request.user = { id, email, role, orgId, kind: 'account', verified: true, viaApiKey: true }`. `actorFromClaims` becomes `verified: c.verified === true`.

Rules:
- Org invite `role`: only `'member'` or `'admin'` (400 `{ error: 'invalid_role' }` otherwise); only the org owner may invite `'admin'` (403).
- Org member removal: nobody removes the owner (400 `{ error: 'Transfer ownership first' }`); only the owner removes an admin (403); self-removal of a non-owner still allowed.
- Venue grants: a caller without `isFullAccess` on the venue's scene may only grant or set scopes that are a subset of their own grant's scopes, may never grant `crew`, and may not PATCH their own grant (403 `{ error: 'forbidden' }`).
- API keys: `POST /api/keys` refuses when `request.user.viaApiKey` (403 — a key cannot mint keys); `orgId` must be an org the caller belongs to (400 otherwise); `scopes` is removed from the request, the insert (store `null`) and both responses. A key acts as its account — document that in the route's comment.

- [ ] **Step 1: Failing tests**: admin invites `owner` → 400; admin invites `admin` → 403; owner invites `admin` → 201; admin removes owner → 400; admin removes another admin → 403; crew holder with `['screens','crew']` granting `['presets']` → 403 and granting `['crew']` → 403 and PATCHing own grant → 403, host granting anything → OK; a request authenticated with an API key calling `POST /api/keys` → 403; `orgId` of an org the caller isn't in → 400; an account token with no `verified` claim (`tokenFor(user, { verified: undefined })`) is treated as unverified by `getSceneAccess` (expect `none` on a scene they'd otherwise own) while an API-key request on the owner's scene still succeeds; `assertProductionSecrets` throws for `{mode:'cloud', jwtSecret:'dev-secret-change-me'}` and `{mode:'single', nodeEnv:'production', jwtSecret:''}`, and does not throw for `{mode:'single', jwtSecret:'dev-secret-change-me'}`.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement**. Check that `tokenFor` in `test/helpers/factories.ts` and every token issuer (`src/auth/tokens.ts`, `src/auth/scene-pass.ts`, OAuth/login in `routes/auth.ts`) sets `verified` explicitly so the stricter default changes nothing for real logins; fix any that don't.
- [ ] **Step 4: Run the full server suite** (`npx vitest run`, alone) and `cd apps/web && npx tsc --noEmit` — expect PASS.
- [ ] **Step 5: Commit** `fix(authz): pin org and crew roles, scope API keys to their account, require JWT_SECRET in production`.

---

### Task 7: Delete legacy and compat code

audit:260-277. Delete these and nothing else:

| What | Where |
|---|---|
| Legacy analytics REST | `apps/server/src/routes/analytics.ts` (whole file) and its import/registration in `app.ts` |
| Deprecated analytics room messages | `ws/VLMSceneRoom.ts` handlers for `session_*`, `request_player_position`, `send_player_position`, `path_segments_add` and `deprecatedAnalytics`; their OPEN entries in `ws/scene-guard.ts`; their types in `packages/vlm-shared/src/protocol.ts`; the `session_started` listener in `packages/vlm-core/src/VLM.ts` |
| Room user-state / giveaway stubs | `get_user_state`, `set_user_state`, `giveaway_claim` in `VLMSceneRoom.ts`, `scene-guard.ts`, `protocol.ts`, and the client methods in `VLM.ts` (and any adapter/HUD caller — `grep -rn` the packages) |
| REST scene-state KV | `routes/scenes.ts` `/api/scenes/:sceneId/state*` routes; `apps/web/src/lib/api.ts` state helpers; `sceneState` from `db/schema.ts`; add `DROP TABLE IF EXISTS scene_state;` to `apps/server/scripts/pre-push-upgrade.mjs` (drizzle push alone is unreliable here) |
| Unused dependency | `decentraland-crypto-middleware` in `apps/server/package.json`; run `pnpm install` to update the lockfile |
| Unverified-wallet re-homing | the re-home branches in `apps/server/src/auth/wallet-users.ts` (`resolveVerifiedWalletUser`, `linkVerifiedWallet`) |
| `verified: false` on account refresh | `apps/server/src/routes/auth.ts:200` |
| Pre-playback-id backfill | `apps/server/src/routes/streaming.ts:214-222` |
| Org-scoped scene access | the `org` branch in `auth/permissions.ts:78-83` and the `'org'` level from `AccessLevel`/`isFullAccess`; `analytics-read.ts:112`; `venues/service.ts:106` |

Keep: the kind-less token rejection itself, the V1 `sk` aliasing, the pre-6.0 explorer canonical keys, the dashboard relay unwrapping.

**Files:** as listed. **Test:** delete tests that only cover removed code (e.g. legacy analytics, scene state); update `scene-pass-guard.test.ts` lists and `permissions.test.ts` for the removed `org` level.

- [ ] **Step 1: Before deleting**, `grep -rn` each removed route path and message name across `apps/` and `packages/` (excluding `node_modules`, `dist`) and record callers in the report; every caller is removed in this task.
- [ ] **Step 2: Delete** in one pass; remove now-unused imports.
- [ ] **Step 3: Run** `pnpm turbo typecheck` (expect 16/16), the full server suite alone, `cd packages/vlm-core && npx vitest run`, `cd apps/web && npx vitest run` — expect PASS. Run `cd packages/vlm-smart-item-dcl && npm test` if it has a test script.
- [ ] **Step 4: Commit** `chore: delete legacy analytics, room stubs, scene state KV, wallet re-homing and dead org access`.

---

### Task 8: Cross-account route walk and docs

**Files:**
- Create: `apps/server/test/cross-account-walk.test.ts`
- Modify: docs pages that the changes make wrong (find them with `grep -rln "hook/register\|scopes\|api key\|deploy" apps/docs/src/content`)

**Interfaces:**
- Consumes: the route list `app.ts` collects (see how `test/scene-pass-guard.test.ts:72` reads it); the factories in `test/helpers/factories.ts`; fixtures from Tasks 3-6.

Design:
- Fixtures: verified users A and B; everything below created **for B**: scene with preset, element and instance; deployment wallet; DCL deployment and Hyperfy deployment; streaming server; event linked to B's scene; giveaway with an item; private asset; media asset; org with B as owner; venue, booking and crew grant; upload token; platform callback.
- A table `CASES: { route: 'METHOD /path/:param'; url: (f) => string; body?: (f) => object }[]` — one entry for every collected route whose path has a `:param`, plus every `POST`/`PUT`/`PATCH`/`DELETE` that takes a resource id in its body (`POST /api/deploy`, `POST /api/scenes/:sceneId/library`, `POST /api/events/:eventId/link-scene`, `POST /api/streaming/provision`, `POST /api/venues`, `POST /api/upload-tokens`).
- For each case, A's account token gets a status in `[401, 403, 404]` and the case's resource is unchanged afterwards (re-read it from the DB; the case may name a `check(f)` that throws if B's row was modified or deleted).
- **Completeness guard:** a test that fails listing every collected route with a `:param` that is neither in `CASES` nor in `NOT_CROSS_ACCOUNT` — a short list of routes where the param is not another account's resource, each with its reason (e.g. `GET /api/upload/:code` — the code is the auth; `POST /api/orgs/accept-invite` — token only; `/api/auth/*` callbacks; `PUT /api/orgs/:orgId/active` — membership checked, see orgs.test.ts).
- Also: the same walk with an API key for A (one representative case per route family is enough: scenes, deploy, events, streaming, giveaways, orgs, venues).

- [ ] **Step 1: Write the walk**. Run it; any case that returns 2xx is a real hole — fix it in the route (smallest change using the helpers above), and list each such fix in the report.
- [ ] **Step 2: Run** the walk and the full server suite alone — expect PASS.
- [ ] **Step 3: Docs**: update the pages found above so they say: hooks need a public address and are capped at 20 per scene; stream keys never go to hooks; an API key acts with its account's full access and cannot create keys; deploys can only use your own wallet.
- [ ] **Step 4: Run** `cd apps/docs && pnpm build` — expect success.
- [ ] **Step 5: Commit** `test: cross-account route walk; docs for hooks, API keys and deploy wallets`.
