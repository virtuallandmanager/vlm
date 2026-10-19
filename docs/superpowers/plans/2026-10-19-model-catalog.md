# Model Catalog (Open-Source Packs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load the Mr Dhingia, Last Slice and Decentraland model collections into VLM's catalog as switchable packs,
each model tagged with style, category and venue tags, browsable and addable to a scene library on the website.

**Architecture:** A `catalog_packs` table plus new columns on `asset_library_items`. A one-off importer reads
per-source tag files (checked-in JSON, drafted from the downloaded repos and spot-checked by the user). It uploads
GLBs and thumbnails under deterministic keys and upserts by `(pack_id, source_ref)`. Browse and link routes filter
out disabled packs; already-linked items are untouched. The web dashboard gets filters, "Add to scene", an admin
packs page and a public credits page.

**Tech Stack:** Fastify, Drizzle/Postgres, vitest, Next.js. New server deps: `@gltf-transform/core` and
`@gltf-transform/functions` (triangle count and bounds).

**Spec:** `docs/superpowers/specs/2026-10-19-model-catalog-design.md`

## Global Constraints

- A catalog model is a row with non-null `pack_id`: `is_public = true`, `uploaded_by = null`. It never counts toward
  storage (`media/quota.ts` sums `uploaded_by = owner`).
- Disabling a pack hides it from browsing (`GET /api/assets` list, its `total`, categories) and refuses new scene
  library links. Already-linked items still list in scene libraries, still resolve via `GET /api/assets/:id`, and
  still render.
- Re-running an import never duplicates (`unique (pack_id, source_ref)`), never changes a row's `id` or its `cdn_url`,
  and never flips `enabled`.
- Storage key for catalog files: `catalog/<packId>/<sha256>.glb`, with the thumbnail at
  `catalog/<packId>/<sha256>.<png|webp>`.
- Identical files (same sha256) already in another pack are skipped and reported. Import order is Decentraland
  first, then Mr Dhingia, then Last Slice, so Decentraland keeps shared files. Last Slice's `current-builder-assets/`
  is never drafted into a tag file.
- Vocabularies live in `vlm-shared` (`CATALOG_STYLES`, `CATALOG_CATEGORIES`, `CATALOG_VENUES`). Unknown values are
  rejected by the tag-file parser. A model that can't be placed gets category `Other`.
- Server tests: `cd apps/server && export PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH && TEST_DATABASE_URL=postgres://vlm:vlm_dev@localhost:5432/vlm_test_catalog npx vitest run <file>`
  (own db name, so other worktrees' runs don't collide).
- Never mutate the shared dev db `vlm`. Production import runs only with the user's explicit OK, each time.
- Rebuild `vlm-shared` after changing it: `pnpm --filter vlm-shared build`.

## Review Focus

1. Re-import after editing one tag: that row's style changes, its `id` and `cdn_url` stay, no new row, `enabled`
   stays false if an admin had turned the pack off. (Task 3 test.)
2. A disabled pack's model already in a scene library still appears in `listSceneLibrary` and in
   `GET /api/assets/:id`. (Task 2 test.)
3. A corrupt GLB in the middle of an import is reported and skipped; the rest import. (Task 3 test.)
4. `GET /api/assets` `total` matches the filtered list when a pack is disabled (pagination stays right). (Task 2 test.)
5. An imported model never shows up in its importer's or anyone's storage usage. (Task 3 test.)

---

### Task 1: Schema and shared vocabularies

**Files:**
- Modify: `apps/server/src/db/schema.ts` (new `catalogPacks` table; `assetLibraryItems` columns)
- Modify: `apps/server/entrypoint.sh` (fallback `CREATE TABLE IF NOT EXISTS catalog_packs …` and `ALTER TABLE
  asset_library_items ADD COLUMN IF NOT EXISTS …` for each column, plus the unique index, beside the existing
  fallbacks)
- Create: `packages/vlm-shared/src/catalog.ts`, exported from the package index
- Test: `apps/server/test/catalog-schema.test.ts`

**Interfaces:**
- Produces:
  - `catalogPacks`: `id text pk` (slug), `name text not null`, `source text not null`
    (`'dhingia'|'last-slice'|'decentraland'`), `license text not null` (`'mit'|'cc-by-nc-3.0'|'unstated'`),
    `attribution text not null`, `sourceUrl text not null`, `enabled boolean not null default true`, `createdAt`.
  - `assetLibraryItems` additions:
    - `packId text references catalog_packs(id) on delete restrict` (nullable)
    - `style text`
    - `venueTags text[]`
    - `sourceRef text`
    - `contentHash text`
    - unique index `asset_library_items_pack_ref` on `(pack_id, source_ref)`
    - index on `content_hash`
  - `vlm-shared`:
    - `CATALOG_STYLES`: `['Cyberpunk','Sci-Fi','Fantasy','Western','Steampunk','Pirates','Asian','Modern','Cozy','Minimalist','Industrial','Nature','Voxel','Halloween','Classic']`
    - `CATALOG_CATEGORIES`: `['Building','Structure','Furniture','Lighting','Decor','Plants & Nature','Food & Drink','Tech & Music','Signage','Vehicles','Characters & Animals','Effects','Other']`
    - `CATALOG_VENUES`: `['cafe','club','gallery','shop','office','home','outdoor','stage','beach','gym','restaurant','bar','museum','park']`
    - types `CatalogStyle`, `CatalogCategory`, `CatalogVenue`, and
      `CatalogPack = { id; name; source; license; attribution; sourceUrl; enabled; modelCount }`

- [ ] **Step 1: Write the failing test.** `catalog-schema.test.ts`:
  - `it('stores a pack and a catalog model')`: insert a pack, then an item with `packId`, `style: 'Cozy'`,
    `venueTags: ['cafe']`, `sourceRef: 'a/b.glb'`, `contentHash: 'h'`; read it back with those values.
  - `it('refuses a second item with the same pack and source ref')`: the second insert rejects.
  - `it('allows the same source ref in different packs')`.
- [ ] **Step 2: Run it.** Expected: FAIL, `catalogPacks` is not exported.
- [ ] **Step 3: Implement** the schema, the entrypoint fallbacks and `vlm-shared/src/catalog.ts`; rebuild vlm-shared.
- [ ] **Step 4: Run it.** Expected: 3/3 PASS. Then run the full server suite. Expected: green.
- [ ] **Step 5: Commit** `feat(catalog): packs table, catalog columns, shared vocabularies`.

### Task 2: Browse filters, pack visibility, linking catalog models

**Files:**
- Create: `apps/server/src/catalog/visibility.ts`
- Modify: `apps/server/src/routes/assets.ts` (list, categories), `apps/server/src/routes/scene-library.ts` (POST
  accepts catalog models), `apps/server/src/library/scene-library.ts` (`linkToScene` refuses disabled packs)
- Modify: `apps/server/test/cross-account-walk.test.ts` only if a new route needs listing
- Test: `apps/server/test/catalog-browse.test.ts`

**Interfaces:**
- Consumes: Task 1 schema.
- Produces:
  - `browsableAsset(): SQL`: the condition "`pack_id IS NULL` or the pack is enabled", to AND into catalog queries.
  - `class PackDisabledError extends Error` (`code = 'pack_disabled'`), thrown by `linkToScene` when linking an
    `assetItemId` whose pack is disabled. Routes map it to `409 { error: 'pack_disabled' }`.
  - `GET /api/assets`:
    - new query params `style`, `venue` (array contains), `pack`, `category` (already there)
    - each returned asset adds `pack: { id, name, license, attribution } | null`
    - `total` uses the same conditions
  - `GET /api/assets/:id` stays unfiltered by pack state, so linked items keep resolving.
  - `POST /api/scenes/:sceneId/library` with `assetItemId` accepts an item the caller uploaded, or
    `isPublic && packId != null && pack enabled`. Other items stay 403. A disabled pack gives 409 `pack_disabled`.

- [ ] **Step 1: Write the failing tests.** `catalog-browse.test.ts`, seeding two packs (one enabled, one disabled),
  each with models:
  - `it('lists only models from enabled packs, and total matches')`
  - `it('filters by style, venue, pack and category')`: `?venue=cafe` returns only items whose `venueTags` contain
    `cafe`.
  - `it('returns pack name, license and attribution with each model')`
  - `it('categories leave out disabled packs')`
  - `it('GET /api/assets/:id still returns a model from a disabled pack')`
  - `it('an editor can add an enabled catalog model to the scene library')`: 201, and the item appears in
    `listSceneLibrary`.
  - `it('adding a disabled pack model gives 409 pack_disabled')`
  - `it('a disabled pack model already linked still lists in the scene library')`: link, disable, then
    `listSceneLibrary` still has it.
  - `it('someone else\'s private upload is still refused')`: 403.
- [ ] **Step 2: Run them.** Expected: FAIL. Filters are ignored, disabled packs are listed, and the catalog link
  gives 403.
- [ ] **Step 3: Implement** `visibility.ts`, the route changes, and the `linkToScene` check.
- [ ] **Step 4: Run them.** Expected: PASS. Then run the full server suite, including `cross-account-walk`.
  Expected: green.
- [ ] **Step 5: Commit** `feat(catalog): browse filters, pack visibility, add catalog models to scenes`.

### Task 3: Pack admin and credits routes

**Files:**
- Create: `apps/server/src/routes/catalog.ts` (register beside `assets.ts` in `app.ts`)
- Modify: `apps/server/src/routes/admin.ts` (two routes, using its existing `requireAdmin` hooks)
- Modify: `apps/server/test/cross-account-walk.test.ts` (new routes in its lists)
- Test: `apps/server/test/catalog-packs.test.ts`

**Interfaces:**
- Produces:
  - `GET /api/admin/catalog/packs` → `{ packs: CatalogPack[] }` (all packs, with model counts), admin only.
  - `PATCH /api/admin/catalog/packs/:id { enabled: boolean }` → `{ pack: CatalogPack }`. 400 for a non-boolean, 404
    for an unknown id.
  - `GET /api/catalog/packs` (public, no auth) → `{ packs: CatalogPack[] }`: every pack with `modelCount > 0`,
    enabled or not (credits page).

- [ ] **Step 1: Write the failing tests.**
  - `it('admin lists packs with counts')`
  - `it('admin turns a pack off and on')`: after off, `GET /api/assets` drops its models; after on, they're back.
  - `it('non-admins get 403 on both admin routes')`
  - `it('PATCH validates enabled and the id')`
  - `it('public packs list includes disabled packs that have models, and leaves out empty ones')`
- [ ] **Step 2: Run them.** Expected: FAIL, 404 on all routes.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them.** Expected: PASS. Then run the full suite. Expected: green.
- [ ] **Step 5: Commit** `feat(catalog): admin pack switches and public credits list`.

### Task 4: Importer

**Files:**
- Create: `apps/server/src/catalog/glb-stats.ts`, `apps/server/src/catalog/tag-file.ts`,
  `apps/server/src/catalog/import.ts`, `apps/server/src/scripts/catalog-import.ts`
- Create: `catalog/packs.json` (repo root `catalog/`: every pack's id, name, source, license, attribution,
  sourceUrl)
- Modify: `apps/server/package.json`:
  - add `@gltf-transform/core` and `@gltf-transform/functions`
  - add script `"catalog:import": "tsx src/scripts/catalog-import.ts"`
- Test: `apps/server/test/catalog-import.test.ts`, with fixtures under `apps/server/test/fixtures/catalog/`. Two tiny
  GLBs are built in the test with `@gltf-transform/core` (a unit cube and a 2×1×3 box), plus one corrupt file.

**Interfaces:**
- Consumes: Task 1 schema and vocabularies.
- Produces:
  - `PackDef = { id: string; name: string; source: 'dhingia'|'last-slice'|'decentraland'; license: 'mit'|'cc-by-nc-3.0'|'unstated'; attribution: string; sourceUrl: string }`. This is one entry of `catalog/packs.json`; `loadPacks(path): PackDef[]` validates the file.
  - `glbStats(buf: Buffer): Promise<{ triangles: number; bbox: { x: number; y: number; z: number } }>`. The bbox is
    the world-space size of the default scene (gltf-transform `getBounds`). It throws on an unparsable file.
  - `TagRow = { pack: string; sourceRef: string; file: string; thumbnail?: string; name: string; description?: string; author: string; style: CatalogStyle | null; category: CatalogCategory; venueTags: CatalogVenue[]; confidence: number }`.
    `file` and `thumbnail` are relative to the repo root passed to the import.
  - `parseTagFile(json: unknown, packIds: Set<string>): { rows: TagRow[]; errors: string[] }`. Rows with an
    unknown pack, style, category or venue, a missing `file`/`sourceRef`/`name`, or a duplicate `sourceRef` within
    a pack each give an error naming the row index; they aren't returned.
  - `importCatalog(opts: { root: string; rows: TagRow[]; packs: PackDef[]; storage: StorageProvider }): Promise<ImportReport>`.
    `ImportReport = { added: number; updated: number; duplicates: { sourceRef: string; keptBy: string }[]; failed: { sourceRef: string; error: string }[] }`.
    It works as follows:
    - Upsert packs first. A new pack starts enabled; `enabled` is never changed for existing ones.
    - For each row: read the file, sha256 it, and compute `glbStats`. A failure goes to `failed`, and the import
      continues.
    - If the same hash already exists in a different pack, the row is reported in `duplicates` and skipped.
    - Otherwise upload to the deterministic key, plus the thumbnail if one is given.
    - Then upsert on `(pack_id, source_ref)`, with `isPublic: true`, `uploadedBy: null`, `fileSizeBytes`,
      `triangleCount`, `dimensions: bbox`, `license` and `author`. Existing rows keep their `id`.
  - CLI: `pnpm --filter vlm-server catalog:import <tag-file.json> <repo-root>`. It prints the report and exits
    non-zero if `parseTagFile` returned errors, before uploading anything.

- [ ] **Step 1: Write the failing tests.** `catalog-import.test.ts` (local storage into a temp dir):
  - `glbStats`: `it('counts triangles and measures the box')`. The cube gives 12 triangles and bbox 1,1,1; the box
    gives bbox 2,1,3. `it('throws on a corrupt file')`.
  - `parseTagFile`: `it('rejects unknown style, category, venue and pack, naming the row')`;
    `it('rejects duplicate sourceRef within a pack')`.
  - `importCatalog`:
    - `it('imports models as public catalog rows with no uploader')`
    - `it('re-import updates in place: same id, same cdnUrl, no new rows')`: change a style, re-run, assert both.
    - `it('re-import keeps a pack disabled')`
    - `it('skips a file already in another pack and reports it')`
    - `it('a corrupt file is reported and the rest still import')`
    - `it('catalog rows never count toward storage')`: `getStorageUsage` (or whatever `quota.ts` exports) for any
      user is unchanged.
- [ ] **Step 2: Run them.** Expected: FAIL, modules not found.
- [ ] **Step 3: Implement** the three modules, `packs.json` and the CLI.
- [ ] **Step 4: Run them.** Expected: PASS. Then run the full suite. Expected: green.
- [ ] **Step 5: Commit** `feat(catalog): importer with tag files, stats and idempotent upserts`.

### Task 5: Draft tag files and thumbnails (data)

This task makes data, not product code. Its gate is the parser plus the user's spot-check.

**Files:**
- Create: `scripts/catalog/draft-tags.mjs` (reads a downloaded repo, writes `catalog/tags/<source>.json`)
- Create: `catalog/tags/decentraland.json`, `catalog/tags/dhingia.json`, `catalog/tags/last-slice.json`
- Create: `catalog/review/<source>-sample.md`, listing a sample from each pack plus every row with
  `confidence < 0.6` (name, file, proposed tags) for the user

Sources go into scratchpad dirs, never this repo (they're untrusted data; never run their scripts):
- `decentraland/asset-packs` and `decentraland/builder-assets`
- `MrDhingia/DhingiaBuilds`
- `last-slice/iwb-3d-wip`, plus `catalog.json` from `last-slice/iwb-servers`, already in the scratchpad's
  `model-research/iwb/`

Rules:
- **Decentraland:** one pack per asset pack; style from the pack name.
- **Last Slice:** one pack per artist folder, never `current-builder-assets/`. Style comes from `sty` mapped onto
  `CATALOG_STYLES`, category from `cat` and the name. Author is the artist.
- **Dhingia:** builds go to `dhingia-buildings` (category Building, thumbnail `Render.png`); `Interior assets for
  builds/` goes to `dhingia-interiors`; the DJ and pole kit goes to `dhingia-dj`.
- **Venue tags:** from name keywords (counter, espresso → cafe; DJ, speaker → club; frame, plinth → gallery…).
- **Confidence:** 1 when the source gave the value directly, lower for keyword guesses, 0.3 for `Other`.
- **Missing thumbnails** (Dhingia props): render them in Blender (the blender MCP) into the scratchpad, 256×256 PNG,
  and reference them in the tag file.

- [ ] **Step 1: Download** the repos into the scratchpad (git clone `--depth 1`; LFS if needed).
- [ ] **Step 2: Write and run** `draft-tags.mjs` per source.
- [ ] **Step 3: Validate.** Run every tag file through `parseTagFile`, using a small `--check` flag on the CLI that
  validates and exits. Expected: 0 errors. Counts are roughly 2,500 Decentraland, 100 Dhingia, 3,000 Last Slice.
- [ ] **Step 4: Render** the missing thumbnails.
- [ ] **Step 5: Do a local import** into a scratch db (`vlm_catalog_local`, never `vlm`) with local storage, in the
  order Decentraland, Dhingia, Last Slice. Expected: report with `failed` and `duplicates` listed, and most rows
  added.
- [ ] **Step 6: Commit** the tag files, review samples and script: `data(catalog): draft tags for three sources`.
- [ ] **Step 7: Stop for the user's spot-check** of `catalog/review/*.md`. Apply their corrections to the tag files,
  re-validate, and commit.

### Task 6: Web — browse filters, Add to scene, admin packs, credits

**Files:**
- Modify: `apps/web/src/lib/api.ts`:
  - `getAssets` params gain `style`, `venue`, `pack`
  - new `getCatalogPacks()`, `getAdminCatalogPacks()`, `setCatalogPackEnabled(id, enabled)`,
    `addToSceneLibrary(sceneId, { assetItemId })` (unless an equivalent exists)
- Create: `apps/web/src/lib/catalog.ts`: `creditLine(asset): string`, e.g. `"by Kirzoz · Last Slice: Kirzoz ·
  license unstated"` / `"by Mr Dhingia · MIT"`; `licenseLabel(license)`
- Modify: `apps/web/src/app/(dashboard)/assets/page.tsx`: style, venue, category and pack selects (from
  `vlm-shared` vocabularies and `getCatalogPacks`), a credit line per card, an "Add to scene" button opening a picker
  of the user's scenes, and a confirmation toast. A `pack_disabled` error shows "This pack is no longer available".
- Create: `apps/web/src/app/(dashboard)/admin/catalog/page.tsx`: a table of packs (name, source, license, models)
  with an on/off toggle. Link it from the existing admin page.
- Create: `apps/web/src/app/credits/page.tsx` (public, outside the dashboard group): every pack from
  `getCatalogPacks`, with name, source link, license, attribution (Dhingia's full MIT text preformatted).
- Test: `apps/web/src/lib/catalog.test.ts`

- [ ] **Step 1: Write the failing test** `catalog.test.ts`:
  - `creditLine` for an MIT pack, an unstated-license pack and a model with no pack (user upload → `''`)
  - `licenseLabel('cc-by-nc-3.0') === 'CC BY-NC 3.0'`
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement** `catalog.ts`, the api additions and the three pages.
- [ ] **Step 4: Verify.** `cd apps/web && npx vitest run`: PASS. `npx tsc --noEmit`: clean. `npx next build`: succeeds.
  With the local server and the Task 5 local import, check by hand in the browser:
  - filter by Cozy + cafe
  - add a model to a scene; it appears in the in-world HUD library
  - turn the pack off in admin; the model is gone from browse but still in that scene's library
  - `/credits` lists it
- [ ] **Step 5: Commit** `feat(web): catalog filters, add to scene, pack admin, credits`.

### Task 7: Docs

- [ ] Add a "Catalog packs" section to `apps/docs/src/content/docs/dashboard/` (browse, Add to scene, credits;
  admins: pack switches; operators: `catalog:import` usage and import order). Commit `docs: catalog packs`.

Production import (R2 plus production db) is **not** a task. It's a separate, user-approved run after merge and
deploy.
