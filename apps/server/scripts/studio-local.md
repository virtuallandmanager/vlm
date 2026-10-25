# Running a real studio worker against a local server

The Docker worker image talks to a server on your machine, with real agents. Everything stays local except the
agents' calls to Anthropic or OpenAI, which spend real money (about $0.15 for one Codex prompt that builds a hat).

1. **A database.** With the dev Postgres running:

   ```bash
   docker exec vlm-dev-postgres-1 psql -U vlm -d postgres -c 'CREATE DATABASE vlm_studio_local'
   cd apps/server && DATABASE_URL=postgres://vlm:vlm_dev@localhost:5432/vlm_studio_local pnpm exec drizzle-kit push --force
   ```

2. **The server**, in cloud mode with a file store and no Fly (`STUDIO_MACHINES=external`: you run the worker):

   ```bash
   cd apps/server && VLM_MODE=cloud PORT=3010 JWT_SECRET=studio-local-secret STORAGE_PROVIDER=local \
     DATABASE_URL=postgres://vlm:vlm_dev@localhost:5432/vlm_studio_local \
     STUDIO_WORKER_IMAGE=vlm-studio-worker:dev STUDIO_S3_URI=file:///tmp/studio-store STUDIO_MACHINES=external \
     PUBLIC_URL=http://host.docker.internal:3010 pnpm exec tsx src/index.ts
   ```

3. **A design and its worker token:**

   ```bash
   cd apps/server && DATABASE_URL=postgres://vlm:vlm_dev@localhost:5432/vlm_studio_local JWT_SECRET=studio-local-secret \
     PUBLIC_URL=http://host.docker.internal:3010 VLM_MODE=cloud pnpm exec tsx scripts/studio-local-design.ts wearable codex
   ```

   It prints `{designId, workerToken, accessToken}`.

4. **The worker**, built by `apps/studio-worker/e2e/network.sh` (or `docker build -t vlm-studio-worker:dev
   apps/studio-worker`), with the agent keys from `apps/studio-worker/.env`:

   ```bash
   docker run --rm --platform linux/amd64 --cap-add NET_ADMIN --env-file apps/studio-worker/.env \
     -e VLM_API_URL=http://host.docker.internal:3010 -e STUDIO_WORKER_TOKEN=<workerToken> \
     -e STUDIO_DESIGN_ID=<designId> -e STUDIO_IDLE_EXIT_SEC=900 vlm-studio-worker:dev
   ```

5. **A prompt**, as the dashboard sends it:

   ```bash
   curl -sS -X POST http://localhost:3010/api/studio/designs/<designId>/prompts \
     -H "authorization: Bearer <accessToken>" -H 'content-type: application/json' \
     -d '{"text": "A rounded cyberpunk cap with a glowing neon visor strip across the front. Make it for both body shapes.", "selectedSlots": ["hat"]}'
   ```

   Then `GET /api/studio/designs/<designId>` shows the reply, the hat's revision and its render URLs (swap
   `host.docker.internal` for `localhost` to open them from your machine). The `vlm_studio` room carries the progress.
