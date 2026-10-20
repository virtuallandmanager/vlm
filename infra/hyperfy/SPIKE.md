# Fly spike for hosted Hyperfy worlds (2026-10-20)

Checked against the live Fly API with an org-scoped token for `vlm-worlds`, using throwaway apps that were deleted afterwards.

| Assumption | Result |
|---|---|
| Create an app in the org: `POST /v1/apps {app_name, org_slug}` | 201 |
| Public IPs over REST: `POST /v1/apps/{app}/ip_assignments` with `{"type":"shared_v4"}` and `{"type":"v6"}` | 200 each, no GraphQL needed. `DELETE …/ip_assignments/{ip}` gives 204. |
| A machine with `autostop: "stop"`, `autostart: true`, `min_machines_running: 0` on `.fly.dev` | Served HTTPS and WebSockets. Stopped after about 7 min idle. Woke on the next request and answered in 1.8 s (a small echo server; Hyperfy boots slower). |
| A world machine uses an image pushed to another app's registry (`registry.fly.io/<image-app>:<tag>`) | Works, after `fly auth docker` and `docker push`. |
| A router app answering `307` with `fly-replay: app=<world app>` (also on `upgrade`) | HTTP and WebSockets reach the world app, even after the world app's public IPs were removed. |
| A request body over 1 MB through the router (fly-replay can't carry it) | Router proxies it over Flycast (`private_v6` from `ip_assignments`, `http://<app>.flycast`): a 5 MB POST reached the world (200) and woke a stopped one in 14.5 s. |
| New org billing | A new org can't create machines until it has a payment method. The owner added one. |

Rulings: IPs use REST `ip_assignments` only (types `shared_v4`, `v6`). Router-addressed worlds get no public IPs.
