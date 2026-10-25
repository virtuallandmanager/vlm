# New Scene Wizard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browser wizard (Where → Size → Assets → Arrange → Deploy, live 3D preview) that creates a Virvi scene from catalog models and deploys it to the citizen's Decentraland World, plus a Worlds deployer that keeps redeploying from the live deployment whenever models are added, for wizard scenes and for anyone's own `vlm-dcl` scene, without anyone ever needing their scene files.

**Architecture:** One generic pre-built SDK7 runtime (`bin/index.js`, built once per Virvi release and committed) plus a generated `scene.json` and the chosen GLBs make a wizard deployment. Every later redeploy starts from the World's live entity (files referenced by hash), adds new GLBs under `models/vlm/`, and is signed either by Virvi's own deploy wallet (mode A, after the owner grants it World deploy permission) or by the owner in the browser (mode B, ephemeral `@dcl/crypto` identity). A sweep batches mode A redeploys; the in-world HUD and the dashboard show mode B's "ready to publish".

**Tech Stack:** Fastify 5 + drizzle (push) + postgres.js; `dcl-catalyst-client` (DeploymentBuilder + content client) and `@dcl/crypto` 3.7.0 on the server; Next 15 static export + React 19 + `three` / `@react-three/fiber` / `@react-three/drei` + `@dcl/crypto` 3.7.0 in the web app; SDK7 (`@dcl/sdk` 7.21.0, as `test-scenes/dcl-test`) for the runtime; vitest.

**Spec:** `docs/superpowers/specs/2026-10-25-new-scene-wizard-design.md` (approved 2026-10-25, with the 2026-10-25 "nobody needs their scene files" addition).

## Global Constraints

- New user-facing copy uses Virvi names (Virvi Studio, Virvi AR, "Let Virvi deploy for me"). Don't rename existing code, packages, domains or the `vlm-dcl` package.
- Never hardcode a domain: public addresses come from `config.publicUrl` / `config.webAppUrl` (server) and `API_URL` (web).
- Billing code (`integrations/stripe.ts`, `routes/billing.ts`, `middleware/feature-gate.ts`) is read-only: you may import from it, never edit it.
- The wizard's Decentraland deploy and every later redeploy are open to every plan: no `requireFeature('deployment')` on any new route. The scene still counts toward the plan's scene limit via the existing check.
- Hyperfy keeps its existing plan checks; the wizard shows Hyperfy locked with an upgrade link, never hidden.
- Decentraland limits, per parcel: 10,000 triangles, 200 entities, 200 files; 50 MB per file. Encode once in `vlm-shared` (Task 1) and use that everywhere.
- Virvi never stores or receives a user's private key. The Virvi deploy key (`VIRVI_DCL_DEPLOY_KEY`) is read from env only, never logged, never returned, never committed.
- Never fetch a model URL that isn't Virvi-hosted (host of `config.cdnUrl` or `config.publicUrl`), https only, ≤ 50 MB.
- Server tests run against `vlm_test` (vitest config); never touch the shared dev DB `vlm`. Decentraland is never called from tests: use the fakes (`FakeDclDirectory`, `FakeWorldsClient`).
- After changing `packages/vlm-shared`, run `pnpm --filter vlm-shared build` before web typecheck/tests/build (the web app reads its dist).
- VLM has no users yet: breaking changes and dropped tables are fine, no migrations or shims.
- Commit messages end with the two trailer lines `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_018ds2NZXw5KLxDpVm9B3ABD`.
- Never bare `git stash`. Push and deploy only with the owner's explicit OK.

## Review Focus

1. **A theme that doesn't fit a small plot** (e.g. "Little park" on 1×1, over 10,000 triangles): the wizard drops items from the end of the theme until it fits and says how many it left out; nothing over budget ever deploys. Pinned in Task 13 (`fitToBudget`) and Task 8 (server refuses over-budget bootstrap).
2. **A mode B signature that arrives after the deploy window** (the owner took 6 minutes in their wallet): the server answers `409 expired`, nothing is uploaded, the page prepares a fresh deploy and asks once more. Pinned in Task 7.
3. **The World's live scene changed outside Virvi** (the owner republished from the Creator Hub) before a redeploy: Virvi marks the destination `needs_review` and deploys nothing until the owner chooses "Use the live version". Pinned in Task 10.
4. **A model element whose URL isn't Virvi-hosted, or points at a private address:** never fetched, reported as "can't be added to Decentraland", and the rest of the redeploy still goes ahead. Pinned in Task 6.
5. **Someone signed in with a wallet that doesn't own the World** tries to create a destination, grant, or sign a deploy: `403 not_world_owner`, nothing stored. Pinned in Task 9.

---

## File map

**vlm-shared**
- Create `packages/vlm-shared/src/dcl-limits.ts`: parcel/plot geometry and the per-parcel budget. Export from `src/index.ts`.

**Server** (`apps/server`)
- Create `src/services/dcl/entity.ts`: entity building (via `dcl-catalyst-client`), signed-fetch payloads, auth-chain checks, Virvi's own signer.
- Create `src/services/dcl/worlds-client.ts`: the Worlds content server, behind an interface with a test fake (`test/helpers/fake-worlds.ts`).
- Create `src/services/dcl/runtime.ts` and `dcl-runtime/1/bin/index.js` (committed build output): the generic runtime files.
- Create `src/services/dcl/assemble.ts`: turns a destination plus a scene into an entity and the new files to upload.
- Create `src/services/dcl/world-deployer.ts`: prepare / sign (mode A) / submit (mode B) / after-deploy bookkeeping.
- Create `src/services/dcl/redeploy-sweep.ts`: pending-model detection and the mode A batch sweep.
- Create `src/wizard/themes.ts`: themes and category chips as data.
- Create `src/routes/wizard.ts`, `src/routes/dcl-destinations.ts`.
- Modify `src/db/schema.ts`, `src/config.ts`, `src/app.ts`, `src/index.ts`, `src/routes/deploy.ts`, `src/routes/scenes.ts` (extract the scene-limit check), `src/routes/assets.ts` (comma list categories), `src/analytics/dcl-directory.ts` (+ `getOwnedNames`), `src/setup/setups.ts` (+ `linkWorldLocation`).
- Delete `src/services/dcl/deployer.ts` and the deploy-wallet routes/table.

**Runtime project** (repo root, outside the pnpm workspace like `test-scenes/`)
- Create `dcl-runtime/` (package.json, scene.json, tsconfig.json, src/index.ts, `build.sh`).

**In-world**
- Modify `packages/vlm-adapter-dcl/src/index.ts` (placed-model message), `packages/vlm-client/src/http.ts` (+ `getDclPublishStatus`).

**Web** (`apps/web/src`)
- Create `lib/wizard/{placement,budget,state}.ts` + tests, `lib/dcl-sign.ts`, `components/wizard/Preview3D.tsx`, `components/wizard/steps/{WhereStep,SizeStep,AssetsStep,ArrangeStep,DeployStep}.tsx`, `app/(dashboard)/scenes/new/page.tsx`, `app/(dashboard)/publish/page.tsx`.
- Modify `lib/api.ts`, `app/(dashboard)/scenes/page.tsx`, `app/(dashboard)/deploy/page.tsx`.

**Ops**
- Modify `.railway/railway.ts`, `.env.example`, `packages/vlm-smart-item-dcl/README.md`.

---

### Task 1: Decentraland plot geometry and budget (vlm-shared)

**Files:**
- Create: `packages/vlm-shared/src/dcl-limits.ts`; Modify: `packages/vlm-shared/src/index.ts`
- Test: `apps/server/test/dcl-limits.test.ts` (the server's vitest aliases vlm-shared's source; vlm-shared has no runner)

**Interfaces:**
- Produces:
  - `DCL_PARCEL_M = 16`, `DCL_MAX_FILE_BYTES = 52_428_800`, `RUNTIME_ENTITY_RESERVE = 20`, `MAX_PLOT_SIDE = 10`
  - `interface Plot { width: number; depth: number; base: { x: number; y: number } }`
  - `plotParcels(plot: Plot): string[]`: `"x,y"` strings, row-major from `base`.
  - `parseParcel(p: string): { x: number; y: number } | null`
  - `dclBudget(parcelCount: number): { triangles: number; entities: number; files: number; maxFileBytes: number }`: triangles `n*10000`, entities `n*200 - RUNTIME_ENTITY_RESERVE`, files `n*200`.
  - `plotSizeM(plot: Plot): { x: number; z: number }`: metres, `width*16` by `depth*16`.
  - `validPlot(plot: unknown): plot is Plot`: integers, `1 ≤ width, depth ≤ MAX_PLOT_SIDE`, base integers in -150..150.

- [ ] **Step 1: Write the failing tests**

```ts
it('plotParcels lists every parcel from the base', () => {
  expect(plotParcels({ width: 2, depth: 2, base: { x: 0, y: 0 } })).toEqual(['0,0', '1,0', '0,1', '1,1'])
  expect(plotParcels({ width: 1, depth: 1, base: { x: -3, y: 5 } })).toEqual(['-3,5'])
})
it('dclBudget scales per parcel and reserves runtime entities', () => {
  expect(dclBudget(4)).toEqual({ triangles: 40_000, entities: 780, files: 800, maxFileBytes: 52_428_800 })
})
it('validPlot refuses fractional, zero and oversized plots', () => {
  expect(validPlot({ width: 3, depth: 3, base: { x: 0, y: 0 } })).toBe(true)
  for (const p of [{ width: 0, depth: 1 }, { width: 1.5, depth: 1 }, { width: 11, depth: 1 }, null, 'x'])
    expect(validPlot(p && typeof p === 'object' ? { ...p, base: { x: 0, y: 0 } } : p)).toBe(false)
})
it('parseParcel', () => { expect(parseParcel('-3,5')).toEqual({ x: -3, y: 5 }); expect(parseParcel('a,b')).toBeNull() })
```

- [ ] **Step 2:** Run `pnpm --filter vlm-server exec vitest run test/dcl-limits.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement the module, export it from `index.ts`.
- [ ] **Step 4:** Run the test (PASS), then `pnpm --filter vlm-shared build`.
- [ ] **Step 5:** Commit `feat(shared): Decentraland plot geometry and per-parcel budget`.

---

### Task 2: Entities, signatures and Virvi's signer

**Files:**
- Create: `apps/server/src/services/dcl/entity.ts`
- Modify: `apps/server/package.json` (add `dcl-catalyst-client`, exact current version; `@dcl/crypto` is already 3.7.0)
- Test: `apps/server/test/dcl-entity.test.ts`

**Interfaces:**
- Produces:
  - `type AuthChain = import('@dcl/crypto').AuthChain`
  - `interface ContentRef { file: string; hash: string }`
  - `interface SceneMetadata` (`display.title`, `scene.{parcels,base}`, `main`, `ecs7`, `runtimeVersion`, `worldConfiguration.name`, `spawnPoints`, optional `virvi: { runtime: number; apiUrl: string; wssUrl: string }`; other keys pass through untouched)
  - `dclHash(bytes: Uint8Array): Promise<string>`: CIDv1, the content server's hash.
  - `buildEntity(input: { pointers: string[]; metadata: SceneMetadata; existing: ContentRef[]; newFiles: Map<string, Uint8Array>; timestamp: number }): Promise<{ entityId: string; files: Map<string, Uint8Array> }>`: uses `DeploymentBuilder.buildEntityWithoutNewFiles` when `newFiles` is empty, otherwise builds with hashes for `existing` plus the new files. The returned `files` holds the entity file and the new files only, keyed by hash.
  - `signedFetchPayload(method: string, path: string, timestamp: number, metadata: string): string`: the exact payload the Worlds server verifies. Before writing it, read the signed-fetch verifier the Worlds server uses (`worlds-content-server` → `@dcl/platform-crypto-middleware`) and record in a doc comment which format it checks and where you confirmed it.
  - `chainSigner(chain: AuthChain): string | null`: the lowercased root signer.
  - `verifyChain(chain: AuthChain, payload: string, expectedSigner: string): Promise<boolean>`: `Authenticator.validateSignature(payload, chain, null)` plus a root-signer match.
  - `virviSigner(): { address: string; signChain(payload: string): Promise<AuthChain> } | null`: from `config.virviDclDeployKey`; null when unset. `signChain` makes an ephemeral identity (10-minute expiry, ethers `Wallet.signMessage` as the owner signer) the way `sdk-commands deploy` does.
- Modify `config.ts`: `virviDclDeployKey: env('VIRVI_DCL_DEPLOY_KEY') || null`.

- [ ] **Step 1: Write the failing tests** using `createUnsafeIdentity` (as `test/helpers/dcl-sign.ts`):
  - `buildEntity` is deterministic: same inputs give the same `entityId`; changing `timestamp` changes it.
  - With `existing: [{ file: 'bin/index.js', hash: H }]` and no new files, `files` holds exactly one entry (the entity file) and the entity's content lists `bin/index.js → H`.
  - A new GLB appears in both `files` (by its `dclHash`) and the entity content.
  - `verifyChain` is true for an ephemeral chain from wallet A over `entityId`, and false for a different payload or `expectedSigner` B.
  - `virviSigner()` is null without the env; with a test key, its address matches `new Wallet(key).address.toLowerCase()` and `verifyChain(await s.signChain('x'), 'x', s.address)` is true.
- [ ] **Step 2:** Run `pnpm --filter vlm-server exec vitest run test/dcl-entity.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Pin `dcl-catalyst-client` to the exact latest version and check that its `DeploymentBuilder` hashes with ADR-32 CIDv1. If its Node build can't be imported from this ESM server, fall back to `@dcl/hashing` + `@dcl/schemas` and build the entity JSON exactly as `DeploymentBuilder` does, and say so in the report.
- [ ] **Step 4:** Run the test. Expected: PASS. Then `pnpm --filter vlm-server typecheck`.
- [ ] **Step 5:** Commit `feat(server): Decentraland entities, signed-fetch payloads and Virvi's signer`.

---

### Task 3: Worlds client and owned names

**Files:**
- Create: `apps/server/src/services/dcl/worlds-client.ts`, `apps/server/test/helpers/fake-worlds.ts`
- Modify: `apps/server/src/analytics/dcl-directory.ts`, `apps/server/test/helpers/fake-dcl.ts`
- Test: `apps/server/test/worlds-client.test.ts`

**Interfaces:**
- Consumes: `AuthChain`, `ContentRef` (Task 2).
- Produces:
  - `interface LiveEntity { id: string; pointers: string[]; content: ContentRef[]; metadata: SceneMetadata }`
  - `class WorldsError extends Error { status: number; body: string }`
  - `interface SignedRequest { method: 'PUT' | 'POST'; path: string; metadata: string; timestamp: number; body?: unknown }`
  - `interface WorldsClient`:
    - `getWorldEntities(world: string): Promise<LiveEntity[]>`: `[]` when the World has no scene.
    - `deploy(d: { entityId: string; authChain: AuthChain; files: Map<string, Uint8Array> }): Promise<void>`: throws `WorldsError`.
    - `sendSigned(req: SignedRequest, chain: AuthChain): Promise<void>`: forwards a signed-fetch request with `x-identity-auth-chain-N`, `x-identity-timestamp` and `x-identity-metadata` headers.
    - `getDeployers(world: string): Promise<{ owner: string | null; deployers: string[] }>`: never cached (unlike the directory).
    - `getWalletStats(address: string): Promise<{ maxAllowedBytes: number; usedBytes: number } | null>`
  - `getWorldsClient(): WorldsClient`, `setWorldsClient(c: WorldsClient | null): void` (same pattern as `getDclDirectory`).
  - `DclDirectory.getOwnedNames(address: string): Promise<string[]>`: the wallet's DCL NAMEs as World names (`<name>.dcl.eth`, lowercased), from `${catalyst}/lambdas/users/${address}/names`, TTL-cached like the other answers.
  - `FakeWorldsClient` (with `entities: Map<world, LiveEntity[]>`, `deployed: Array<…>`, `signed: Array<…>`, `stats`, `failNext?: WorldsError`, and `down`). `FakeDclDirectory.ownedNames: Map<address, string[]>`.

Endpoints to confirm against `https://raw.githubusercontent.com/decentraland/worlds-content-server/main/docs/openapi.yaml` before coding, recording each in a doc comment:
- `GET /world/{name}/about` gives the scene URNs.
- `GET /contents/{entityId}` gives the entity JSON.
- `POST /entities` is the multipart upload, as `dcl-catalyst-client`'s content client sends it. Use that client's deploy with `url = config.worldsUrl` if it works against the Worlds server.
- `GET /world/{name}/permissions` gives the permissions.
- `GET /wallet/{address}/stats` gives the storage budget. If it doesn't exist under that path, find the real one; if there is none, return null and say so in the report.

Use `GET /lambdas/users/{address}/names` for owned names. Check its real response shape with one live read-only `curl`.

- [ ] **Step 1: Write the failing tests** by stubbing `fetch` (`vi.stubGlobal`):
  - `getWorldEntities` maps `/about` plus `/contents/{id}` into a `LiveEntity`; a 404 from `/about` gives `[]`.
  - `deploy` posts multipart to `${worldsUrl}/entities` with `entityId`, the auth chain and every file. A 400 response throws `WorldsError` with status 400 and the body text.
  - `sendSigned` sends exactly `x-identity-auth-chain-0..N`, `x-identity-timestamp` and `x-identity-metadata`, using the request's method and path.
  - `getOwnedNames('0xAbc')` lowercases and suffixes the names: `['cafe.dcl.eth']`.
- [ ] **Step 2:** Run `pnpm --filter vlm-server exec vitest run test/worlds-client.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the client and both fakes.
- [ ] **Step 4:** Run the new test and the whole server suite (the fake directory gained a method). Expected: PASS.
- [ ] **Step 5:** Commit `feat(server): Worlds content client and owned DCL names`.

---

### Task 4: Schema: World destinations, out with deploy wallets

**Files:**
- Modify: `apps/server/src/db/schema.ts`
- Delete: `apps/server/src/services/dcl/deployer.ts`; the `/api/deploy/wallets*` routes, `POST /api/deploy` and `POST /api/deploy/:id/redeploy` in `src/routes/deploy.ts`; the matching tests in `test/deploy-routes.test.ts`.
- Test: `apps/server/test/dcl-destinations-schema.test.ts`

**Interfaces:**
- Produces:
  - `dclDestinationModeEnum = pgEnum('dcl_destination_mode', ['virvi', 'sign'])`
  - `dclDestinationStatusEnum = pgEnum('dcl_destination_status', ['ok', 'needs_review', 'over_budget', 'unreachable'])`
  - table `dclWorldDestinations` (`dcl_world_destinations`) with these columns:
    - `id` uuid pk
    - `sceneId` → scenes, cascade
    - `ownerUserId` → users, cascade
    - `ownerWallet` text, lowercased
    - `worldName` text, lowercased, **unique**
    - `base` text `"x,y"`
    - `parcels` text[]
    - `mode` enum
    - `grantedAt` timestamp, null until mode A permission is confirmed
    - `status` enum, default `ok`
    - `statusDetail` text
    - `lastEntityId` text
    - `deployedFiles` text[], lowercased paths, default `{}`
    - `pendingSince` timestamp
    - `adopted` boolean, default false (true = the owner's own scene code, never touched)
    - `createdAt`, `updatedAt`
    - index on `sceneId`
  - `deploymentStatusEnum` gains `'awaiting_signature'`; `setupEndReasonEnum` gains `'replaced'`.
  - `sceneDeployments` gains `destinationId` → `dclWorldDestinations` (set null).
  - `deploymentWallets` and its relations are removed.
- `deploy.ts` keeps `GET /api/deploy/:id`, `GET /api/deploy/scene/:sceneId`, `POST /api/deploy/:id/cancel` and `GET /api/deploy/platforms`, plus `publicDeployment` / `deploymentForCaller`.

- [ ] **Step 1: Write the failing test.** Insert a destination. A second one for the same `worldName` fails with `23505`. Deleting the scene cascades. A `scene_deployments` row accepts status `awaiting_signature`.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Change the schema and routes as above.
- [ ] **Step 4:** Run `pnpm --filter vlm-server test` and `typecheck`. Expected: PASS. No file still imports `deployer.js` or `deploymentWallets`.
- [ ] **Step 5:** Commit `feat(server)!: Decentraland World destinations replace deploy wallets`.

---

### Task 5: The generic runtime

**Files:**
- Create `dcl-runtime/` with:
  - `package.json`: name `virvi-dcl-runtime`, private; devDeps `@dcl/sdk` and `@dcl/js-runtime` at 7.21.0; dep `vlm-dcl: file:../packages/vlm-smart-item-dcl`.
  - `scene.json`: build placeholder, 0,0.
  - `tsconfig.json`, copied from `test-scenes/dcl-test`.
  - `src/index.ts`
  - `build.sh`
  - `.gitignore`: `node_modules`, `bin`.
- Create: `apps/server/dcl-runtime/1/bin/index.js` (the committed build output), `apps/server/src/services/dcl/runtime.ts`
- Test: `apps/server/test/dcl-runtime.test.ts`

**Interfaces:**
- Produces:
  - `DCL_RUNTIME_VERSION = 1`
  - `runtimeFiles(version?: number): Promise<Map<string, Uint8Array>>`: `{'bin/index.js': bytes}`, read from `apps/server/dcl-runtime/<v>/bin/index.js`, resolved relative to the module so it works from `src/` (tsx) and `dist/` (prod). Throws for an unknown version.
  - The runtime contract (doc comment in `runtime.ts`): the runtime reads `scene.json`'s `virvi.{apiUrl,wssUrl}` through `getSceneInformation().metadataJson` and calls `createVLM({ apiUrl, wssUrl })` with no `sceneId`. The scene is found through the location setup that Task 7 creates, the same path every `vlm-dcl` scene already uses. Models are loaded from `models/vlm/<basename>.glb`, as `DclAdapter.resolveModelSrc` already does.
- Ruling, recorded here: the spec's "small data file telling the runtime which scene it is" is the `virvi` block in `scene.json` plus the location setup. A separate scene-id file would bypass the setup, which is what grants in-world edit rights (`vlm-adapter-dcl/src/index.ts:198`).
- `build.sh`:
  1. `pnpm --filter vlm-dcl bundle`
  2. `cd dcl-runtime && npm install && npx sdk-commands build`
  3. copy `bin/index.js` to `apps/server/dcl-runtime/$VERSION/bin/index.js`
  `VERSION` defaults to the value in `runtime.ts`.

- [ ] **Step 1: Write the failing test.** `runtimeFiles()` returns a non-empty `bin/index.js` that contains `getSceneInformation`, and `runtimeFiles(99)` rejects.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Write `src/index.ts`, run `bash dcl-runtime/build.sh`, commit the output, and write `runtime.ts`.
- [ ] **Step 4:** Run the test (PASS). Run `docker build` only if Docker is available; otherwise check that the Dockerfile's cleanup (`find apps/server/src -name '*.ts' -delete`) leaves `apps/server/dcl-runtime/**` alone, which it does because it only deletes `.ts` under `src`.
- [ ] **Step 5:** Commit `feat(dcl-runtime): generic Virvi runtime scene, version 1`.

---

### Task 6: Assembling a deployment

**Files:**
- Create: `apps/server/src/services/dcl/assemble.ts`
- Test: `apps/server/test/dcl-assemble.test.ts`

**Interfaces:**
- Consumes: `buildEntity`, `dclHash`, `SceneMetadata`, `LiveEntity`, `runtimeFiles`, `DCL_RUNTIME_VERSION`, `localModelFile` (vlm-shared), `dclBudget` / `plotParcels`.
- Produces:
  - `interface ModelNeed { elementId: string; name: string; url: string; file: string; triangles: number | null; bytes: number | null }`
  - `modelsInScene(sceneId: string): Promise<ModelNeed[]>`: the active preset's `model` elements whose `modelSrc` maps through `localModelFile`, de-duplicated by `file`. `triangles` and `bytes` come from `asset_library_items` (matched on `cdnUrl`) or `media_assets` (matched on `publicUrl`).
  - `type ModelFetcher = (url: string) => Promise<Uint8Array>`; `defaultModelFetcher` refuses non-https, hosts other than those of `config.cdnUrl` / `config.publicUrl`, and private addresses (`assertPublicHttpUrl`), and anything over `DCL_MAX_FILE_BYTES`. It throws `ModelRefused(reason)`.
  - `wizardSceneJson(d: { title: string; world: string; base: string; parcels: string[]; spawn: { x: number; y: number; z: number } }): SceneMetadata`: with `main: 'bin/index.js'`, `ecs7: true`, `runtimeVersion: '7'`, `worldConfiguration: { name: world }`, one default spawn point, and `virvi: { runtime: DCL_RUNTIME_VERSION, apiUrl: config.publicUrl, wssUrl: <publicUrl with ws(s)> }`.
  - `interface Assembled { entityId: string; files: Map<string, Uint8Array>; pointers: string[]; deployedFiles: string[]; added: string[]; refused: Array<{ name: string; reason: string }>; triangles: number; newBytes: number }`
  - `assembleFresh(input: { metadata: SceneMetadata; models: ModelNeed[]; timestamp: number; fetch?: ModelFetcher }): Promise<Assembled>`: runtime files, `scene.json` and every model.
  - `assembleRedeploy(input: { live: LiveEntity; adopted: boolean; models: ModelNeed[]; timestamp: number; fetch?: ModelFetcher }): Promise<Assembled>` builds from what's live:
    - Every live file is kept by hash, and the metadata is kept as it is.
    - Only models whose `file` isn't already in the live content are added.
    - When `!adopted` and `live.metadata.virvi.runtime < DCL_RUNTIME_VERSION`, it replaces `bin/index.js` and bumps `virvi.runtime`. Adopted scenes never change code or metadata.
    - `pointers` = `live.pointers`.

- [ ] **Step 1: Write the failing tests** with an injected fetcher:
  - `assembleRedeploy` with live content `[bin/index.js, scene.json, models/vlm/a.glb]` and models `a, b` uploads only `b`. `added` is `['models/vlm/b.glb']`. The entity content keeps the original hashes for the first three files.
  - An adopted scene with `virvi` missing keeps its `bin/index.js` hash and its metadata exactly as they were.
  - A wizard scene on runtime 0 gets the current runtime's hash for `bin/index.js`, and `virvi.runtime === 1`.
  - **Review Focus 4:** a model at `https://evil.example/x.glb`, and one at `https://10.0.0.1/x.glb`, are in `refused` with reasons. The fetcher is never called for them, and the other models are still added.
  - `assembleFresh` content has exactly `bin/index.js`, `scene.json` and one file per distinct model. Its `scene.json` has `worldConfiguration.name` and `scene.parcels` equal to the input.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit `feat(server): assemble World deployments from the live entity`.

---

### Task 7: The World deployer

**Files:**
- Create: `apps/server/src/services/dcl/world-deployer.ts`
- Modify: `apps/server/src/setup/setups.ts`
- Test: `apps/server/test/world-deployer.test.ts`

**Interfaces:**
- Consumes: Tasks 2–6, `getDclDirectory`, `resolveVerifiedWalletUser`.
- Produces:
  - `DEPLOY_WINDOW_MS = 240_000`: the server's limit before Decentraland's ~5-minute timestamp window.
  - `startVirviDeploy(destinationId: string, by: string | null): Promise<Deployment>` (mode A):
    - Inserts a `scene_deployments` row: platform `decentraland`, deploymentType `world`, `destinationId`, `target: { world, parcels }`, status `building`.
    - Runs the rest in the background: assemble, set status `deploying` with `assetBundle.progress = { modelsTotal, modelsUploaded }`, sign with `virviSigner()`, `worlds.deploy`, then `afterWorldDeploy`.
    - Failures set status `failed` and a plain-language `errorMessage`.
    - Throws `DeployerError(503, 'virvi_deploys_unavailable')` when the signer is null, and `DeployerError(409, 'not_granted')` when `grantedAt` is null.
  - `prepareSignedDeploy(destinationId: string, by: string): Promise<{ deployment: Deployment; payload: string; expiresAt: string }>` (mode B):
    - Assembles and stores the row as `awaiting_signature`. `assetBundle` holds `{ entityId, timestamp, pointers, deployedFiles, added, newFiles: Array<{ hash, url }>, existing: ContentRef[], metadata }`, which is enough to rebuild the upload, never the bytes.
    - `payload` = the entityId.
  - `submitSignedDeploy(deploymentId: string, chain: AuthChain): Promise<Deployment>`:
    - `409 expired` when more than `DEPLOY_WINDOW_MS` has passed since the timestamp, with nothing uploaded.
    - `403 not_world_owner` unless `verifyChain(chain, entityId, destination.ownerWallet)`.
    - Otherwise it re-fetches the new files, rebuilds and checks that the entityId is unchanged (`500 entity_mismatch` if not), uploads, then calls `afterWorldDeploy`.
  - `afterWorldDeploy(dest, entityId, deployedFiles): Promise<void>`: sets `lastEntityId`, `deployedFiles` and `status: ok`, clears `pendingSince`, sets the deployment to `deployed` / `deployedAt` / `catalystEntityId`, then calls `linkWorldLocation`.
  - In `setups.ts`, `linkWorldLocation(input: { world: string; vlmSceneId: string; hostUserId: string; entityId: string; title: string }): Promise<void>`:
    1. Upserts `analytics_scenes` for `world:<name>`. Use the same `kind`, `realm` and `worldName` that `registry.upsert` would write for a World ref; read `validateSceneRef` / `locationKeyFor` for the realm value.
    2. If the active setup belongs to another VLM scene, ends it with `endReason: 'replaced'`, then creates the new setup with `deploymentEntityId: entityId`.
    3. If it already belongs to this scene, only updates `deploymentEntityId`.
    4. Sets `analyticsScenes.vlmSceneId`.
    All in one transaction.
  - `class DeployerError extends Error { status: number; code: string }`

- [ ] **Step 1: Write the failing tests** with `FakeWorldsClient`, a test `VIRVI_DCL_DEPLOY_KEY` (set `config.virviDclDeployKey` in the test) and an injected fetcher:
  - Mode A happy path: the deployment ends `deployed`. The fake received an entity signed by Virvi's address. The destination's `lastEntityId` and `deployedFiles` are set. An active location setup for `world:cafe.dcl.eth` points at the scene with that `deploymentEntityId`.
  - Mode A without `grantedAt` throws `not_granted`, and without a key throws `virvi_deploys_unavailable`. Neither creates a row.
  - `worlds.failNext = new WorldsError(400, 'bad')` leaves the deployment `failed`, with an `errorMessage` naming Decentraland's reason, and the destination unchanged.
  - Mode B: prepare, then submit with a chain signed by the owner over `payload`, gives `deployed`.
  - **Review Focus 2:** submitting with a fake clock 241 s after prepare gives `409 expired`, and `fake.deployed` stays empty.
  - **Review Focus 5:** a chain from another wallet gives `403 not_world_owner`, with nothing uploaded.
  - `linkWorldLocation` replacing another scene's setup ends it with `replaced`. Calling it twice for the same scene keeps a single active setup.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it and the full server suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(server): World deployer, Virvi-signed and owner-signed`.

---

### Task 8: Themes, categories and the bootstrap endpoint

**Files:**
- Create: `apps/server/src/wizard/themes.ts`, `apps/server/src/routes/wizard.ts`
- Modify: `apps/server/src/routes/scenes.ts` (extract the limit check), `apps/server/src/routes/assets.ts` (comma-separated `category`), `apps/server/src/app.ts`
- Test: `apps/server/test/wizard-routes.test.ts`, `apps/server/test/wizard-themes.test.ts`

**Interfaces:**
- Produces:
  - `interface ThemeItemRef { pack: string; sourceRef: string; x: number; z: number; rotationY: number }`: `x` and `z` are fractions (0..1) of the plot; `rotationY` is in degrees. Items are ordered most-important first, because trimming drops from the end.
  - `interface Theme { id: string; name: string; items: ThemeItemRef[] }`. Ids are `little-park`, `cozy-cafe`, `gallery`, `beach-hangout`, `stage-venue` and `empty`.
  - `interface CategoryChip { id: string; label: string; categories: string[]; picks: Array<{ pack: string; sourceRef: string }> }`, with these chips:
    - `nature`: Nature → `Plants & Nature`
    - `furniture`: Furniture → `Furniture`
    - `lighting`: Lighting → `Lighting`
    - `buildings`: Buildings → `Building`, `Structure`
    - `decor`: Decor → `Decor`, `Signage`
    Each chip has 12–24 picks.
  - `THEMES: Theme[]`, `CATEGORY_CHIPS: CategoryChip[]`
  - `sceneLimitError(userId: string): Promise<null | { error: 'scene_limit_reached'; message: string; currentUsage: number; limit: number; tier: string }>`, moved out of `POST /api/scenes`, which now uses it.
  - Routes, all `authenticate`, none feature-gated:
    - `GET /api/wizard/catalog` → `{ themes: Array<{ id, name, items: Array<{ asset: WizardAsset; x; z; rotationY }> }>, chips: Array<{ id, label, categories, assets: WizardAsset[] }> }`.
      - `WizardAsset = { id, name, thumbnailUrl, cdnUrl, dimensions: { x, y, z } | null, triangleCount, fileSizeBytes }`.
      - References that don't resolve, or whose pack is disabled, are left out silently.
    - `GET /api/wizard/options` → `{ dcl: { virviDeploys: boolean; virviAddress: string | null }, hyperfy: { allowed: boolean; requiredTier: 'creator' }, scenes: { used: number; limit: number | null } }`.
      - `hyperfy.allowed` = `config.allFeaturesUnlocked` OR admin OR `getTierRank(sub.tier) >= getTierRank('creator')`, reading `getSubscription` (read-only).
    - `POST /api/wizard/scenes` with body `{ name: string; plot: Plot; items: Array<{ assetId: string; x: number; z: number; rotationY: number }>; spawn: { x: number; z: number } }` → `201 { sceneId }`. In one transaction:
      1. the scene-limit check (403 with the existing body);
      2. the scene and its `Default` preset;
      3. one `model` element per distinct asset, with `properties.modelSrc = cdnUrl` and the asset's name;
      4. one instance per item at `{ x, y: 0, z }` with the rotation, in the units the dashboard's transform editor uses (check `scenes/[sceneId]/client.tsx`);
      5. a `scene_library` link per distinct asset.
      It returns 400 when `!validPlot`, when any position is outside `[0, plotSizeM]`, when an asset isn't a public catalog model, or when items exceed `dclBudget(parcels).entities`. **Review Focus 1:** it returns `422 over_budget` when the summed `triangleCount` exceeds `dclBudget(parcels).triangles`.
    - `GET /api/assets?category=Building,Structure` matches any of the listed categories.
- Drafting the data: pick from `catalog/tags/{decentraland,dhingia,last-slice}.json` by name and category. Keep each theme to 8–15 items and prefer `decentraland` and `dhingia` pieces (smaller files). Lay them out by hand with x/z fractions: trees and plants at the edges, a clear path to a spawn near the south edge (z ≈ 0.1). The owner reviews these before launch; list every theme's items in the task report.

- [ ] **Step 1: Write the failing tests.**
  - Themes: every id is unique, every `x` and `z` is within [0,1], and every pack id exists in `catalog/packs.json`.
  - Routes, with catalog rows inserted for a few refs:
    - The catalog response resolves known refs and drops unknown ones.
    - Bootstrap creates exactly 1 preset, N elements, M instances and N library links.
    - A position at `x = 33` on a 2×2 plot gives 400.
    - Over the triangle budget gives 422 `over_budget`, and no scene is created.
    - At the scene limit (non-unlocked config, as the existing scene-limit test does) gives 403 `scene_limit_reached`.
    - `options.hyperfy.allowed` is false for a free user when features aren't unlocked.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement and draft the data.
- [ ] **Step 4:** Run it and the suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(server): wizard catalog, themes and one-call scene bootstrap`.

---

### Task 9: World destination routes

**Files:**
- Create: `apps/server/src/routes/dcl-destinations.ts`; Modify: `apps/server/src/app.ts`
- Test: `apps/server/test/dcl-destination-routes.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 4 and 7, `verifiedWalletsOf`, `getSceneAccess` / `isFullAccess`.
- Produces routes, all `authenticate` and none feature-gated. "Owner" means one of the caller's verified wallets is `getDeployers(world).owner`; failing that gives `403 not_world_owner`.
  - `GET /api/dcl/names` → `{ wallets: Array<{ address, names: Array<{ world, hasScene: boolean, footprint: { base, parcels } | null, storage: { maxAllowedBytes, usedBytes } | null }> }> }` for each verified wallet.
    - `footprint` is the parcel union of the live entities.
    - ENS Worlds aren't listed (no lookup for them); they're handled by `GET /api/dcl/worlds/:world`.
  - `GET /api/dcl/worlds/:world` → the same item for one typed name (ENS or DCL), plus `owner: boolean`.
  - `POST /api/dcl/destinations` with body `{ sceneId, world, mode: 'virvi' | 'sign', plot?: Plot, spawn?: { x: number; z: number } }` → `201 { destination }`. It needs full access to the scene and a caller who owns the World. Two shapes:
    - **With `plot`** (wizard): `base` / `parcels` come from the plot. When the World already has a scene, the plot's base is moved to that scene's base (so the new deploy overlaps and replaces it, the Decentraland rule) and the response carries `replaces: { parcels }`.
    - **Without `plot`** (adopt an existing scene): the World must have a live scene and an active location setup pointing at `sceneId`. `base`, `parcels`, `lastEntityId` and `deployedFiles` come from the live entity, with `adopted: true`.
    It returns `409 world_in_use` with the other `sceneId` when the World already has a destination.
  - `GET /api/dcl/destinations/:id` → `{ destination, pending: ModelNeed[], refused, lastDeployment }`, with scene.edit access.
  - `PATCH /api/dcl/destinations/:id` with body `{ mode }`. Switching to `sign` clears `grantedAt`, and the response says the owner can revoke Virvi in the Creator Hub or with `DELETE`.
  - `GET /api/dcl/destinations/:id/grant` → `{ virviAddress, requests: Array<SignedRequest & { payload: string }> }`.
    - The first request is the deployment permission `PUT`. The second is the parcels `POST` scoped to the destination's parcels plus any `replaces` footprint.
    - Before coding, confirm in the openapi whether a `PUT` alone grants all parcels, and whether a parcel-scoped grant needs the `PUT` first. Encode what's true, and say it in a doc comment.
  - `POST /api/dcl/destinations/:id/grant` with body `{ chains: AuthChain[] }`:
    - Each chain must verify against its request's payload with the owner as signer.
    - It forwards each request through `sendSigned`, in order.
    - It then re-reads `getDeployers` and sets `grantedAt` only when `virviAddress` is listed. Otherwise it returns `502 grant_not_visible`.
  - `DELETE /api/dcl/destinations/:id/grant` → `{ requests }` to sign for the revoke, then a `POST …/revoke` with the chains. It clears `grantedAt` and sets `mode: 'sign'`.
  - `POST /api/dcl/destinations/:id/deploy`:
    - mode `virvi` → `startVirviDeploy`, returns `202 { deployment }`;
    - mode `sign` → `prepareSignedDeploy`, returns `200 { deployment, payload, expiresAt }`.
  - `POST /api/deploy/:id/signature` with body `{ chain }` → `submitSignedDeploy`. The caller must be the scene's full-access user.
  - `POST /api/dcl/destinations/:id/rebase` → takes the live entity as the new base: `lastEntityId`, `deployedFiles`, `status: ok`. This is the "Use the live version" button.
  - `GET /api/scenes/:sceneId/dcl/publish-status` → `{ destination: null | { id, world, mode, status, pending: number, publishUrl } }`, where `publishUrl = ${config.webAppUrl}/publish/?d=<id>`. It uses `scenePass: { sceneFrom: fromParam('sceneId') }`, so the in-world HUD's scene token can call it.
  - `DeployerError`s map to `{ error: code }` with their status.

- [ ] **Step 1: Write the failing tests** with `FakeDclDirectory` and `FakeWorldsClient`. Verified wallets come from the factories (`createUser` gives a wallet). Cover:
  - `GET /api/dcl/names` lists the fake's owned names, with `hasScene` and `footprint`.
  - **Review Focus 5:** create, grant and deploy from a user whose wallet isn't the owner all give 403, and no rows are created.
  - A wizard create on a World whose live scene is at `5,5` gets `base: '5,5'` and `replaces`.
  - Adopt without a matching setup gives 400 `not_connected`. With one, it copies the live entity's base, parcels and files.
  - The grant round trip: the fake records two signed requests in order, and `grantedAt` is set. If the fake's deployers don't list Virvi afterwards, the response is 502 and `grantedAt` stays null.
  - A second destination for the same World gives 409 `world_in_use`.
  - `publish-status` with a scene-pass token for that scene works; another scene's pass gets 404.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it and the suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(server): World destination, grant and deploy routes`.

---

### Task 10: Pending models and the redeploy sweep

**Files:**
- Create: `apps/server/src/services/dcl/redeploy-sweep.ts`
- Modify: `apps/server/src/config.ts` (`dclRedeploySweepMs: parseInt(env('DCL_REDEPLOY_SWEEP_MS') || '30000')`), `apps/server/src/index.ts` (start it next to `startLifecycleSweep`, unless 0), `apps/server/vitest.config.ts` (env `DCL_REDEPLOY_SWEEP_MS: '0'`)
- Test: `apps/server/test/redeploy-sweep.test.ts`

**Interfaces:**
- Consumes: `modelsInScene`, `assembleRedeploy`, `startVirviDeploy`, `WorldsClient`, `dclBudget`.
- Produces:
  - `BATCH_WINDOW_MS = 60_000`
  - `pendingModels(dest): Promise<ModelNeed[]>`: `modelsInScene` minus files already in `dest.deployedFiles`.
  - `sweepRedeploys(now?: Date): Promise<{ started: number; marked: number }>`. For each destination:
    1. If it has pending models and no `pendingSince`, set `pendingSince = now`. With none pending, clear it.
    2. For `mode = 'virvi'`, `grantedAt` set, `status ∈ {ok, unreachable}`, `now - pendingSince ≥ BATCH_WINDOW_MS`, and no deployment for it in `building | deploying`:
       - Read the live entity at `dest.base`. If unreadable, set `status: unreachable` and retry on the next sweep.
       - **Review Focus 3:** if its id isn't `dest.lastEntityId`, set `status: needs_review` with `statusDetail` "Your World changed outside Virvi", and deploy nothing.
       - If the pending triangles (catalog counts; unknown counts as 0, said in `statusDetail`) plus the triangles already in the scene exceed `dclBudget(parcels.length).triangles`, or the new bytes exceed the remaining `getWalletStats` space, set `status: over_budget` with a plain sentence. This status clears by itself when the pending set changes.
       - Otherwise call `startVirviDeploy(dest.id, null)`.
    Mode `sign` destinations only track `pendingSince` (for the HUD and dashboard).
  - `startDclRedeploySweep(ms: number): () => void`

- [ ] **Step 1: Write the failing tests** with a fake clock and fakes:
  - A model added at t=0 isn't deployed at t=30 s and is deployed at t=61 s.
  - Two models added 20 s apart give one deployment that contains both.
  - **Review Focus 3:** with the fake's live entity id changed, the destination becomes `needs_review` and `fake.deployed` stays empty. After `rebase` (call the route), the next sweep deploys.
  - With the fake down, the destination becomes `unreachable`, and the next sweep after recovery deploys.
  - Going over the triangle budget gives `over_budget`, with no deploy.
  - A `sign` destination only gets `pendingSince` and is never deployed.
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it and the suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(server): batch redeploys when models are added`.

---

### Task 11: In-world "placed a model" message

**Files:**
- Modify: `packages/vlm-client/src/http.ts` (`getDclPublishStatus(sceneId: string): Promise<{ destination: null | { id: string; world: string; mode: 'virvi' | 'sign'; status: string; pending: number; publishUrl: string } }>`), `packages/vlm-adapter-dcl/src/index.ts:~357-375`, `packages/vlm-smart-item-dcl/README.md`

**Interfaces:**
- Consumes: `GET /api/scenes/:sceneId/dcl/publish-status` (Task 9).
- Behaviour after a model is placed in-world. The message is exact copy:
  - No destination: `Placed ${name} — let Virvi deploy it from vlm.gg/deploy, or run npx vlm-dcl sync and redeploy`
  - `virvi`: `Placed ${name} — Virvi is adding it to your World; it appears in a minute or two`
  - `sign`: `Placed ${name} — publish it on vlm.gg to see it`, with an "Publish" action that opens `publishUrl` through `adapter.openUrl`. Follow the `open_analytics` action pattern.
  - If the status call fails, fall back to the no-destination message.
- Ruling: the spec's "link and QR" is a link only in Decentraland, because the explorer opens links itself and a QR code would need a second device. The dashboard shows the same prompt (Task 16).
- README: `npx vlm-dcl sync` becomes "optional, if you want the files locally"; Virvi deploys are the default path.

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** Run `pnpm --filter vlm-client typecheck && pnpm --filter vlm-adapter-dcl typecheck && pnpm --filter vlm-dcl bundle`. Expected: no errors.
- [ ] **Step 3:** Rebuild the runtime (`bash dcl-runtime/build.sh`) so version 1 carries the new message, and run `test/dcl-runtime.test.ts` again.
- [ ] **Step 4:** Commit `feat(dcl): say what happens next after placing a model in-world`.

---

### Task 12: Browser signing helper and API client

**Files:**
- Create: `apps/web/src/lib/dcl-sign.ts`
- Modify: `apps/web/package.json` (add `@dcl/crypto` 3.7.0), `apps/web/src/lib/api.ts`
- Test: `apps/web/src/lib/dcl-sign.test.ts`

**Interfaces:**
- Produces:
  - `interface SignSession { address: string; sign(payload: string): AuthChain }`
  - `isContractWallet(wallet: Eip1193Provider, address: string): Promise<boolean>`: true when `eth_getCode` isn't `0x`.
  - `startSignSession(wallet: Eip1193Provider, opts?: { minutes?: number; expectedAddress?: string }): Promise<SignSession>`:
    - Makes a fresh ephemeral identity (default 10 minutes, kept in memory only).
    - Uses one `personal_sign` from the wallet to authorise it (`Authenticator.initializeAuthChain`).
    - `sign` = `Authenticator.signPayload`.
    - It rejects with `WrongWalletError(expected)` when `opts.expectedAddress` is given and doesn't match.
  - `api.ts` additions, typed against the server responses in Tasks 8 and 9:
    - `getWizardCatalog`, `getWizardOptions`, `bootstrapWizardScene`
    - `getDclNames`, `getDclWorld`
    - `createDclDestination`, `getDclDestination`, `patchDclDestination`
    - `getDclGrant`, `submitDclGrant`, `getDclRevoke`, `submitDclRevoke`
    - `deployDclDestination`, `submitDeploySignature`, `rebaseDclDestination`
  - Removed: `createDeployment`, `redeployDeployment`, `getDeployWallets`, `createDeployWallet`, `deleteDeployWallet`.

- [ ] **Step 1: Write the failing test** with a fake EIP-1193 provider that signs with `createUnsafeIdentity` (`eth_requestAccounts`, `personal_sign`): `sign('abc')` gives a chain whose root signer is the provider's address and which validates (`Authenticator.validateSignature('abc', chain, null)`). A mismatched `expectedAddress` rejects.
- [ ] **Step 2:** Run `pnpm --filter vlm-web test`. Expected: FAIL.
- [ ] **Step 3:** Implement. `@dcl/crypto` must bundle for the browser in the static export. Check that `pnpm --filter vlm-web build` still succeeds; if a Node built-in leaks in, alias or polyfill it in `next.config.ts` and say so.
- [ ] **Step 4:** Run the tests and `pnpm --filter vlm-web typecheck`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): browser signing session and Decentraland API client`.

---

### Task 13: Wizard state, placement and budget (pure logic)

**Files:**
- Create: `apps/web/src/lib/wizard/placement.ts`, `apps/web/src/lib/wizard/budget.ts`, `apps/web/src/lib/wizard/state.ts`
- Test: `apps/web/src/lib/wizard/{placement,budget,state}.test.ts`

**Interfaces:**
- Consumes: `Plot`, `plotSizeM`, `dclBudget` (vlm-shared), `WizardAsset` (the API type).
- Produces:
  - `interface PlacedItem { key: string; asset: WizardAsset; x: number; z: number; rotationY: number }` (metres, plot-relative, y=0)
  - `footprint(asset: WizardAsset): { x: number; z: number }`: from `dimensions`, defaulting to 1×1 m when missing, and swapped for 90° / 270° rotations.
  - `layoutTheme(items: Array<{ asset; x; z; rotationY }>, plot: Plot): PlacedItem[]`: fractions to metres, clamped inside the plot.
  - `suggestPosition(plot: Plot, placed: PlacedItem[], asset: WizardAsset, spawn: { x: number; z: number }): { x: number; z: number } | null`:
    - Searches a spiral from the plot's centre in 0.5 m steps.
    - The first spot whose footprint (plus a 0.5 m margin) overlaps no placed item, stays inside the plot, and keeps a 2 m radius around the spawn clear.
    - Null when nothing fits.
  - `clampToPlot(plot, item): PlacedItem`
  - `budgetStatus(items: PlacedItem[], plot: Plot | null, storage: { maxAllowedBytes: number; usedBytes: number } | null): { triangles: { used: number; limit: number | null }; entities: { used: number; limit: number | null }; bytes: { used: number; remaining: number | null }; over: null | string }`.
    - `bytes.used` counts each distinct asset once.
    - `over` is the plain sentence from the spec, e.g. `"This plot fits about 40,000 triangles; that would make it 43,500"`.
  - `fitToBudget(items: PlacedItem[], plot: Plot): { items: PlacedItem[]; dropped: number }`: drops from the end.
  - `type WizardStep = 'where' | 'size' | 'assets' | 'arrange' | 'deploy'`
  - `interface WizardState`:
    - `step`
    - `destinations: { dcl: { world: string; wallet: string; hasScene: boolean; footprint } | null; hyperfy: null | { kind: 'self' | 'hosted'; name: string }; ar: null | { name: string } }`
    - `plot: Plot | null`
    - `themeId: string | null`
    - `items: PlacedItem[]`
    - `spawn: { x: number; z: number }`
    - `mode: 'virvi' | 'sign'`
    - `name: string`
  - `wizardReducer(state, action)` with these actions:
    - `setDcl`, `setHyperfy`, `setAr`
    - `setPlot`: keeps items, clamped; when the plot shrinks below the budget, applies `fitToBudget`.
    - `applyTheme`: `layoutTheme` then `fitToBudget`, recording `lastDropped`.
    - `addAsset`: uses `suggestPosition`; when it's null or over budget, leaves the state unchanged with `notice`.
    - `removeItem`, `moveItem` (clamped), `rotateItem` (+90°)
    - `moveSpawn`, `setMode`, `goTo`
  - `canAdvance(state): boolean`:
    - `where` needs at least one destination;
    - `size` needs a plot when `dcl` is set (Hyperfy/AR-only gets a default 2×2 guide plot);
    - `assets` and `arrange` need `over === null`.

- [ ] **Step 1: Write the failing tests:**
  - `suggestPosition` on an empty 1×1 plot is near the centre (8,8) and at least 2 m from spawn (8,1).
  - On a plot full of 4×4 m items it returns null.
  - A 2×2 m item rotated 90° has a swapped footprint.
  - **Review Focus 1:** `applyTheme` with 12 items at 1,500 triangles each on a 1×1 plot keeps 6 items and records `lastDropped = 6`.
  - `budgetStatus` counts a duplicated asset's bytes once, and its `over` sentence matches the spec's wording.
  - `canAdvance` at `where` with no destinations is false.
  - `moveItem` outside the plot clamps inside it.
- [ ] **Step 2:** Run `pnpm --filter vlm-web test`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): wizard state, placement and budget`.

---

### Task 14: The 3D preview

**Files:**
- Create: `apps/web/src/components/wizard/Preview3D.tsx`
- Modify: `apps/web/package.json`: add `three`, `@react-three/fiber`, `@react-three/drei` (the latest versions that support React 19, pinned exactly) and `@types/three`.

**Interfaces:**
- Consumes: `PlacedItem`, `Plot`, `plotSizeM`.
- Produces: `<Preview3D plot={Plot | null} items={PlacedItem[]} spawn={{x,z}} selectedKey={string|null} editable={boolean} onMove={(key, x, z) => void} onRotate={(key) => void} onSelect={(key|null) => void} onMoveSpawn={(x, z) => void} />`, client-only, loaded with `next/dynamic` and `ssr: false`.
- What it draws:
  - A ground plane with a 16 m parcel grid and the plot's edge.
  - Each item's GLB from `cdnUrl` (`useGLTF`, cached by URL).
  - A spawn marker.
  - An orbit camera that frames the plot.
- Editing, when `editable`: drag moves an item on the ground plane (orbit is disabled while dragging), click selects, and a rotate button turns the selection +90°.
- If a GLB fails to load (404, CORS), the item shows a translucent box sized by `footprint` × `dimensions.y`, and the rest of the preview keeps working. Check in the browser that the CDN allows cross-origin GLB fetches from vlm.gg and from the dev origin, and report what you found.
- Without WebGL, a plain top-down SVG of footprints is drawn (reuse the plot math; no new 3D).

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** Run `pnpm --filter vlm-web typecheck && pnpm --filter vlm-web build`. Expected: success, and `out/` is still a static export.
- [ ] **Step 3:** Run the web app and the server locally (the `run` skill). Add a temporary dev-only page showing a 2×2 plot with three catalog models, and delete it before committing. Check that drag, rotate, the fallback box (point one item at a bad URL) and orbit work, and take a screenshot.
- [ ] **Step 4:** Commit `feat(web): live 3D preview of the plot`.

---

### Task 15: The wizard page

**Files:**
- Create: `apps/web/src/app/(dashboard)/scenes/new/page.tsx`, `apps/web/src/components/wizard/steps/{WhereStep,SizeStep,AssetsStep,ArrangeStep,DeployStep}.tsx`
- Modify: `apps/web/src/app/(dashboard)/scenes/page.tsx`: a primary "New scene" button that links to `/scenes/new`. The existing one-field form stays as "Blank scene".

**Interfaces:**
- Consumes: Tasks 12–14, existing `POST /api/hyperfy/worlds`, `POST /api/scenes/:id/ar/spaces`, `signWalletChallenge` / `linkWallet` (wallet sign-in and linking).
- Layout (mockup B): the step column sits on the left. Done steps collapse to a one-line summary with ✓ and reopen on click. `Preview3D` fills the right. On phone widths the preview sits above the steps. Use the dashboard's existing classes (`rounded-lg border border-gray-800 bg-gray-900 p-4`, `ui.tsx` components).
- **Where:**
  - With no verified wallet, offer "Connect your wallet" (sign + link).
  - List `getDclNames` with a "has a scene" badge, plus "Use an ENS name or another World" (typed, checked with `getDclWorld`; refused with a plain message unless `owner`).
  - Ticks for Hyperfy (locked with an "Upgrade to Creator" link to `/settings` when `options.hyperfy.allowed` is false) and Virvi AR (name field).
  - When `isContractWallet` is true for the chosen wallet, say plainly: "Contract wallets (like Safe) can't sign Decentraland World deploys yet. Connect an ordinary wallet that owns the name." Don't let them continue with it.
  - A World that has a scene shows "Your World already has a scene on N parcels. Deploying will replace it." with a confirm checkbox that is required to continue.
- **Size:**
  - Choices are 1×1, 2×2, 3×3 and Custom (width × depth up to 10).
  - Show `dclBudget` numbers and storage ("uses about X MB of your Y MB left") from the names response.
  - Hyperfy/AR-only shows "Used as a guide for placing things".
- **Assets:**
  - Theme cards, where switching themes asks "Replace what's in the scene?".
  - Category chips with their picks, plus a search box calling `GET /api/assets?category=<chip categories>&q=&maxTriangles=<remaining>`.
  - Click to add, × to remove.
  - The running count line, which shows `over` and the "left out N items to fit" notice.
- **Arrange:** the preview is editable, with a "Move the arrival point" toggle. The copy says exact placement happens in-world.
- **Deploy:**
  - The mode choice, "Let Virvi deploy for me (recommended)" or "I'll sign each deploy", each with one line from the spec. When `options.dcl.virviDeploys` is false, only "sign" is offered, with the reason.
  - "Create and deploy" runs these in order:
    1. `bootstrapWizardScene`
    2. `createDclDestination`
    3. mode virvi: grant (start one sign session, sign both payloads, submit), then `deployDclDestination`; mode sign: `deployDclDestination`, then sign the payload and `submitDeploySignature` (on `409 expired`, prepare again and sign once more)
    4. Hyperfy/AR creates via their existing endpoints
    5. poll `GET /api/deploy/:id` every 2 s
  - Progress lines, with exact copy: "Packing your scene", "Uploading N models", "Decentraland is checking it", "Live".
  - On a failure, the step shows the server's message and "Try again", which reuses the created scene and destination and never makes a second scene.
  - "Jump in" appears only after status `deployed` and opens `https://decentraland.org/play/?realm=<world>` in a new tab. Confirm this URL form opens a World in the current web explorer and fix the format if not.
  - A link to the scene's dashboard page sits beside it.
- [ ] **Step 1:** Implement.
- [ ] **Step 2:** Run `pnpm --filter vlm-web typecheck && pnpm --filter vlm-web test && pnpm --filter vlm-web build`. Expected: success.
- [ ] **Step 3:** Run it locally against the server with `FakeWorldsClient`-style stubs: start the server with `DCL_WORLDS_URL` pointing at a tiny local stub that accepts `/entities` and the permission calls, or make the deployer's client injectable through a dev-only env, whichever is less code. Walk the whole wizard in mode A and mode B. Take screenshots of each step and of "Live". Never point it at the real Worlds server with a real name during development.
- [ ] **Step 4:** Commit `feat(web): New Scene Wizard`.

---

### Task 16: Deploy page and the publish page

**Files:**
- Modify: `apps/web/src/app/(dashboard)/deploy/page.tsx`: remove the New Deployment form and the Deploy Wallets section; keep "Your Hyperfy worlds".
- Create: `apps/web/src/app/(dashboard)/publish/page.tsx` (`/publish/?d=<destinationId>`; static path, read `d` from the query string)

**Interfaces:**
- Consumes: the Task 9 routes and Task 12's `startSignSession`.
- Deploy page, per scene with a destination:
  - The World name, mode, status (with `statusDetail` in plain words), pending model count, the last deployment and its time, and deploy history (`GET /api/deploy/scene/:id`).
  - Buttons:
    - "Redeploy now" (mode A starts a deploy; mode B goes to `/publish/?d=`)
    - "Let Virvi deploy for me" / "Switch to signing each deploy" (grant / revoke flow)
    - "Use the live version" when `needs_review`
  - For a scene with an active World location setup but no destination (a Creator Hub `vlm-dcl` scene), a "Turn on Virvi deploys for <world>" card that adopts it (`createDclDestination` without `plot`), then offers the grant.
- Publish page:
  - Shows the World, the models waiting ("3 models are waiting to go live"), and one "Sign and publish" button.
  - It runs prepare → sign → submit (re-preparing once on `expired`), then the same progress lines as the wizard, then "Live".
  - A wrong wallet shows "Sign with <short owner address>, the wallet that owns <world>".
- [ ] **Step 1:** Implement.
- [ ] **Step 2:** Run `pnpm --filter vlm-web typecheck && pnpm --filter vlm-web build`. Expected: success, and no reference left to deploy wallets (`grep -rn "DeployWallet\|deploy/wallets" apps/web/src` is empty).
- [ ] **Step 3:** Check both pages locally against the stub from Task 15 (screenshots).
- [ ] **Step 4:** Commit `feat(web): deploy page shows World destinations; publish page for signed redeploys`.

---

### Task 17: Ops, docs and the whole-branch check

**Files:**
- Modify: `.railway/railway.ts` (add `VIRVI_DCL_DEPLOY_KEY: preserve(),` in sorted position), `.env.example` (`VIRVI_DCL_DEPLOY_KEY=`, with a comment saying it's the private key of a wallet used only for World deploys it has been granted, never a user's key; and `DCL_REDEPLOY_SWEEP_MS=30000`)

- [ ] **Step 1:** Make the edits.
- [ ] **Step 2:** Run the full checks: `pnpm --filter vlm-shared build && pnpm --filter vlm-server typecheck && pnpm --filter vlm-server test && pnpm --filter vlm-web typecheck && pnpm --filter vlm-web test && pnpm --filter vlm-web build && pnpm --filter vlm-dcl bundle`. Expected: everything passes. Report the counts.
- [ ] **Step 3:** Run `grep -rn "requireFeature('deployment')" apps/server/src/routes/wizard.ts apps/server/src/routes/dcl-destinations.ts`. Expected: empty. Check `git diff main --stat -- apps/server/src/integrations apps/server/src/routes/billing.ts apps/server/src/middleware/feature-gate.ts`. Expected: empty.
- [ ] **Step 4:** Commit `chore: Virvi deploy key and redeploy sweep settings`.
- [ ] **Step 5:** In the report, list what the owner does before Virvi deploys work in production:
  1. Make a fresh wallet just for World deploys.
  2. Set `VIRVI_DCL_DEPLOY_KEY` in Railway (never paste it into chat).
  3. Run `railway config plan`.
  4. Try the wizard end to end on a test NAME.
  5. Review the five themes.
