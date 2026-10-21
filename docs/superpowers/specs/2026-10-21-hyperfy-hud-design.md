# Hyperfy HUD: design

Status: approved by the owner, 2026-10-21.

## Intent

A VLM owner or collaborator standing in a Hyperfy world that runs the VLM app can edit that VLM scene from inside the world, the way the VLM HUD works in Decentraland. They can:

- move things;
- show and hide them;
- switch presets;
- turn a stream on or off;
- add models from their library, the catalog or a GLB link.

Every edit saves to VLM, so the dashboard, Decentraland and every Hyperfy world showing that scene follow.

This works in hosted worlds and in worlds people run themselves. Hyperfy players have no wallets, so VLM learns who they are through a pairing code, which the owner approves on the website.

## What exists to build on

- **The VLM app for Hyperfy** (`packages/vlm-hyperfy-app`). It is display-only today.
  - The server half long-polls the scene feed with the world key and hands snapshots to browsers through `app.send`.
  - The client half renders nodes from `planScene`/`diffPlans`.
- **Edit logic:** `packages/vlm-core/src/transform/session.ts` (`TransformSession`) is pure. It covers:
  - modes: move, rotate and resize;
  - axis lock and snap;
  - drags from a ray;
  - typed values;
  - save and revert.

  The DCL HUD drives it, and the Hyperfy HUD can bundle and drive the same class.
- **Edit endpoints a scene pass can already call (REST):**
  - `PUT /api/instances/:id` for transforms;
  - `PUT /api/elements/:id` with `enabled` for show/hide;
  - `PUT /api/scenes/:sceneId` with `activePresetId` for presets;
  - `POST /api/presets/:presetId/elements`, then `POST /api/elements/:id/instances`, to place a model;
  - the scene library routes.
- **Not available to a scene pass today:**
  - adding a catalog model to the scene library;
  - turning a stream on or off. The DCL path is the room message `scene_video_update`, which isn't saved.
- **Patterns to reuse for pairing:**
  - The auth hand-off (`routes/auth-handoff.ts`): a hashed single-use code with a TTL, claimed atomically, rate-limited, never logged.
  - The companion-upload code and its QR endpoint (`routes/companion-upload.ts`).
- **Scene passes** are issued today only after a Decentraland wallet signature (`POST /api/auth/platform`).
  - A pass acts as its user only inside its bound scene.
  - Scopes come from `getSceneAccess`, and routes opt in through `scenePass.sceneFrom`.
  - Passes last 15 minutes and have no refresh token.

## Goals

- **Pair, then edit.** A signed-in VLM user links their Hyperfy session to their VLM account in under a minute. From then on, the HUD edits with that user's VLM roles: owner, collaborator, or host during a booking.
- **Edit mode feels like Decentraland's.** It has:
  - the same Move / Rotate / Resize bar;
  - axis lock (free, X, Y, Z) and snap;
  - an exact-value panel;
  - Save / Revert / Done.
- **Panels:**
  - **Scene layout:** each object with show/hide, plus the preset switcher.
  - **Streams:** go live and go offline for each screen.
  - **Asset browser:** the scene's library, the catalog, or a GLB link, then "Place in front of me".
  - **Alerts:**
    - link status: "Linked to VLM as <name>", "Link expired, pair again";
    - saved, or couldn't save, with the reason;
    - lost connection and reconnected, from the HUD's own requests failing and recovering;
    - stream live or offline, from the feed's snapshots;
    - "Added here. Decentraland needs a redeploy to show it", when a model is added.
- **Visitors see nothing new.** Only a linked player sees the HUD's editing tools.
- **Works in self-run worlds too,** including stock Hyperfy without the WebSocket patch.

## Non-goals (for now)

- **Live drag previews for other editors.** In Decentraland, other editors see a drag as it happens. From Hyperfy, an edit shows up for everyone when it's saved, within about a second, through the feed.
- **"A host joined or left" alerts in Hyperfy.** They come from the Decentraland room, which the Hyperfy browser doesn't join. A linked Hyperfy editor also doesn't show up as a host to Decentraland hosts.
- **Moderation controls** (moderator messages, pinned notes). That is roadmap project 2, built for Decentraland and Hyperfy together.
- **The Events and Worlds panels.** These need rethinking for multi-world events first.
- **Uploading files from inside Hyperfy.** Uploads go through the dashboard or the existing phone upload page. The HUD places what's already in the library or catalog, or a GLB link.
- **Automatic Decentraland redeploys.** That is roadmap project 4. The alert only tells the user a redeploy is needed.

## Anti-goals

- **An edit authorized by the world key.** Any visitor can read the world key, because Hyperfy shares app settings with every client. It must never grant edit rights.
- **Trusting a self-run world's server with a user's identity.** Its operator controls that server, so there it must not be able to edit as a linked user on its own.
- **A HUD that gets in visitors' way.** Nothing is drawn until a player is linked, except a small "Link to VLM" button for world admins and builders.

## How it works

### Pairing: a browser-held pass

1. **The admin asks to link.** A world admin or builder clicks "Link to VLM" in the HUD. Scripts can read `player.admin` and `player.builder`. In a world with no admin code, everyone counts as admin, so everyone sees the button. That's harmless, since approval still needs VLM access to the scene.
2. **The browser makes a secret.** The client half makes a random pairing secret from three `uuid()` values joined. `uuid()` is nanoid over `crypto.getRandomValues`, about 59.5 bits each, so 128+ bits in total. The secret stays in that browser's script memory.
3. **The browser asks VLM for a code.** It calls `POST /api/hyperfy/pair` with the world key and a SHA-256 of the secret. The bundle needs a small pure-JS SHA-256, since there's no `crypto` in the sandbox. Here the world key only identifies the world and its scene. VLM returns a short code (for example `K7Q-4XP`, valid 10 minutes) and a link to `vlm.gg/pair/<code>`.
4. **The HUD shows the code** with a QR code (an image from VLM, like the upload QR) and the link.
5. **The user approves on the website.** The page asks "Link Hyperfy world <name> (scene <scene>) to your account?" and shows the Hyperfy player's display name.
   - Approving requires editing access to that scene through `getSceneAccess`: owner, admin, cohost, editor, or a booking host.
   - A booking host may approve at any time. Their tools work only while their booking is live, exactly as in Decentraland, because scopes are resolved per request.
   - A Hyperfy pass carries the approving user's verified wallet when they have one, so wallet-matched booking grants apply.
6. **The browser claims the pass.** The client half polls `POST /api/hyperfy/pair/<code>/claim` with the secret. After approval, VLM returns:
   - a **Hyperfy pass**: a scene pass for the approving user, bound to the world's scene, 15 minutes;
   - a **pairing id**.

   Claims are single-use, rate-limited, and the secret is checked by its hash.
7. **The browser renews.** Before expiry it calls `POST /api/hyperfy/pair/<pairing id>/renew` with the secret. VLM issues a fresh pass while the pairing is valid.
8. **The user can revoke.** Pairings are listed under the user's account on the website. Revoking cuts editing off at once: a Hyperfy pass carries its pairing id, and the auth middleware rejects it as soon as the pairing is revoked or expired. That's one indexed lookup per request that carries a Hyperfy pass.

**Storage:** pairings are `hyperfy_pairings` rows with the world, user, secret hash, the Hyperfy player id (hosted worlds), and the created, expires, last-used and revoked times. Scene-pass claims are extended with `via: 'hyperfy'`, `pairingId` and `worldId`.

### Remembering the link (decided with the owner)

- **VLM-hosted worlds remember it per browser.**
  - Hyperfy gives each browser a stable player id per world (it keeps its own auth token in the browser), and scripts read it as `player.id`.
  - VLM's image patch gives the VLM app's *server* half a server-only secret, `VLM_WORLD_SECRET`. It comes from the machine env and is never sent to browsers, unlike blueprint props.
  - When a linked player comes back, the server half vouches "player <id> in world <world>" to VLM with that secret. VLM then issues that browser a fresh Hyperfy pass for the user who approved the original pairing. The pass reaches the browser through `app.sendTo`.
  - The pairing is tied to the world and the Hyperfy player id. It lasts until revoked, or until 90 days unused (Claude's call).
- **Self-run worlds pair once per visit.**
  - Their operator controls the server and could claim to be any player, so there's no vouching.
  - The browser-held secret applies, with a pairing of up to 12 hours, and a reload means a new code.
  - The owner accepted this: "if you're connecting to a non-vlm hosted world, you have to re-authenticate each time you want to make edits from hyperfy".
- **The address bar never carries pairing state.**

### Making edits

The client half calls VLM's REST routes directly with the Hyperfy pass, from the browser. These are the same routes and permission checks the dashboard and the DCL HUD use, so roles behave the same everywhere.

New or changed routes:

- **Stream toggle:** `POST /api/elements/:id/live` with `{ enabled }`.
  - It saves the screen's "live stream on" setting (`enableLiveStream`).
  - It also sends the room the same `scene_video_update` the DCL HUD sends, so Decentraland and every Hyperfy world follow (Hyperfy through the feed).
  - Whether a stream is actually live (`isLive`) stays the streaming server's to set.
  - It has the same permission (`screens`) and booking-window rules as the room message.
- **Catalog to library:** allow a scene pass on adding a catalog item to the scene library, under the same permission as library edits.
- **No feed or protocol version change.** Edits go to REST, and the feed is unchanged.

### Edit mode in Hyperfy

- **Selection.** Clicking a VLM object while edit mode is on selects it.
  - It uses each node's `onPointerDown`, which is Hyperfy's render raycast. `world.raycast` only hits physics colliders, and VLM nodes get no colliders, so visitors don't bump into them.
  - While edit mode is on, clicks select instead of opening an object's link.
  - Non-VLM objects in the world can't be selected by the HUD; Hyperfy's own build mode handles them.
- **Gizmo.** The client draws handles as Hyperfy nodes: arrows and planes for move, rings for rotate, a cube for uniform scale.
  - It feeds pointer rays into `TransformSession` and previews the draft locally on the selected node.
  - On Save it sends `PUT /api/instances/:id`. The change then comes back through the feed like any other edit.
- **Pointer rays.** Scripts get the camera's position and rotation and the pointer's screen position, but not the field of view.
  - With the pointer locked, the ray is exact.
  - Unlocked drags assume Hyperfy's default field of view (Claude's call; the builder checks it against the source).
- **Edit bar and panels.** These are Hyperfy screen UI (`ui`, `uiview`, `uitext`, `uiimage`). They mirror the DCL HUD's layout and copy where Hyperfy's UI nodes allow.
  - The exact-value panel uses `app.control()` digit, minus and letter keys, with on-screen buttons, since there's no text input.
- **Input.** Keys and pointer come through `app.control()`.
  - Shift cycles the axis lock, as in DCL. If Hyperfy already uses a key, the HUD uses a fallback and the bar shows the hint.
  - Edit mode takes over the pointer only while it's on.

### Browser calls to VLM (decided with the owner)

- VLM's API accepts browser calls from any origin, without credentials. No cookies are ever sent or needed, since every request carries its bearer token.
- The global CORS setting changes from a production allowlist with `credentials: true` to any origin with `credentials: false`. Check first that nothing in the dashboard relies on cookies.
- The client half's `fetch` returns `undefined` on a network or CORS failure instead of throwing. The HUD treats that as "lost connection".

### The worlds design's old non-goal

`docs/superpowers/specs/2026-10-19-hyperfy-worlds-design.md` listed "Editing the scene from inside the Hyperfy world" as a non-goal for now. This design replaces that line, which gets updated to point here.

## Constraints

- **Hyperfy sandbox:**
  - Only the script globals: `world`, `app`, `fetch`, `props`, `setTimeout`, `Math`, `Date.now`, `num`, `uuid`, `prng` and three.js math.
  - No `localStorage`, `crypto`, `TextEncoder` or `setInterval`, and `URL` only as `createObjectURL`.
- **Secrets.** Never log pairing secrets, codes, passes or `VLM_WORLD_SECRET`. Codes are shown on screen by design, so they're short-lived and single-use.
- **Hosted image.** The `VLM_WORLD_SECRET` change goes into `infra/hyperfy/patches/0002-vlm-app.patch` and the provisioner's machine env. Existing hosted worlds get it on their next image update.
- **Off limits:** billing code.
- **Deploying:** only with `railway up <worktree> --path-as-root -s vlm-server --ci`.

## Left to the builder

- Exact HUD layout within Hyperfy's UI nodes.
- Gizmo geometry.
- Key fallbacks.
- Polling intervals for pairing claims.
- Where the pairings list sits on the website.
- How the server-only secret reaches the server half's script: a server-only proxy value or a fetch header injected by the patch. Never through props.
