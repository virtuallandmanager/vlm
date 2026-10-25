# Design Studio (server)

People design Decentraland wearables and emotes by talking to an agent (Claude Code or Codex). Each design gets its
own Fly worker machine (`apps/studio-worker`), which talks to the routes here through
`apps/studio-worker/CONTRACT.md`.

| File | What |
|---|---|
| `store.ts` | the private studio bucket, and the contract's file paths |
| `quota.ts` | the daily prompt allowance and the hidden daily cost ceiling, per plan (`TIER_LIMITS`) |
| `machines.ts` | one Fly worker machine per design, and its worker token (only the hash is stored) |
| `results.ts` | applying a worker's Result once, and failing lost jobs |
| `designs.ts` | prompts, renders, view keys and the design detail the dashboard reads |
| `render-urls.ts` | signed, hour-long URLs for render frames: the only files a browser receives |
| `events.ts` | progress on the bus, relayed to the page by the `vlm_studio` room (`src/ws/VLMStudioRoom.ts`) |
| `sweep.ts` | every minute: fails lost jobs and refunds them, restarts machines for waiting jobs, destroys idle machines |

Routes: `src/routes/studio.ts` (the dashboard, `/api/studio`) and `src/routes/studio-worker.ts` (the workers,
`/api/studio/worker`). Every studio route answers 404 unless the studio is enabled.

## Deploying (the owner's steps)

The studio is on when `VLM_MODE=cloud` and both `STUDIO_WORKER_IMAGE` and `STUDIO_S3_URI` are set.

1. **A private R2 bucket.** In Cloudflare, create a bucket `vlm-studio` with no public access and no custom domain,
   and an R2 API token with Object Read & Write on that bucket only. It must not be the public uploads bucket.
2. **Railway variables** on the server service:
   - `STUDIO_S3_URI=s3://<access key id>:<secret>@<account id>.r2.cloudflarestorage.com/vlm-studio`
   - `STUDIO_WORKER_IMAGE=registry.fly.io/vlm-studio-worker:<tag>`, the image deployed from `apps/studio-worker`
   - `STUDIO_FLY_APP` only if the worker app isn't `vlm-studio-worker`
   - optional: `STUDIO_CLAUDE_MODEL` (default `claude-opus-5-5`), `STUDIO_CODEX_MODEL` (default `gpt-6.1-sol`)
3. **The schema.** Run `drizzle-kit push` against production (seven new `studio_*` tables).
4. **Fly.** Confirm that the server's `FLY_API_TOKEN` can manage machines in `vlm-studio-worker`, in the
   `FLY_WORLDS_ORG` org (`vlm-worlds`). The agent keys are that app's secrets (`fly secrets import -a
   vlm-studio-worker`), never Railway variables or machine env.
5. **Spend limits** on the Anthropic and OpenAI keys: the daily cost ceilings are a backstop, not a budget.

To check a deploy's machine lifecycle without a user: `scripts/studio-fly-smoke.ts`. To run a real worker against
a local server: `scripts/studio-local.md`.
