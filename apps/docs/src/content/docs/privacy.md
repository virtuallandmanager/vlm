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
