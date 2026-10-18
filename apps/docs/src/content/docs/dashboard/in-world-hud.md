---
title: In-World HUD
description: Control and monitor your scenes from within Decentraland.
---

## Management and access control

The management HUD and all scene-changing messages now require a signed-in, verified user with permission for that scene. Visitors still receive scene updates. Clients receive `auth_status`, `venue_access` and `access_revoked` messages, and `vlm_error { code, messageType }` when a message is rejected. The error codes are:

- `forbidden` — the user lacks permission for the requested action
- `not_found` — the requested scene or resource does not exist
- `server_error` — the handler threw an unhandled exception

## Moving things in-world

Editors can move, rotate and resize placed models, images, screens and sounds without leaving Decentraland.

Open the Layout panel and press **Edit layout**. The button shows for editors, cohosts and hosts. Renters and venue renters never see it. Items have to be visible (synced) in your scene before you can edit them.

Click an item to select it, then pick a mode on the bar:

- **Move:** click and drag. The item lands where your pointer hits the scene. Tap **Shift** to cycle Free, X, Y, Z, then back to Free. The locked axis shows as a guide line (red for X, green for Y, blue for Z) and follows the scene's axes.
- **Rotate:** drag one of three rings. Hold **Shift** to turn in 15° steps.
- **Resize:** drag the corner handle to scale evenly, or an axis handle to stretch one way. Hold **Shift** to snap (10% steps, or 0.25 m).

Changes are drafts until you press **Save**. Save stores them to the live preset only. **Revert** puts the item back. If you press **Done** with unsaved changes, you are asked what to do first.

While you hold an item, other editors see "being moved by" and your name on it and can't grab it until you save or revert. Visitors only ever see saved changes.

Shift needs a scene on Decentraland SDK 7.23 or newer.
