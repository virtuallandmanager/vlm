# Virvi Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename VLM to Virvi across the monorepo (names, copy, logo, identifiers, default domains) on branch `feature/virvi-rename`, then roll it out to virvi.org in owner-approved steps.

**How it's built:**
- A guard script lists every remaining "vlm" in tracked files outside an explicit allowlist. Each code task drives its area of the repo to zero hits, so the guard is the failing test that each task turns green.
- Code tasks 1 to 14 are local only, merged locally.
- Rollout tasks R1 to R6 change production and external services. Each one needs the owner's go-ahead when it runs.

**Tech Stack:** pnpm 9 and turbo monorepo; Fastify, drizzle-orm 0.38 and drizzle-kit 0.31.11 (patched) on Postgres; Next.js (web); Astro Starlight (docs); Decentraland SDK7; Hyperfy; Kotlin/Gradle (Quest); xcodegen (ar-spike); Python (ring-marker); Railway, Fly.io and Cloudflare.

**Spec:** `docs/superpowers/specs/2026-10-25-virvi-rename-design.md`

## Global Constraints

### Names and copy

- **Clean break.** There are no compatibility shims, no dual-reading of old keys or prefixes, and no old room or event names kept alongside.
- **Name rules:**

  | Kind | Rule |
  |---|---|
  | Visible copy | "VLM" and "Virtual Land Manager" become "Virvi". Use a product name (Virvi OS, Studio, Drops, Events, AR, Sync) only where the feature clearly is that product. |
  | Identifiers | `VLM_*` becomes `VIRVI_*`, `vlm_*` becomes `virvi_*`, `vlm:*` becomes `virvi:*`, `vlm-*` becomes `virvi-*`, and `VLM*`/`Vlm*` types become `Virvi*`. |
  | Log prefixes | `[vlm-server]` becomes `[virvi-server]`, and `[VLM …]` becomes `[Virvi …]`. Same pattern for the rest. |
  | Prometheus metrics | `vlm_*` becomes `virvi_*`. |

- **Packages** (scope `@virvixr`):

  | Old name (old directory) | New name (new directory) |
  |---|---|
  | `vlm-shared` (`packages/vlm-shared`) | `@virvixr/shared` (`packages/shared`) |
  | `vlm-core` | `@virvixr/core` (`packages/core`) |
  | `vlm-client` | `@virvixr/client` (`packages/client`) |
  | `vlm-hud` | `@virvixr/hud` (`packages/hud`) |
  | `vlm-adapter-dcl` | `@virvixr/adapter-dcl` (`packages/adapter-dcl`) |
  | `packages/vlm-adapter-hyperfy` | `packages/adapter-hyperfy` |
  | `vlm-hyperfy-app` | `@virvixr/hyperfy-app` (`packages/hyperfy-app`). The app file becomes `virvi.hyp`. |
  | `vlm-dcl` (`packages/vlm-smart-item-dcl`) | `@virvixr/dcl` (`packages/dcl`). The CLI is `virvi-dcl`. |
  | `vlm-server`, `vlm-web`, `vlm-docs`, `vlm-streaming` | `@virvixr/server`, `@virvixr/web`, `@virvixr/docs`, `@virvixr/streaming` |
  | root `vlm` | root `virvi` |
  | `virvi-dcl-runtime` (`dcl-runtime/`) | unchanged |

  `vlm-adapter-hyperfy` has no package.json today, so only its directory moves.

- **Publishing:** only `@virvixr/dcl` is publishable. Every other package.json gets `"private": true`.

### Domains and IDs

- **Default domains:**

  | Old | New |
  |---|---|
  | `vlm.gg` | `virvi.org` |
  | `api.vlm.gg` | `api.virvi.org` |
  | `cdn.vlm.gg` | `cdn.virvi.org` |
  | `live.vlm.gg` | `live.virvi.org` |
  | `ingest.vlm.gg` | `ingest.virvi.org` |
  | `worlds.vlm.gg` | `worlds.virvi.org` |
  | `worlds-cdn.vlm.gg` | `worlds-cdn.virvi.org` |
  | `staging-api.vlm.gg` and `api.staging.vlm.gg` | `api.staging.virvi.org` |
  | `noreply@vlm.gg`, `support@vlm.gg` | `noreply@virvi.org`, `support@virvi.org` |

- **Quest:** `applicationId` and `namespace` are `org.virvi.ar`, the Kotlin package is `org.virvi.ar`, the label is "Virvi AR", and App Links use `https://virvi.org/s/`.
- **iOS/visionOS:** `org.virvi.ar.ios`, `org.virvi.ar.visionos` and `bundleIdPrefix: org.virvi.ar`. The display name is "Virvi AR" and the types are `VirviAR*`.

### Server, database and runtime

- **Server rules:**
  - The API key prefix is `virvi_k1_`.
  - Browser storage keys are `virvi_auth`, `virvi_pending_invite` and `virvi-dash-*`.
  - The Colyseus room names are `virvi_scene`, `virvi_command_center`, `virvi_studio`, `virvi_streams` and `virvi_device_auth`.
- **Database:**
  - `vlm_scene_id` becomes `virvi_scene_id` in `analytics_scenes` and `location_setups`.
  - The indexes `analytics_scenes_vlm_scene_idx` and `location_setups_vlm_scene_idx` become `analytics_scenes_virvi_scene_idx` and `location_setups_virvi_scene_idx`.
  - Renames happen in `apps/server/scripts/pre-push-upgrade.mjs`, idempotently, before `drizzle-kit push`.
- **DCL runtime:** rebuild with `VERSION=2 bash dcl-runtime/build.sh` and never hand-edit `apps/server/dcl-runtime/**`. `DCL_RUNTIME_VERSION = 2`, and `apps/server/dcl-runtime/1/` is deleted.

### Kept as-is (allowlisted in the guard)

- **Fly app and org names** (`vlm-w-<slug>` for all worlds, `vlm-worlds`, `vlm-worlds-router`, `vlm-worlds-pg`, `vlm-worlds-db-jobs`, `vlm-hyperfy-image`, `vlm-studio-worker`, `vlm-studio-spike`, `vlm-streaming`) and the R2 bucket `vlm-media`.
- **Local dev database names, users and passwords** (`vlm`, `vlm_test`, `vlm_dev`, `vlm_prod`, `vlm_main`, `vlm_next`).
- **The Quest keystore alias** `vlm-quest` and file `vlm-quest-release.jks`.
- **History and old names:**
  - `docs/superpowers/**` and the root `VLM_V2_*.md` files.
  - Old names inside the rename and rewrite code itself (Tasks 5 and 13).
  - The legacy GitHub repo names (`vlm-api`, `vlm-ui`, `vlm-jobs`, `vlm-scenes`, `vlm-dcl-qc`, `vlm-proxy`, `vlm-dcl-sdk6`, `vlm-dcl-sdk7`, `vlm-hyperfy-sdk2`).

### Process

- **Commits:** end every commit message with
  ```
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_018ds2NZXw5KLxDpVm9B3ABD
  ```
- **Tests:**
  - Run server tests against a private database: `TEST_DATABASE_URL=postgres://vlm:vlm_dev@localhost:5432/<private db>`. Another session uses `vlm_test`.
  - Never mutate the dev database `vlm`.
  - Every shell needs `export PATH=/opt/homebrew/bin:$PATH`.
- **Off limits:** billing code changes only by rename, never in behaviour.
- **Git:** never use bare `git stash`.

## Review Focus

1. **Prod boot over the old schema.** On a database that still has `vlm_scene_id`, booting the new server renames the columns and indexes, and `drizzle-kit push` finishes without asking anything. Pinned in Task 5.
2. **A wizard World deployed after the rename.** The new runtime bundle joins `virvi_scene` and sends `virvi_*` messages, and nothing in it says `vlm_scene` or `api.vlm.gg`. Pinned in Task 8.
3. **A returning browser with only an old `vlm_auth` in storage.** It lands on the login page with no crash or loop, and the old key is ignored. Pinned in Task 6.
4. **The stored-URL rewrite.** It changes only whole `vlm.gg` hosts, including inside nested jsonb and inside a `vlm-w-` or `*.worlds.` address. It's idempotent on a second run, and leaves look-alikes such as `notvlm.gg.example.com` or `vlm.ggx` untouched. Pinned in Task 13.
5. **Quest App Links.** `GET /.well-known/assetlinks.json` names `org.virvi.ar`, and the manifest's intent filter host is `virvi.org`. Pinned in Tasks 4 and 10.

---

## Code tasks (branch `feature/virvi-rename`, worktree `.worktrees/virvi-rename`)

### Task 1: Guard script

**Files:**
- Create: `scripts/check-no-vlm.mjs`
- Create: `scripts/check-no-vlm.test.mjs`
- Create: `scripts/vlm-allowlist.json`

**Interfaces:**
- Produces: `node scripts/check-no-vlm.mjs [pathspec...]`.
  - It prints `<file>:<line>: <text>` for each hit, then `N hits`.
  - It exits 1 if N > 0, otherwise 0.
  - With pathspecs, it only scans those paths.
  - Every later task's done-check is `node scripts/check-no-vlm.mjs <its paths>` printing `0 hits`.

**What counts as a hit:**
- Each line of each `git ls-files` text file that matches `/vlm/i`. Binary files count as one hit per file.
- **Exceptions** (`scripts/vlm-allowlist.json`):
  - `paths`: globs that are skipped entirely. Initially `docs/superpowers/**`, `VLM_V2_*.md`, `pnpm-lock.yaml`, `**/package-lock.json`, `scripts/vlm-allowlist.json` and `scripts/check-no-vlm*.mjs`.
  - `tokens`: regexes removed from a line before matching. These are the "kept as-is" names from Global Constraints. Exact list: `vlm-w-`, `vlm-worlds(-router|-pg|-db-jobs)?`, `vlm-hyperfy-image`, `vlm-studio-(worker|spike)`, `vlm-streaming`, `vlm-media`, `vlm-quest(-release\.jks)?`, `\bvlm_(test|dev|prod|main|next)\b`, `postgres(ql)?://vlm:`, `@[\w.-]+:\d+/vlm\b`, `virvi-xr/vlm-(api|ui|jobs|scenes|dcl-qc|proxy|dcl-sdk6|dcl-sdk7|hyperfy-sdk2)`.
  - A line with the marker comment `virvi-rename: keep` is skipped. It's meant for the rename and rewrite code in Tasks 5 and 13, and for docker-compose `POSTGRES_USER`/`POSTGRES_DB` lines.

- [ ] **Step 1: Write the failing tests** in `scripts/check-no-vlm.test.mjs` with `node:test`. Each test makes a temp git repo with fixture files and runs the script on it:
  - `flags a plain vlm line`: a file containing `const a = 'vlm'` gives exit 1 and output containing `a.txt:1:`.
  - `skips allowlisted paths`: `docs/superpowers/x.md` containing `vlm` gives exit 0.
  - `strips allowlisted tokens`: `app = "vlm-worlds-router"` gives exit 0, and `app = "vlm-worlds-router" // vlm` gives exit 1.
  - `honours the keep marker`: `old = 'vlm_scene_id' // virvi-rename: keep` gives exit 0.
  - `scopes to pathspecs`: hits under `b/` and a pathspec `a/` give exit 0.
- [ ] **Step 2:** Run `node --test scripts/check-no-vlm.test.mjs`. Expected: FAIL (the script doesn't exist yet).
- [ ] **Step 3:** Implement the script with Node built-ins only. It reads the allowlist relative to its own directory.
- [ ] **Step 4:** Run `node --test scripts/check-no-vlm.test.mjs`. Expected: PASS. Then run `node scripts/check-no-vlm.mjs | tail -1`, which prints the starting count (about 4,000 hits). Record it in the commit message.
- [ ] **Step 5:** Commit: `chore: guard script listing remaining vlm names`.

### Task 2: Package and directory rename

**Files:**
- Move with `git mv`: every `packages/vlm-*` directory to its new path (Global Constraints).
- Modify:
  - every `package.json` (name, dependencies and `"private": true`, except `packages/dcl`)
  - every import of `vlm-*` packages (about 190 files)
  - `Dockerfile` (`COPY packages/...` lines)
  - `dcl-runtime/build.sh` (`--filter '@virvixr/dcl^...'` and `--filter @virvixr/dcl bundle`)
  - `dcl-runtime/package.json` (`"@virvixr/dcl": "file:../packages/dcl"`) and `dcl-runtime/src/index.ts` (the import)
  - tsconfig `paths`/`references` and vitest aliases that name the old directories
  - `packages/dcl/bin/vlm-dcl.mjs`, moved to `packages/dcl/bin/virvi-dcl.mjs`, with its `bin` key
  - regenerate `pnpm-lock.yaml` and `dcl-runtime/package-lock.json` with installs, never by hand

**Interfaces:**
- Produces: the package names and directories in Global Constraints. All later tasks import `@virvixr/*`.

- [ ] **Step 1:** Run `node scripts/check-no-vlm.mjs packages Dockerfile dcl-runtime '*/package.json' | tail -1`. Expected: N > 0 hits.
- [ ] **Step 2:** Move the directories and rewrite names and imports. Imports change in source only: skip `dist/`, `apps/server/dcl-runtime/**` and binary files.
- [ ] **Step 3:** Run `pnpm install` (lockfile regenerates). In `dcl-runtime`, run `npm install`.
- [ ] **Step 4:** Run `pnpm -r typecheck && pnpm --filter @virvixr/core test && pnpm --filter @virvixr/hyperfy-app test && pnpm --filter @virvixr/dcl test && pnpm --filter @virvixr/web test`. Expected: all pass.
  - Then run the server suite against the private database (Global Constraints). Expected: all pass, the same count as on main.
  - Then run `docker build -t virvi-rename-check .`. Expected: the build succeeds.
- [ ] **Step 5:** Commit: `refactor: rename packages to @virvixr/*`.

Package names and their imports are the only things that change here. Code identifiers inside the packages are Task 3.

### Task 3: Protocol and code identifiers (shared, core, client, hud, adapters, dcl, hyperfy-app, server)

**Files:**
- Modify: the source under `packages/*/src`, `apps/server/src`, and the related tests.

**Interfaces:**
- Produces:
  - the room names in Global Constraints;
  - events `virvi:link`, `virvi:scene`, `virvi:hello`, `virvi:smart_item:connected`, `virvi:preset:switch`, `virvi:hud:toggle` and `virvi:giveaway:trigger`;
  - message types `virvi_error` and `virvi_scene`;
  - role constants `VIRVI_ADMIN`, `VIRVI_EMPLOYEE` and `VIRVI_CONTRACTOR`;
  - types `Virvi*`, for example `VirviPlatformAdapter` and `VirviSceneRoom`;
  - the `createVirvi` factory in `@virvixr/dcl`, renamed from `createVLM`;
  - `virvi_*` metric names.
- Task 8 consumes `createVirvi` and the room and message names.

- [ ] **Step 1:** Run `node scripts/check-no-vlm.mjs packages apps/server/src apps/server/test | tail -1`. Expected: N > 0.
- [ ] **Step 2:** Add an assertion to an existing room test in `apps/server/test`: the server registers a room named `virvi_scene` and no room whose name starts with `vlm`. Run it. Expected: FAIL.
- [ ] **Step 3:** Rename the protocol strings, constants, types, metric names, log prefixes and settings names (`VLM_*` → `VIRVI_*`) across server and packages.
  - Settings names are read through `apps/server/src/config.ts` and the package configs.
  - Don't touch database columns (Task 5), domains (Task 4), `VLM_WORLD_KEY`/`VLM_WORLD_SECRET` (Task 9) or the `VLM_QUEST_*` names (Task 10).
- [ ] **Step 4:** Run `pnpm -r typecheck`, the package tests from Task 2, and the server suite. Expected: all pass.
- [ ] **Step 5:** Run `node scripts/check-no-vlm.mjs packages | tail -1`. Expected: `0 hits`, except in `packages/dcl` README/docs copy and `packages/hyperfy-app/dist`, which Tasks 7 and 9 handle.
- [ ] **Step 6:** Commit: `refactor: virvi protocol, types and settings names`.

### Task 4: Server domains, email, API surface

**Files:**
- Modify:
  - `apps/server/src/config.ts`: the defaults `emailFrom: 'noreply@virvi.org'`, `arReportsEmail: 'support@virvi.org'`, `ANDROID_APP_PACKAGE` default `'org.virvi.ar'`, and the hyperfy router domain comment
  - `apps/server/src/app.ts`: the Swagger title `'Virvi API'` and the assetlinks route
  - the `vlm_k1_` key prefix (`schema.ts:879` area and the key service)
  - `apps/server/src/services/email.ts`: the `[virvi-email]` prefix
  - every other `vlm.gg` in `apps/server/src`
  - tests: `apps/server/test/ar-pages.test.ts` and the API-key tests

- [ ] **Step 1:** Update the tests first:
  - In `ar-pages.test.ts`, assetlinks returns `package_name: 'org.virvi.ar'`.
  - In the API-key tests, a new key matches `/^virvi_k1_/`, and a key starting with `vlm_k1_` is rejected with 401.

  Run them. Expected: FAIL.
- [ ] **Step 2:** Change the defaults, title, prefix and hosts to the Global Constraints values.
- [ ] **Step 3:** Run the server suite. Expected: PASS.
- [ ] **Step 4:** Run `node scripts/check-no-vlm.mjs apps/server/src apps/server/test | tail -1`. Expected: `0 hits`, apart from the `vlm_scene_id` hits left for Task 5.
- [ ] **Step 5:** Commit: `feat(server): virvi.org domains, email and API names`.

### Task 5: Database column and index rename

**Files:**
- Modify:
  - `apps/server/src/db/schema.ts`: `virviSceneId: uuid('virvi_scene_id')` in both tables, and the index names from Global Constraints
  - every query using `vlmSceneId`
  - `apps/server/scripts/pre-push-upgrade.mjs`
  - `apps/server/scripts/check-upgrade-push.sh`

**Interfaces:**
- Produces: the column `virvi_scene_id`, with the Drizzle field `virviSceneId`.

- [ ] **Step 1:** Extend `check-upgrade-push.sh`. The base schema that its first push creates must come from main's `schema.ts` (it has `vlm_scene_id`). After `pre-push-upgrade.mjs` and the second push, the script asserts:
  - `virvi_scene_id` exists on both tables and `vlm_scene_id` exists on neither;
  - both `*_virvi_scene_idx` indexes exist;
  - the push exits 0 with no `DROP` and no prompt.

  Run it on Postgres 16. Expected: FAIL.
- [ ] **Step 2:** In `pre-push-upgrade.mjs`, add an idempotent `DO $$ … $$` block before push.
  - For each table, if column `vlm_scene_id` exists and `virvi_scene_id` doesn't, it runs `ALTER TABLE … RENAME COLUMN`.
  - It runs `ALTER INDEX IF EXISTS … RENAME TO …` for both indexes.
  - Mark the old-name lines `-- virvi-rename: keep`, and add a log line fragment `vlm_scene_id renamed` (marked the same way).
- [ ] **Step 3:** Rename the schema field and its call sites.
- [ ] **Step 4:** Run `check-upgrade-push.sh` on Postgres 16 and on the Postgres 18 container. Expected: PASS both. Then run the server suite. Expected: PASS.
- [ ] **Step 5:** Run `node scripts/check-no-vlm.mjs apps/server | tail -1`. Expected: `0 hits`, apart from `apps/server/dcl-runtime/1`, which Task 8 removes.
- [ ] **Step 6:** Commit: `feat(db): rename vlm_scene_id to virvi_scene_id before push`.

### Task 6: Web app: copy, logo, icons, storage keys

**Files:**
- Delete: `apps/web/public/vlm-logo.svg`.
- Create, in `apps/web/public/`:
  - `virvi-logo-light.svg` (white wordmark) and `virvi-logo-dark.svg` (navy wordmark), copied from `/Users/unknower/-Virvi/Branding/`
  - `virvi-symbol.svg` (from `virvi-symbol-dark-clean.svg`)
  - `favicon.ico` (16 and 32 px), `apple-touch-icon.png` (180 px), `icon-192.png` and `icon-512.png`
  - `site.webmanifest` (`name: "Virvi"`)
  - `og.png`: 1200×630, the white wordmark centred on the dashboard's graphite background colour
- Modify:
  - `apps/web/src/app/layout.tsx`: the title template `'%s · Virvi'` with default `'Virvi'`, the icons/manifest/openGraph metadata, and the description from the landing copy
  - `apps/web/src/app/_landing/Nav.tsx`: the `<img src="/virvi-logo-light.svg" alt="Virvi">`, or dark if the nav background is light
  - `privacy/page.tsx` and all of `apps/web/src`: copy, hosts, storage keys (`virvi_auth`, `virvi_pending_invite`, `virvi-dash-*`) and the ring download name `virvi-ring-${id}.${format}`
  - the web tests

- [ ] **Step 1:** Write a test in the existing web vitest setup, `auth ignores a legacy vlm_auth entry`. With localStorage holding only `vlm_auth`, the auth provider reports signed out without throwing. With `virvi_auth` set, it reads it. Run it. Expected: FAIL.
- [ ] **Step 2:** Make the changes. Render the PNGs from the SVGs with a script kept in the scratchpad (not committed); macOS `qlmanage` plus PIL work.
- [ ] **Step 3:** Run `pnpm --filter @virvixr/web test && pnpm --filter @virvixr/web build`. Expected: PASS and a successful build.
- [ ] **Step 4:** Run `node scripts/check-no-vlm.mjs apps/web | tail -1`. Expected: `0 hits`.
- [ ] **Step 5:** Start the web dev server and look at the landing page, the dashboard nav, the browser tab icon and `/privacy` in a browser. Save screenshots to the scratchpad for the final report.
- [ ] **Step 6:** Commit: `feat(web): Virvi name, logo and icons`.

### Task 7: Docs site, READMEs and root metadata

**Files:**
- Modify:
  - `apps/docs/astro.config.mjs`: title `'Virvi Docs'`, the description, the GitHub link `https://github.com/virvi-xr/virvi`, and the Starlight `logo` and `favicon` using the wordmark and symbol (copied into `apps/docs/src/assets/` and `public/`)
  - all `apps/docs/src/content/**`
  - move `getting-started/what-is-vlm.md` to `getting-started/what-is-virvi.md` and fix the links to it
  - `README.md`, root `package.json` description
  - `packages/dcl/README.md` and the package `description`/`homepage` (`https://virvi.org`)/`repository` (`github.com/virvi-xr/virvi`) fields
  - `.env.example` (the hosts and `VIRVI_*` names)

- [ ] **Step 1:** Run `node scripts/check-no-vlm.mjs apps/docs README.md package.json packages/dcl .env.example | tail -1`. Expected: N > 0.
- [ ] **Step 2:** Make the changes.
- [ ] **Step 3:** Run `pnpm --filter @virvixr/docs build`. Expected: success, with no broken-link warnings for `what-is-virvi`.
- [ ] **Step 4:** Run the Step 1 guard command again. Expected: `0 hits`.
- [ ] **Step 5:** Commit: `docs: Virvi name across docs and READMEs`.

### Task 8: DCL runtime v2

**Files:**
- Modify:
  - `apps/server/src/services/dcl/runtime.ts`: `DCL_RUNTIME_VERSION = 2`
  - `apps/server/test/dcl-runtime.test.ts`
  - `dcl-runtime/src/index.ts`: `createVirvi`, from Task 3
- Create: `apps/server/dcl-runtime/2/bin/index.js`, built by the script.
- Delete: `apps/server/dcl-runtime/1/`.

**Interfaces:**
- Consumes: `createVirvi`, the room `virvi_scene` and the `virvi_*` messages (Task 3).

- [ ] **Step 1:** Update the test to expect `DCL_RUNTIME_VERSION` to be `2`. The bundle text must contain `virvi_scene` and must not match `/vlm_scene|vlm\.gg|models\/vlm\//`. Run it. Expected: FAIL.
- [ ] **Step 2:** Run `VERSION=2 bash dcl-runtime/build.sh`. Expected: it prints `Runtime v2: <bytes> bytes`, about 1 MB.
- [ ] **Step 3:** Bump the constant, delete `apps/server/dcl-runtime/1/`, and run the server suite. Expected: PASS. That includes the assemble and world-deployer tests, which compare runtime hashes.
- [ ] **Step 4:** Run `node scripts/check-no-vlm.mjs apps/server dcl-runtime | tail -1`. Expected: `0 hits`.
- [ ] **Step 5:** Commit: `feat(dcl-runtime): v2 built with Virvi names`.

### Task 9: Hyperfy: app file, router, image

**Files:**
- Modify:
  - `packages/hyperfy-app` scripts and sources: the output is `dist/virvi.hyp`, and the `vlm.hyp` constants become `virvi.hyp`
  - delete `dist/vlm.hyp` and commit the rebuilt `dist/virvi.hyp`
  - `apps/server/src/routes/hyperfy-worlds.ts` and `infra/hyperfy/{Dockerfile,Dockerfile.dockerignore,build.sh,SETUP.md,test-world.mjs}`: the `.hyp` path and the `VIRVI_WORLD_KEY`/`VIRVI_WORLD_SECRET` names the image reads
  - `infra/hyperfy-router/server.mjs`: the fallback domain `worlds.virvi.org` and the 404 copy "There is no Virvi world at this address."
  - `infra/hyperfy-router/fly.toml`: `ROUTER_DOMAIN = "worlds.virvi.org"`. The app name stays `vlm-worlds-router`.
  - `infra/hyperfy-router/server.test.mjs`
  - the server Hyperfy provisioning code: the secrets it sets on world apps use the `VIRVI_*` names, and the `vlm-w-` prefix stays

- [ ] **Step 1:** In `server.test.mjs`, change the expectations:
  - The host `foo.worlds.virvi.org` replays to `app=vlm-w-foo`.
  - `foo.worlds.vlm.gg` gets the 404 body "There is no Virvi world at this address."

  Run `node --test infra/hyperfy-router/server.test.mjs`. Expected: FAIL.
- [ ] **Step 2:** Make the changes, then rebuild the app with `pnpm --filter @virvixr/hyperfy-app build`.
- [ ] **Step 3:** Run the router tests, `pnpm --filter @virvixr/hyperfy-app test` and the server suite. Expected: all pass.
- [ ] **Step 4:** Run `node scripts/check-no-vlm.mjs packages/hyperfy-app infra | tail -1`. Expected: `0 hits`.
- [ ] **Step 5:** Commit: `feat(hyperfy): virvi.hyp, worlds.virvi.org router, VIRVI_ world secrets`.

### Task 10: Quest app: Virvi AR

**Files:**
- Move with `git mv`: `apps/quest/app/src/{main,test,androidTest}/java/gg/vlm/spaces` to `…/java/org/virvi/ar`.
- Modify:
  - every `package`/`import` line in those Kotlin files
  - `apps/quest/app/build.gradle.kts`: `namespace = "org.virvi.ar"`, `applicationId = "org.virvi.ar"`, and the `VIRVI_QUEST_*` keystore environment names (the alias value `vlm-quest` stays)
  - `AndroidManifest.xml`: `android:label="Virvi AR"`, the App Link host `virvi.org`, and `android:icon`/`roundIcon` pointing at the new mipmaps
  - `res/values/strings.xml`
  - `STORE.md` and `README.md`: copy, the privacy URL `https://virvi.org/privacy`, and "Virvi ring"
  - all `vlm.gg` hosts and API URLs in the Kotlin sources
- Create: `apps/quest/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml` and `ic_launcher_round.xml`. The foreground layer is the symbol as a vector drawable (`drawable/ic_launcher_foreground.xml`, converted from `virvi-symbol-light-clean.svg`) and the background is the graphite colour. Also create the PNG fallbacks in `mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}`.

- [ ] **Step 1:** Add a unit test under `src/test/java/org/virvi/ar`, `AppLinkHostTest`. The deep-link parser accepts `https://virvi.org/s/abc` and rejects `https://vlm.gg/s/abc`. The parser is the existing one that `VisitorFlow` and the link handling use. Run `./gradlew :app:testDebugUnitTest`. Expected: FAIL.
- [ ] **Step 2:** Make the changes.
- [ ] **Step 3:** Run `cd apps/quest && ./gradlew :app:testDebugUnitTest :app:assembleDebug`. Expected: PASS, and the APK is built.
  - Check `aapt2 dump badging app/build/outputs/apk/debug/app-debug.apk | head -3` shows `package: name='org.virvi.ar'` and `application-label:'Virvi AR'`.
- [ ] **Step 4:** Run `node scripts/check-no-vlm.mjs apps/quest | tail -1`. Expected: `0 hits` (the keystore alias is allowlisted).
- [ ] **Step 5:** Commit: `feat(quest): Virvi AR, org.virvi.ar, launcher icon`.

### Task 11: AR spike (iOS/visionOS), ring-marker, streaming

**Files:**
- Modify:
  - `apps/ar-spike/project.yml`: the bundle IDs, display name, usage strings and target names from Global Constraints
  - rename `VLMSpacesApp.swift` to `VirviARApp.swift`, and rename the `VLM*` Swift types
  - `apps/ring-marker/ringmarker/printfiles.py` and the ring-marker README: the "Virvi ring" copy and file names
  - `apps/streaming/**`: the log prefix, settings names, hosts, `DEPLOY.md`, and `fly.toml` env values. The Fly app name stays `vlm-streaming`.
  - the ring-marker test vectors, only if a test asserts on the copy

- [ ] **Step 1:** Run `node scripts/check-no-vlm.mjs apps/ar-spike apps/ring-marker apps/streaming | tail -1`. Expected: N > 0.
- [ ] **Step 2:** Make the changes.
- [ ] **Step 3:** Run these. Expected: all pass, and the ar-spike project generates.
  - `cd apps/ring-marker && python3 -m pytest -q`
  - `pnpm --filter @virvixr/streaming test`
  - `cd apps/ar-spike && xcodegen generate`
- [ ] **Step 4:** Run the Step 1 guard command again. Expected: `0 hits`.
- [ ] **Step 5:** Commit: `chore: Virvi names in ar-spike, ring-marker and streaming`.

### Task 12: Infra config and test scenes

**Files:**
- Modify:
  - `.railway/railway.ts`: the project name `"Virvi"`, the service `virvi-server`, `VIRVI_MODE`, and the virvi.org hosts in any env values it declares
  - root `fly.toml`: `app = "virvi"`
  - `render.yaml`: service `virvi`
  - `docker-compose.{dev,single,scalable}.yml`: the service name `virvi` and `VIRVI_MODE`. The database names, users and passwords stay and are marked `# virvi-rename: keep` where the token allowlist doesn't cover them.
  - `Dockerfile`: the header comment
  - `test-scenes/**`: the package names `virvi-v2-dcl-test` and `virvi-v2-dcl-smart-item-test`, the imports, copy and hosts. **Leave the uncommitted `test-scenes/*/bin/index.js` changes in the hud-test worktree alone.** This worktree's copies are the committed ones, so rebuild them with each scene's own build script rather than hand-editing.
  - `catalog/**` and `scripts/**`: hosts and names

- [ ] **Step 1:** Run `node scripts/check-no-vlm.mjs .railway fly.toml render.yaml 'docker-compose.*' Dockerfile test-scenes catalog scripts | tail -1`. Expected: N > 0.
- [ ] **Step 2:** Make the changes. The deploy command in the memory notes changes to `-s virvi-server` only after R6, so no memory edit happens here.
- [ ] **Step 3:** Run these. Expected: both succeed.
  - `docker compose -f docker-compose.dev.yml config -q`
  - `docker build -t virvi-rename-check .`
- [ ] **Step 4:** Run the Step 1 guard command again. Expected: `0 hits`.
- [ ] **Step 5:** Commit: `chore: Virvi names in infra config and test scenes`.

### Task 13: Stored-URL rewrite script

**Files:**
- Create: `apps/server/scripts/rewrite-vlm-urls.mjs` and `apps/server/test/rewrite-vlm-urls.test.ts`.

**Interfaces:**
- Produces: `node apps/server/scripts/rewrite-vlm-urls.mjs [--apply]`.
  - Without `--apply`, it runs read-only and prints, per column, how many rows it would change.
  - With `--apply`, it does everything in one transaction:
    1. creates the schema `retired` if needed;
    2. copies each affected row's id and old value into `retired.vlm_url_rewrite_20261026(table_name text, column_name text, row_id text, old_value text)`;
    3. updates the rows;
    4. prints the counts.
- It also exports `rewriteHosts(s: string): string` for the test.
- **Columns** (found in production on 2026-10-25):
  - `asset_library_items.cdn_url` and `thumbnail_url`
  - `media_assets.public_url`
  - `streaming_servers.hls_playlist_url` and `rtmp_url`
  - `scene_elements.properties` (jsonb, rewritten as text)
  - `hyperfy_worlds.address`
- **Host map:**
  - `cdn.vlm.gg` → `cdn.virvi.org`
  - `live.vlm.gg` → `live.virvi.org`
  - `ingest.vlm.gg` → `ingest.virvi.org`
  - `worlds-cdn.vlm.gg` → `worlds-cdn.virvi.org`
  - `<slug>.worlds.vlm.gg` → `<slug>.worlds.virvi.org`
  - `api.vlm.gg` → `api.virvi.org`
  - bare `vlm.gg` → `virvi.org`
- Match only at host boundaries: the host is preceded by start, `/`, `.` (for subdomains) or `@`, and followed by end, `/`, `:`, `"`, `?` or `#`.
- Every line holding an old host string carries `// virvi-rename: keep`.

- [ ] **Step 1:** Write the tests:
  - `rewriteHosts` maps each pair in the host map.
  - It leaves `https://notvlm.gg.example.com/x` and `https://vlm.ggx/y` unchanged.
  - It is idempotent: `rewriteHosts(rewriteHosts(s)) === rewriteHosts(s)`.
  - An integration test seeds one row per listed column in the private test database, including a nested jsonb value `{"a":{"src":"https://cdn.vlm.gg/m.glb"}}`. It runs `--apply` twice and asserts that the rows are rewritten, the `retired` table has exactly one copy per row after both runs, and the second run changes 0 rows.

  Run them. Expected: FAIL.
- [ ] **Step 2:** Implement it. Note the 5,549-row catalog: use set-based `UPDATE … SET col = <SQL regexp_replace chain>`, not per-row round trips. The SQL regex must mirror `rewriteHosts`, and the test is the proof that they agree.
- [ ] **Step 3:** Run the tests. Expected: PASS.
- [ ] **Step 4:** Commit: `feat(server): one-off rewrite of stored vlm.gg URLs`.

### Task 14: Whole-repo guard green, merge locally

- [ ] **Step 1:** Run `node scripts/check-no-vlm.mjs | tail -1`. Expected: `0 hits`. For each remaining hit, rename it, or add it to the allowlist only if it is a "kept as-is" item from Global Constraints. Note each allowlist addition in the commit message.
- [ ] **Step 2:** Run the full checks. Expected: all pass, and the Quest debug APK builds.
  - `pnpm -r typecheck`
  - all package tests
  - the server suite on the private database
  - `check-upgrade-push.sh` on Postgres 16 and 18
  - `pnpm --filter @virvixr/web build`
  - `pnpm --filter @virvixr/docs build`
  - the Quest unit tests
  - `docker build`
- [ ] **Step 3:** Commit any fixes. Then merge `feature/virvi-rename` into `main` locally, with no push and no deploy.

---

## Rollout tasks (each needs the owner's go-ahead at the time)

**Prerequisites from the owner:**
- The three domains are active and are zones in Cloudflare.
- virvi.org is in Google Workspace, with `noreply@` and `support@`.
- npm is logged in as a `virvixr` member that can also deprecate `vlm-dcl`.
- An empty `virtuallandmanager` org exists on GitHub to hold the name.

### R1: DNS and certificates

- **Railway:** add the custom domains `virvi.org` and `api.virvi.org` to the production service. Create the CNAME/ALIAS records Railway gives, DNS-only, in the virvi.org Cloudflare zone.
- **R2:** add `cdn.virvi.org` as a custom domain on the `vlm-media` bucket. Add `worlds-cdn.virvi.org` the same way as `worlds-cdn.vlm.gg` is set up today, mirroring its current config.
- **Fly:**
  - `fly certs add live.virvi.org` and `fly certs add ingest.virvi.org` on `vlm-streaming`.
  - `fly certs add worlds.virvi.org` and `fly certs add '*.worlds.virvi.org'` on `vlm-worlds-router`.
  - Create the matching DNS records.
- **Check:** every new host answers over HTTPS (RTMP only on `ingest`) with a valid certificate, before R2 starts.

### R2: Settings and deploy

**Railway settings to set:**
- `WEB_APP_URL=https://virvi.org`
- `PUBLIC_URL=https://api.virvi.org`
- `NEXT_PUBLIC_API_URL=https://api.virvi.org`
- `NEXT_PUBLIC_WSS_URL=wss://api.virvi.org`
- `CORS_ORIGINS=https://virvi.org,https://www.virvi.org`
- `CDN_URL=https://cdn.virvi.org`
- `HLS_BASE_URL=https://live.virvi.org/streams`
- `RTMP_INGEST_URL=rtmp://ingest.virvi.org/live`
- `HYPERFY_ROUTER_DOMAIN=worlds.virvi.org`
- `HYPERFY_ASSETS_BASE_URL=https://worlds-cdn.virvi.org`

**Renamed settings:** add `VIRVI_MODE=cloud` and remove `VLM_MODE`. Rename any other `VLM_*` the server reads, as listed in Task 3.

**Hyperfy worlds:** set `VIRVI_WORLD_KEY` and `VIRVI_WORLD_SECRET` on each existing world app, copying the values from the `VLM_*` secrets, so no secret is printed.

**Deploy:**
- Deploy the router (`fly deploy` in `infra/hyperfy-router`) and streaming with the new env.
- Update the release-deploy checkout to `main`.
- Run `railway up <release-deploy worktree> --path-as-root -s vlm-server --ci`.

**Check:**
- The boot log has `vlm_scene_id renamed`, and the push succeeds.
- `https://api.virvi.org/api/health` returns 200.
- Login on virvi.org works, and so does the WebSocket.
- One catalog thumbnail loads from `cdn.virvi.org`.

### R3: Stored-URL rewrite

Run `node apps/server/scripts/rewrite-vlm-urls.mjs` (dry run) inside the server container and show the owner the counts. Then run it with `--apply`. The expected affected rows are about 5,549 + 5,547 + 2 + 1 + 9 + 3.

### R4: Redirects

- Detach `vlm.gg` and `api.vlm.gg` from Railway.
- In Cloudflare, add 301 Single Redirect rules that keep path and query:
  - `vlm.gg/*` and `www.vlm.gg/*` → `https://virvi.org/$1`
  - `cdn.vlm.gg/*` → `cdn.virvi.org`
  - `virvi.net/*`, `www.virvi.net/*`, `virvixr.com/*` and `www.virvixr.com/*` → `https://virvi.org/$1`
  - `www.virvi.org/*` → `https://virvi.org/$1`
- Check: `curl -sI` on each shows a 301 to the right location.

### R5: Publish and redeploy

- `pnpm --filter @virvixr/dcl bundle && cd packages/dcl && npm publish --access public`.
- `npm deprecate vlm-dcl "Renamed to @virvixr/dcl"`.
- Rename the GitHub repos with `gh repo rename`: `virvi-xr/vlm` → `virvi`, `vlm-dcl` → `virvi-dcl`, and `vlm-docs` → `virvi-docs`. Update the local remotes.
- Redeploy the Decentraland test scenes and the wizard Worlds with `@virvixr/dcl` and runtime v2.
- Redeploy the docs site wherever it's hosted.

### R6: Railway names and Quest

- Rename the Railway project to "Virvi" and the service to `virvi-server`.
- Update the deploy command (`-s virvi-server`) in the memory notes.
- Build Virvi AR (`./gradlew :app:assembleRelease`) and sideload it on the headset.
- Check that pairing works and that a `https://virvi.org/s/<code>` link opens the app.
- Update the memory notes `virvi-rebrand.md` and `vlm-venues-project.md`.
