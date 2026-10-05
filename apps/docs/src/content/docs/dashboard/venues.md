---
title: Venues & Bookings
description: Rent time-boxed control of a VLM scene to an organizer and their crew.
---

A **venue** is a scene whose owner lets others control parts of it for a booked time slot.

## Make a scene a venue
`POST /api/venues` with `sceneId`, `name`, `slug`, and `rentableElementIds` (the screens, posters and sounds renters may change). The scene's current active preset becomes the venue default.

## Bookings
Admins create bookings with `POST /api/venues/:venueId/bookings` (`renterWallet` or `renterUserId`, `title`, `startsAt`, `endsAt`). Each booking gets its own copy of the default preset. Overlapping bookings (including the venue's buffer) are rejected.

- **Setup window** — from booking until `setupLeadMinutes` before start: renters and crew edit the booking's copy; the live venue is untouched.
- **Live window** — until `graceMinutes` after the end: the copy is the live scene.
- At the end, the venue switches back to its default preset and access ends.

## Crew
The renter (host) adds crew by wallet with a role — `cohost`, `vj`, `lighting`, `performer`, `door` — and can toggle individual scopes. Crew don't need a VLM account; access attaches when their wallet signs in from Decentraland.

## Upgrading an existing instance

Before deploying to any running VLM instance, review wallet users who got `admin` role from the old auto-promote bug. The following queries list users and auth methods to review by hand. **Nothing should be deleted automatically** — review, understand the context, and make deliberate choices about role corrections.

### Wallet users with admin role

```sql
SELECT u.id, u.display_name, u.created_at, m.identifier, m.metadata->>'verified' AS verified
FROM users u JOIN user_auth_methods m ON m.user_id = u.id AND m.type = 'wallet'
WHERE u.role = 'admin'
ORDER BY u.created_at;
```

### Unverified wallet auth methods

The following query lists wallet auth methods whose identifier is not `preview:`-prefixed and whose `metadata->>'verified'` is not `'true'`. These may be accounts created from unverified body wallets by the old login route:

```sql
SELECT m.identifier, m.user_id, u.display_name, u.role, u.created_at FROM user_auth_methods m JOIN users u ON u.id = m.user_id WHERE m.type = 'wallet' AND m.identifier NOT LIKE 'preview:%' AND coalesce(m.metadata->>'verified', 'false') <> 'true' ORDER BY u.created_at;
```
