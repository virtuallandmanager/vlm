---
title: Privacy & visitor data
description: What VLM analytics collect in Decentraland scenes, and how to delete your data.
---

## What is collected
When a scene uses VLM, the scene sends anonymous usage events to VLM while you're inside its parcels: when you arrive and leave, where you walk (sampled every few seconds), what you click or hover, videos you play, emotes, and camera mode.

## How you're identified
- By default VLM stores a **per-scene pseudonym**: a keyed hash of your wallet (or guest id). It can't be linked across scenes and it isn't your wallet address.
- **Display names and wallet addresses are only stored** if the scene owner turns on wallet visibility. When they do, the scene shows a notice when you enter, and only data collected after that notice includes your wallet and name.
- **IP addresses are never stored.** VLM uses them briefly to limit abuse and to look up your country, then discards them.

## Retention
Raw events are kept for the scene owner's plan (7–365 days, unlimited on the top tier and self-hosted installs), 30 days for unclaimed scenes, and 7 days for local previews. Aggregated statistics (counts, heatmaps) are kept longer and contain no identities.

## Deleting your data
Call `POST /api/analytics/me/delete` with your session token. A dashboard control for this is coming. This removes your sessions, events and positions from every scene.

## VLM Spaces on Quest
VLM Spaces is the Meta Quest app that shows a VLM space in your room. It talks to vlm.gg, and only to vlm.gg.
- **Every visitor sends:** the code of the ring you look at, to find its space; a request for the space's contents (the space feed); and anonymous visit events: when you arrive and leave, and where your head is (every few seconds), in the space's own coordinates rather than your room's. Each visit uses a fresh random id that is never stored, so visits can't be linked to you or to each other.
- **Builders also send:** the edits they make to a space, the alignment of a ring, and the pairing of their headset with a VLM account. Pairing sends a hash of a secret kept on the headset, never the secret itself.
- **Never sent:** camera images and room scans. The headset's cameras are used on the headset to find rings, and your room's walls and surfaces are used on the headset to hide virtual things behind real ones and to snap items to walls. Neither leaves the headset.

Visit events follow the same retention as the rest of VLM analytics, above. They carry no identity, so there is nothing to look up or delete for a single visitor. A builder can revoke a paired headset on vlm.gg, which stops it from editing.

## Advertiser early access
When you ask for advertising early access on vlm.gg, VLM stores the email address, name, company or project, website and message you enter, and the time you sent the form. It's used only to contact you about advertising on VLM. If you send the form again with the same email, the new answers replace the old ones (fields you leave blank keep what you sent before). Your IP address is used briefly to limit repeated submissions and is not stored. To be removed from the list, email sales@vlm.gg.
