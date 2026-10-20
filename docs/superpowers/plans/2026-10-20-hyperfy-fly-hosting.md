# VLM-Hosted Hyperfy Worlds on Fly (Hyperfy Project 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "Deploy to Hyperfy" in the dashboard creates a real Hyperfy world on Fly, at its own address, already showing the scene, and destroying it frees its slot.

**Architecture:**
- **One Fly app per world** (`vlm-w-<slug>`) in a dedicated Fly org, running VLM's Hyperfy image: Hyperfy pinned to a commit with VLM's patches and the VLM app (`vlm.hyp` from project 1) built in.
- **World data lives off the machine:** a schema and role per world in a dedicated Fly Managed Postgres, and files under a per-world prefix in a dedicated R2 bucket. Machines sleep when idle and wake on the next request.
- **The VLM server provisions and tears down worlds** through Fly's Machines API. It records them in the `hyperfy_worlds` table (project 1) as `kind 'hosted'`, enforces per-plan slots, and runs a sweep that ends temporary worlds and purges them 30 days later.
- **`<slug>.worlds.vlm.gg` for Pro and up:** a tiny router app holds the wildcard certificate and hands each request to the world's app with `fly-replay`.

**Tech Stack:** TypeScript, Fastify, drizzle and Postgres, vitest, Fly Machines API, Fly Managed Postgres, Cloudflare R2 (S3 API), Docker, Hyperfy 0.16 (pinned), Next.js.

**Spec:** `docs/superpowers/specs/2026-10-19-hyperfy-worlds-design.md`. This plan covers project 2, hosting. Project 1 (the VLM app, the feed and "Connect your own world") is merged at dced52c.

## Global Constraints

- **Hyperfy pinned** to `dev` at `b4081eb`, with `infra/hyperfy/patches/` applied in order. Upgrading is a deliberate change that re-runs the world test. Never `latest`.
- **Region:** every world runs in `iad`.
- **Fly org for worlds:** `vlm-worlds`. The server's `FLY_API_TOKEN` is scoped to that org only; it must not be able to touch `vlm-streaming`.
- **Worlds DB:** a dedicated Fly Managed Postgres in `iad`, inside `vlm-worlds`. Each world gets schema `world_<slug>` and a role of the same name that can use only that schema.
- **Worlds bucket:** `vlm-hyperfy`, with an R2 token scoped to that bucket. Each world's files live under prefix `<slug>/`. `ASSETS_BASE_URL` is the bucket's public CDN domain, with CORS allowing world origins.
- **Slots** (`TIER_LIMITS.hyperfyInstances`): Free 0, Creator 1, Pro 3, Studio 10, Enterprise `Infinity`. Every hosted world that isn't purged counts, asleep, awake or failed. Worlds that have ended (temporary, past their end date) don't count. Self-run worlds never count.
- **Addresses, fixed for life:** a world created on Creator gets `vlm-w-<slug>.fly.dev`. One created on Pro or higher gets `<slug>.worlds.vlm.gg`. Upgrades and downgrades never move a world.
- **Downgrades:** if a downgrade leaves an owner over their limit, new worlds are blocked and existing ones keep running.
- **Temporary worlds:** the end date is optional and editable until it passes (extend it, or clear it to make the world permanent). At the end date the world stops and its slot frees. Its data, slug and key are kept for 30 days and can be restored if a slot is free. After that a sweep deletes the schema, the bucket prefix and the Fly app.
- **Hosting gate:** `hyperfyHosting()` stays the single source of truth for whether hosted worlds are offered. Self-run worlds never consult it.
- **Secrets:** never print or log any of them: Fly token, admin codes, world keys, DB passwords, R2 keys. A world's admin code is stored encrypted, using the same AES helper pattern as `services/dcl/deployer.ts`.
- **Off limits:** don't change subscription or billing flows. The only change in `integrations/stripe.ts` is the `hyperfyInstances` numbers, as the spec approves.
- **Deploying the VLM server:** only with `railway up <worktree> --path-as-root -s vlm-server --ci`.

## Fixed values

| Name | Value |
|---|---|
| Fly app name | `vlm-w-<slug>` |
| Slug | lowercase `[a-z0-9-]`, 3–30 characters, unique across all worlds that aren't purged, from the world name. A suffix `-2`, `-3`, … is added on a clash. |
| Machine | `shared-cpu-1x`, 1024 MB, `iad`, internal port 3000, services 80 (http) and 443 (tls+http), `autostop: 'stop'`, `autostart: true`, `min_machines_running: 0` |
| Health wait | up to 180 s for `GET https://<address>/` to answer 200 |
| Retention after end | 30 days |
| Sweep interval | 5 minutes |
| World statuses | `provisioning`, `running`, `failed`, `ended` |

## Decisions this plan makes (the spec leaves them to the builder, or a ruling replaces its text)

- **The VLM app is its own blueprint, not `$scene`.** Hyperfy's `$scene` app carries the ground, sky and lighting (the default "Meadow"). Making the VLM app `$scene` would leave hosted worlds with no floor. So `$scene` stays Hyperfy's default, and VLM owns a second blueprint with id `vlm`, plus exactly one entity of it at the origin. Owners may build anything else, and VLM only rewrites `vlm`. **This replaces the spec's "VLM owns `$scene`".**
- **How the app gets into a world:** a VLM-only Hyperfy patch, `0002-vlm-app.patch`. On every boot, after Hyperfy's migrations, it reads `/app/vlm/vlm.hyp` and uploads its assets with Hyperfy's own `assets.upload`. It upserts blueprint `vlm` with props `{ feedUrl: VLM_FEED_URL, worldKey: VLM_WORLD_KEY }` and ensures one `vlm` entity exists. That way app updates and key rotation reach existing worlds on their next start. Running inside Hyperfy reuses its DB and asset code, so the image needs no separate entrypoint step.
- **Long-poll only, for hosted worlds too.** The spec's WebSocket feed transport is deferred. Project 1's feed delivered an edit in 270 ms in the end-to-end test, so a second transport buys nothing yet. Hosted worlds still set `PUBLIC_SCRIPT_WEBSOCKET_ORIGINS=wss://api.vlm.gg`, so a later WebSocket feed needs no image change. **This replaces the spec's "Transport 1, WebSocket" for now.**
- **World keys for hosted worlds:** the same `createWorldKey`/`findWorldByKey` as project 1. The raw key lives only in the world's Fly machine env (`VLM_WORLD_KEY`), set at create and on rotate (rotate updates the machine env and restarts it).
- **Admin code:** generated at create, stored encrypted, returned once in the create response. `POST /api/hyperfy/worlds/:id/admin-code` reveals it again to someone with full scene access.
- **Fly calls:** REST Machines API at `https://api.machines.dev/v1` for apps, machines and secrets. Public IPs (shared IPv4 plus IPv6) through `POST /v1/apps/{app}/ip_assignments`, with Fly's GraphQL `allocateIpAddress` as the fallback if the spike (Task 0) finds that route missing. Only worlds on `.fly.dev` addresses need public IPs. Router-addressed worlds are reached only through `fly-replay`.
- **Routing for `worlds.vlm.gg`:** a router app `vlm-worlds-router` in the same org. It holds a wildcard certificate for `*.worlds.vlm.gg` and DNS has one wildcard record. For `Host: <slug>.worlds.vlm.gg` it replies with `fly-replay: app=vlm-w-<slug>`, before any WebSocket upgrade, and anything else gets 404. No per-world certificates are needed.
- **The old provider code goes.** `services/hyperfy/infrastructure.ts` keeps only `hyperfyHosting()`. The Docker and Local providers and `services/hyperfy/provisioner.ts` are removed, along with the Hyperfy branch of `routes/deploy.ts`. Hosted worlds live under `/api/hyperfy/worlds`. `GET /api/deploy/platforms` keeps reporting availability from `hyperfyHosting()`.
- **Image registry:** the image is pushed to `registry.fly.io/vlm-hyperfy-image:<git-sha>` (an app in `vlm-worlds` used only for its registry). The server reads the tag from `HYPERFY_IMAGE`.

## Server environment (all read in `config.ts`)

| Variable | Use |
|---|---|
| `HYPERFY_INFRA_PROVIDER=fly` | turns hosting on |
| `FLY_API_TOKEN` | org-scoped token for `vlm-worlds` |
| `FLY_WORLDS_ORG` | `vlm-worlds` |
| `HYPERFY_IMAGE` | `registry.fly.io/vlm-hyperfy-image:<sha>` |
| `HYPERFY_WORLDS_DATABASE_URL` | admin URL of the worlds Postgres, used by the VLM server to create and drop roles and schemas |
| `HYPERFY_WORLDS_DB_URL_TEMPLATE` | the URL worlds connect with (the pooled private address), with `{user}` and `{password}` placeholders |
| `HYPERFY_ASSETS_S3_URI` | `s3://<key>:<secret>@<account>.r2.cloudflarestorage.com/vlm-hyperfy`. Each world gets `/<slug>/` appended. |
| `HYPERFY_ASSETS_BASE_URL` | the bucket's CDN origin, e.g. `https://worlds-cdn.vlm.gg`. Each world gets `/<slug>` appended. |
| `HYPERFY_ROUTER_DOMAIN` | `worlds.vlm.gg` |
| `HYPERFY_SECRET_KEY` | 32-byte hex key for encrypting admin codes |

`hyperfyHosting()` reports `available: true` only when the provider is `fly` and every variable above is set.

## Review Focus

1. **Provisioning fails halfway** (Fly app created, then machine creation or the health wait fails). The world ends `failed`, everything created so far is removed (app, schema and role, bucket prefix), the slot is free again, and the dashboard shows the error. Test: Task 6, `a failure after the app exists cleans up the app, schema and files and marks the world failed`.
2. **Two creates race for the last slot, or for the same slug.** At most one gets the slot, and slugs never collide. Test: Task 6, `two concurrent creates for the last slot: one succeeds, one gets world_limit_reached`.
3. **Destroy while provisioning is still running.** The world never ends up half-alive. Destroy waits for, or cancels, the in-flight create, then removes everything. Test: Task 6, `destroy during provisioning leaves no Fly app, schema or row`.
4. **A temporary world reaches its end date while asleep, or the sweep runs on two servers at once.** It ends once, frees its slot once, and purges once after 30 days. Test: Task 8, `concurrent sweeps end a world exactly once`.
5. **Fly API errors, rate limits or timeouts.** Each surfaces as a clear failure on that world, never an unhandled rejection or a world stuck in `provisioning`. Test: Task 2, `non-2xx and network errors become FlyError with status and Fly's message`, plus Task 6, `a world left in provisioning past the health wait is marked failed by the sweep`.

---

### Task 0: Spike: verify the Fly assumptions (run by the controller with the owner)

No product code. The owner runs `fly auth login` in their own terminal if needed.

- [ ] Create org `vlm-worlds` and an org-scoped deploy token, and store it in `~/.config/vlm/fly-worlds.token` (never printed).
- [ ] With that token, check against the live API:
  - `POST /v1/apps` in `vlm-worlds`;
  - `POST /v1/apps/{app}/ip_assignments` for shared IPv4 and for IPv6 (falling back to GraphQL `allocateIpAddress`);
  - that a machine in the org can use an image from `registry.fly.io/vlm-hyperfy-image`;
  - `autostop: 'stop'` plus `autostart: true` wakes a stopped machine on request;
  - `fly-replay: app=<other>` from a router app carries a WebSocket upgrade.
- [ ] Record what worked in `infra/hyperfy/SPIKE.md`, and rule on any assumption that failed before Task 2 starts.

### Task 1: Limits and hosted world records

**Files:**
- Modify: `apps/server/src/integrations/stripe.ts`. Only `hyperfyInstances`: free 0, creator 1, pro 3, studio 10, enterprise `Infinity`.
- Modify: `apps/server/src/db/schema.ts` `hyperfyWorlds`. Add nullable columns:
  - `slug` text, unique among rows where `purged_at` is null;
  - `address` text;
  - `flyApp` text;
  - `status` text not null, default `'running'` (self-run rows stay `'running'`);
  - `errorMessage` text;
  - `adminCodeEnc` text;
  - `endsAt` timestamptz;
  - `endedAt` timestamptz;
  - `purgeAfter` timestamptz;
  - `purgedAt` timestamptz.

  Add the matching idempotent fallback in `apps/server/entrypoint.sh`.
- Modify: `packages/vlm-shared/src/hyperfy.ts`:
  - `HyperfyWorldSummary` gains `kind: 'self' | 'hosted'`, `address: string | null`, `status: 'provisioning' | 'running' | 'failed' | 'ended'`, `errorMessage: string | null`, `endsAt: string | null`, `endedAt: string | null` and `purgeAfter: string | null`;
  - add `HOSTED_WORLD_RETENTION_DAYS = 30`.
- Create: `apps/server/src/hyperfy/slots.ts`
- Test: `apps/server/test/hyperfy-slots.test.ts`

**Interfaces:**
- Produces:
  - `hostedWorldSlots(userId: string): Promise<{ used: number; limit: number }>`. Counts the user's `kind 'hosted'` rows whose `purgedAt` is null and whose status isn't `'ended'`. `limit` comes from the user's tier via `getSubscription` and `TIER_LIMITS`.
  - `worldSummary` (project 1, `hyperfy/worlds.ts`) fills the new summary fields.

- [ ] **Step 1: Write the failing tests:**
  - `TIER_LIMITS hyperfyInstances are 0, 1, 3, 10 and Infinity`;
  - `slots count hosted worlds that exist, including failed, but not ended, purged or self-run`;
  - `summary of a self-run world has kind self, status running and null hosting fields`.
- [ ] **Step 2: Run them.** `cd apps/server && npx vitest run test/hyperfy-slots.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Rebuild vlm-shared.
- [ ] **Step 4: Run them, then the server suite.** → PASS.
- [ ] **Step 5: Commit.** `feat(server): hosted Hyperfy world records and plan slots`.

### Task 2: Fly API client

**Files:**
- Create: `apps/server/src/hyperfy/fly.ts`
- Test: `apps/server/test/hyperfy-fly.test.ts`

**Interfaces:**
- Produces:
  - `class FlyError extends Error { status: number; body: string }`
  - `class FlyApi`, with constructor `(opts: { token: string; org: string; fetch?: typeof fetch; baseUrl?: string })`. `baseUrl` defaults to `https://api.machines.dev/v1`. Methods:
    - `createApp(name: string): Promise<void>`;
    - `deleteApp(name: string): Promise<void>` (a 404 counts as success);
    - `allocatePublicIps(app: string): Promise<void>` (shared v4 plus v6);
    - `createMachine(app: string, m: WorldMachineSpec): Promise<{ id: string }>`;
    - `updateMachine(app: string, id: string, m: WorldMachineSpec): Promise<void>`;
    - `listMachines(app: string): Promise<{ id: string; state: string }[]>`;
    - `getMachineEnv(app: string, id: string): Promise<Record<string, string>>`;
    - `stopMachine(app: string, id: string): Promise<void>`;
    - `startMachine(app: string, id: string): Promise<void>`.
  - `type WorldMachineSpec = { image: string; env: Record<string, string> }`. `FlyApi` turns it into the machine config in "Fixed values".
  - Every request carries `Authorization: Bearer <token>`.

- [ ] **Step 1: Write the failing tests** with an injected fake `fetch` that records requests:
  - `createApp posts app_name and org_slug`;
  - `createMachine sends the fixed machine config with image, env, region iad, autostop stop, autostart true`;
  - `deleteApp treats 404 as done`;
  - `non-2xx and network errors become FlyError with status and Fly's message`;
  - `the token is sent as a bearer header and never appears in an error message`.
- [ ] **Step 2: Run them.** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** → PASS.
- [ ] **Step 5: Commit.** `feat(server): Fly Machines API client for Hyperfy worlds`.

### Task 3: Worlds database and bucket housekeeping

**Files:**
- Create: `apps/server/src/hyperfy/worlds-db.ts`, `apps/server/src/hyperfy/worlds-bucket.ts`
- Test: `apps/server/test/hyperfy-worlds-db.test.ts`, `apps/server/test/hyperfy-worlds-bucket.test.ts`

**Interfaces:**
- Produces:
  - `createWorldDatabase(slug: string, adminUrl?: string): Promise<{ dbUri: string; schema: string }>`. It creates role `world_<slug>` with a random 32-byte password and LOGIN, and schema `world_<slug>` owned by that role. It revokes CREATE on schema `public` from that role, and connects through `HYPERFY_WORLDS_DB_URL_TEMPLATE`. Running it twice for the same slug is an error.
  - `dropWorldDatabase(slug: string, adminUrl?: string): Promise<void>`. It drops the schema (CASCADE) and the role, and is idempotent.
  - `deleteWorldFiles(slug: string, s3?: S3Like): Promise<number>`. It deletes every object under `<slug>/` in the worlds bucket and returns the count.
  - `type S3Like = { list(prefix: string): Promise<string[]>; deleteMany(keys: string[]): Promise<void> }`. The default is built from `HYPERFY_ASSETS_S3_URI` with `@aws-sdk/client-s3`.

- [ ] **Step 1: Write the failing tests:**
  - DB, against the local test Postgres:
    - `a world role can create tables in its own schema`;
    - `a world role can't read or create in another world's schema or in public`;
    - `drop removes schema and role, twice is fine`.
  - Bucket, with a fake `S3Like`:
    - `deletes only keys under the slug prefix, paging through more than 1000`.
- [ ] **Step 2: Run them.** → FAIL.
- [ ] **Step 3: Implement.** Quote identifiers safely, and accept only slugs that pass the "Fixed values" slug rule.
- [ ] **Step 4: Run them, then the server suite.** → PASS.
- [ ] **Step 5: Commit.** `feat(server): per-world Postgres schema and bucket housekeeping`.

### Task 4: VLM's Hyperfy image

**Files:**
- Modify: `infra/hyperfy/patches/0001-script-websockets.patch`. Regenerate it from PR hyperfy-xyz/hyperfy#167's two commits (9c9e618 and cee496a), so it includes the reconnect fix.
- Create:
  - `infra/hyperfy/patches/0002-vlm-app.patch`. It adds `src/server/vlm.js`, called at the end of `src/server/db.js` migrations: read `/app/vlm/vlm.hyp`, upload its assets with `assets.upload`, upsert blueprint `vlm` (props `feedUrl` from `VLM_FEED_URL` and `worldKey` from `VLM_WORLD_KEY`), and ensure exactly one entity of blueprint `vlm` at the origin.
  - `infra/hyperfy/Dockerfile`. It clones Hyperfy at `b4081eb`, applies the patches in order, runs `npm ci` and `npm run build`, and copies `packages/vlm-hyperfy-app/dist/vlm.hyp` to `/app/vlm/vlm.hyp`. It runs `node build/index.js` on port 3000.
  - `infra/hyperfy/build.sh` (builds and pushes `registry.fly.io/vlm-hyperfy-image:<git short sha>`).
  - `infra/hyperfy/test-world.mjs` (the local check below).
  - Update `infra/hyperfy/patches/README.md`.
- Test: `infra/hyperfy/test-world.mjs`. It runs the patched Hyperfy source locally with `ASSETS=local` and the sqlite DB, as in project 1's spike.

**Interfaces:**
- Consumes: `dist/vlm.hyp` (project 1). Hyperfy's env from the spec, set by Task 6.
- Produces: an image whose world shows the VLM app pointed at `VLM_FEED_URL` with `VLM_WORLD_KEY`, and keeps Hyperfy's default `$scene`.

- [ ] **Step 1: Write `test-world.mjs`**, asserting through the world's sqlite DB and a headless Chrome DevTools probe (reuse project 1's `probe.mjs` approach):
  - `fresh boot: blueprint vlm exists with the env's feedUrl and worldKey, one vlm entity, $scene is the default`;
  - `second boot with a new VLM_WORLD_KEY: blueprint vlm props updated, still one entity, user-built apps untouched`;
  - `the vlm app's assets are served by the world`.
- [ ] **Step 2: Run it against unpatched source.** → FAIL (no `vlm` blueprint).
- [ ] **Step 3: Write the patches, the Dockerfile and `build.sh`.**
- [ ] **Step 4: Run `test-world.mjs` against the patched source.** → PASS. Then run `docker build -f infra/hyperfy/Dockerfile .` → success. Don't push; the push happens in Task 11.
- [ ] **Step 5: Commit.** `feat(infra): VLM Hyperfy world image with the VLM app built in`.

### Task 5: The `worlds.vlm.gg` router

**Files:**
- Create: `infra/hyperfy-router/server.mjs` (no dependencies, Node 22), `infra/hyperfy-router/fly.toml` (app `vlm-worlds-router`, `iad`, always on, one machine), `infra/hyperfy-router/Dockerfile`, `infra/hyperfy-router/server.test.mjs` (run with `node --test`)

**Interfaces:**
- Produces: `replayTarget(host: string, domain: string): string | null` → `vlm-w-<slug>` for a valid `<slug>.<domain>` (the slug rule from "Fixed values"), otherwise null. The server answers `fly-replay: app=<target>` with an empty 307 for any method, upgrades included. An unknown host gets 404 with a short HTML page ("No world here").

- [ ] **Step 1: Write the failing tests:**
  - `valid slug host maps to vlm-w-<slug>`;
  - `apex, nested subdomain, bad characters, other domains → null`;
  - `a WebSocket upgrade request gets the replay header without being upgraded`.
- [ ] **Step 2: Run them.** `node --test infra/hyperfy-router/` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** → PASS.
- [ ] **Step 5: Commit.** `feat(infra): worlds.vlm.gg router using fly-replay`.

### Task 6: Hosting: create, destroy, switch, rotate

**Files:**
- Create: `apps/server/src/hyperfy/hosting.ts`
- Modify: `apps/server/src/services/hyperfy/infrastructure.ts` (keep only `hyperfyHosting()`, with the env check from "Server environment"). Delete `services/hyperfy/provisioner.ts` and the providers, and update their importers.
- Test: `apps/server/test/hyperfy-hosting-worlds.test.ts`

**Interfaces:**
- Consumes: `FlyApi` (Task 2), `createWorldDatabase`/`dropWorldDatabase`/`deleteWorldFiles` (Task 3), `hostedWorldSlots` (Task 1), `createWorldKey` (project 1).
- Produces, with every dependency injectable for tests (`deps?: Partial<HostingDeps>`):
  - `createHostedWorld(input: { ownerId: string; sceneId: string; name: string; endsAt: Date | null }): Promise<{ world: HyperfyWorldSummary; adminCode: string }>`. Steps, in order:
    1. Slot check and row insert (status `provisioning`, slug, address) in one transaction that takes a per-owner advisory lock.
    2. Return at once.
    3. Finish in the background: world database, Fly app, IPs (`.fly.dev` worlds only), then a machine with this env:
       - `PORT=3000`, `WORLD=world`;
       - `PUBLIC_WS_URL=wss://<address>/ws`, `PUBLIC_API_URL=https://<address>/api`;
       - `ASSETS=s3`, `ASSETS_S3_URI=<base>/<slug>/`, `ASSETS_BASE_URL=<cdn>/<slug>`;
       - `DB_URI`, `DB_SCHEMA=world_<slug>`;
       - `JWT_SECRET` (random), `ADMIN_CODE`, `SAVE_INTERVAL=60`, `CLEAN=true`;
       - `PUBLIC_SCRIPT_WEBSOCKET_ORIGINS=wss://api.vlm.gg`;
       - `VLM_FEED_URL` (the server's public API URL), `VLM_WORLD_KEY`.
    4. Wait for health, then set status `running`. On any failure: clean up, status `failed`, `errorMessage`.
    - Address: `vlm-w-<slug>.fly.dev` when the owner's tier is creator, `<slug>.<HYPERFY_ROUTER_DOMAIN>` for pro and up.
  - `destroyHostedWorld(worldId: string): Promise<void>`. Waits for any in-flight create of that world (an in-process map of promises), deletes the Fly app, drops the database, deletes the files, then deletes the row.
  - `switchHostedWorldScene(worldId: string, sceneId: string): Promise<void>`. Updates the row; the feed follows the key's scene, so no machine change is needed.
  - `rotateHostedWorldKey(worldId: string): Promise<{ key: string }>`. Sets the new hash, reads the machine's current env with `getMachineEnv`, replaces only `VLM_WORLD_KEY`, and calls `updateMachine`, which restarts it. No other secret is stored outside Fly.
  - `revealAdminCode(worldId: string): Promise<string>`.

- [ ] **Step 1: Write the failing tests** with fake `FlyApi`, database and bucket deps:
  - `create inserts provisioning, then running after health, with the exact env (no secrets in logs)`;
  - `creator gets a fly.dev address and public IPs; pro gets a worlds.vlm.gg address and no IPs`;
  - `create past the slot limit throws world_limit_reached and creates nothing`;
  - `two concurrent creates for the last slot: one succeeds, one gets world_limit_reached`;
  - `slug clash gets a -2 suffix`;
  - `a failure after the app exists cleans up the app, schema and files and marks the world failed`;
  - `destroy during provisioning leaves no Fly app, schema or row`;
  - `rotate updates the machine env and old key stops working`;
  - `admin code is stored encrypted and revealed only by revealAdminCode`.
- [ ] **Step 2: Run them.** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, then the server suite.** → PASS.
- [ ] **Step 5: Commit.** `feat(server): provision VLM-hosted Hyperfy worlds on Fly`.

### Task 7: Hosted world routes

**Files:**
- Modify: `apps/server/src/routes/hyperfy-worlds.ts`:
  - `POST /api/hyperfy/worlds` takes `kind?: 'self' | 'hosted'`, defaulting to `'self'`, and `endsAt?: string | null`.
  - `kind 'hosted'` requires `hyperfyHosting().available`, else 503 `hyperfy_hosting_unavailable`. Over the slot limit it gets 403 `world_limit_reached` with `{ used, limit }`. It returns 202 `{ world, adminCode }`.
  - `PATCH /api/hyperfy/worlds/:id` with `{ endsAt?: string | null; sceneId?: string }`. `endsAt` is editable only before it passes and must be in the future. A `sceneId` must be another scene the caller has full access to.
  - `POST /:id/restore` brings back an ended world within its 30 days if a slot is free: it starts its machines and sets status `running` with `endsAt` null. Otherwise it gets 403 `world_limit_reached`.
  - `POST /:id/admin-code` returns `{ adminCode }`.
  - `DELETE /:id` calls `destroyHostedWorld` for hosted worlds.
  - `rotate-key` calls `rotateHostedWorldKey` for hosted worlds.
  - `GET /api/hyperfy/slots` returns `{ used, limit, hostingAvailable }`.
- Modify: `apps/server/src/routes/deploy.ts`. Remove the Hyperfy provision, redeploy, destroy, status and logs paths. Keep `GET /api/deploy/platforms`.
- Test: `apps/server/test/hyperfy-worlds.test.ts` (extend), `test/cross-account-walk.test.ts` (new `:id` routes)

**Interfaces:**
- Consumes: Task 6.
- Produces: the routes above, all `authenticate` plus full scene access. Only creating a hosted world also needs `requireFeature('deployment')`, as project 1 left it for self-run.

- [ ] **Step 1: Write the failing tests:**
  - `hosted create is 503 when hosting is unavailable and self-run still works`;
  - `hosted create returns 202 with the admin code once; list never has it`;
  - `world_limit_reached carries used and limit`;
  - `endsAt in the past is 400; clearing endsAt makes it permanent`;
  - `restore within 30 days with a free slot restarts it; without a slot is 403`;
  - `another user gets 404 on every :id route`.
- [ ] **Step 2: Run them.** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, then the server suite.** → PASS.
- [ ] **Step 5: Commit.** `feat(server): hosted Hyperfy world routes`.

### Task 8: The worlds sweep

**Files:**
- Create: `apps/server/src/hyperfy/sweep.ts`. Start it in `apps/server/src/index.ts` beside `startLifecycleSweep`, every 5 minutes.
- Test: `apps/server/test/hyperfy-sweep.test.ts`

**Interfaces:**
- Produces: `sweepHostedWorlds(now: Date, deps?): Promise<{ ended: number; purged: number; stuck: number }>`. Three passes:
  - **End:** for worlds with status `running` and `endsAt <= now`, a conditional `UPDATE … RETURNING` sets status `ended`, `endedAt` and `purgeAfter = now + 30 days`. Only the claimed rows have their machines stopped.
  - **Purge:** for status `ended` and `purgeAfter <= now`, it claims each row by setting `purgedAt`, then runs `destroyHostedWorld`.
  - **Stuck:** status `provisioning` older than 10 minutes becomes `failed`, with cleanup.
- Exports `startHostedWorldSweep(intervalMs: number): () => void`.

- [ ] **Step 1: Write the failing tests:**
  - `a running world past its end date ends, stops its machines and frees its slot`;
  - `concurrent sweeps end a world exactly once`;
  - `ended worlds are purged after 30 days, not before`;
  - `a world left in provisioning past the health wait is marked failed by the sweep`.
- [ ] **Step 2: Run them.** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, then the server suite.** → PASS.
- [ ] **Step 5: Commit.** `feat(server): end and purge temporary Hyperfy worlds`.

### Task 9: Dashboard: hosted worlds

**Files:**
- Modify: `apps/web/src/app/(dashboard)/deploy/page.tsx`. In "Your Hyperfy worlds":
  - When `hostingAvailable`, a "Create a hosted world" form with a name and an optional end date, plus a line "1 of 3 hosted worlds". When there are no slots left, the form is replaced by "You've used all your hosted worlds" with a link to plans.
  - Hosted rows show the address as a link, the status ("Setting up…", "Live", "Failed: <message>", "Ended. Restorable until <date>"), and the end date.
  - Actions: "Edit end date", "Make permanent", "Restore", "Show admin code", "New key", "Destroy" (with a confirm that says the world and everything built in it are deleted).
  - A one-time panel after create shows the admin code ("Type /admin <code> in the world's chat to build"), the address, and how long setup takes.
  - Rows in `provisioning` refresh every 5 s until they settle.
  - Remove the old hosted-deploy Hyperfy option.
- Modify: `apps/web/src/lib/api.ts`, `apps/web/src/lib/hyperfy.ts`
- Test: `apps/web/src/lib/hyperfy.test.ts`

**Interfaces:**
- Produces: `worldStatusLabel(w: HyperfyWorldSummary, now: Date): string` with the exact copy above, and `slotLine(used: number, limit: number): string` → `"1 of 3 hosted worlds"`, or `"1 hosted world"` when the limit is `Infinity`.

- [ ] **Step 1: Write the failing tests** for both helpers.
- [ ] **Step 2: Run them.** → FAIL.
- [ ] **Step 3: Implement** the helpers and the UI.
- [ ] **Step 4: Run them.** Run the web suite and `npx tsc --noEmit -p .` → pass.
- [ ] **Step 5: Commit.** `feat(web): create and manage hosted Hyperfy worlds`.

### Task 10: Docs and the setup runbook

**Files:**
- Create: `infra/hyperfy/SETUP.md`. In order:
  1. create the org and token;
  2. create the Managed Postgres (Basic plan, `iad`) and take its admin and pooled URLs;
  3. create the R2 bucket `vlm-hyperfy` with a bucket-scoped token, a CDN domain and CORS;
  4. add the DNS wildcard and the router's wildcard certificate;
  5. deploy the router;
  6. build and push the image;
  7. set the Railway env vars;
  8. verify.
- Modify: `apps/docs/src/content/docs/sdk/hyperfy/install.md`. Add a "Hosted worlds" section covering slots per plan, addresses, temporary worlds and the 30-day restore, the admin code, and that destroying deletes everything.

- [ ] **Step 1: Write both.**
- [ ] **Step 2: Commit.** `docs: hosted Hyperfy worlds and the hosting runbook`.

### Task 11: Bring up hosting and test a real world (run by the controller with the owner)

Each external step needs the owner's go-ahead (accounts, spend, DNS):
1. Follow `infra/hyperfy/SETUP.md` steps 1 to 6.
2. Set the Railway env vars on `vlm-server`.
3. Deploy the server.
4. Create a hosted world for a test scene from the dashboard.
5. Confirm, in headless Chrome:
   - it reaches `running` within 3 minutes;
   - the scene shows on first visit;
   - a dashboard edit appears within 2 s;
   - the world sleeps when idle and wakes on the next visit;
   - files uploaded in the world land under its prefix;
   - destroy removes the Fly app, schema and files and frees the slot;
   - a Pro test account gets a `worlds.vlm.gg` address that works, WebSockets included.

Record the results in the ledger.
