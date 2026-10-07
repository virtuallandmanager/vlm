# Deploying the VLM streaming server (Fly.io, one region)

One always-on Fly machine runs RTMP ingest + FFmpeg → HLS. Two fixed DNS names point at it:

- `rtmp://ingest.vlm.gg/live` — OBS "Server" (raw TCP 1935)
- `https://live.vlm.gg/streams/<key>/playlist.m3u8` — playback (HTTPS, Fly certificate)

Run every command from the **repo root**.

## 1. Create the app, volume and IPs

```bash
fly apps create vlm-streaming
fly volumes create vlm_streams --app vlm-streaming --region iad --size 10
fly ips allocate-v4 --app vlm-streaming   # dedicated IPv4 (billed monthly) — required for RTMP on 1935
fly ips allocate-v6 --app vlm-streaming
```

## 2. Secrets and API settings

Generate one shared secret: `openssl rand -hex 32`.

```bash
fly secrets set VLM_WEBHOOK_KEY=<secret> --app vlm-streaming
```

On the Railway `vlm-server` service set:

| Variable | Value |
|---|---|
| `STREAMING_WEBHOOK_KEY` | the same secret |
| `RTMP_INGEST_URL` | `rtmp://ingest.vlm.gg/live` |
| `HLS_BASE_URL` | `https://live.vlm.gg/streams` |
| `ENABLE_STREAMING` | `true` (cloud mode already enables it) |

The API must be deployed with the streaming changes (`/api/streaming/authorize`) **before** the media server, or every publish is refused.

## 3. Deploy

```bash
fly deploy . --config apps/streaming/fly.toml
```

## 4. DNS (Cloudflare — DNS only / grey cloud)

`fly ips list --app vlm-streaming` shows the addresses.

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `ingest` | the dedicated v4 | DNS only |
| A | `live` | the dedicated v4 | DNS only |
| AAAA | `live` | the v6 | DNS only |

Then:

```bash
fly certs add live.vlm.gg --app vlm-streaming
fly certs show live.vlm.gg --app vlm-streaming   # wait for "Issued"
```

Never proxy (orange cloud) either record: RTMP can't pass Cloudflare's proxy, and Fly's certificate check needs direct DNS.

## 5. Verify

1. `curl https://live.vlm.gg/health` → `{"status":"ok",...}`.
2. Dashboard → Streaming → provision a stream.
3. OBS: Server `rtmp://ingest.vlm.gg/live`, Stream Key = the key.
4. Paste the stream's Playback URL into a test-scene video screen's Live URL and enable live streaming on it.
5. Go live → the screen switches to the stream (also for a second client that joins mid-stream). Stop → it goes back.
6. An unknown key is refused: `fly logs --app vlm-streaming` shows `[rtmp reject]`.

## Capacity

One `performance-2x` machine runs about `MAX_STREAMS=4` concurrent 720p transcodes; extra publishes are refused. Raise the VM size and `MAX_STREAMS` (in `fly.toml`) together.

## Existing streams

Streams provisioned before the env change still hold `localhost` URLs. Delete and re-provision them.
