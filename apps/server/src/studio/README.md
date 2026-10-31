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
| `events.ts` | progress on the bus, relayed to the page by the `virvi_studio` room (`src/ws/VirviStudioRoom.ts`) |
| `pricing.ts` | what finalizing costs: first finalize, extra pieces, half-price revisions, and the checker gate |
| `payments.ts` | one-time Stripe Checkout for finalizing and top-ups, applied once from the webhook; entitlements, finalize jobs, mistake refunds |
| `scope.ts` | keeping the studio to design work: the turn-down log, flags for the owner (and their email), pausing an account |
| `sweep.ts` | every minute: fails lost jobs and refunds them, restarts machines for waiting jobs, destroys idle machines |

Routes: `src/routes/studio.ts` (the dashboard, `/api/studio`) and `src/routes/studio-worker.ts` (the workers,
`/api/studio/worker`). Every studio route answers 404 unless the studio is enabled.

## Paying

- **Finalizing** a piece pays for its latest revision: `GET /designs/:id/finalize` quotes it, `POST` opens a Stripe
  Checkout (or grants at once when every line is waived). The webhook makes an *entitlement* per paid revision and
  queues a `finalize` job, which builds the package from that revision's stored files. The owner downloads it from
  `GET /designs/:id/pieces/:category/revisions/:number/package`; a failed package is retried free with `…/package/retry`.
- **Revisions** (every finalize after a piece's first) are half price. A customer who says the revision fixed the
  agent's mistake (`…/report`, within 30 days, or at checkout) is refunded that line in full, at once.
- **Top-ups** (`POST /topups`) add prompts used after the day's allowance; they never expire.

## Deploying (the owner's steps)

The studio is on when `VIRVI_MODE=cloud` and both `STUDIO_WORKER_IMAGE` and `STUDIO_S3_URI` are set.

1. **A private R2 bucket.** In Cloudflare, create a bucket `vlm-studio` with no public access and no custom domain,
   and an R2 API token with Object Read & Write on that bucket only. It must not be the public uploads bucket.
2. **Railway variables** on the server service:
   - `STUDIO_S3_URI=s3://<access key id>:<secret>@<account id>.r2.cloudflarestorage.com/vlm-studio`
   - `STUDIO_WORKER_IMAGE=registry.fly.io/vlm-studio-worker:<tag>`, the image deployed from `apps/studio-worker`
   - `STUDIO_FLY_APP` only if the worker app isn't `vlm-studio-worker`
   - optional: `STUDIO_CLAUDE_MODEL` (default `claude-opus-5-5`), `STUDIO_CODEX_MODEL` (default `gpt-6.1-sol`),
     `STUDIO_GROK_MODEL` (default `grok-build-0.1`)
3. **The schema.** Run `drizzle-kit push` against production: the eleven `studio_*` tables (four of them for payments)
   and two new columns (`studio_designs.finalized_at`, `studio_jobs.counted_from`).
4. **Fly.** Confirm that the server's `FLY_API_TOKEN` can manage machines in `vlm-studio-worker`, in the
   `FLY_WORLDS_ORG` org (`vlm-worlds`). The agent keys are that app's secrets (`fly secrets import -a
   vlm-studio-worker`), never Railway variables or machine env.
5. **Spend limits** on the Anthropic and OpenAI keys: the daily cost ceilings are a backstop, not a budget.
6. **Stripe.** On the existing webhook endpoint (`/api/billing/webhook`), also enable `checkout.session.completed`
   (already on for subscriptions), `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`
   and `checkout.session.expired`. Nothing
   needs creating in Stripe: prices are sent with each checkout. They are settings, in US cents:
   `STUDIO_PRICE_WEARABLE_CENTS` (2900), `STUDIO_PRICE_EXTRA_PIECE_CENTS` (1900), `STUDIO_PRICE_EMOTE_CENTS` (3900),
   `STUDIO_REVISION_WEARABLE_CENTS` (1500), `STUDIO_REVISION_EXTRA_PIECE_CENTS` (1000), `STUDIO_REVISION_EMOTE_CENTS`
   (2000), `STUDIO_TOPUP_CENTS` (500) and `STUDIO_TOPUP_PROMPTS` (10).
7. **The worker image** must be rebuilt and pushed for finalize jobs: it adds ffmpeg and Decentraland's animations
   (`apps/studio-worker/README.md`, "Releasing an image"), then `STUDIO_WORKER_IMAGE` points at the new tag.

8. **Keeping the studio to design work** (`scope.ts`, `routes/admin-studio.ts`, the admin page Studio flags):
   - The worker checks each prompt the user typed with Claude Haiku before the agent runs (`studio_worker/scope.py`).
     An off-topic message ends as `off_topic`, not counted for the first `STUDIO_FLAG_THRESHOLD` in the window and counted
     after that; an agent that stops on one ends as `declined` (counted).
     Both are logged in `studio_scope_events`; the user sees only a category's fixed words, never the model's note.
   - An account with `STUDIO_FLAG_THRESHOLD` (3) turn-downs within `STUDIO_FLAG_WINDOW_HOURS` (24) is flagged once,
     and the owner is emailed at `STUDIO_FLAG_EMAIL` (unset: nothing is sent). Admins dismiss flags and pause or
     resume an account's studio access; a paused account can't send prompts, start designs, request renders, upload or
     buy top-ups, and can still finalize, pay and download.
   - A piece's first `STUDIO_INSTANT_REPORTS` (2) mistake reports refund at once; later ones are charged and wait for
     the owner's Approve or Decline on the same page, with an email.
   - **The owner's steps:** SMTP (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM`) and
     `STUDIO_FLAG_EMAIL` on Railway; no email goes out without SMTP.
   - **Deploy order:** the server first (it accepts the `off_topic` and `declined` outcomes and creates the new tables
     at boot), then the worker image: `fly deploy --build-only --push --remote-only --image-label <sha>` from
     `apps/studio-worker`, then `e2e/fly.sh <image>`, then `e2e/scope_eval.py` on a machine of that image (it fails if
     a designer's message would be turned down), then `STUDIO_WORKER_IMAGE` on Railway.

To check a deploy's machine lifecycle without a user: `scripts/studio-fly-smoke.ts`. To run a real worker against
a local server: `scripts/studio-local.md`.
