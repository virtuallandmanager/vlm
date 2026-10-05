---
title: Analytics
description: Zero-config visitor analytics for Decentraland LANDs and Worlds.
---

VLM analytics start collecting as soon as a scene calls `startVLMAnalytics()` or `createVLM()`. No account is needed to collect; sign in with the wallet that owns the LAND or World to see the data.

## What you get
- **Claims:** claim a LAND or World with the owning wallet to unlock its data.
- **Summary:** visits, unique visitors, session length and top countries.
- **Timeseries:** visits and visitors over time.
- **Live:** who is in the scene right now.
- **Heatmap:** where visitors walk and spend time.
- **Sessions:** individual visits and their events.
- **Wallet visibility:** optionally store wallet addresses and display names. Visitors see a notice when this is on. See [Privacy](/privacy/).

## Status
The charts UI arrives with the next dashboard update. Until then the data is available through the API endpoints under `/api/analytics/locations/...`.
