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

## Testing and building

```sh
# a built, patched Hyperfy tree: clone at b4081eb, `git am` the patches, `npm ci && npm run build` (Node 22)
node infra/hyperfy/test-world.mjs <hyperfy-src-dir>
docker build --platform linux/amd64 -f infra/hyperfy/Dockerfile .   # from the repo root
infra/hyperfy/build.sh                                                # build and push registry.fly.io/vlm-hyperfy-image:<sha>
```
