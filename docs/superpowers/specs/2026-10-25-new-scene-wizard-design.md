# Virvi Studio: New Scene Wizard

Status: draft for owner review, 2026-10-25. VLM is rebranding to **Virvi**; this feature is part of **Virvi Studio**. The code still lives in the VLM v2 repo and the site is still vlm.gg, so the wizard reads the site's public address from config (`PUBLIC_URL` / `WEB_APP_URL`) and never hardcodes a domain.

## Intent

A regular Decentraland citizen wants to put a scene out there without installing the Creator Hub. They want a friendly, browser-only way to pick a few assets, see roughly how it'll look, and get it live, then explore it and move things around in-world.

The wizard has to deploy the scene for them, because Decentraland only loads 3D models that are packed into the deployed scene. A GLB can't be streamed from a URL at runtime (confirmed in the Unity explorer: `GltfContainer.src` must be a file in the scene's content). Moving things later is already live through VLM, but which models exist is fixed at deploy time. Virvi doing the deploy is what makes this possible at all.

Success: a citizen with a Decentraland NAME goes from vlm.gg to standing in their own live World with a starter scene, without touching a terminal, in a few minutes.

## Who it's for

- **Primary:** a Decentraland citizen who isn't a developer and doesn't want the Creator Hub. Comfortable with a wallet; owns a DCL NAME (or an ENS name) and so has a World.
- **Also:** someone putting the same scene in a Hyperfy world or their own AR space (Virvi AR). One scene can go to several places at once.

## Goals

1. A browser wizard with five steps (Where, Size, Assets, Arrange, Deploy) and a live 3D preview that stays on screen the whole time.
2. Starts from ready-made themes or category filters, never the whole 5,500-model catalog at once.
3. Light-touch arranging on the website; exact placement happens in-world.
4. Virvi deploys the Decentraland scene, in one of two ways the citizen picks.
5. Ends with a "Jump in" link that drops them into their live World with the scene there and the in-world editor ready.

## Non-goals (this build)

- **Genesis City LAND.** Phase 2. Granting deploy rights on LAND is an on-chain transaction (operator / update operator / UpdateManager) and Genesis has adjacency and 15 MB-per-parcel limits. Design the Where step so LAND slots in later.
- **Virvi-run social cities** (an "archipelago" of Virvi worlds separate from Genesis City, where people deploy without owning a name). A later idea. Nothing here should rule it out: keep "destination" a general concept, not "the user's own World".
- Precise editing on the website (exact numbers, gizmos, multi-select). That's in-world.
- Authoring custom code or interactivity. The deployed scene is a generic Virvi scene.
- Uploading the user's own GLBs in the wizard (catalog only for v1; their own uploads stay in the existing asset library flow).
- The Virvi rename of existing code, packages or domains.

## Anti-goals (failure even if it technically works)

- Dumping the full catalog on someone. The Assets step must start from a theme or a category.
- Silently replacing something they already have deployed in their World. If the World already has a scene on those parcels, the wizard says so and asks before replacing it.
- Holding power over someone's wallet beyond what they chose. Mode A gets only a revocable, parcel-scoped World deploy permission; mode B never lets Virvi sign anything itself.
- A deploy that looks done but isn't. "Jump in" shows only once the World's content server has accepted the deployment.
- A scene that blows Decentraland's limits and then fails or lags. The wizard keeps a running budget and stops before the limit.

## The flow

Layout (owner's choice, mockup B): the steps sit in a column on the left, each collapsing to a one-line summary with a ✓ once done; a 3D preview of the plot fills the right side and updates as they go. On a phone the preview sits above the steps.

### 1. Where

- Sign in with their wallet (the existing wallet sign-in, `routes/wallet-auth.ts`). If they're already signed in with a linked wallet, skip.
- Virvi lists the Decentraland names the wallet owns (DCL NAMEs and ENS names) and, for each, whether its World already has a scene. They pick one. No typing coordinates or names.
- Optional extra destinations, ticked on: **Hyperfy** (connect a self-run world with a world key, or a Virvi-hosted world where their plan allows it; existing flows) and **Virvi AR** (creates an AR space shell for the scene; printing and aligning rings stays in the existing AR tab).
- At least one destination is required. A Decentraland World is the main path; Hyperfy-only and AR-only work too and simply skip the Decentraland parts of Size and Deploy.

### 2. Size

- Decentraland: choose the plot, in parcels (16 m each): 1×1, 2×2, 3×3, or custom width × depth. The step shows what that buys: triangle budget (10,000 per parcel), entity budget (200 per parcel), and how much of the owner's World storage the scene will use against what's left (100 MB per NAME owned, plus 100 MB per LAND parcel and per 2,000 MANA held, shared across all their Worlds; ENS-name Worlds have a fixed 36 MB).
- Hyperfy and AR have no hard edges; the same footprint is used as a guide for placement. (My call.)
- The plot sits at World parcels starting at 0,0. (My call; Worlds don't care where.)

### 3. Assets

As in the mockup:

- **Start from a theme:** Little park, Cozy café, Gallery, Beach hangout, Stage & venue, Empty plot. Picking one drops its starter set, already arranged, into the preview. Picking another theme asks before replacing what's there.
- **Add or swap items:** category chips (Nature, Furniture, Lighting, Buildings, Decor, …) each show a short, curated list from the catalog, with search inside the category. Adding an item places it automatically (see Arrange). Removing is a click on the item.
- **Running count:** items in the scene, triangles against the plot's budget, and size against the World's storage. Going over blocks adding more, with a plain message ("This plot fits about 40,000 triangles; that would make it 43,500").
- Themes are data, not code: a theme is a list of catalog items with positions relative to the plot, so it scales to the chosen size. Themes and category lists are curated, not generated. The builder drafts the first five themes and the category lists from the existing catalog as a plan task, and the owner reviews them before launch. How they're edited later (admin page or a file in the repo) is the builder's call. (My call.)

### 4. Arrange (light touch)

- Drag items around the preview and turn them. Items snap to the ground and can't leave the plot's edges.
- Suggested placement: a theme comes arranged; a single added item goes to a free spot near the middle using the catalog's real bounding box (`dimensions`), not overlapping other items and keeping the spawn point clear.
- A spawn point marker they can move (where people arrive).
- That's all. Exact positions, rotations and scaling happen in-world with the existing editor.

### 5. Deploy

They choose how Virvi deploys to their Decentraland World:

- **"Let Virvi deploy for me" (recommended).** They sign one free, off-chain request in their wallet that adds Virvi's deploy wallet as a collaborator on their World, scoped to the scene's parcels (`PUT /world/{name}/permissions/deployment/{address}` and its parcels endpoint, signed fetch). Virvi then deploys now, and redeploys on its own later, for example when they add a model in-world that isn't in the deployment yet. They can remove the permission anytime, on vlm.gg or in the Creator Hub.
- **"I'll sign each deploy."** Like the Creator Hub: for each deploy the browser makes a one-off key, their wallet signs once to authorise it, and that key signs the deployment. Virvi never holds anything that can deploy for them later. When they add a model in-world that needs a redeploy, it waits as "ready to publish" and the in-world editor shows a link or QR to vlm.gg to sign it.

Then:

- Progress in plain steps: "Packing your scene → Uploading 14 models → Decentraland is checking it → Live".
- If their World already had a scene, they confirmed replacing it back in step 1 or here before anything uploads. Replacing a scene needs deploy permission on the old scene's whole footprint, so if the old scene is bigger than the new plot, mode A's grant covers the old footprint too, and the wizard says so in plain words ("Your World's current scene covers 3×3 parcels, so Virvi needs permission on those to replace it"). (My call.)
- **Finished:** a "Jump in" button opens `https://decentraland.org/play/?realm=<name>` (exact URL form is the builder's to confirm). They arrive at the spawn point, the scene is there, and the in-world editor is already linked to their Virvi scene, with no "Set up VLM here" step.
- Hyperfy and AR destinations, if chosen, are connected in the same run; they need no deploy because they load models by URL.

### After the wizard: redeploys (in this build)

Both modes' later behaviour is part of this build, not a follow-up, because it's the reason Virvi deploys at all:

- **Mode A:** when someone adds a model in-world (or from the dashboard) that isn't in the deployment, Virvi redeploys automatically; the owner agreed to this. The scene reloads for people standing in it a minute or two later. Several adds close together are batched into one redeploy. (Batching is my call.)
- **Mode B:** the add is saved as "ready to publish". The in-world editor shows a link and a QR code to a vlm.gg page where the owner signs the redeploy, and the dashboard shows the same prompt.

### Runtime upgrades

The generic scene's code and the server talk through a versioned contract, and the server keeps older runtimes working. An already-deployed scene picks up a new runtime the next time it's redeployed for any reason (mode A, automatically; mode B, when they next sign). No bulk redeploy of everyone in this build. (My call.)

## How it gets made (decided)

- **One generic, pre-built Decentraland scene.** Virvi builds a single SDK7 scene (VLM's existing in-world runtime, `vlm-dcl` / vlm-core) once per Virvi release, not per user. Each deployment is that same `bin/index.js` plus a generated `scene.json` (parcels, base, spawn point, title, `worldConfiguration.name`), the chosen models' GLBs (and their textures) as content files, and a small data file telling the runtime which Virvi scene it is. No compiling at deploy time; the Worlds server never inspects the JS.
- The layout itself comes from the Virvi server at runtime, as it does today, so moving things in-world is live and needs no redeploy. Only the set of model files is fixed per deployment.
- **The current deploy page's Decentraland path is replaced, not kept alongside.** The deploy page's World/parcel deploy form and its "Deploy Wallets" section (users adding their own private keys) are removed; Decentraland deploys go through the new deployer only, and the deploy page shows a scene's destinations and deploy history. VLM has no users yet, so no migration. Genesis LAND returns in phase 2 through the new deployer. (My call.)
- **The current server deployer is replaced.** `services/dcl/deployer.ts` is a stub: it uploads only `scene.json`, signs with a server-held key without a proper auth chain, and the web form sends parcels in the wrong shape. The new deployer builds a full entity (content hashes, auth chain), checks the timestamp window (the entity must be signed and uploaded within about 5 minutes), and posts to the Worlds content server.
- **Signing in mode B:** the server assembles the deployment and its entity id; the browser makes the one-off key, the wallet signs the auth chain, the one-off key signs the entity id, and the browser sends the auth chain back for the server to upload. (The builder may upload straight from the browser instead; the Worlds server allows CORS. Either way, Virvi's server never holds the user's key.)
- **Mode A's deploy wallet** is a Virvi-held key used only for World deployments it has been granted. It lives in the server's secrets like the other keys, never in the repo or logs.
- **3D preview:** a WebGL view of the plot with a parcel grid, loading catalog GLBs, orbit camera, drag on the ground plane, rotate handle. three.js (react-three-fiber or plain) is the builder's choice; the web app has no 3D library yet.
- **Adding models in one go:** the wizard needs a server endpoint that creates the scene with its preset, links the catalog items and places all instances in one request (today it's several calls per item, nothing atomic).
- The in-world link is made server-side at deploy: the wizard knows the World and the scene, so it creates the location setup the in-world "Set up VLM here" step would have made.

## Constraints

- Decentraland per-parcel soft limits: 10,000 triangles, 200 entities. Hard: 50 MB per file, 200 files per parcel. World storage budget as in Size. Encode these server-side; the server has no limits table today.
- Worlds content server code defaults (production may differ; check before relying on them): 350 MB upload cap, 500 MB per scene.
- Contract wallets (EIP-1654) are likely rejected by the Worlds server; support ordinary wallets first and say so plainly if a contract wallet is used.
- The web app is a static-export SPA calling the Fastify server; multi-step server work (create scene + place items + deploy) should be server endpoints, not a chain of client calls.
- Billing code is off limits for changes. **Deploying to a Decentraland World through the wizard is open to every plan, free included (owner's decision).** So the wizard's Decentraland deploy and its later redeploys don't sit behind `requireFeature('deployment')`; they need only a signed-in account with the wallet that owns the World. The scene the wizard creates still counts toward the plan's scene limit (free: 3), using the existing check. Hyperfy keeps its existing plan checks (connecting a world, and hosted worlds where the plan allows it); the wizard shows those as locked with an upgrade link instead of hiding them.

## Left to the builder

- Exact UI, copy and responsive layout beyond the mockups (Virvi names in new copy).
- The 3D library and how the preview loads and caches GLBs.
- How themes and category lists are stored and edited.
- Whether mode B uploads from the browser or the server.
- How the wizard lists a wallet's names (Decentraland's NAME/ENS lookups) and detects an existing World scene.
- Retry and resume behaviour if a deploy fails partway.

## Open questions for the owner

None left. Answered after the builder check: free accounts can deploy to Decentraland with the wizard (see Constraints). The other builder questions were settled as calls marked "(My call.)" above, for the owner to check while reading.
