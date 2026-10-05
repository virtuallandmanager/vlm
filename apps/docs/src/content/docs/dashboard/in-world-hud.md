---
title: In-World HUD
description: Control and monitor your scenes from within Decentraland.
---

## Management and access control

The management HUD and all scene-changing messages now require a signed-in, verified user with permission for that scene. Visitors still receive scene updates. Clients receive `auth_status`, `venue_access` and `access_revoked` messages, and `vlm_error { code, messageType }` when a message is rejected. The error codes are:

- `forbidden` — the user lacks permission for the requested action
- `not_found` — the requested scene or resource does not exist
- `server_error` — the handler threw an unhandled exception
