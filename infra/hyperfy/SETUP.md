# Setting up Virvi-hosted Hyperfy worlds

A one-time runbook for the Fly, Cloudflare, DNS and Railway pieces behind hosted Hyperfy worlds. The code is in
`apps/server/src/hyperfy/`; the server offers hosted worlds only once every variable in step 7 is set
(`hyperfyHosting()` in `apps/server/src/services/hyperfy/infrastructure.ts`). Do the steps in order. Never paste a
token, password or key into a repo, a ticket or a chat.

Every world runs in `iad`, in the Fly org `vlm-worlds`, in an app named `vlm-w-<slug>`. The Fly org is separate from
`@virvixr/streaming`, and the server's token must not reach that one.

You need: `flyctl`, `docker`, `railway`, a Cloudflare account, and access to your DNS provider for `virvi.io`.

## 1. The Fly org and token

1. Create the org `vlm-worlds` in the Fly dashboard and add a payment method. A new org can't create machines without one.
2. Create an org-scoped token for the server (long-lived, named so it can be found and revoked):

   ```sh
   fly tokens create org -o vlm-worlds -n virvi-server-worlds -x 8760h
   ```

   Store it in a password manager. It becomes `FLY_API_TOKEN` in step 7. It is valid for a year, so put the renewal date in a calendar. When it expires, create a new one, update Railway and redeploy.
3. Create the app that only holds the world image's registry:

   ```sh
   fly apps create vlm-hyperfy-image -o vlm-worlds
   ```
4. Create the app the worlds database jobs run in (step 2). It has no services or addresses; the server starts a
   short-lived machine in it for each world database create or drop, and deletes the machine when it stops:

   ```sh
   fly apps create vlm-worlds-db-jobs -o vlm-worlds
   ```

## 2. The worlds database (self-run Fly Postgres)

Every world gets a schema `world_<slug>` and a Postgres role of the same name that can use only that schema. All worlds share one cluster.

The database is the self-run Fly Postgres app `vlm-worlds-pg` (Postgres 18, database `worlds`). It is reachable only inside Fly's private network, so the Virvi server (on Railway) never connects to it. Database admin SQL runs in Fly job machines (`vlm-worlds-db-jobs`, `HYPERFY_WORLDS_DB_MODE=fly-job`). The server
builds the SQL for a world's role and schema and runs it in a one-shot machine of `vlm-worlds-db-jobs`, using the world
image (`node /app/virvi/db-job.mjs`). Each create or drop runs as one transaction. The job exits 0 when it committed, 1
when a statement failed and the whole batch rolled back (nothing changed), and 2 when COMMIT itself failed, so the outcome
is unknown. After exit 2 (or a Fly error or timeout) Virvi drops the world's role and schema to be safe.

1. Run the Postgres app `vlm-worlds-pg` **in the org `vlm-worlds`** (the job machines and worlds reach it only over that org's private network), region `iad`, with database `worlds`. It is Postgres 18, and must be **Postgres 15 or newer**: the server refuses older versions with `worlds database must run Postgres 15 or newer`.
2. Take two connection strings for the app:
   - **Admin URL**: the cluster's **private** address with its admin user, which can create and drop roles and schemas. That user needs `CREATEROLE` and `CREATE` on the database, not superuser. On Postgres 16+ a `CREATEROLE` user isn't a member of the roles it creates, and `CREATE SCHEMA … AUTHORIZATION` needs it to be, so Virvi's statements grant the admin each world's role (`GRANT … TO CURRENT_USER`) before creating the world's schema, and again before dropping it. It is stored only as a Fly secret of the jobs app, which Fly injects into every job machine; the Virvi server never sees it:

     ```sh
     fly secrets set -a vlm-worlds-db-jobs DB_ADMIN_URL='<admin url>'
     ```

     (Type it at the prompt or paste from a password manager rather than leaving it in shell history.)
   - **Pooled URL**: the address on Fly's private network that the worlds can reach. This is what the worlds connect with. Replace the user and password in it with the literal placeholders `{user}` and `{password}`, giving something like `postgres://{user}:{password}@<pooled-host>:5432/<database>`. That becomes `HYPERFY_WORLDS_DB_URL_TEMPLATE`. The server fills the placeholders in with each world's own role and a random password.
3. Don't make the database public: nothing outside Fly needs to reach it. If a world database create or drop fails, the world's error says `worlds database job failed with exit code …`, and the job's one-line Postgres error (never the SQL) is in `fly logs -a vlm-worlds-db-jobs`. Exit code 1 means the batch rolled back; any other code (or a Fly error) means the outcome is unknown, and the server drops the world's role and schema as part of the cleanup. Job machines are deleted when they stop; the 5-minute sweep force-deletes any left behind (named `db-job-…`, stopped, older than 10 minutes).

## 3. The files bucket (Cloudflare R2)

World files (models, images, uploads) live in R2 under the prefix `<slug>/`, and players load them from a CDN domain.

1. Create a bucket named `virvi-hyperfy`.
2. Create an R2 API token scoped to **only** that bucket with **Object Read & Write**. Keep the access key ID, the secret and your account ID. They make up `HYPERFY_ASSETS_S3_URI`:

   ```
   s3://<access-key-id>:<secret>@<account-id>.r2.cloudflarestorage.com/virvi-hyperfy
   ```

   Give it without a trailing slash and without a world name. The server appends `/<slug>` for each world. R2 access key IDs and secrets are hex, so paste them as they are: don't URL-encode anything (Hyperfy reads the key and secret out of the URI without decoding them).
3. In the bucket's settings, add a public **custom domain** for the CDN, for example `worlds-cdn.virvi.io`. Its origin, `https://worlds-cdn.virvi.io`, becomes `HYPERFY_ASSETS_BASE_URL` (no trailing slash; the server appends `/<slug>`).
4. Add a **CORS rule** on the bucket: allow `GET` and `HEAD` from `*` (the files are public anyway). If you'd rather restrict it, list explicit origins instead, `https://*.worlds.virvi.io` and `https://vlm-w-*.fly.dev`, if R2 accepts wildcards inside origins.

## 4. DNS and the router certificate

Worlds on Pro and above live at `<slug>.worlds.virvi.io`. One router app answers for all of them (step 5), so there is one wildcard certificate and one wildcard DNS record, and nothing to do per world.

1. Create the router app and give it addresses:

   ```sh
   fly apps create vlm-worlds-router -o vlm-worlds
   fly ips allocate-v6 -a vlm-worlds-router
   fly ips allocate-v4 --shared -a vlm-worlds-router
   fly ips list -a vlm-worlds-router
   ```
2. Request the wildcard certificate:

   ```sh
   fly certs add "*.worlds.virvi.io" -a vlm-worlds-router
   fly certs show "*.worlds.virvi.io" -a vlm-worlds-router
   ```
3. At your DNS provider, add the records Fly asks for. That includes the `_acme-challenge` CNAME for the wildcard (it points under `_acme-challenge.worlds.virvi.io`; copy the exact name and target from `fly certs show`).
4. Add a wildcard record `*.worlds.virvi.io` pointing at the router's IPs from `fly ips list`: an `A` record for the IPv4 and an `AAAA` record for the IPv6.
5. Re-run `fly certs show "*.worlds.virvi.io" -a vlm-worlds-router` until the certificate reports as issued.

Worlds on Creator get `vlm-w-<slug>.fly.dev` instead, which needs no DNS or certificate.

## 5. Deploy the router

The router (`infra/hyperfy-router/`) looks at the `Host` header, answers `fly-replay: app=vlm-w-<slug>` and lets Fly forward the request to that world (also for WebSockets). Anything that isn't a world gets a 404, and `/healthz` answers `ok`. Requests with a body over 1 MB, or chunked, can't be replayed, so the router proxies those to `http://vlm-w-<slug>.flycast`. That is why router-addressed worlds get a private Flycast IP and no public IP.

```sh
cd infra/hyperfy-router
fly deploy -a vlm-worlds-router
```

`fly.toml` keeps one machine always running (`min_machines_running = 1`, no autostop) in `iad` and sets `ROUTER_DOMAIN=worlds.virvi.io`. Check it with:

```sh
curl -i https://anything.worlds.virvi.io/   # 404 "No world here" while no such world exists
```

## 6. Build and push the world image

The image is Hyperfy `dev` at `b4081eb` with `infra/hyperfy/patches/` applied in order, plus the Virvi app (see `infra/hyperfy/patches/README.md`). Hyperfy is pinned; upgrading it is a deliberate change that re-runs `infra/hyperfy/test-world.mjs`.

```sh
fly auth docker
infra/hyperfy/build.sh
```

Build the Virvi app first so `packages/hyperfy-app/dist/virvi.hyp` exists and is committed (the script refuses to run with uncommitted changes in `infra/hyperfy` or that `dist`, so the tag matches what is in the image). It builds for `linux/amd64`, pushes `registry.fly.io/vlm-hyperfy-image:<git-sha>` and prints that tag. That tag is `HYPERFY_IMAGE`.

New worlds use the current `HYPERFY_IMAGE`. Existing worlds keep their image until their next key rotation or restore, either of which moves them to the current one.

Hosted worlds get `VIRVI_WORLD_SECRET` automatically when they are created. It lets the world's server half vouch for builders who press **Link to Virvi** in the HUD. Worlds that already exist get it on their next key rotation or restore. Patch 0003 keeps the secret out of app scripts: vouching runs in a Node worker, so scripts never see it.

## 7. Railway variables

Set these on the `@virvixr/server` service:

| Variable | Value |
|---|---|
| `HYPERFY_INFRA_PROVIDER` | `fly` |
| `FLY_API_TOKEN` | the org token from step 1 |
| `FLY_WORLDS_ORG` | `vlm-worlds` |
| `HYPERFY_IMAGE` | the tag printed in step 6 |
| `HYPERFY_WORLDS_DB_URL_TEMPLATE` | the pooled URL with `{user}` and `{password}` |
| `HYPERFY_ASSETS_S3_URI` | `s3://<key>:<secret>@<account-id>.r2.cloudflarestorage.com/virvi-hyperfy` |
| `HYPERFY_ASSETS_BASE_URL` | `https://worlds-cdn.virvi.io` |
| `HYPERFY_ROUTER_DOMAIN` | `worlds.virvi.io` |
| `HYPERFY_SECRET_KEY` | 32 random bytes as 64 hex characters (`openssl rand -hex 32`); it encrypts the worlds' admin codes. Don't lose or change it, or stored admin codes become unreadable. |
| `HYPERFY_DB_JOB_APP` | optional, default `vlm-worlds-db-jobs` (the app from step 1) |
| `HYPERFY_WORLDS_DB_MODE` | optional, default `fly-job`. Leave it unset in production. `direct` makes the server connect to `HYPERFY_WORLDS_DATABASE_URL` itself (an admin URL it can reach, so local dev only); that variable is needed only in direct mode, and production doesn't set it. |

```sh
railway variables -s virvi-server --set "HYPERFY_INFRA_PROVIDER=fly" --set "FLY_WORLDS_ORG=vlm-worlds" # …and the rest
```

Enter the secret values in the Railway dashboard instead if you don't want them in your shell history.

Also add every one of these names (and `HYPERFY_WORLDS_DATABASE_URL`, which stays unset in production) to the `env` of `@virvixr/server` in `.railway/railway.ts`, each as `NAME: preserve()`. `railway config apply` deletes any variable that file doesn't list, so unlisted ones would vanish on the next apply. Run `railway config plan` before any apply.

Deploy the server (and only this way):

```sh
railway up <path-to-the-worktree> --path-as-root -s virvi-server --ci
```

## 8. Verify

1. `GET https://api.virvi.io/api/deploy/platforms` (signed in) reports `"hyperfy": true`. If it is `false`, a variable from step 7 is missing or `HYPERFY_INFRA_PROVIDER` isn't `fly`.
2. In the dashboard, open **Deploy**, pick a scene on a plan that has hosted worlds, and create a hosted world.
3. Its row goes from **Setting up…** to **Live** within 3 minutes (the server waits up to 180 seconds for the address to answer 200). The first visit to a world that was asleep takes longer.
4. Open the address, type the admin code shown on creation as `/admin <code>`, and check the scene shows.
5. Destroy the test world. It frees its slot and removes its Fly app, its database schema and role, and its files in the bucket.

If creation fails, the row shows the error and the world is cleaned up; the server logs (`[hyperfy-hosting]`) have the detail without any secrets.

## Running costs and housekeeping

- Worlds stop when idle (`autostop`) and wake on the next visit, so a quiet world costs little. The worlds database is the fixed cost.
- A sweep runs every 5 minutes: it ends temporary worlds at their end date (stopping them and freeing the slot) and, 30 days after that, deletes the schema, bucket files and Fly app.
- Rotate the Fly token before it expires (step 1).
