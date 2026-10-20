# Setting up VLM-hosted Hyperfy worlds

A one-time runbook for the Fly, Cloudflare, DNS and Railway pieces behind hosted Hyperfy worlds. The code is in
`apps/server/src/hyperfy/`; the server offers hosted worlds only once every variable in step 7 is set
(`hyperfyHosting()` in `apps/server/src/services/hyperfy/infrastructure.ts`). Do the steps in order. Never paste a
token, password or key into a repo, a ticket or a chat.

Every world runs in `iad`, in the Fly org `vlm-worlds`, in an app named `vlm-w-<slug>`. The Fly org is separate from
`vlm-streaming`, and the server's token must not reach that one.

You need: `flyctl`, `docker`, `railway`, a Cloudflare account, and access to your DNS provider for `vlm.gg`.

## 1. The Fly org and token

1. Create the org `vlm-worlds` in the Fly dashboard and add a payment method. A new org can't create machines without one.
2. Create an org-scoped token for the server (long-lived, named so it can be found and revoked):

   ```sh
   fly tokens create org -o vlm-worlds -n vlm-server-worlds -x 8760h
   ```

   Store it in a password manager. It becomes `FLY_API_TOKEN` in step 7. It is valid for a year, so put the renewal date in a calendar. When it expires, create a new one, update Railway and redeploy.
3. Create the app that only holds the world image's registry:

   ```sh
   fly apps create vlm-hyperfy-image -o vlm-worlds
   ```

## 2. The worlds database (Fly Managed Postgres)

Every world gets a schema `world_<slug>` and a Postgres role of the same name that can use only that schema. All worlds share one cluster.

1. Create a Managed Postgres cluster in `vlm-worlds`, region `iad`, plan **Basic** (about $38 per month, see fly.io/docs/mpg). It must be **Postgres 15 or newer**: the server refuses older versions with `worlds database must run Postgres 15 or newer`.
2. From the cluster's page take two connection strings:
   - **Admin URL**: the cluster's admin user, which can create and drop roles and schemas. It becomes `HYPERFY_WORLDS_DATABASE_URL`. Only the VLM server uses it.
   - **Pooled URL**: the pooled (PgBouncer) address that is reachable on Fly's private network. This is what the worlds connect with. Replace the user and password in it with the literal placeholders `{user}` and `{password}`, giving something like `postgres://{user}:{password}@<pooled-host>:5432/<database>`. That becomes `HYPERFY_WORLDS_DB_URL_TEMPLATE`. The server fills the placeholders in with each world's own role and a random password.
3. The VLM server (on Railway) reaches the admin URL over the public internet, so it must be a host the cluster accepts from outside Fly. If the cluster only offers a private address, make the public one available before continuing.

## 3. The files bucket (Cloudflare R2)

World files (models, images, uploads) live in R2 under the prefix `<slug>/`, and players load them from a CDN domain.

1. Create a bucket named `vlm-hyperfy`.
2. Create an R2 API token scoped to **only** that bucket with **Object Read & Write**. Keep the access key ID, the secret and your account ID. They make up `HYPERFY_ASSETS_S3_URI`:

   ```
   s3://<access-key-id>:<secret>@<account-id>.r2.cloudflarestorage.com/vlm-hyperfy
   ```

   Give it without a trailing slash and without a world name. The server appends `/<slug>` for each world. URL-encode the key or secret if they contain special characters.
3. In the bucket's settings, add a public **custom domain** for the CDN, for example `worlds-cdn.vlm.gg`. Its origin, `https://worlds-cdn.vlm.gg`, becomes `HYPERFY_ASSETS_BASE_URL` (no trailing slash; the server appends `/<slug>`).
4. Add a **CORS rule** on the bucket: allow `GET` and `HEAD` from `*` (the files are public anyway). If you'd rather restrict it, list explicit origins instead, `https://*.worlds.vlm.gg` and `https://vlm-w-*.fly.dev`, if R2 accepts wildcards inside origins.

## 4. DNS and the router certificate

Worlds on Pro and above live at `<slug>.worlds.vlm.gg`. One router app answers for all of them (step 5), so there is one wildcard certificate and one wildcard DNS record, and nothing to do per world.

1. Create the router app and give it addresses:

   ```sh
   fly apps create vlm-worlds-router -o vlm-worlds
   fly ips allocate-v6 -a vlm-worlds-router
   fly ips allocate-v4 --shared -a vlm-worlds-router
   fly ips list -a vlm-worlds-router
   ```
2. Request the wildcard certificate:

   ```sh
   fly certs add "*.worlds.vlm.gg" -a vlm-worlds-router
   fly certs show "*.worlds.vlm.gg" -a vlm-worlds-router
   ```
3. At your DNS provider, add the records Fly asks for. That includes the `_acme-challenge` CNAME for the wildcard (it points under `_acme-challenge.worlds.vlm.gg`; copy the exact name and target from `fly certs show`).
4. Add a wildcard record `*.worlds.vlm.gg` pointing at the router's IPs from `fly ips list`: an `A` record for the IPv4 and an `AAAA` record for the IPv6.
5. Re-run `fly certs show "*.worlds.vlm.gg" -a vlm-worlds-router` until the certificate reports as issued.

Worlds on Creator get `vlm-w-<slug>.fly.dev` instead, which needs no DNS or certificate.

## 5. Deploy the router

The router (`infra/hyperfy-router/`) looks at the `Host` header, answers `fly-replay: app=vlm-w-<slug>` and lets Fly forward the request to that world (also for WebSockets). Anything that isn't a world gets a 404, and `/healthz` answers `ok`. Requests with a body over 1 MB, or chunked, can't be replayed, so the router proxies those to `http://vlm-w-<slug>.flycast`. That is why router-addressed worlds get a private Flycast IP and no public IP.

```sh
cd infra/hyperfy-router
fly deploy -a vlm-worlds-router
```

`fly.toml` keeps one machine always running (`min_machines_running = 1`, no autostop) in `iad` and sets `ROUTER_DOMAIN=worlds.vlm.gg`. Check it with:

```sh
curl -i https://anything.worlds.vlm.gg/   # 404 "No world here" while no such world exists
```

## 6. Build and push the world image

The image is Hyperfy `dev` at `b4081eb` with `infra/hyperfy/patches/` applied in order, plus the VLM app (see `infra/hyperfy/patches/README.md`). Hyperfy is pinned; upgrading it is a deliberate change that re-runs `infra/hyperfy/test-world.mjs`.

```sh
fly auth docker
infra/hyperfy/build.sh
```

Build the VLM app first so `packages/vlm-hyperfy-app/dist/vlm.hyp` exists and is committed (the script refuses to run with uncommitted changes in `infra/hyperfy` or that `dist`, so the tag matches what is in the image). It builds for `linux/amd64`, pushes `registry.fly.io/vlm-hyperfy-image:<git-sha>` and prints that tag. That tag is `HYPERFY_IMAGE`.

New worlds use the current `HYPERFY_IMAGE`. Existing worlds keep their image until their next key rotation or restore, either of which moves them to the current one.

## 7. Railway variables

Set these on the `vlm-server` service:

| Variable | Value |
|---|---|
| `HYPERFY_INFRA_PROVIDER` | `fly` |
| `FLY_API_TOKEN` | the org token from step 1 |
| `FLY_WORLDS_ORG` | `vlm-worlds` |
| `HYPERFY_IMAGE` | the tag printed in step 6 |
| `HYPERFY_WORLDS_DATABASE_URL` | the admin URL from step 2 |
| `HYPERFY_WORLDS_DB_URL_TEMPLATE` | the pooled URL with `{user}` and `{password}` |
| `HYPERFY_ASSETS_S3_URI` | `s3://<key>:<secret>@<account-id>.r2.cloudflarestorage.com/vlm-hyperfy` |
| `HYPERFY_ASSETS_BASE_URL` | `https://worlds-cdn.vlm.gg` |
| `HYPERFY_ROUTER_DOMAIN` | `worlds.vlm.gg` |
| `HYPERFY_SECRET_KEY` | 32 random bytes as 64 hex characters (`openssl rand -hex 32`); it encrypts the worlds' admin codes. Don't lose or change it, or stored admin codes become unreadable. |

```sh
railway variables -s vlm-server --set "HYPERFY_INFRA_PROVIDER=fly" --set "FLY_WORLDS_ORG=vlm-worlds" # …and the rest
```

Enter the secret values in the Railway dashboard instead if you don't want them in your shell history.

Also add every one of these ten names, plus `HYPERFY_DB_JOB_APP` and `HYPERFY_WORLDS_DB_MODE` (see the Postgres notes) to the `env` of `vlm-server` in `.railway/railway.ts`, each as `NAME: preserve()`. `railway config apply` deletes any variable that file doesn't list, so unlisted ones would vanish on the next apply. Run `railway config plan` before any apply.

Deploy the server (and only this way):

```sh
railway up <path-to-the-worktree> --path-as-root -s vlm-server --ci
```

## 8. Verify

1. `GET https://api.vlm.gg/api/deploy/platforms` (signed in) reports `"hyperfy": true`. If it is `false`, a variable from step 7 is missing or `HYPERFY_INFRA_PROVIDER` isn't `fly`.
2. In the dashboard, open **Deploy**, pick a scene on a plan that has hosted worlds, and create a hosted world.
3. Its row goes from **Setting up…** to **Live** within 3 minutes (the server waits up to 180 seconds for the address to answer 200). The first visit to a world that was asleep takes longer.
4. Open the address, type the admin code shown on creation as `/admin <code>`, and check the scene shows.
5. Destroy the test world. It frees its slot and removes its Fly app, its database schema and role, and its files in the bucket.

If creation fails, the row shows the error and the world is cleaned up; the server logs (`[hyperfy-hosting]`) have the detail without any secrets.

## Running costs and housekeeping

- Worlds stop when idle (`autostop`) and wake on the next visit, so a quiet world costs little. The Managed Postgres Basic plan is the fixed cost.
- A sweep runs every 5 minutes: it ends temporary worlds at their end date (stopping them and freeing the slot) and, 30 days after that, deletes the schema, bucket files and Fly app.
- Rotate the Fly token before it expires (step 1).
