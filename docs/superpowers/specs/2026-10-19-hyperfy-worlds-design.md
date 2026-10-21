# Hyperfy Worlds: design

Status: approved by the owner, 2026-10-19.

## Intent

A VLM user deploys a scene to Hyperfy from the dashboard and gets a real Hyperfy world, at its own web address. When they walk in, it already shows that scene: screens, images, models (including library and catalog GLBs) and sounds, laid out as they are in Decentraland, and live-updating when they edit in the dashboard.

Today none of this works:

- **No hosting.** Production has no Hyperfy hosting. Deploys used to fall back to a development stub that faked a `localhost:4000` world; that is now refused (shipped in 61e2cc3).
- **Broken provider code.** The Fly provider code is a sketch that can't work. It gives all worlds one shared app but promises each a separate address, keeps no storage, and sets the world's address after it starts.
- **The adapter targets the old Hyperfy.** `packages/vlm-adapter-hyperfy` is written for the original React-based Hyperfy (`useWorld` and `useFields`). Current Hyperfy (0.16) runs apps as sandboxed scripts that use `app` and `world` objects.

## Two projects, in this order

1. **The VLM app for Hyperfy, plus the scene feed it reads.** This works in any Hyperfy world, including one somebody runs themselves.
2. **Fly.io world hosting.** Deploying from the dashboard creates a world with the VLM app already installed and pointed at the scene.

Project 1 is testable on a locally run Hyperfy world before hosting exists. Project 2 is what makes it a VLM product.

## Goals

- **Deploying gives a real world.** "Deploy to Hyperfy" produces a working world at its own address within a couple of minutes.
- **The scene is there on first visit.** The world shows the deployed scene the first time anyone enters, with no manual setup.
- **Edits show up live.** A change in the dashboard appears in the world without a redeploy.
- **Destroying works.** It removes the world and frees its slot.
- **Worlds can be permanent or temporary.** A temporary world ends at a set date.
- **Idle worlds cost almost nothing.**

## Non-goals (for now)

- Custom domains. These are a later Pro perk.
- A region picker. Every world starts in US East (`iad`), where the streaming server runs.
- Wallet sign-in inside Hyperfy. Hyperfy players have Hyperfy accounts, so their visits count as unverified analytics.
- Ads in Hyperfy worlds. The ad platform's step 1 is Decentraland only.
- Editing the scene from inside the Hyperfy world. Designed separately: see `docs/superpowers/specs/2026-10-21-hyperfy-hud-design.md`.

## Anti-goals

- **A world that loses its content** when a machine restarts or is replaced.
- **A "deployed" status for a world that isn't actually reachable.** That is the bug that started this.
- **Weakening Hyperfy's sandbox for every world.** WebSockets are opt-in and limited to allowed origins.
- **Tracking Hyperfy's `latest` release.** Its scripting API is still alpha and breaks between versions.

## Decided with the owner

### Hosting

- **Platform:** Fly.io, on the same account as the `vlm-streaming` app.
- **One Fly app per world,** each with its own address, set before the world first starts.
- **World data:** a dedicated Postgres on Fly, in the same region as the worlds (`iad`) and inside the worlds' Fly organisation, separate from VLM's Railway database. Each world has its own schema in it (Hyperfy's `DB_URI` and `DB_SCHEMA`) and connects as its own Postgres role that can only use that schema. The VLM server reaches it to create and drop worlds' schemas and roles. The owner chose this over sharing VLM's Railway Postgres: it's faster for worlds, keeps them away from VLM's own data, and keeps their connections off VLM's limit, at the cost of one more monthly bill. Check Fly's current Postgres pricing before choosing the plan size.
- **World files:** VLM's existing R2 bucket, using Hyperfy's `ASSETS=s3`. Machines hold nothing that can be lost.
- **Sleeping:** a world stops when it's idle and starts on the next request.
- **Permanent or temporary:** a world can be either. A temporary world shuts down at its end date and frees its slot. Its data is kept for 30 days (my guess, not confirmed), and destroying the world early deletes it.
- **Limits per plan, counting every world that exists, asleep or awake:**

  | Plan | Worlds |
  |---|---|
  | Free | 0 |
  | Creator | 1 |
  | Pro | 3 |
  | Studio | 10 |
  | Enterprise | set per customer |

  Destroying a world frees its slot.
- **Address:**
  - Creator: `vlm-w-<slug>.fly.dev`.
  - Pro and up: `<slug>.worlds.vlm.gg`. This needs a small routing service on Fly in front of the worlds, or a certificate per world; that choice is left to the builder.

### WebSockets in Hyperfy apps

- **Stock Hyperfy scripts have no `WebSocket`.** This was verified in Hyperfy's SES sandbox and in a running world.
- **The patch:** VLM wrote one that adds an opt-in `WebSocket`, limited to the origins in `PUBLIC_SCRIPT_WEBSOCKET_ORIGINS`.
  - It was tested on Hyperfy `dev` in a real world, on both the server and a browser.
  - It is open upstream as hyperfy-xyz/hyperfy#167. Hyperfy's maintainer said he'd accept a clean PR.
  - It is kept in this repo at `infra/hyperfy/patches/0001-script-websockets.patch`.
- **VLM-hosted worlds** run VLM's image, with the patch applied until it's merged and released upstream.

### What a world contains

The VLM app, already configured to show the deployed scene, so everything is in place on first visit, just as in Decentraland.

## Design calls made by Claude (flagged for review)

- **The VLM app is a small Hyperfy script, not a port of `vlm-core`.**
  - Hyperfy's sandbox gives scripts no `TextEncoder`, `TextDecoder`, `setInterval` or `crypto`, so Colyseus and msgpack (which `vlm-core` needs) won't run there.
  - The app speaks a small JSON protocol to a new VLM endpoint, and renders with Hyperfy nodes directly: `video`, `image`, `audio`, and `world.load('model', url)` for GLBs.
  - The app's server half talks to VLM and passes changes to visitors' browsers through `app.send`. Browsers don't connect to VLM themselves.
  - The old `packages/vlm-adapter-hyperfy` is replaced.
- **The scene feed: one VLM endpoint, two transports.**
  - A world authenticates with a per-world key. On connect it receives the scene snapshot (the same serialized preset the scene room sends), then the same `scene_preset_update`, `scene_change_preset` and `scene_video_status` messages as JSON.
  - **Transport 1, WebSocket.** Used when the world allows VLM's origin; this is every VLM-hosted world.
  - **Transport 2, HTTP long-poll.** For stock Hyperfy worlds. Each request returns at once if there are changes since the version the world last saw, or holds up to 25 seconds otherwise. Edits appear within about a second.
- **World key.**
  - Each deployment gets a random key, stored hashed, and shown once to people running their own Hyperfy.
  - The key identifies the world and its scene; the feed refuses a key that doesn't match the scene.
  - Hosted worlds get the key automatically (see the image below).
- **Analytics.** The app's server half posts world sessions to VLM in batches (joins, leaves, positions), as unverified visitors, through a feed-authenticated route. Visitors' browsers never post.
- **VLM's world image** (`infra/hyperfy/`):
  - Built from Hyperfy's source, pinned to a release or commit, with the patch applied, plus the VLM app as the world's starting scene app (`src/world/scene.hyp`).
  - Scripts can't read env vars, so the image's entrypoint writes the scene id, world key and feed URL into the scene app's props before Hyperfy first starts.
  - The image is published to Fly's registry.
- **Hyperfy settings set by the provisioner:**
  - `PUBLIC_WS_URL` and `PUBLIC_API_URL`, from the world's address;
  - `ASSETS_BASE_URL`, the worlds bucket's CDN domain;
  - `ADMIN_CODE`, random and stored encrypted, shown to the owner;
  - `JWT_SECRET`, random;
  - `DB_URI` and `DB_SCHEMA=world_<slug>`;
  - the `ASSETS_S3_URI` for the worlds bucket, prefix `<slug>/`;
  - `PUBLIC_SCRIPT_WEBSOCKET_ORIGINS=wss://api.vlm.gg`.
- **Plan limit storage.** `TIER_LIMITS.hyperfyInstances` already exists in `apps/server/src/integrations/stripe.ts`, set to Free 0, Creator 1, Pro 5 and Studio/Enterprise unlimited. Change it to the owner's numbers: Free 0, Creator 1, Pro 3, Studio 10, Enterprise unlimited (the per-customer override comes later). These numbers aren't shown anywhere users see, and VLM has no paying subscribers yet, so nothing is being broken. Only the limits table changes.
- **Worlds are their own records.** A new `hyperfy_worlds` table holds the world's slug, address, Fly app, key hash, scene, owner, kind (hosted or self-run), end date and status. A world outlives any single deployment.
  - **Redeploy:** the same world gets the scene's latest content; address, data and key are unchanged.
  - **One scene per world.** A scene can have several worlds.
  - **Switching scenes:** a world can be switched to another of the owner's scenes.
  - **Slots:** a slot is a hosted world that exists. Redeploys use no slot.
- **Bring your own world.** "Connect your own Hyperfy world" is a separate flow that sits outside the hosting gate.
  - It creates a self-run world record, shows its key once, and gives the VLM app (`.hyp`) to download.
  - It's open to any plan that can deploy, and it doesn't count toward the hosted-world limit, since VLM pays nothing for it.
  - This is how project 1 ships before hosting exists.
- **VLM owns the scene app in hosted worlds.**
  - On every boot, the image's entrypoint writes the current VLM app and its props (scene id, world key, feed URL) into the world's `$scene` blueprint in its schema, so app updates and key rotation reach existing worlds on their next start.
  - The app and the feed protocol carry a version number. The feed keeps answering the previous protocol version for one release.
  - Owners get the admin code and may build anything else in their world; only `$scene` is VLM's.
  - In self-run worlds the owner installs and updates the app themselves.
- **A dedicated R2 bucket for worlds.** World files go in their own bucket (`vlm-hyperfy`), with an API token scoped to that bucket only, so a world machine can't touch VLM user uploads.
  - In S3 mode Hyperfy doesn't serve `/assets`, so `ASSETS_BASE_URL` is that bucket's public CDN domain (for example `worlds-cdn.vlm.gg`), with CORS allowing world origins.
  - Files uploaded inside a world don't count toward the owner's VLM storage for now.
- **Plan changes.**
  - A world keeps its address for life. Only worlds created on Pro or higher get `worlds.vlm.gg`, and an upgrade doesn't move existing worlds.
  - A downgrade that leaves an owner over the limit blocks new worlds but keeps existing ones running.
- **Temporary worlds.**
  - An end date is optional, set at deploy and editable any time before it passes: extend it, or clear it to make the world permanent.
  - At the end date the world's Fly app stops and the world frees its slot.
  - The world's data, slug and key are kept for 30 days, during which the owner can restore it if they have a free slot. After that a sweep deletes the schema, the bucket prefix and the Fly app.
- **A separate Fly org for worlds.** Worlds live in their own Fly organisation (`vlm-worlds`) with a token scoped to that org, so the VLM server's token can't touch `vlm-streaming`. The world image and the `worlds.vlm.gg` router live in that org too.

## Constraints

- **Billing:** don't change the subscription or billing flows.
- **Deploying the VLM server:** only with `railway up <worktree> --path-as-root -s vlm-server --ci`.
- **Secrets:** never print any (Fly API token, admin codes, world keys, DB passwords).
- **Hyperfy version:** pinned. Upgrading is a deliberate change that re-runs the world test.
- **The existing "is hosting really set up" gate** (`hyperfyHosting()`) stays the single source of truth for whether **hosted** Hyperfy worlds are offered. Connecting a self-run world doesn't depend on it.

## What exists to build on

- **Hosting gate.** `hyperfyHosting()` and the 503 `hyperfy_hosting_unavailable` in `apps/server/src/services/hyperfy/infrastructure.ts` and `routes/deploy.ts`. `GET /api/deploy/platforms` drives the dashboard's Hyperfy option.
- **Provisioning.** `HyperfyProvisioner` (`services/hyperfy/provisioner.ts`) handles provision and destroy. Destroy deletes the deployment, tearing the world down first when hosting can reach it.
- **The scene feed's message shapes.** The scene room (`apps/server/src/ws/VLMSceneRoom.ts`) and `services/scene-serializer.ts` already produce them.
- **Fly.** `vlm-streaming` shows the Fly setup and deploy pattern (`apps/streaming/DEPLOY.md`).
- **Hyperfy test harness.** The spike's approach: inject a probe into `scene.hyp`, run a fresh world, open it in headless Chrome. It's described in the PR, and `infra/hyperfy/patches/README.md` points at it.

## Left to the builder

- The `worlds.vlm.gg` routing approach: a proxy app, or a certificate per world.
- The exact JSON message shapes beyond reusing the scene room's.
- Long-poll limits and back-off.
- How the app maps VLM transforms and element properties onto Hyperfy nodes.
- How temporary worlds' end dates are enforced: a sweep job, like venue bookings.
- How the 30-day data retention is cleaned up.
