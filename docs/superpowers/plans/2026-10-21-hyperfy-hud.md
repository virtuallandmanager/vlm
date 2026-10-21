# Hyperfy HUD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A linked VLM editor standing in a Hyperfy world can move, rotate, resize, show and hide VLM objects, switch presets, toggle streams, and place models, all saved to VLM, using a HUD inside the world.

**Architecture:**
- **Pairing.** A pairing code, approved on vlm.gg, gives the browser a short-lived **Hyperfy pass**: a scene pass for the approving user, bound to the world's scene and its pairing.
- **Editing.** The VLM app's client half calls VLM's existing REST routes with that pass. Edits come back to every platform through the feed.
- **Remembering the link.** In VLM-hosted worlds, the world's server half holds a server-only world secret. It vouches for a returning player's stable Hyperfy id, so the link survives reloads. Self-run worlds pair once per visit.
- **Reuse.** Edit mode reuses `TransformSession` from vlm-core. The HUD is drawn with Hyperfy's UI nodes.

**Tech Stack:**
- server: TypeScript, Fastify, drizzle and Postgres, vitest;
- the app: Hyperfy 0.16 app scripting, esbuild into one script, vitest for its pure modules;
- web: Next.js;
- the image: a Hyperfy patch for the hosted-world secret.

**Spec:** `docs/superpowers/specs/2026-10-21-hyperfy-hud-design.md`. It is approved and is the binding authority. Background: `docs/superpowers/specs/2026-10-19-hyperfy-worlds-design.md`. Earlier plans: `docs/superpowers/plans/2026-10-19-hyperfy-app-and-feed.md` and `2026-10-20-hyperfy-fly-hosting.md`.

## Global Constraints

- **The world key never grants edit rights.** It only identifies the world and its scene when a pairing code is requested.
- **Self-run worlds' servers are never trusted with identity.** Only hosted worlds' server halves may vouch, and only with the server-only `VLM_WORLD_SECRET`.
- **Hyperfy sandbox:**
  - Allowed globals: `world`, `app`, `fetch`, `props`, `setTimeout`, `Math`, `Date.now`, `num`, `uuid`, `prng` and three.js math.
  - Not available: `localStorage`, `crypto`, `TextEncoder` and `setInterval`. `URL` exists only as `createObjectURL`.
  - Script `fetch` returns `undefined` on a network or CORS failure, so the HUD treats `undefined` as "lost connection".
- **Pairing secret:** three `uuid()` values joined (128+ bits). It is hashed with a pure-JS SHA-256 in the bundle and never leaves that browser in plain text, except over TLS to VLM on claim and renew.
- **Lifetimes:**
  - pairing code: 10 minutes, single-use;
  - Hyperfy pass: 15 minutes (`config.jwtAccessExpiry`);
  - self-run pairing: 12 hours;
  - hosted pairing: until revoked, or 90 days without use.
- **Revoking is immediate.** Every request carrying a Hyperfy pass checks that its pairing is still active.
- **Who can approve:** any user `getSceneAccess` gives an editing scope for the world's scene: owner, admin, cohost, editor, or a booking host. Scopes are resolved per request, so a booking host's tools work only during their booking. The pass carries the approving user's verified wallet when they have one.
- **CORS:** any origin, `credentials: false`, replacing today's production allowlist with `credentials: true` (`apps/server/src/app.ts:67-68`).
- **No feed or protocol version change.**
- **Secrets:** never log pairing secrets, codes, passes or `VLM_WORLD_SECRET`.
- **Off limits:** billing code.
- **Deploying:** only with `railway up <worktree> --path-as-root -s vlm-server --ci`.

## Fixed values (in `packages/vlm-shared/src/hyperfy-hud.ts` as `HYPERFY_PAIRING`)

| Name | Value |
|---|---|
| `codeTtlMs` | 600_000 |
| `selfPairingTtlMs` | 43_200_000 (12 h) |
| `hostedIdleTtlMs` | 7_776_000_000 (90 days) |
| `renewBeforeMs` | 120_000 (renew 2 min before a pass expires) |
| `claimPollMs` | 2_000 |
| `codeAlphabet` | `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (no 0/O/1/I) |
| `codeLength` | 6, shown as `XXX-XXX` |

## Review Focus

1. **The pass expires or renewal fails in the middle of a drag or before Save.** The draft is kept, the HUD shows "Link expired, pair again", and Save works again after re-pairing, with the draft still there. Test: Task 6, `an expired pass keeps the draft and Save succeeds after renew`.
2. **A feed snapshot changes the selected object while it's being dragged.** The local draft stays until Save or Revert, without jumping. After Save, the feed's value is the truth. Test: Task 7, `a snapshot during a drag doesn't overwrite the draft; revert shows the newest feed value`.
3. **A booking host outside their booking, or an editor whose access was removed, presses Save.** They get a clear "You can't edit this right now" alert from the 403, not a generic error, and the object reverts. Test: Task 6, `403 on save maps to the no-access alert and reverts`.
4. **`fetch` returns `undefined`, or VLM is unreachable.** The HUD shows "Lost connection to VLM, retrying", backs off, and recovers without another pairing while the pass is still valid. Test: Task 6, `undefined fetch is lost-connection, then recovers`.
5. **A world without an admin code**, where everyone is admin, so every visitor sees Link. A visitor without VLM access who approves gets "You don't have access to this scene", and no pass is issued. Test: Task 2, `approval by a user without editing access is refused and the claim never returns a pass`.

---

### Task 1: Shared vocabulary

**Files:**
- Create: `packages/vlm-shared/src/hyperfy-hud.ts`, exported from `packages/vlm-shared/src/index.ts`
- Test: `packages/vlm-core/test/hyperfy-hud-contract.test.ts`

**Interfaces:**
- Produces:
  - `HYPERFY_PAIRING`, the table above, `as const`.
  - `formatPairingCode(raw: string): string`, which turns `K7Q4XP` into `K7Q-4XP`.
  - `normalizePairingCode(input: string): string | null`: uppercases, drops `-` and spaces, maps `0`/`O` and `1`/`I` per the alphabet, and returns null if the result isn't 6 alphabet characters.
  - Types:
    - `PairStartResponse { code: string; approveUrl: string; qrUrl: string; expiresAt: string }`
    - `PairClaimResponse = { status: 'pending' } | { status: 'approved'; pass: string; passExpiresAt: string; pairingId: string; user: { id: string; displayName: string } } | { status: 'refused' | 'expired' }`
    - `PairRenewResponse { pass: string; passExpiresAt: string }`
    - `HyperfyPairingSummary { id: string; worldId: string; worldName: string; sceneId: string; sceneName: string; kind: 'self' | 'hosted'; createdAt: string; lastUsedAt: string | null; expiresAt: string | null }`

- [ ] **Step 1: Write the failing tests:**
  - `pairing constants`;
  - `formats a code with a dash`;
  - `normalizes a typed code with lowercase, spaces, a dash and look-alike characters`;
  - `rejects codes of the wrong length or with characters outside the alphabet`.
- [ ] **Step 2: Run them.** Run `cd packages/vlm-core && npx vitest run test/hyperfy-hud-contract.test.ts` and confirm they fail.
- [ ] **Step 3: Implement**, then `pnpm --filter vlm-shared build`.
- [ ] **Step 4: Run them.** Confirm they pass.
- [ ] **Step 5: Commit** with message `feat(shared): Hyperfy HUD pairing vocabulary`.

### Task 2: Pairings and Hyperfy passes (server)

**Files:**
- Modify: `apps/server/src/db/schema.ts`. Add a new table `hyperfyPairings` (`hyperfy_pairings`):
  - `id` uuid pk;
  - `worldId` references `hyperfy_worlds`, with cascade;
  - `userId` references `users`, with cascade, null until approval;
  - `codeHash` text unique, null once claimed;
  - `secretHash` text not null;
  - `hyperfyPlayerId` text, null (hosted worlds only);
  - `playerName` text;
  - `status` text: `pending`, `approved`, `refused`, `claimed` or `revoked`;
  - `codeExpiresAt` timestamptz;
  - `expiresAt` timestamptz, null for hosted pairings;
  - `lastUsedAt` timestamptz;
  - `createdAt` timestamptz.

  Add the matching idempotent fallback in `apps/server/entrypoint.sh`.
- Create: `apps/server/src/hyperfy/pairing.ts`
- Modify: `apps/server/src/auth/scene-pass.ts`. Add `issueHyperfyPass`.
- Modify: `apps/server/src/middleware/auth.ts`. Add the revocation check.
- Modify: `packages/vlm-shared` `SessionClaims`, or the server's copy in `auth/tokens.ts`. Add optional `via?: 'hyperfy'`, `pairingId?: string` and `worldId?: string`.
- Test: `apps/server/test/hyperfy-pairing.test.ts`

**Interfaces:**
- Consumes: `findWorldByKey` (Hyperfy project 1), `getSceneAccess`, the hand-off code pattern in `routes/auth-handoff.ts` (hashed single-use code, atomic claim).
- Produces, in `pairing.ts`, with injectable `now`:
  - `startPairing(worldKey: string, secretHash: string, playerName: string | null, hyperfyPlayerId: string | null): Promise<{ code: string; expiresAt: Date }>`. It throws `invalid_world_key`. `hyperfyPlayerId` is accepted only from the vouch path in Task 3, never from a browser.
  - `pairingForApproval(code: string): Promise<{ pairingId; worldName; sceneId; sceneName; playerName } | null>`
  - `approvePairing(code: string, actor: Actor): Promise<'approved' | 'no_access' | 'expired'>`. A user without an editing scope gets `no_access`, which sets status `refused`.
  - `claimPairing(code: string, secret: string): Promise<PairClaimResponse>`. Claiming an approved pairing is atomic: it moves to `claimed`, clears `codeHash`, sets `expiresAt` to now plus `selfPairingTtlMs` (or null when hosted), and issues the pass.
  - `renewPairing(pairingId: string, secret: string): Promise<PairRenewResponse | 'revoked' | 'expired'>`. It bumps `lastUsedAt`.
  - `revokePairing(pairingId: string, userId: string): Promise<boolean>`
  - `listPairings(userId: string): Promise<HyperfyPairingSummary[]>`
  - `pairingActive(pairingId: string): Promise<boolean>`. Used by the middleware.
- `issueHyperfyPass(app, user, wallet: string | null, pairing: { id; worldId; sceneId }): { pass: string; passExpiresAt: Date }`. Claims are `sceneClaims` with the user's verified wallet, or null, plus `via: 'hyperfy'`, `pairingId` and `worldId`.
- Middleware: when the decoded token has `via === 'hyperfy'` and `!(await pairingActive(pairingId))`, reply 401 `pairing_revoked`. Use a 10 s per-pairing in-memory cache. Revoking also deletes the cache entry, so revocation is immediate on this process.

- [ ] **Step 1: Write the failing tests:**
  - `a code from a valid world key; invalid key throws`;
  - `approval by a user without editing access is refused and the claim never returns a pass`;
  - `owner approves, claim returns a pass bound to the world's scene with via hyperfy and the pairing id`;
  - `a booking host can approve; their pass carries their verified wallet`;
  - `claim with the wrong secret returns pending and doesn't consume the code`;
  - `a code can be claimed once`;
  - `an expired code is expired`;
  - `renew issues a fresh pass and bumps lastUsedAt; renew after revoke is revoked`;
  - `self pairing expires after 12 h`;
  - `a revoked pairing's pass is refused by the middleware at once` (call a pass-enabled route, revoke, call again, expect 401);
  - `codes and secrets are stored only as hashes`.
- [ ] **Step 2: Run them.** Run `cd apps/server && npx vitest run test/hyperfy-pairing.test.ts` and confirm they fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, then the server suite.** Confirm both pass.
- [ ] **Step 5: Commit** with message `feat(server): Hyperfy pairings and passes`.

### Task 3: Pairing routes, CORS, and the hosted vouch

**Files:**
- Create: `apps/server/src/routes/hyperfy-pairing.ts`, registered in `app.ts`.
- Modify: `apps/server/src/app.ts`. CORS becomes `origin: true, credentials: false`. First grep `apps/web/src` for `credentials:` or cookie use and say what was found in the report.
- Modify:
  - `apps/server/src/hyperfy/hosting.ts`: a random 32-byte `VLM_WORLD_SECRET` is added to the machine env at create. Its SHA-256 is stored in a new column `hyperfy_worlds.world_secret_hash`, with a schema change and entrypoint fallback. Rotate-key does not change it.
  - `apps/server/src/hyperfy/worlds.ts`: `findWorldBySecret(worldId, secret)`.
- Test: `apps/server/test/hyperfy-pairing-routes.test.ts`, plus `test/scene-pass-guard.test.ts` (add `PUBLIC_EXACT` entries) and `test/cross-account-walk.test.ts` (the new `:id` routes).

**Interfaces:**
- Routes:
  - `POST /api/hyperfy/pair`: body `{ worldKey, secretHash, playerName? }`, returns `PairStartResponse`. `approveUrl = ${webAppUrl}/pair/${code}`, and `qrUrl` points at the next route. Public, rate-limited to 10 per minute per IP.
  - `GET /api/hyperfy/pair/:code/qr.png`: public. Same QR approach as `routes/companion-upload.ts`.
  - `GET /api/hyperfy/pair/:code`: signed-in only. Returns `pairingForApproval`, or 404.
  - `POST /api/hyperfy/pair/:code/approve`: signed-in only. Returns `{ result }`, with a 403 body for `no_access`.
  - `POST /api/hyperfy/pair/:code/claim`: body `{ secret }`, returns `PairClaimResponse`. Public, rate-limited to 60 per minute per IP.
  - `POST /api/hyperfy/pairings/:id/renew`: body `{ secret }`, returns `PairRenewResponse`. 401 `pairing_revoked` or `pairing_expired`.
  - `POST /api/hyperfy/pairings/vouch`: body `{ worldId, worldSecret, hyperfyPlayerId, playerName }`. Only VLM-hosted worlds have a `world_secret_hash`; a bad or missing secret is 401. Returns one of:
    - `{ status: 'linked', pass, passExpiresAt, pairingId, user }` when an active hosted pairing exists for that world and player;
    - `{ status: 'unlinked', code, approveUrl, qrUrl, expiresAt, pairingId }`: a new pending pairing tied to that player id, which the server half hands to that player's browser.
  - `GET /api/hyperfy/pairings`: signed-in only. Returns `{ pairings: HyperfyPairingSummary[] }`.
  - `DELETE /api/hyperfy/pairings/:id`: signed-in only, own pairings only. Returns `{ revoked: true }`.
- **Hosted claim path.** A pending pairing created by vouch has no browser secret. After approval, the server half finishes it by calling `vouch` again, which now returns `linked`. So the hosted flow needs no browser polling of `claim`.

- [ ] **Step 1: Write the failing tests:**
  - `self-run flow: start, approve, claim, then a pass-enabled edit succeeds`;
  - `CORS answers any origin without credentials`;
  - `vouch with a wrong secret is 401; self-run worlds can't vouch`;
  - `hosted flow: vouch unlinked returns a code, approve, vouch again returns linked with a pass, a later vouch for the same player is linked without a new code`;
  - `hosted pairing unused for 90 days is expired`;
  - `revoke via DELETE then renew is 401`;
  - `pair start is rate limited`;
  - `world secret is stored only as a hash, and create sets VLM_WORLD_SECRET in the machine env` (hosting test fakes).
- [ ] **Step 2: Run them.** Confirm they fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, then the server suite.** Confirm both pass.
- [ ] **Step 5: Commit** with message `feat(server): pairing routes, open CORS, hosted world vouching`.

### Task 4: Edit routes a Hyperfy pass needs

**Files:**
- Modify: `apps/server/src/routes/scenes.ts`, adding the stream toggle, and `apps/server/src/routes/scene-library.ts`, allowing a scene pass on adding a catalog item.
- Test: `apps/server/test/hyperfy-hud-edits.test.ts`

**Interfaces:**
- `POST /api/elements/:elementId/live` with body `{ enabled: boolean }` and `scenePass: { sceneFrom: fromElement }`.
  - The element must be a video.
  - Authorize it with the same rules as the room's `scene_video_update` in `ws/scene-guard.ts`: `liveScope(access, 'screens')`, plus the booking preset and rentable-element checks for grant holders. Factor that check out of the guard into an exported function that both callers use.
  - Save `enableLiveStream`, publish the element change (`elementChanged`), and broadcast the room message `scene_video_update` `{ sk, enableLiveStream }` the same way the room does.
  - Returns `{ element }`.
- `POST /api/scenes/:sceneId/library` accepts a scene pass (`fromParam('sceneId')`) under the same scope as the other library routes.

- [ ] **Step 1: Write the failing tests:**
  - `a hyperfy pass toggles a stream on and off and the snapshot follows`;
  - `a booking host can toggle only during their booking and only rentable screens`;
  - `a non-video element is 400`;
  - `a hyperfy pass can add a catalog model to the scene library`;
  - `the room guard still enforces the same rules` (the existing room test stays green).
- [ ] **Step 2: Run them.** Confirm they fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, then the server suite.** Confirm both pass.
- [ ] **Step 5: Commit** with message `feat(server): stream toggle and catalog placement for Hyperfy passes`.

### Task 5: Website: approve a pairing, manage linked sessions

**Files:**
- Create: `apps/web/src/app/pair/[code]/page.tsx`, the approval page. It is signed-in only and sends the user to sign in with `next` otherwise.
- Modify:
  - `apps/web/src/lib/api.ts`: one method per Task 3 route.
  - the account settings page: add a "Linked Hyperfy sessions" list with Revoke. Find the account page under `apps/web/src/app/(dashboard)/settings`.
- Create: `apps/web/src/lib/pairing.ts`
- Test: `apps/web/src/lib/pairing.test.ts`

**Interfaces:**
- `approvalPrompt(p: { worldName; sceneName; playerName }): string` returns `Link Hyperfy world "${worldName}" (scene ${sceneName}) to your account? Requested by ${playerName ?? 'a player'}.`
- `pairingErrorMessage(err): string`:
  - expired: "This code has expired. Ask for a new one in the world."
  - no access: "You don't have access to this scene."
  - not found: "That code doesn't exist."
- `pairingRowLabel(p: HyperfyPairingSummary, now: Date): string` returns `${worldName} · ${kind === 'hosted' ? 'remembered on this browser' : 'until ' + time}`, in UTC.
- The page accepts a code typed into the URL in any case or format, through `normalizePairingCode`.

- [ ] **Step 1: Write the failing tests** for the three helpers.
- [ ] **Step 2: Run them.** Confirm they fail.
- [ ] **Step 3: Implement** the helpers, the page and the list.
- [ ] **Step 4: Run them, the web suite, and `npx tsc --noEmit -p .`.** Confirm they pass.
- [ ] **Step 5: Commit** with message `feat(web): approve Hyperfy pairings and manage linked sessions`.

### Task 6: App: pairing and the VLM client (pure)

**Files:**
- Create in `packages/vlm-hyperfy-app/src/`:
  - `sha256.ts`, a pure-JS SHA-256 over a string, returning hex;
  - `pairing.ts`;
  - `vlm-api.ts`.
- Test: `packages/vlm-hyperfy-app/test/sha256.test.ts`, `test/pairing.test.ts`, `test/vlm-api.test.ts`

**Interfaces:**
- `sha256Hex(s: string): string`, tested against the NIST vectors `''`, `'abc'` and the 448-bit message, and against multibyte UTF-8.
- `class Pairing`, constructor `(opts: { feedUrl; worldKey; fetch; setTimeout; uuid: () => string; onState: (s: PairingState) => void })`:
  - `start(playerName)`: makes the secret from three `uuid()` calls, then posts pair start;
  - `adopt(link)`: used by the hosted flow, when the server half hands over a `linked` result;
  - `pass(): string | null`;
  - `renewLoop`: renews `renewBeforeMs` before expiry, with back-off;
  - `stop()`.
- `type PairingState = { status: 'idle' } | { status: 'waiting'; code; approveUrl; qrUrl; expiresAt } | { status: 'linked'; displayName } | { status: 'expired' } | { status: 'lost' }`
- `class VlmApi`, constructor `(opts: { feedUrl; fetch; getPass: () => string | null; onAuthFailure: () => void })`. Methods:
  - `saveTransform(instanceId, t)`, which calls `PUT /api/instances/:id`;
  - `setEnabled(elementId, enabled)`;
  - `setPreset(sceneId, presetId)`;
  - `setLive(elementId, enabled)`;
  - `listLibrary(sceneId)`;
  - `listCatalog(query)`;
  - `addFromCatalog(sceneId, item)`;
  - `placeModel(presetId, src, transform)`.

  Each returns `{ ok: true, value } | { ok: false, reason: 'lost' | 'no_access' | 'auth' | 'invalid' | 'server' }`:
  - `undefined` from fetch is `lost`;
  - 401 is `auth`, which calls `onAuthFailure`;
  - 403 is `no_access`.

- [ ] **Step 1: Write the failing tests:**
  - the SHA-256 vectors;
  - `start posts the secret's hash, never the secret`;
  - `claim polling stops on approved and adopts the pass`;
  - `renew happens 2 minutes before expiry`;
  - `an expired pass keeps the draft and Save succeeds after renew` (VlmApi plus Pairing with a fake fetch and a fake clock);
  - `403 on save maps to the no-access alert and reverts` (the result is `no_access`);
  - `undefined fetch is lost-connection, then recovers`;
  - `bundle uses no forbidden globals` (extend the existing hyp test: no `crypto`, `TextEncoder`, `setInterval`, `localStorage` or `new URL`).
- [ ] **Step 2: Run them.** Run `cd packages/vlm-hyperfy-app && npx vitest run` and confirm they fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Confirm they pass.
- [ ] **Step 5: Commit** with message `feat(hyperfy-app): pairing and VLM edit client`.

### Task 7: App: edit mode

**Files:**
- Create: `packages/vlm-hyperfy-app/src/edit/controller.ts` (pure state and wiring), `src/edit/rays.ts` (pointer and camera rays), and `src/edit/gizmo.ts` (Hyperfy nodes for the handles).
- Modify: `scripts/build-hyp.mjs`. Alias `vlm-core`'s transform session to its source files (`packages/vlm-core/src/transform/session.ts` and `math.ts`), so only those are bundled.
- Test: `packages/vlm-hyperfy-app/test/edit-controller.test.ts`, `test/rays.test.ts`

**Interfaces:**
- Consumes: `TransformSession` from `packages/vlm-core/src/transform/session.ts`, used as it is (modes, `cycleLock`, `setSnap`, `beginDrag`/`drag`/`endDrag`, `setValue`, `takeSave`, `revert`), and `VlmApi.saveTransform` (Task 6).
- `pointerRay(camera: { position; quaternion }, pointer: { x: number; y: number } | null, fovDeg = HYPERFY_DEFAULT_FOV): Ray`
  - A locked pointer (`null`) is the camera's forward ray.
  - An unlocked pointer uses `HYPERFY_DEFAULT_FOV`. Read it from Hyperfy's source (`src/core/systems/ClientGraphics.js` or the camera setup) and pin it with a test.
- `class EditController`, constructor `(opts: { session: TransformSession; api: VlmApi; items: () => Map<string, RenderedItem>; preview: (key, t) => void; restore: (key) => void; alert: (a: HudAlert) => void })`. Methods:
  - `select(key)`;
  - `pointerDown(handle | null, ray)`, `pointerMove(ray)`, `pointerUp()`;
  - `setMode(mode)`, `cycleLock()`, `setSnap(on)`, `setValue(axis, v)`;
  - `save()`, `revert()`, `done()`;
  - `onSnapshot(prevPlan, nextPlan)`.
- **Mapping:** a `RenderedItem` carries its RenderItem key, which is `elementId:instanceId`, and its current transform in VLM coordinates. Mapping to and from Hyperfy uses `transform.ts`, so drafts and saves stay in VLM coordinates.
- **The gizmo:**
  - arrows for move on X, Y and Z;
  - rings for rotate;
  - a cube for uniform scale;
  - plus hit targets for each.

  Built from Hyperfy `mesh` or `prim` nodes, with `onPointerDown`, `onPointerEnter` and `onPointerLeave` mapped to `Handle` values. It is shown only on the selected item.
- **Clicks:** while edit mode is on, every VLM node's `onPointerDown` selects it instead of opening its link (`app.ts` swaps the handler when the mode changes).

- [ ] **Step 1: Write the failing tests:**
  - `a locked pointer ray is the camera forward`;
  - `an unlocked pointer ray uses the default fov` (numeric case);
  - `select, drag on the X arrow, save calls saveTransform with VLM coordinates`;
  - `revert restores the baseline and clears dirty`;
  - `a snapshot during a drag doesn't overwrite the draft; revert shows the newest feed value`;
  - `selecting another item while dirty asks to save or revert` (the controller returns `'dirty'`, and the HUD shows the prompt);
  - `edit mode makes clicks select instead of open links`.
- [ ] **Step 2: Run them.** Confirm they fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Confirm they pass.
- [ ] **Step 5: Commit** with message `feat(hyperfy-app): in-world edit mode`.

### Task 8: App: the HUD (bar, panels, alerts) and wiring

**Files:**
- Create: `packages/vlm-hyperfy-app/src/hud/model.ts` (a pure view model) and `src/hud/view.ts` (Hyperfy `ui`/`uiview`/`uitext`/`uiimage` nodes drawn from the model).
- Modify: `packages/vlm-hyperfy-app/src/app.ts`.
  - **Client:** a "Link to VLM" button for `player.admin` or `player.builder`. After that:
    - pairing (Task 6);
    - the HUD;
    - edit mode (Task 7);
    - `app.control()` for keys, with Shift cycling the lock, or the documented fallback if Hyperfy uses Shift.
  - **Server (hosted):** answer a player's `vlm:link` request.
    - Call `vouch` with `VLM_WORLD_SECRET`, which reaches the script as in Task 9.
    - Send the result to that player with `app.sendTo`, either `linked` or `unlinked` with the code.
    - Poll `vouch` every `claimPollMs` while unlinked, until approved or expired.
- Test: `packages/vlm-hyperfy-app/test/hud-model.test.ts` and `test/app.test.ts` (the existing sandbox harness).

**Interfaces:**
- `hudModel(state: { pairing: PairingState; edit: EditState; plan: RenderItem[]; scene: SerializedScene | null; alerts: HudAlert[] }): HudViewModel`, covering:
  - the edit bar (mode, lock, dirty, selected name);
  - Scene layout (each item with an `enabled` toggle, and presets with the active one);
  - Streams (each video with `enableLiveStream` and `isLive`);
  - the Asset browser (tabs Library, Catalog and Link, with "Place in front of me");
  - the alert stack.
- `alertsFromSnapshot(prev, next): HudAlert[]` gives "Stream is live" / "Stream went offline" from `isLive` changes.
- **Alert copy**, kept exactly:
  - "Linked to VLM as <name>"
  - "Link expired. Pair again."
  - "Saved"
  - "Couldn't save: <reason>"
  - "Lost connection to VLM. Retrying…"
  - "Reconnected"
  - "Stream is live"
  - "Stream went offline"
  - "You can't edit this right now"
  - "Added here. Decentraland needs a redeploy to show it."
- **Placement:** "Place in front of me" puts a model 2 m in front of the player's camera on the floor, converted to VLM coordinates with `toVlmPosition`.

- [ ] **Step 1: Write the failing tests:**
  - the view model for each panel;
  - `alertsFromSnapshot` for live and offline;
  - `placing a model emits the redeploy alert`;
  - `the HUD draws nothing for a visitor who isn't admin or builder`;
  - `the sandbox build runs the client and server halves without forbidden globals` (app.test.ts);
  - `hosted: a vlm:link request is answered with the vouch result for that player only`.
- [ ] **Step 2: Run them.** Confirm they fail.
- [ ] **Step 3: Implement**, then rebuild `dist/vlm.hyp` with `pnpm --filter vlm-hyperfy-app build`.
- [ ] **Step 4: Run them.** Confirm they pass.
- [ ] **Step 5: Commit** with message `feat(hyperfy-app): VLM HUD in Hyperfy`, and include `dist/vlm.hyp`.

### Task 9: Image: hand the world secret to the VLM app's server half only

**Files:**
- Modify: `infra/hyperfy/patches/0002-vlm-app.patch`, or add `0003-vlm-world-secret.patch`. Expose `process.env.VLM_WORLD_SECRET` to scripts only:
  - on the server (`world.isServer`);
  - only for the app whose blueprint id is `vlm`;
  - for example as a read-only `app.vlmWorldSecret` getter on the app proxy (`src/core/systems/Apps.js`) that returns undefined anywhere else.

  It must never be part of blueprint props, entity state or any network packet.
- Modify: `infra/hyperfy/test-world.mjs`. Add tests.
- Modify: `infra/hyperfy/patches/README.md`

**Interfaces:**
- Produces: `app.vlmWorldSecret`, a string on the server half of the `vlm` app and undefined everywhere else. Task 8's server half reads it.

- [ ] **Step 1: Extend `test-world.mjs`:**
  - `the vlm app's server script reads the secret`;
  - `client scripts and other apps read undefined`;
  - `the secret never appears in the client's snapshot or in /env.js` (grep the served page and a captured client snapshot for the value).
- [ ] **Step 2: Run it against the current patches.** Confirm it fails.
- [ ] **Step 3: Write the patch.**
- [ ] **Step 4: Run it, then `docker build --platform linux/amd64 -f infra/hyperfy/Dockerfile .`.** Confirm both pass.
- [ ] **Step 5: Commit** with message `feat(infra): server-only world secret for the VLM app`.

### Task 10: Docs

**Files:**
- Modify:
  - `apps/docs/src/content/docs/sdk/hyperfy/install.md`: add an "Editing from inside Hyperfy" section covering linking, what can be edited, that hosted worlds remember the link per browser while self-run worlds pair each visit, and revoking from the account page;
  - `docs/superpowers/specs/2026-10-19-hyperfy-worlds-design.md`: replace the "Editing the scene from inside the Hyperfy world" non-goal with a pointer to the HUD design;
  - `infra/hyperfy/SETUP.md`: note that hosted worlds get `VLM_WORLD_SECRET` automatically, and that existing hosted worlds get the HUD's vouching after their next image update (rotate a key or restore).

- [ ] **Step 1: Write them.**
- [ ] **Step 2: Commit** with message `docs: Hyperfy HUD`.

### Task 11: End-to-end check (run by the controller)

1. **Local:** a self-run world (the project 1 e2e setup) against a branch server.
   - Link: get a code, approve it on the local web app, and confirm the HUD shows linked.
   - Move an image and Save: the feed and DB change, and a DCL room visitor gets the update.
   - Toggle a stream: the snapshot follows.
   - Place a catalog model: the redeploy alert shows.
   - Revoke on the web: the next Save fails and the HUD shows "Link expired".
   - Reload: the HUD asks to pair again.
2. **Hosted:** deploy, push the new image, and update the Ghost Towns hosted world to it (rotate its key).
   - Link once, then reload: the HUD is still linked.
   - Revoke: the next action asks to pair.

Record the results in the ledger.
