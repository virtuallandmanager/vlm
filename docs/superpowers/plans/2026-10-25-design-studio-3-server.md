# Design Studio Plan 3: the server core

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** VLM's server runs Design Studio designs end to end: it stores designs, pieces, revisions and the conversation, counts prompts against each plan's daily allowance, starts one Fly worker machine per design, implements the worker's side of `apps/studio-worker/CONTRACT.md`, keeps every file in a private R2 bucket, serves only render frames to the browser, and streams progress over the websocket.

**Architecture:**
- **A new `apps/server/src/studio/` module**, with one file per concern: the data (`schema` tables in `src/db/schema.ts`), the private store, the quota, the machines, applying a worker's result, and the sweep.
- **Two route files:**
  - `routes/studio-worker.ts` implements CONTRACT.md, authenticated by the per-design worker token;
  - `routes/studio.ts` is the dashboard's API, authenticated as the user.
- **Progress** reaches the page through a new Colyseus room, `vlm_studio`, fed from the existing presence bus.
- **One worker change carried from Plan 2:** a loopback proxy in the worker adds the API keys, so the agents never hold one.

**Tech Stack:** TypeScript, Fastify 5, Drizzle ORM on Postgres, Colyseus 0.15, `@aws-sdk/client-s3` against R2, the Fly Machines API (`src/hyperfy/fly.ts`), vitest with the real test database. The worker side is Python 3.11.

**Spec:** `docs/superpowers/specs/2026-10-24-design-studio-design.md`. Also read:
- the findings it rests on, `docs/superpowers/specs/2026-10-24-design-studio-spike-findings.md` (allowances, cost ceilings, machine size);
- the worker's contract, `apps/studio-worker/CONTRACT.md`. It is binding: the server implements exactly that, and Task 10 runs the real worker against it.

**Not in this plan:**
- **Plan 4 (payments):** finalize checkout, the finalize job, entitlements and GLB downloads, half-price revisions, mistake reports and refunds, prompt top-ups, and the checker gate on finalizing. Plan 4 extends `remainingPrompts` (Task 3) with top-up balances and adds `finalizedAt` to designs.
- **Plan 5 (the studio page):** all UI.
- **Plan 6 (the revision log admin page):** this plan stores everything that page lists.
- **Deploying:** creating the R2 bucket, Railway variables and the schema push are the owner's, after merge (README, Task 10).

## Global Constraints

- **Cloud only.** Every studio route answers 404 unless `config.studioEnabled`. That's `VLM_MODE=cloud` plus `STUDIO_WORKER_IMAGE` and `STUDIO_S3_URI` set; tests set it directly.
- **Agents:** `claude` (model `claude-opus-5-5`) and `codex` (model `gpt-6.1-sol`), overridable by `STUDIO_CLAUDE_MODEL` and `STUDIO_CODEX_MODEL`. `grok` is refused with 400 `"Grok is coming soon"`.
- **Allowances, per plan, in `TIER_LIMITS`:**

  | Plan | `studioPromptsPerDay` | `studioDailyCostCeilingUsd` (hidden) | `studioOpenDesigns` |
  |---|---|---|---|
  | free | 3 | 6 | 1 |
  | creator | 15 | 30 | Infinity |
  | pro | 40 | 75 | Infinity |
  | studio | 100 | 200 | Infinity |
  | enterprise | 300 | 600 | Infinity |

  Enterprise's numbers are a call ("custom" in the spec); they are settings.
- **Per-prompt limits** sent in every prompt job: `{timeoutSec: 1500, maxTurns: 80, costCeilingUsd: 3}`.
- **Days are UTC.** The allowance resets at 00:00 UTC.
- **A prompt counts when it is accepted** (job created). It is given back when the job ends in `error` or is lost (Task 8). The outcomes `ok`, `needs_input`, `no_change`, `ceiling` and `timeout` keep it.
- **Continuing after `ceiling`** is `POST …/prompts {continue: true}`. It sends `"Continue where you stopped."`, doesn't count against the allowance, and is still subject to the daily cost ceiling.
- **The browser never receives** a GLB, `.blend`, `piece.json`, checker report or workspace. Only `renders/…/*.webp` frames are served to it, through short-lived signed URLs.
- **Files live in a private R2 bucket** (`STUDIO_S3_URI`, `s3://<key>:<secret>@<account>.r2.cloudflarestorage.com/<bucket>`, as `HYPERFY_ASSETS_S3_URI` is), never in the public `createStorage()` bucket. Keys:
  - `designs/<designId>/workspace.tar.gz`
  - `designs/<designId>/jobs/<jobId>/<path>`, where `<path>` is the contract's file path.
- **Worker machines:**
  - app `STUDIO_FLY_APP` (default `vlm-studio-worker`), in org `config.flyWorldsOrg`, with token `config.flyApiToken`;
  - image `STUDIO_WORKER_IMAGE` (today `registry.fly.io/vlm-studio-worker:d7a45d5`);
  - size `performance-4x` (`cpu_kind: 'performance', cpus: 4, memory_mb: 8192`), region `iad`, restart policy `no`, no services;
  - name `design-<designId>`, env `VLM_API_URL=config.publicUrl`, `STUDIO_WORKER_TOKEN`, `STUDIO_DESIGN_ID`, `STUDIO_IDLE_EXIT_SEC=600`. The agent keys are app secrets, never in machine env.
- **The worker token** is 32 random bytes, base64url, made when a machine is created. Only its SHA-256 is stored. It is never logged and never returned by a user route.
- **Worker file uploads:** a path must match `^(pieces/[a-z_]+/[A-Za-z0-9._-]+\.(glb|json)|checks/[a-z_]+\.txt|renders/[a-z_]+/[a-z0-9-]+/[0-9]{3}\.webp)$`, contain no `..` segment, and be at most 200 characters. Body limits: 50 MB per file, 1 GB per workspace.
- **Timeouts:**
  - a taken job with no result after its `limits.timeoutSec` (renders: 300 s) plus 15 minutes is lost;
  - a queued job not taken within 10 minutes is lost (the machine never started);
  - a design's machine is destroyed after 3 days without a job.
- **Tests:** `pnpm --filter vlm-server test` with the real test database (`TEST_DATABASE_URL`). Fly, R2 and the clock are injected fakes. Python worker tests: `python3 -m pytest -q apps/studio-worker/tests`.

## Review Focus

1. **Two prompts sent at once, or a prompt sent while one is running.** Exactly one is accepted; the other gets 409, and only one prompt is counted. Test: `concurrent prompts accept one and count one` (Task 6).
2. **A worker posts the same result twice** (its retry after a lost response). The second post changes nothing: no second revision, no second refund, no second message. Test: `result is idempotent` (Task 5).
3. **A worker token for design A used on design B's routes or jobs.** 403 everywhere, including `jobs/{jobId}` routes for B's jobs. Test: `token only works for its own design` (Task 5).
4. **The machine never starts, or dies mid-prompt.** The job is failed with a plain error, the prompt is given back, and the page hears about it. The design isn't stuck "building" forever. Tests: `start failure fails the job and refunds` (Task 6) and `lost jobs are failed and refunded` (Task 8).
5. **A signed render URL reused for another design's frame, after expiry, or for a non-render file.** 403 every time, and no route takes a `pieces/` or `checks/` path from a browser. Test: `render urls only open their own frame` (Task 6).

---

### Task 1: Data, config and plan limits

**Files:**
- Modify: `apps/server/src/db/schema.ts` (new section `// ── Design Studio ──`)
- Modify: `apps/server/src/config.ts`
- Modify: `apps/server/src/integrations/stripe.ts` (`TierLimits`, `TIER_LIMITS`)
- Create: `apps/server/test/studio-schema.test.ts`

**Interfaces:**
- Produces these tables, all with `uuid` ids (`defaultRandom()`) and `created_at timestamptz default now()`:
  - **`studio_designs`:** `owner_id` → users (cascade), `name text`, `kind text` (`wearable` | `emote`), `agent text` (`claude` | `codex`), `status text default 'idle'` (`idle` | `building`), `archived_at`, `last_job_at`, `machine_id text`, `machine_claimed_at`, `worker_token_hash text unique`. Index on `owner_id`.
  - **`studio_pieces`:** `design_id` (cascade), `category text`, `name text`, `latest_revision_id uuid` (nullable, no FK, to avoid a cycle). Unique `(design_id, category)`.
  - **`studio_revisions`:** `piece_id` (cascade), `number int`, `job_id`, `change_kind text`, `meta jsonb`, `checker jsonb` (`{pass, failures, warnings}`), `files jsonb` (contract paths). Unique `(piece_id, number)`.
  - **`studio_jobs`:** `design_id` (cascade), `type text` (`prompt` | `render`), `status text default 'queued'` (`queued` | `taken` | `done` | `failed`), `payload jsonb` (the contract Job without `jobId`), `result jsonb`, `counted boolean default false`, `counted_day date`, `taken_at`, `finished_at`. Index `(design_id, status, created_at)`. A partial unique index on `design_id` where `type = 'prompt' AND status IN ('queued', 'taken')` makes "one prompt at a time" hold in the database, not just in a check. The revision log (Plan 6) reads the request, agent, model, skills SHA and cost from a revision's job: `payload.prompt` and `result.{agent, model, skillsSha, costUsd}`.
  - **`studio_messages`:** `design_id` (cascade), `role text` (`user` | `agent` | `system`), `agent text`, `text text`, `job_id uuid`, `proposal jsonb`. Index `(design_id, created_at)`.
  - **`studio_renders`:** `revision_id` (cascade), `view_key text`, `job_id uuid`, `frames int default 0`, `status text` (`queued` | `ready` | `failed`). Unique `(revision_id, view_key)`.
  - **`studio_usage_days`:** `user_id` (cascade), `day date`, `prompts int default 0`, `cost_usd double precision default 0`. Primary key `(user_id, day)`.
- Produces config fields: `studioWorkerImage`, `studioS3Uri`, `studioFlyApp` (default `'vlm-studio-worker'`), `studioClaudeModel` (default `'claude-opus-5-5'`), `studioCodexModel` (default `'gpt-6.1-sol'`), `studioEnabled: boolean` (`mode === 'cloud' && !!studioWorkerImage && !!studioS3Uri`).
- Produces `TierLimits.studioPromptsPerDay`, `studioDailyCostCeilingUsd` and `studioOpenDesigns`, with the values in Global Constraints.

- [ ] **Step 1: Write the failing tests** in `test/studio-schema.test.ts`:
  - `studio tables accept a design with a piece, revision, job, message, render and usage day`: insert one of each through Drizzle and read them back.
  - `one piece per category per design`: a second `hat` piece for the same design throws a unique-violation.
  - `one open prompt job per design`: a second `queued` prompt job for the same design throws; a render job beside it doesn't.
  - `plan limits carry the studio allowances`: assert `TIER_LIMITS.free` has `{studioPromptsPerDay: 3, studioDailyCostCeilingUsd: 6, studioOpenDesigns: 1}`, `creator` 15/30, `pro` 40/75, `studio` 100/200, and `enterprise` 300/600.
- [ ] **Step 2: Run them to confirm they fail.** Run `pnpm --filter vlm-server exec vitest run test/studio-schema.test.ts`. Expected: import errors for the new tables.
- [ ] **Step 3: Implement the tables, config fields and limits.** Follow the `hyperfyWorlds` section's style: comments on non-obvious columns, indexes in the table callback. Add relations only where a later task queries through them (none needed).
- [ ] **Step 4: Run the server suite.** Run `pnpm --filter vlm-server test`. Expected: all pass (global setup pushes the new tables).
- [ ] **Step 5: Commit:** `feat(studio): design studio tables, config and plan allowances`

### Task 2: The private studio store and file paths

**Files:**
- Create: `apps/server/src/studio/store.ts`
- Create: `apps/server/test/studio-store.test.ts`

**Interfaces:**
- Produces:
  - `interface StudioStore { put(key: string, body: Buffer, contentType: string): Promise<void>; get(key: string): Promise<{ body: Buffer; contentType: string } | null>; deletePrefix(prefix: string): Promise<number> }`.
  - `r2StudioStore(uri = config.studioS3Uri): StudioStore`, parsing the URI as `r2S3Like` does in `src/hyperfy/worlds-bucket.ts`.
  - `localStudioStore(dir: string): StudioStore`, used by dev and Task 10's local e2e, when `STUDIO_S3_URI` starts with `file://`.
  - `memoryStudioStore(): StudioStore & { keys(): string[] }`, for tests.
  - `getStudioStore(): StudioStore`, which picks one of the three from `config.studioS3Uri` and is memoised; `setStudioStore(s)` is for tests.
  - `workspaceKey(designId: string): string` and `jobFileKey(designId: string, jobId: string, path: string): string`.
  - `checkFilePath(path: string): { ok: true; kind: 'piece' | 'check' | 'render'; category: string } | { ok: false; reason: string }`, enforcing the Global Constraints pattern.

- [ ] **Step 1: Write the failing tests:**
  - `file paths follow the contract`: these are accepted:
    - `pieces/hat/neon_cap_male.glb` (piece, `hat`)
    - `pieces/hat/piece.json`
    - `checks/hat.txt` (check)
    - `renders/hat/spin-male-outfit-2/007.webp` (render)

    These are refused, each with a reason:
    - `../x`
    - `pieces/hat/../../workspace.tar.gz`
    - `/pieces/hat/a.glb`
    - `pieces/hat/a.blend`
    - `renders/hat/spin/7.webp`
    - `checks/hat.txt/x`
    - `pieces/Hat/a.glb`
    - `pieces/hat/a b.glb`
    - a 201-character path
  - `memory and local stores round-trip and delete by prefix`: run for both `memoryStudioStore()` and `localStudioStore(tmpdir)`. Put two keys under `designs/d1/` and one under `designs/d2/`. `deletePrefix('designs/d1/')` returns 2, and the `d2` key is still readable. `get` of a missing key is `null`.
  - `local store refuses keys that escape its folder`: `put('../x', …)` rejects.
- [ ] **Step 2: Run them to confirm they fail.** Expected: import error.
- [ ] **Step 3: Implement `store.ts`.** `r2StudioStore` uses `PutObjectCommand`, `GetObjectCommand` (a `NoSuchKey` error means `null`), and `ListObjectsV2Command` plus `DeleteObjectsCommand` in batches of 1000, as `deleteWorldFiles` does.
- [ ] **Step 4: Run the suite.** Expected: all pass.
- [ ] **Step 5: Commit:** `feat(studio): private file store and the contract's file paths`

### Task 3: Prompt allowance and cost ceiling

**Files:**
- Create: `apps/server/src/studio/quota.ts`
- Create: `apps/server/test/studio-quota.test.ts`

**Interfaces:**
- Consumes `getSubscription(userId)` and `TIER_LIMITS` (Task 1).
- Produces:
  - `utcDay(now: Date): string`, as `YYYY-MM-DD`.
  - `promptStatus(userId: string, now: Date): Promise<{ plan: string; allowance: number; used: number; left: number; resetsAt: string; overCostCeiling: boolean }>`.
  - `reservePrompt(userId: string, now: Date, opts: { counted: boolean }): Promise<{ ok: true; day: string } | { ok: false; reason: 'allowance' | 'cost_ceiling' }>`. This is one atomic statement: upsert the day row, then increment `prompts` only while `prompts < allowance` (when counted) and `cost_usd < ceiling`.
  - `refundPrompt(userId: string, day: string): Promise<void>`, which never goes below 0.
  - `recordCost(userId: string, day: string, costUsd: number): Promise<void>`.
  - `remainingPrompts` is `promptStatus().left`. Plan 4 adds top-ups here.
- `config.allFeaturesUnlocked` doesn't lift the studio allowance: it runs on VLM's paid keys.

- [ ] **Step 1: Write the failing tests:**
  - `free plan gets three prompts a day`: three `reservePrompt(counted)` calls succeed, the fourth gives `{ok: false, reason: 'allowance'}`, and `promptStatus().left` is 0.
  - `the allowance resets at midnight UTC`: three on `2026-10-25T23:59:00Z`, then one more at `2026-10-26T00:00:01Z` succeeds. `resetsAt` is `2026-10-26T00:00:00.000Z` for the first day.
  - `concurrent reservations never pass the allowance`: `Promise.all` of 6 on a Free user gives exactly 3 `ok`.
  - `the hidden cost ceiling stops prompts, counted or not`: a Creator user with `recordCost(…, 30)` gets `{ok: false, reason: 'cost_ceiling'}` for both `counted: true` and `counted: false`.
  - `uncounted reservations don't use the allowance`: three counted, then one with `counted: false` succeeds, and `used` stays 3.
  - `refunds give a prompt back once and never go negative`: two refunds after one reservation leave `used` at 0.
  - `paid plans use their own allowance`: a `subscriptions` row with tier `pro` gives `allowance` 40.
- [ ] **Step 2: Run them to confirm they fail.** Expected: import error.
- [ ] **Step 3: Implement `quota.ts`.** Do the reservation as a single SQL statement: `INSERT … ON CONFLICT (user_id, day) DO UPDATE SET prompts = studio_usage_days.prompts + $inc WHERE <limits> RETURNING`. When there's no row returned, decide the reason from a follow-up read.
- [ ] **Step 4: Run the suite.** Expected: all pass.
- [ ] **Step 5: Commit:** `feat(studio): daily prompt allowance and hidden cost ceiling`

### Task 4: Worker machines on Fly

**Files:**
- Modify: `apps/server/src/hyperfy/fly.ts` (add worker machines)
- Create: `apps/server/src/studio/machines.ts`
- Create: `apps/server/test/studio-machines.test.ts`

**Interfaces:**
- Produces in `fly.ts`:
  - `type WorkerMachineSpec = { name: string; image: string; env: Record<string, string> }`;
  - `FlyApi.createWorkerMachine(app: string, m: WorkerMachineSpec): Promise<{ id: string }>`, with the Global Constraints body: no `services`, `restart: {policy: 'no'}`, `auto_destroy: false`, performance-4x guest;
  - `FlyApi.getMachineState(app: string, id: string): Promise<string | null>`, which is null on 404.
- Produces in `machines.ts`:
  - `type MachineDeps = { fly: Pick<FlyApi, 'createWorkerMachine' | 'getMachineState' | 'startMachine' | 'deleteMachine'>; now: () => Date }`, plus `machineDeps(): MachineDeps` from config.
  - `ensureWorker(designId: string, deps?: Partial<MachineDeps>): Promise<void>`. It throws `StudioMachineError` (with a plain message) when Fly fails.
  - `destroyWorker(designId: string, deps?: Partial<MachineDeps>): Promise<void>`, which clears `machine_id` and `worker_token_hash`.
  - `hashWorkerToken(token: string): string`, the SHA-256 hex.
- **How `ensureWorker` decides:**
  - **No machine:** claim the creation with `UPDATE studio_designs SET machine_claimed_at = now WHERE id = $1 AND machine_id IS NULL AND (machine_claimed_at IS NULL OR machine_claimed_at < now - 2 min) RETURNING`. Only the winner creates the machine, with a fresh token, and stores `machine_id` and `worker_token_hash`. A loser returns: the winner's machine will take the job.
  - **A machine exists:** read its state. `stopped` or `suspended` → `startMachine`. A start that fails with a Fly 412 or "already started" error is fine if the state now reads `started`. `null` (destroyed outside VLM) → clear it and create again. `started`, `starting` or `created` → nothing.

- [ ] **Step 1: Write the failing tests** with a fake Fly that records calls:
  - `creates one machine with the worker's env and a hashed token`:
    - `createWorkerMachine` is called once, with name `design-<id>`, the image from config, and env holding `VLM_API_URL`, `STUDIO_DESIGN_ID` and `STUDIO_IDLE_EXIT_SEC: '600'`;
    - `STUDIO_WORKER_TOKEN` is 43 base64url characters, and the row's `worker_token_hash` equals `hashWorkerToken(token)`;
    - the env holds neither `ANTHROPIC_API_KEY` nor `OPENAI_API_KEY`.
  - `concurrent ensureWorker creates once`: `Promise.all` of 5 calls gives exactly 1 `createWorkerMachine`.
  - `a stopped machine is started, a running one left alone`.
  - `a machine destroyed outside VLM is recreated`: `getMachineState` returns null, so a new machine and a new token are made.
  - `fly failure is a StudioMachineError with no token in its message`.
  - `destroyWorker deletes the machine and forgets the token`.
  - In `test/hyperfy-fly.test.ts` style, against a fake `fetch`: `createWorkerMachine sends a performance-4x machine with no services and no restart`.
- [ ] **Step 2: Run them to confirm they fail.** Expected: import errors.
- [ ] **Step 3: Implement the Fly methods and `machines.ts`.**
- [ ] **Step 4: Run the suite.** Expected: all pass, `hyperfy-fly.test.ts` included.
- [ ] **Step 5: Commit:** `feat(studio): one Fly worker machine per design, started on demand`

### Task 5: The worker routes (CONTRACT.md) and applying results

**Files:**
- Create: `apps/server/src/studio/events.ts`
- Create: `apps/server/src/studio/results.ts`
- Create: `apps/server/src/routes/studio-worker.ts`
- Modify: `apps/server/src/app.ts` (register it)
- Create: `apps/server/test/studio-worker-routes.test.ts`
- Create: `apps/server/test/helpers/studio.ts` (factories: `createDesign(user, opts)`, `issueWorker(design) → token`, `queueJob(design, payload)`)

**Interfaces:**
- Consumes `checkFilePath`, `jobFileKey`, `workspaceKey`, `getStudioStore` (Task 2), `refundPrompt` and `recordCost` (Task 3), and `hashWorkerToken` (Task 4).
- Produces in `events.ts`:
  - `studioTopic(designId: string): string`, which is `studio:<designId>`;
  - `publishStudio(designId: string, e: StudioEvent): Promise<void>`, over the presence bus; it never throws;
  - `type StudioEvent = { type: 'progress'; jobId: string; text: string } | { type: 'phase'; jobId: string; phase: string } | { type: 'job'; jobId: string; status: 'queued' | 'taken' | 'done' | 'failed'; outcome?: string; error?: string }`. A `job` event with `done` or `failed` tells the page to re-read the design.
- Produces in `results.ts`: `applyResult(jobId: string, result: ContractResult, now: Date): Promise<'applied' | 'already'>`. In one transaction, it claims the job with `UPDATE studio_jobs SET status = …, result = …, finished_at = now WHERE id = $1 AND status = 'taken' RETURNING`. If no row comes back, it returns `'already'`. Then:
  - **Prompt job:**
    - It adds the agent's message, with `reply` and `proposal`.
    - For each result piece whose `files` is non-empty, it upserts `studio_pieces` (by category, name from `meta.name`) and inserts revision `number = previous + 1`, with `change_kind`, `meta`, `checker` and `files`. It sets `latest_revision_id`, then adds a `ready` `studio_renders` row for each `renders` entry with frames > 0.
    - It calls `recordCost(owner, counted_day ?? utcDay(now), costUsd ?? 0)`.
    - On outcome `error` with `counted`, it refunds the prompt.
  - **Render job:** it sets each `studio_renders` row for this job to `ready` with its frames, or `failed`.
  - **Both:** it sets the design's `status` to `idle` when no other prompt job is queued or taken. After commit, it publishes `{type: 'job', status, outcome, error}`.
- **The routes** are the contract's, under `/api/studio/worker`, each with a `preHandler` that authenticates the worker. It hashes the Bearer token and finds the design by `worker_token_hash`; for `/jobs/{jobId}/…` routes the job's `design_id` must be that design. Answers: 401 with no or unknown token, 403 for another design's design or job.
  - `GET /designs/:designId/workspace` streams the stored tar.gz, or 404.
  - `PUT /designs/:designId/workspace`: `application/gzip`, `bodyLimit` 1 GB, stored at `workspaceKey`.
  - `GET /designs/:designId/jobs/next` claims the oldest queued job with `UPDATE … WHERE id = (SELECT id … WHERE design_id = $1 AND status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING`, publishes `{type: 'job', status: 'taken'}`, and returns the contract Job (`{jobId, ...payload}`), or 204.
  - `POST /jobs/:jobId/events` publishes `progress` or `phase`; other event types get 400. It's 204 and stores nothing.
  - `PUT /jobs/:jobId/files/*`: the wildcard is the contract path. A `checkFilePath` failure is 400 with the reason. Any content type is accepted (`addContentTypeParser('*', {parseAs: 'buffer'})` in this route's scope), `bodyLimit` is 50 MB, and the file is stored at `jobFileKey`. The job must be `taken`, or the answer is 409.
  - `POST /jobs/:jobId/result` calls `applyResult`, answering 204 for `applied` or `already`. A malformed Result is 400.

- [ ] **Step 1: Write the failing tests** with `memoryStudioStore` and the app from `testApp()`:
  - `token only works for its own design`: design A's token on B's workspace, jobs/next, and a B job's events/files/result gives 403 each time; no token or a wrong one gives 401.
  - `workspace round-trips and is private`: PUT then GET returns the same bytes; a new design's GET is 404.
  - `jobs/next hands each job out once, oldest first`: two queued jobs and three concurrent `jobs/next` give each job once and one 204; the jobs are now `taken`.
  - `file paths are checked`: `pieces/hat/../../x.glb` (sent URL-encoded) and `renders/hat/spin/1.webp` are 400; `pieces/hat/cap_male.glb` is 204 and stored at `designs/<d>/jobs/<j>/pieces/hat/cap_male.glb`; a file for a `done` job is 409.
  - `an ok prompt result makes revisions, renders and a reply`: with the CONTRACT.md Result example, the hat piece has revision 1 with the files and checker, a ready `spin-male-default` render with 36 frames, and the agent's message with the reply; the design is `idle`; the owner's usage day has `cost_usd` 0.74.
  - `a second prompt result makes revision 2`.
  - `no_change makes no revision`.
  - `an error result gives the prompt back`: a counted job's `error` outcome takes `used` from 1 to 0.
  - `result is idempotent`: the same Result posted twice gives one revision, one message, one refund, and 204 both times.
  - `progress events reach the bus`: subscribe a fake presence and assert `{type: 'progress', jobId, text}` is published on `studio:<designId>`.
- [ ] **Step 2: Run them to confirm they fail.** Expected: 404s and import errors.
- [ ] **Step 3: Implement `events.ts`, `results.ts` and `routes/studio-worker.ts`, and register it.** Validate the Result's shape by hand: `outcome` in the contract's six, `pieces` an array, every `files` entry passing `checkFilePath`. Swagger-hide these routes (`schema: { hide: true }`).
- [ ] **Step 4: Run the suite.** Expected: all pass.
- [ ] **Step 5: Commit:** `feat(studio): worker routes from the contract, private files and result handling`

### Task 6: The dashboard's studio API

**Files:**
- Create: `apps/server/src/studio/designs.ts` (queries and job creation the routes share)
- Create: `apps/server/src/studio/render-urls.ts`
- Create: `apps/server/src/routes/studio.ts`
- Modify: `apps/server/src/app.ts`
- Create: `apps/server/test/studio-routes.test.ts`

**Interfaces:**
- Consumes Tasks 2–5.
- **Routes,** under `/api/studio`, all `authenticate`d. A design route for a design you don't own is 404, never 403.
  - `GET /usage` → `{plan, promptsLeft, allowance, resetsAt, openDesigns, openDesignLimit}`.
  - `POST /designs {kind: 'wearable'|'emote', agent: 'claude'|'codex'|'grok', name?}` → 201 with the design. Responses:
    - `grok` → 400 `"Grok is coming soon"`;
    - over `studioOpenDesigns` → 403 `{code: 'open_design_limit'}`.
  - `GET /designs?archived=true|false`: the owner's designs, newest first.
  - `GET /designs/:id` →
    - `{design, pieces: [{id, category, name, revision: {number, changeKind, checker, createdAt}, renders: {[viewKey]: {status, frames, urls: string[]}}}], messages, activeJob: {id, type, status} | null}`;
    - `urls` are signed frame URLs, made only for `ready` renders of each piece's latest revision.
  - `PATCH /designs/:id {name?, agent?, archived?: boolean}`. Unarchiving is checked against `studioOpenDesigns`.
  - `POST /designs/:id/prompts {text?: string, selectedSlots?: string[] | null, continue?: true}` → 202 `{jobId}`. The rules:
    - `text` is 1–4000 characters unless `continue`;
    - `selectedSlots` must be wearable categories, only for a `wearable` design;
    - `continue` is allowed only when the latest prompt job's outcome was `ceiling`, else 409;
    - another prompt job `queued` or `taken` → 409 `{code: 'busy'}`;
    - quota refusal → 429 `{code: 'allowance' | 'cost_ceiling', resetsAt}`;
    - an archived design → 409.
  - **Prompt order,** in one transaction:
    1. reserve the prompt (`counted: !continue`);
    2. insert the user's message;
    3. insert the job (payload `{type: 'prompt', kind, agent, model, prompt, selectedSlots, limits, render: null}`, `counted`, `counted_day`);
    4. set the design to `building` and `last_job_at`.
    5. After commit, `ensureWorker`. If that throws, fail the job with `"The studio machine could not start; your prompt was not counted."`, refund, add a `system` message, set the design `idle`, and publish. The route still answers 202, and the page hears the failure.
  - `POST /designs/:id/renders {category, bodyShape: 'male'|'female', outfit: 'default'|'outfit-2'|'outfit-3', emote: null|'idle'|'wave'|'dance'|'clap'|'walk'}` → 200:
    - when that view's render for the piece's latest revision is `ready`, `{status: 'ready', frames, urls}`;
    - when it's `queued`, `{status: 'queued'}`;
    - otherwise it inserts a `queued` render row and a render job (`render: {categories: [category], bodyShape, outfit, emote}`), runs `ensureWorker`, and returns `{status: 'queued'}`.
    - Render jobs don't count prompts.
    - The view key is the contract's, `<mode>-<bodyShape>-<outfit>[-<emote>]`, with mode `emote` for an emote design and `spin` otherwise. One function, `viewKey(kind, view)` in `designs.ts`, makes it for both the render rows and the job.
  - `GET /render-frames/:token`: no `authenticate`, because the token is the authority. It serves the frame's bytes (`image/webp`, `Cache-Control: private, max-age=3600`), or 403.
- **Render URLs:** `signRenderFrame({designId, revisionId, viewKey, frame, jobId}, expiresAt: Date): string` returns `<publicUrl>/api/studio/render-frames/<token>`, and `verifyRenderFrame(token, now)` returns those fields or null. The token is base64url JSON plus an HMAC-SHA256 under `config.jwtSecret`. It expires one hour after signing. The store key is always built from the verified fields as `jobFileKey(designId, jobId, renders/<category>/<viewKey>/<nnn>.webp)`, so no token can name any other kind of file.
- Prompt jobs build the model from `config.studioClaudeModel` or `studioCodexModel`, and the limits from Global Constraints.

- [ ] **Step 1: Write the failing tests** with the fake Fly from Task 4 and `memoryStudioStore`:
  - `studio routes are 404 when the studio is off`.
  - `creating designs respects the agent list and the open-design limit`: grok 400; a Free user's second open design 403; archiving the first allows a second.
  - `a prompt is queued, counted and starts the worker`: 202, the job's payload matches the contract (model `claude-opus-5-5`, limits `{1500, 80, 3}`), `promptsLeft` drops by one, `createWorkerMachine` was called, and the design is `building`.
  - `concurrent prompts accept one and count one`: two parallel POSTs give one 202 and one 409, with `used` 1. The loser's transaction rolls back its reservation when the partial unique index refuses its job.
  - `the fourth free prompt of the day is refused`: 429 `allowance`, with `resetsAt` at the next UTC midnight.
  - `continue is free and only follows a ceiling`: `continue` after an `ok` outcome is 409. After a `ceiling` outcome, it's 202, its job text is `"Continue where you stopped."`, and `used` is unchanged.
  - `start failure fails the job and refunds`: the fake Fly throws on create. The response is 202, the job is `failed`, `used` is back to 0, there's a system message, and the design is `idle`.
  - `render requests reuse a ready render and queue a missing one`.
  - `design detail shows renders with signed urls and never file paths`: the JSON has no `pieces/` or `checks/` strings.
  - `render urls only open their own frame`:
    - a valid URL serves the stored bytes;
    - a token with its `frame` edited is 403;
    - an expired one is 403;
    - one whose `jobId` belongs to another design is 403, because the verified `designId` must own that job.
  - `designs of other users are 404`.
- [ ] **Step 2: Run them to confirm they fail.** Expected: 404s.
- [ ] **Step 3: Implement `designs.ts`, `render-urls.ts` and `routes/studio.ts`, and register them.**
- [ ] **Step 4: Run the suite.** Expected: all pass.
- [ ] **Step 5: Commit:** `feat(studio): dashboard API for designs, prompts, renders and usage`

### Task 7: Live progress over the websocket

**Files:**
- Create: `apps/server/src/ws/VLMStudioRoom.ts`
- Modify: `apps/server/src/index.ts` (`gameServer.define('vlm_studio', VLMStudioRoom).filterBy(['designId'])`)
- Modify: `apps/server/test/helpers/game-server.ts` (define the room; add `joinStudio(url, designId, token)`, modelled on `joinScene`)
- Create: `apps/server/test/studio-room.test.ts`

**Interfaces:**
- Consumes `studioTopic` and `StudioEvent` (Task 5).
- **The room:**
  - `onAuth` uses `VLMCommandCenterRoom`'s rule: account sessions only, verified, and the user must own the design (else `Unauthorized`).
  - `onCreate` subscribes to `studioTopic(designId)` on the presence and broadcasts each event as message type `studio_event`. `onDispose` unsubscribes.
  - Clients send nothing.

- [ ] **Step 1: Write the failing tests:**
  - `the owner hears progress, phases and job changes`: join, then a worker `POST …/events` (through the app, with a real token from `issueWorker`) and a result arrive as `studio_event` messages, in order.
  - `other users can't join a design's room`: the join rejects.
  - `scene passes and guests can't join`.
- [ ] **Step 2: Run them to confirm they fail.** Expected: the room isn't defined.
- [ ] **Step 3: Implement the room.**
- [ ] **Step 4: Run the suite.** Expected: all pass.
- [ ] **Step 5: Commit:** `feat(studio): live progress for a design over the websocket`

### Task 8: The studio sweep

**Files:**
- Create: `apps/server/src/studio/sweep.ts`
- Modify: `apps/server/src/index.ts` (start it next to the hosted-world sweep when `config.studioEnabled`, every 60 s)
- Create: `apps/server/test/studio-sweep.test.ts`

**Interfaces:**
- Produces `sweepStudio(now: Date, deps?: Partial<MachineDeps>): Promise<{ lost: number; destroyed: number }>`. Each transition is a conditional `UPDATE … RETURNING`, so two servers claim each job once.
  - **Lost taken jobs:** `taken_at` older than `limits.timeoutSec` (renders 300) plus 15 min. The job is set `failed` with result `{outcome: 'error', error: 'The studio machine stopped responding.'}`, and a counted prompt is refunded. The page gets a `system` message and `{type: 'job', status: 'failed'}`, and the design goes `idle` if nothing else is queued.
  - **Lost queued jobs:** `created_at` older than 10 min. Same handling, with `'The studio machine did not start.'`.
  - **Idle machines:** designs with a `machine_id` whose `last_job_at` is older than 3 days, and no queued or taken job, go to `destroyWorker`.

- [ ] **Step 1: Write the failing tests:**
  - `lost jobs are failed and refunded`: a counted taken prompt job 26 min old (1500 s + 15 min = 40 min, so not yet), then 41 min old (lost). Only the second sweep fails it. `used` drops by one, and a later worker result for it gets `'already'`.
  - `a queued job nobody took is failed after 10 minutes`.
  - `idle machines are destroyed after three days, busy ones never`.
  - `two sweeps at once fail each job once`: `Promise.all` of two sweeps gives `lost` totals summing to the job count, and one refund each.
- [ ] **Step 2: Run them to confirm they fail.** Expected: import error.
- [ ] **Step 3: Implement `sweep.ts` and start it.**
- [ ] **Step 4: Run the suite.** Expected: all pass.
- [ ] **Step 5: Commit:** `feat(studio): sweep lost jobs and idle machines`

### Task 9: The worker's key proxy (agents never hold a key)

**Files:**
- Create: `apps/studio-worker/studio_worker/keyproxy.py`
- Modify: `apps/studio-worker/studio_worker/agent.py` (`agent_env`)
- Modify: `apps/studio-worker/entrypoint.sh`
- Modify: `apps/studio-worker/Dockerfile` (a `keyproxy` system user)
- Create: `apps/studio-worker/tests/test_keyproxy.py`
- Modify: `apps/studio-worker/tests/test_agent.py`
- Modify: `apps/studio-worker/e2e/network_checks.sh`

**Interfaces:**
- **`keyproxy.py`:**
  - `serve(port: int, upstream: str, header: str, key: str, proxy: str | None) -> ThreadingHTTPServer`, bound to 127.0.0.1.
  - Every request is forwarded to `upstream` (`https://api.anthropic.com` or `https://api.openai.com`) with the same method, path, query and body.
  - It strips the client's `x-api-key` and `authorization` headers, and sets the real one: for Anthropic `x-api-key: <key>`, for OpenAI `authorization: Bearer <key>`.
  - Upstream goes through `proxy` (tinyproxy) with `HTTPSConnection.set_tunnel`.
  - The response is streamed back chunk by chunk (`read1`), with no buffering, so server-sent events arrive as they're sent.
  - It never logs a request or a header.
  - `main()` runs both: Anthropic on 8890 and OpenAI on 8891, with keys from its env.
- **`agent_env` now gives:**
  - **Claude:** `ANTHROPIC_BASE_URL=http://127.0.0.1:8890` and `ANTHROPIC_API_KEY=studio-proxy`.
  - **Codex:** `CODEX_API_KEY=studio-proxy`, and `CODEX_HOME/config.toml` written by `run_agent` with:

    ```toml
    model_provider = "studio"

    [model_providers.studio]
    name = "studio"
    base_url = "http://127.0.0.1:8891/v1"
    env_key = "CODEX_API_KEY"
    wire_api = "responses"
    ```

  - Neither real key is in any agent's env.
- **`entrypoint.sh`** starts `runuser -u keyproxy -- env -i ANTHROPIC_API_KEY=… OPENAI_API_KEY=… HTTPS_PROXY=… PYTHONPATH=/opt python3 -m studio_worker.keyproxy &` after tinyproxy, and waits for both ports. The `keyproxy` user's traffic goes through tinyproxy like everyone's, so nftables doesn't change.

- [ ] **Step 1: Write the failing tests:**
  - `test_proxy_swaps_the_key`: a fake upstream (a local HTTP server, with `upstream='http://127.0.0.1:<port>'` and `proxy=None`) receives `x-api-key: real-key` when the client sent `x-api-key: studio-proxy`, and never sees `studio-proxy`.
  - `test_proxy_streams_without_buffering`: the fake upstream sends `data: 1`, sleeps 1 s, then sends `data: 2`. The client reads `data: 1` within 0.5 s.
  - `test_proxy_passes_status_and_body`: a 429 with a JSON body comes back unchanged.
  - Update `test_agent_env_has_only_its_key` → `test_agent_env_holds_no_real_key`:
    - neither env contains `sk-ant` or `sk-oai` anywhere;
    - Claude has `ANTHROPIC_BASE_URL == 'http://127.0.0.1:8890'`;
    - after `run_agent` with the Codex fake, `CODEX_HOME/config.toml` contains `base_url = "http://127.0.0.1:8891/v1"`.
- [ ] **Step 2: Run them to confirm they fail.** Run `python3 -m pytest -q apps/studio-worker/tests`. Expected: an import error for `keyproxy`, and the env assertion failing.
- [ ] **Step 3: Implement `keyproxy.py`, the env change, the entrypoint and the Dockerfile user.**
- [ ] **Step 4: Run the suite.** Expected: all pass.
- [ ] **Step 5: Check it with real agents.**
  - Add to `e2e/network_checks.sh`: `runuser -u agent -- cat /proc/$(pgrep -u keyproxy -f keyproxy)/environ` fails, and `runuser -u agent -- env | grep -c sk-` is 0.
  - Run `bash apps/studio-worker/e2e/network.sh`. Expected: all checks OK.
  - Run `e2e/real_prompt.py --agent claude --then codex`, as in Plan 2. Expected: `PASSED`. This spends about $0.60.
  - If Codex fails to reach the provider, read its error. The fallback is `OPENAI_BASE_URL=http://127.0.0.1:8891/v1` in its env; record which one worked.
- [ ] **Step 6: Commit:** `feat(studio-worker): a loopback key proxy so agents never hold an API key`

### Task 10: The real worker against the real server

**Files:**
- Create: `apps/studio-worker/e2e/drive_worker.py` (runs `jobs.main` with fake agent CLIs and a fake render, against `VLM_API_URL`)
- Create: `apps/server/test/studio-contract.test.ts`
- Create: `apps/server/scripts/studio-local.md`, the local recipe the next step follows
- Modify: `apps/studio-worker/README.md` and `apps/studio-worker/CONTRACT.md` (only if the run finds a disagreement; the contract stays the source of truth)
- Create: `apps/server/src/studio/README.md`: the owner's deploy steps
  - create the private R2 bucket `vlm-studio` and an access key scoped to it;
  - set `STUDIO_S3_URI`, `STUDIO_WORKER_IMAGE` and (if different) `STUDIO_FLY_APP` on Railway;
  - run the `drizzle-kit push`;
  - confirm `FLY_API_TOKEN` can manage `vlm-studio-worker` in `vlm-worlds`.

**Interfaces:**
- Consumes everything.

- [ ] **Step 1: Write the failing test.** `studio-contract.test.ts` → `the python worker completes a prompt and a render against the real routes` (skipped when `python3` is missing):
  1. Start the app on a real port with a memory store.
  2. Create a design, issue a worker token, and queue a prompt job and a render job.
  3. Spawn `python3 apps/studio-worker/e2e/drive_worker.py` with `VLM_API_URL`, `STUDIO_WORKER_TOKEN`, `STUDIO_DESIGN_ID` and `STUDIO_IDLE_EXIT_SEC=2`. It uses Plan 2's `tests/fakes/claude_builds_hat.jsonl` and a fake render writing 36 webp frames.
  4. Wait for exit 0. Assert:
     - the hat has revision 1, with the checker result;
     - `spin-male-default` is ready with 36 frames;
     - the render job's view is ready;
     - the workspace is stored;
     - the phases arrived on the bus in order.
- [ ] **Step 2: Run it to confirm it fails.** Expected: `drive_worker.py` is missing.
- [ ] **Step 3: Write `drive_worker.py`.** Fix any contract disagreement it finds in the server, unless the contract is wrong. Then change CONTRACT.md and the worker together, and ledger it.
- [ ] **Step 4: Run both suites.** Run `pnpm --filter vlm-server test` and `python3 -m pytest -q apps/studio-worker/tests`. Expected: all pass.
- [ ] **Step 5: Run the real worker image against a local server.**
  - Follow `studio-local.md`:
    - the server runs with `VLM_MODE=cloud`, `STUDIO_S3_URI=file:///tmp/studio-store` and `PUBLIC_URL=http://host.docker.internal:3010`;
    - a design and token are made with a script;
    - the worker image runs with `--cap-add NET_ADMIN --env-file apps/studio-worker/.env` and those three variables.
  - Send one real Codex prompt through `POST /api/studio/designs/:id/prompts`. That's brief 01 (about $0.15).
  - Expected:
    - the design reaches `idle` with a hat revision and 36 frames, all reachable through the signed URLs;
    - `GET /designs/:id` shows the reply;
    - the websocket carried the progress lines.
- [ ] **Step 6: Smoke the Fly lifecycle.**
  - Use a one-off `tsx` script, `apps/server/scripts/studio-fly-smoke.ts`, built on `machines.ts`.
  - It calls `ensureWorker` for a throwaway design row against the real Fly API, with `PUBLIC_URL=https://example.invalid`. The worker can't reach it and exits.
  - It waits for the state `stopped`, calls `ensureWorker` again (expect a start), then `destroyWorker`.
  - Expected: create, stop, start and destroy all succeed, and `fly machine list -a vlm-studio-worker` is empty after.
- [ ] **Step 7: Commit:** `test(studio): the real worker against the real server routes; deploy notes`
