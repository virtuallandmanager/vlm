# Hyperfy patches

Patches applied, in order, on top of Hyperfy `dev` at `b4081eb` when building VLM's Hyperfy world image
(`infra/hyperfy/Dockerfile`). Upgrading Hyperfy is a deliberate change: regenerate the patches on the new commit and
re-run `infra/hyperfy/test-world.mjs`.

- `0001-script-websockets.patch`: opt-in `WebSocket` for app scripts, limited to the origins in
  `PUBLIC_SCRIPT_WEBSOCKET_ORIGINS` (unset = no WebSocket, stock behaviour). Scripts get a small wrapper, and an
  app's sockets close when it is torn down; a socket that fails to connect on the server still fires `close`. The two
  commits of hyperfy-xyz/hyperfy#167 (`git format-patch b4081eb..cee496a`). Until the PR lands, the image applies this.
- `0002-vlm-app.patch`: VLM only, never for upstream. Adds `src/server/vlm.js`, run by `getDB` after Hyperfy's
  migrations on every boot. It reads the VLM app from `/app/vlm/vlm.hyp` (`VLM_APP_PATH` overrides it), uploads its
  assets with Hyperfy's `assets.upload`, upserts blueprint `vlm` with props `feedUrl` = `VLM_FEED_URL` and
  `worldKey` = `VLM_WORLD_KEY` (version bumped when anything changes), and keeps exactly one `vlm` entity, created at
  the origin. `$scene` and every other app are left alone. On Postgres it skips `CREATE SCHEMA` when `DB_SCHEMA`
  already exists, because world roles have no CREATE on the database (VLM creates the schema first).
- `0003-vlm-world-secret.patch`: VLM only, never for upstream. Hosted worlds vouch for their builders with VLM while
  the world secret stays out of every script. The server half of the shipped VLM app gets
  `app.vlmVouch({ hyperfyPlayerId, playerName, pendingPairingId })`. Node checks that the player is connected and is a
  builder or admin, POSTs `${VLM_FEED_URL}/api/hyperfy/pairings/vouch` with `VLM_WORLD_KEY` and `VLM_WORLD_SECRET`,
  and resolves only the expected fields of VLM's answer, or `{ status: 'error' }`.
  - **Who gets it:** `src/server/vlm.js` remembers, in server memory only, the script asset `installVlmApp` installed
    for blueprint `vlm`. `App.getScriptAppProxy` adds `vlmVouch` to a proxy made for that one script run, on the server
    only, for blueprint `vlm` only, and only while that blueprint's script is still that asset. A builder's edited
    script is a new asset, so it sees undefined, and so does any callback it leaves behind after the shipped script is
    restored. Clients, other apps and self-run worlds (any of the three env vars unset) also see undefined.
  - **Why a worker thread:** the request runs in a worker thread, which reads the secret from its own copy of the env.
    All app scripts share the server's realm, and Hyperfy's `lockdown()` (`__hardenTaming__: 'unsafe'`) leaves its
    intrinsics mutable. A script can hook `Object.prototype.toJSON` or `JSON.stringify` and see any secret the main
    thread serialises, even through references captured at load. The worker is a separate realm.
  - **Never exposed:** the secret is never in blueprint props, entity state, snapshots, `/env.js`, any packet or any
    log.

## Testing and building

```sh
# a built, patched Hyperfy tree: clone at b4081eb, `git am` the patches, `npm ci && npm run build` (Node 22)
node infra/hyperfy/test-world.mjs <hyperfy-src-dir>
docker build --platform linux/amd64 -f infra/hyperfy/Dockerfile .   # from the repo root
infra/hyperfy/build.sh                                                # build and push registry.fly.io/vlm-hyperfy-image:<sha>
```
