# Virvi Rename: Design

Date: 2026-10-25
Status: draft, awaiting owner approval

## Intent

Virtual Land Manager (VLM) is now **Virvi**, announced 2026-10-24. The product should carry the new name everywhere a person can see it, and the code should stop saying "vlm", so the old name stops leaking into new work. VLM has no real users yet, so this is a **clean break**: nothing has to keep working under the old name, and there are no compatibility shims (owner, 2026-10-25).

Product names, as announced by the owner:

| Name | What it is |
|---|---|
| Virvi OS | The whole ecosystem |
| Virvi Studio | The design studio (scene building) |
| Virvi Drops | Giveaways |
| Virvi Events | Events |
| Virvi AR | AR spaces: the Quest app, today "VLM Spaces" |
| Virvi Sync | Keeping everything in sync across worlds |

The existing "Virvi deploys" feature (the Decentraland deploy wallet and signer, `VIRVI_DCL_DEPLOY_KEY`) already uses the new name. It keeps that name, and the rest of the code catches up to it.

## Goals

- **virvi.org is the home.** virvi.net, virvixr.com and vlm.gg all redirect permanently to it, keeping the path.
- **The visible name changes everywhere:** "Virvi" and its product names appear in the dashboard, landing page, docs, emails, the API docs, the Quest app and its store listing, and Decentraland and Hyperfy in-world text.
- **The new logo replaces `vlm-logo.svg`.** The favicon, app icons and share image are new, made from the symbol.
- **Package, app and code identifiers use virvi.** That covers npm packages, the Quest app ID, settings names, database columns, storage keys, event names and log prefixes.
- **Hosted infrastructure is renamed where it can be renamed in place.** That's the GitHub repos and the Railway project and service.

## Non-goals

- **No visual redesign.** The dashboard keeps its graphite-and-cyan look (owner). Only the logo and the name change.
- **History stays as written.** The specs and plans under `docs/superpowers/` and the root `VLM_V2_*.md` documents stay as they are.
- **The Quest Store release stays on hold.** This rename doesn't trigger it.
- **No Galaxy Gardeners changes,** except that its jobs repo's git remote already points at `virvi-xr/vlm-jobs`. That was done.

## Anti-goals: things that make this a failure even if it technically works

- A blanket find-and-replace that mangles the vendored `apps/server/dcl-runtime/**` bundle, lockfile hashes, or the "Virvi deploys" names.
- Production boot hanging because drizzle-kit asks "renamed or created?" about a renamed column or table. Every rename has to be handled before `drizzle-kit push` (see Database).
- vlm.gg going dark before virvi.org serves everything, including API, WebSocket, CDN, streaming and Hyperfy worlds.
- A visitor seeing "VLM" anywhere a visitor can see it.

## Already done (2026-10-25)

- **GitHub:** the org `virtuallandmanager` was renamed to **`virvi-xr`**, and its 13 repos came along. The local git remotes were updated.
  - `VirviXR` is held by GitHub after the owner deleted that org.
  - `virvi` is an unrelated personal account.
- **Clean symbol redraw:** `/Users/unknower/-Virvi/Branding/virvi-symbol-{dark,light}-clean.svg`. The originals were left untouched.

## Owner prerequisites (things only the owner can do)

1. **Domains:**
   - Check that virvi.org, virvi.net and virvixr.com show as active at the registrar. On 2026-10-25 the .org, .net and .com registries had no record of them.
   - Add all three as zones in **Cloudflare**, next to vlm.gg, and switch the registrar's nameservers to Cloudflare.
2. **Email:** add virvi.org to Google Workspace as a secondary domain, and create or alias `noreply@virvi.org` and `support@virvi.org`.
3. **npm:**
   - Confirm the `virvixr` npm org is yours.
   - Run `! npm login` as a member of `virvixr`.
   - Make sure that login can still manage `vlm-dcl`, which today is owned by the npm user `virtuallandmanager`, so it can be deprecated.
4. **GitHub:** create an empty org `virtuallandmanager` to hold the name, so the old-link redirects keep working.

## Decided naming

### Domains

| Old | New |
|---|---|
| `vlm.gg`, `www.vlm.gg` | `virvi.org`. `www.virvi.org` redirects to the bare domain. |
| `api.vlm.gg` (HTTP and `wss://`) | `api.virvi.org` |
| `cdn.vlm.gg` | `cdn.virvi.org` |
| `live.vlm.gg` (HLS) | `live.virvi.org` |
| `ingest.vlm.gg` (RTMP) | `ingest.virvi.org` |
| `worlds.vlm.gg`, `*.worlds.vlm.gg` | `worlds.virvi.org`, `*.worlds.virvi.org` |
| `worlds-cdn.vlm.gg` | `worlds-cdn.virvi.org` |
| `staging-api.vlm.gg` / `api.staging.vlm.gg` | `api.staging.virvi.org` (my call: one spelling) |
| `noreply@vlm.gg`, `support@vlm.gg` | `noreply@virvi.org`, `support@virvi.org` |

virvi.net, virvixr.com and every old vlm.gg host get Cloudflare redirect rules: a 301 to the same path on virvi.org, or for subdomains, the matching virvi.org subdomain.

**My call:** `api.vlm.gg` is removed at cutover, with no grace period.
- The event, message and key-prefix renames ship together with no shims, so old scenes would break anyway even if the hostname stayed attached.
- Already-deployed test scenes and Worlds stop working until they're redeployed. That's accepted under the clean break.
- RTMP (`ingest.vlm.gg`) and WebSocket hosts can't be redirected, so they just stop.

### Packages

npm scope **`@virvixr`** (owner). Packages and their directories:

| Old package (directory) | New package (directory) |
|---|---|
| `vlm` (root) | `virvi` (root, private) |
| `vlm-server`, `vlm-web`, `vlm-docs`, `vlm-streaming` | `@virvixr/server`, `@virvixr/web`, `@virvixr/docs`, `@virvixr/streaming` |
| `vlm-shared` (`packages/vlm-shared`) | `@virvixr/shared` (`packages/shared`) |
| `vlm-core`, `vlm-client`, `vlm-hud` | `@virvixr/core`, `@virvixr/client`, `@virvixr/hud` (`packages/core`, `client`, `hud`) |
| `vlm-adapter-dcl`, `vlm-adapter-hyperfy` | `@virvixr/adapter-dcl`, `@virvixr/adapter-hyperfy` |
| `vlm-hyperfy-app` | `@virvixr/hyperfy-app`. The app file `vlm.hyp` becomes `virvi.hyp`. |
| `vlm-dcl` (`packages/vlm-smart-item-dcl`), CLI `vlm-dcl` | `@virvixr/dcl` (`packages/dcl`), CLI `virvi-dcl` |

- **Published:** only `@virvixr/dcl` is published. Every other package gets `"private": true`, which also blocks accidental publishes.
- **Old package:** `vlm-dcl` on npm gets `npm deprecate` with a pointer to `@virvixr/dcl`.

### GitHub repos (org `virvi-xr`)

- `vlm` → `virvi`
- `vlm-dcl` → `virvi-dcl`
- `vlm-docs` → `virvi-docs`

The older v1 repos (`vlm-api`, `vlm-ui`, `vlm-jobs`, `vlm-scenes`, `vlm-dcl-qc`, `vlm-proxy` and the SDK repos) keep their names. **My call:** they're legacy.

### App identifiers

- **Quest:**
  - `applicationId` and `namespace` change from `gg.vlm.spaces` to **`org.virvi.ar`**. The Kotlin package moves from `gg/vlm/spaces/**` to `org/virvi/ar/**`.
  - The label "VLM Spaces" becomes **"Virvi AR"**.
  - App Links move from `vlm.gg/s/` to `virvi.org/s/`.
  - The server default `ANDROID_APP_PACKAGE` and the assetlinks route follow.
  - It's a new app to Meta, which is fine while the store release is on hold.
  - The signing keystore stays the same. The key alias `vlm-quest` may stay; it isn't visible.
- **iOS/visionOS spike:** `gg.vlm.spaces.*` becomes `org.virvi.ar.*`, the display name becomes "Virvi AR", and `VLMSpaces*` targets and types become `VirviAR*`.

### Code identifiers

| Kind | Rule |
|---|---|
| Settings names | `VLM_*` becomes `VIRVI_*`: `VIRVI_MODE`, `VIRVI_WORLD_KEY`, `VIRVI_API_URL`, the Quest keystore variables, and so on. Role constants `VLM_ADMIN` and friends become `VIRVI_ADMIN`. |
| Browser storage | `vlm_auth` becomes `virvi_auth`, `vlm_pending_invite` becomes `virvi_pending_invite`, and `vlm-dash-*` becomes `virvi-dash-*`. People get logged out once, which is accepted. |
| API key prefix | `vlm_k1_` becomes `virvi_k1_`. Old keys stop working, which is accepted. |
| Events and message types | `vlm:*` becomes `virvi:*`, and `vlm_*` becomes `virvi_*`. Scene, HUD and server have to change together. |
| Log prefixes | `[vlm-server]` becomes `[virvi-server]`, `[VLM ...]` becomes `[Virvi ...]`, and so on. |
| Type and class names | `VLM*` becomes `Virvi*`, for example `VLMPlatformAdapter` becomes `VirviPlatformAdapter`. |
| Ring-marker download names | `vlm-ring-<id>` becomes `virvi-ring-<id>`. The "VLM ring" copy becomes "Virvi ring". |

### Database

- **Columns:**
  - `vlm_scene_id` becomes `virvi_scene_id` in both tables.
  - The indexes `analytics_scenes_vlm_scene_idx` and `location_setups_vlm_scene_idx` become `*_virvi_scene_idx`.
- **Boot must not prompt:** each rename is done with `ALTER ... RENAME` in `apps/server/scripts/pre-push-upgrade.mjs`. That script runs before `drizzle-kit push`, so push never asks whether something was renamed. Each step is idempotent: it only renames if the old name exists.
- **Tests:** `apps/server/scripts/check-upgrade-push.sh` has to keep passing on Postgres 16 and 18.
- **Other table and column names** containing "vlm" go through the same check.

### Railway and other hosting

- **Railway:** rename the project "VLM" to "Virvi" and the service `vlm-server` to `virvi-server`. Update `.railway/railway.ts` and the deploy command to match.
- **Railway settings:** `WEB_APP_URL`, `PUBLIC_URL`, `NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_WSS_URL`, `CORS_ORIGINS`, `CDN_URL`, `HLS_BASE_URL`, `RTMP_INGEST_URL`, `HYPERFY_ROUTER_DOMAIN` and `HYPERFY_ASSETS_BASE_URL` all move to the virvi.org hosts. `VLM_MODE` becomes `VIRVI_MODE`.
- **My call: these keep their names**, because they can't be renamed in place, aren't visible to anyone, and recreating them means moving data:
  - the Fly apps (`vlm-streaming`, `vlm-worlds-router`, `vlm-worlds-pg` and the others);
  - the Fly org `vlm-worlds`;
  - the R2 bucket `vlm-media`.

  This includes the per-world app prefix `vlm-w-<slug>` for **all** worlds, new ones too. The router (`infra/hyperfy-router/server.mjs`) and `hosting.ts` turn a slug straight into an app name with no lookup, so one prefix has to cover every world. A visitor only ever sees `<slug>.worlds.virvi.org`.
- **My call: local dev database names stay as they are** (`vlm`, `vlm_test`, the docker-compose user and passwords). Other sessions and tests depend on them, and they're never visible.

### Stored URLs in production data

Production rows store full vlm.gg URLs:
- streaming `rtmp_url` and `hls_playlist_url`;
- the Hyperfy world `address`;
- any asset or CDN URLs.

The plan's first database task finds every column that holds a vlm.gg host. In rollout step 3, after the virvi.org hosts serve and before the redirect, a one-off script rewrites `vlm.gg` hosts to their virvi.org equivalents. It runs as one transaction, and the old values are copied to the `retired` schema first. It's a production data change, so the owner OKs it when it runs. **My call.**

### Decentraland runtime bundle

`apps/server/dcl-runtime/1/bin/index.js` is the vendored scene runtime the server deploys for wizard Worlds. It has the old protocol built in: `vlm_scene`, `vlm_*` messages, `models/vlm/` paths and `api.vlm.gg`.
- It is **rebuilt** from repo source as runtime version `2` with the new names. Hand-editing the bundle is still an anti-goal.
- `runtime.ts` then points at v2, and v1 is removed.
- It's rebuilt with the existing `dcl-runtime/build.sh` at the repo root (`VERSION=2`).
- Wizard Worlds already deployed on v1 get redeployed in rollout step 5. **My call.**

### Brand assets

- **Wordmark:** `/Users/unknower/-Virvi/Branding/virvi-logo-{dark,light}.svg`.
  - Dark: navy `#071323` letters with cyan `#08DDEB` dots.
  - Light: white letters.
- **Symbol:** `virvi-symbol-{dark,light}-clean.svg`.
- **Placement in the web app:**
  - The wordmark replaces `apps/web/public/vlm-logo.svg` in the landing nav.
  - The symbol becomes the favicon set: SVG favicon, 32-pixel and 16-pixel ICO, 180-pixel apple-touch icon, and a web manifest.
  - The symbol also becomes a 1200×630 share image for the web app and docs. **My call:** wordmark on graphite.
- **Quest:** a launcher icon made from the symbol, as adaptive icon mipmaps. The app has none today.
- **Docs site:** the Starlight logo and favicon.
- **Which variant goes where:** the builder picks the variant per surface for contrast. White wordmark on dark surfaces, navy on light.

## Rollout order

1. **Code** (one branch, merged locally, not deployed): all identifier, copy, logo and config-default changes, plus the database rename in `pre-push-upgrade.mjs`. The full server test suite and `check-upgrade-push.sh` pass on Postgres 16 and 18. The web, docs and Quest builds succeed.
2. **Infrastructure:** this needs the owner prerequisites first.
   - Add virvi.org and `api.virvi.org` as Railway custom domains, with DNS in Cloudflare.
   - Point `cdn.virvi.org` at R2.
   - Add Fly certificates for `live.`, `ingest.`, `worlds.`, `*.worlds.` and `worlds-cdn.virvi.org`.
   - Set the router's `ROUTER_DOMAIN`.
   - Verify every host serves before anything redirects.
3. **Deploy:** update the Railway settings and deploy the branch. Check health, login, WebSocket, the CDN, a stream and a Hyperfy world, all on virvi.org.
4. **Redirect:**
   - Run the stored-URL rewrite.
   - Detach `vlm.gg` and `api.vlm.gg` from Railway.
   - Add Cloudflare 301 rules for every vlm.gg web host, virvi.net and virvixr.com.
5. **Publish:**
   - Publish `@virvixr/dcl` and deprecate `vlm-dcl`.
   - Rename the three GitHub repos.
   - Redeploy the test Decentraland scenes and wizard Worlds with the new package or runtime.
   - Rename the Railway project and service.
6. **Quest:** build and sideload Virvi AR (`org.virvi.ar`). Check pairing and App Links on virvi.org.

Steps 2 to 6 are pushes, deploys, publishes and external changes, so each needs the owner's go-ahead at the time it happens.

## Left to the builder

- How to batch the code rename. Codemods, moving directories with `git mv`, then fixing imports is the expected approach. `pnpm-lock.yaml` is regenerated, not hand-edited.
- Exactly which favicon sizes to make and which tool generates them.
- Rewording copy where "VLM" sits mid-sentence. Plain "Virvi" is the default, and a product name like "Virvi Studio" is used only where the feature clearly is that product.
- The order of the Railway domain and settings changes inside step 2, as long as vlm.gg never stops serving before virvi.org works.
