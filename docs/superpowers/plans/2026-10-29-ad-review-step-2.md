# Ad Review Queue and Owner Content Settings (Ad Platform Step 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Virvi reviews every ad before it can show anywhere: an admin approves it with a family-friendly or mature label, or rejects it with a reason. Each ad space's owner chooses family-friendly only, allow all, or approve only, and approves or declines specific ads on approve-only spaces. Ad serving honours both.

**Architecture:**
- **Review state lives on `ads`**, with every decision also written to a new `ad_reviews` log. One server function, `recordReview`, makes all decisions. It takes a reviewer that is either a named person or the AI, so an AI reviewer can call the same function later without changing anything else.
- **The owner's setting and approvals get their own tables** (`ad_space_settings`, `ad_space_approvals`), keyed by element id. They are not element properties. That keeps them out of reach of editors and booking renters, who can write element properties. Booking clones read their original's rows, the same way placements already work in `ads/select.ts`.
- **Serving changes in one place:** `selectAdsForElements` filters on review state, audience and the space's setting through a pure, tested `adAllowed` rule. In-world code (`packages/core`, `adapter-dcl`) doesn't change.

**Tech Stack:** TypeScript, Fastify, drizzle and Postgres, vitest, Next.js (apps/web).

**Spec:** `docs/superpowers/specs/2026-10-19-ad-platform-design.md`, sections "Owner controls, per ad space", "Review" and "Build order" step 2. Step 1 is `docs/superpowers/plans/2026-10-19-ad-spaces-step-1.md`, already on main.

## Global Constraints

- Owner settings, verbatim from the spec:
  - **Family-friendly only:** only ads reviewed as safe for all ages.
  - **Allow all:** any approved ad, including mature ones such as alcohol.
  - **Approve only:** nothing shows until the owner approves that specific ad.
- Review, verbatim: "The reviewer approves the ad, or rejects it with a reason, and labels it family-friendly or mature." "An ad moves from pending to approved or rejected, and records who decided it: a named person, or the AI."
- VLM reviews every ad before it can show anywhere. This includes house ads.
- Not in this step: the AI reviewer itself, buying, rentals, refunds, payouts and self-hosted sync. The spec's rules on network campaigns skipping approve-only spaces, and on rentals needing approval, arrive with step 3. They will use the same `ad_space_approvals` rows.
- Do not change subscription billing (`apps/server/src/routes/billing.ts`, the subscription paths of `apps/server/src/integrations/stripe.ts`).
- New tables and columns go in both `apps/server/src/db/schema.ts` and the idempotent "Ads" block in `apps/server/entrypoint.sh`. Use `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
- Use Virvi names in all new copy and code. New code must pass `node scripts/check-no-vlm.mjs`.
- Node 22 for builds and tests: `export PATH=~/.nvm/versions/node/v22.23.3/bin:$PATH`. Server tests need the local test database, as for step 1.

## Fixed values (the spec leaves these to the builder; this plan decides them)

- `AdContent = 'family' | 'all' | 'approve'`. A space with no settings row is `'family'`, the safest choice.
- `AdAudience = 'family' | 'mature'`. The reviewer sets it when approving; it is null until then.
- `AdReviewStatus = 'pending' | 'approved' | 'rejected'`. New ads start `'pending'`. The migration also sets existing ads to pending. Production has 0 ads, so nothing that is showing disappears.
- **What sends an ad back to review:** a change to `clickUrl`, adding a creative, or deleting one. This blocks approve-then-swap. Name, status and date changes don't.
- **Approving needs content:** an ad with no creatives can't be approved (`400 ad_has_no_creatives`).
- **A rejection reason is required:** at least 1 character after trimming, at most 500.
- **Who changes owner settings and approvals:** full scene access only, meaning owner, co-host or global admin (`isFullAccess`). Editors and booking grant holders can't.
- **Approve-only covers every ad, house ads included.** On an approve-only space, an ad still needs Virvi's approval first, but its audience label doesn't restrict it: the owner's own approval covers it.
- **An owner's decision is per element.** Approving on a video screen doesn't approve the same ad on another space. A declined ad doesn't show and isn't offered again. The owner can change the decision later.

## Review Focus

1. **The ad changes after approval.** If a reviewed ad's click URL or creatives change, it stops serving until it is reviewed again. Test: Task 3, `editing click url or creatives after approval sends the ad back to pending and stops it serving`.
2. **An editor or booking renter tries to change the owner setting or approve an ad.** They get 403, and the setting is unchanged. Test: Task 4, `editors and booking grant holders cannot change the setting or decide ads`.
3. **A booking clone of an approve-only space.** It follows its original's setting and approvals. Approvals made on the original apply to the clone, and nothing has to be approved twice. Test: Task 2, `a booking clone uses its original's setting and approvals`.
4. **A mature ad placed on a family-friendly space,** and an unreviewed house ad on any space. Neither is served, and the space falls back to other ads, its fallback image, or hidden. Test: Task 2, `mature and unreviewed ads never reach a family space`.
5. **An owner decides on an ad that can't show in that space,** such as a wrong shape, a rejected ad, or an element from another scene. The request is refused, and no approval row is written. Test: Task 4, `refuses decisions on ads that are not candidates for the space`.

---

### Task 1: Vocabulary, schema and the review function

**Files:**
- Modify: `packages/shared/src/ads.ts`
- Modify: `apps/server/src/db/schema.ts` (Ads section), `apps/server/entrypoint.sh` (Ads block)
- Create: `apps/server/src/ads/review.ts`
- Test: `apps/server/test/ads-review.test.ts`, and update `apps/server/test/ads-schema.test.ts`

**Interfaces:**
- Produces, in `@virvixr/shared`:
  - `AdContent`, `AdAudience`, `AdReviewStatus`, `AD_CONTENT_DEFAULT: AdContent = 'family'`.
  - `AdReviewer = { kind: 'human'; userId: string } | { kind: 'ai'; label: string }`.
  - `AdminAd` gains `review: { status: AdReviewStatus; audience: AdAudience | null; reason: string | null; reviewerKind: 'human' | 'ai' | null; reviewedAt: string | null }`.
  - `AdminAdSpace` gains `content: AdContent`.
- Produces, in the schema:
  - `ads` gains `reviewStatus` (text, not null, default `'pending'`), `audience` (text, null), `rejectReason` (text, null), `reviewerKind` (text, null), `reviewedBy` (uuid, references users, on delete set null), `reviewedAt` (timestamptz, null).
  - `adReviews` (`ad_reviews`): `id` bigserial, `adId` (cascade), `decision` ('approved' | 'rejected' | 'reset'), `audience`, `reason`, `reviewerKind` ('human' | 'ai' | 'system'), `reviewerId` (uuid, null), `reviewerLabel` (text, null), `createdAt`. Index on `(ad_id, created_at)`.
  - `adSpaceSettings` (`ad_space_settings`): `elementId` (uuid, primary key, references scene_elements, cascade), `content` (text, not null), `updatedBy` (uuid, null), `updatedAt`.
  - `adSpaceApprovals` (`ad_space_approvals`): `adId` (cascade), `elementId` (cascade), `decision` ('approved' | 'declined'), `decidedBy` (uuid, null), `decidedAt`. Primary key `(ad_id, element_id)`.
- Produces, in `apps/server/src/ads/review.ts`:
  - `recordReview(adId: string, d: { decision: 'approved'; audience: AdAudience } | { decision: 'rejected'; reason: string }, by: AdReviewer): Promise<'ok' | 'not_found' | 'no_creatives' | 'bad_reason'>`. It updates `ads` and appends to `ad_reviews` in one transaction.
  - `resetReview(adId: string, tx?): Promise<void>`. It sets the ad to pending, clears audience, reason and reviewer, and logs `decision: 'reset'` with `reviewerKind: 'system'`. It does nothing if the ad is already pending.

- [ ] **Step 1: Write the failing tests** in `ads-review.test.ts`:
  - `approving records the audience and the named reviewer, and logs it`: after `recordReview(id, { decision: 'approved', audience: 'mature' }, { kind: 'human', userId })`, the ad row has `reviewStatus 'approved'`, `audience 'mature'`, `reviewerKind 'human'`, `reviewedBy userId`. There is one `ad_reviews` row with decision `'approved'`.
  - `rejecting needs a reason and clears the audience`: `{ decision: 'rejected', reason: '  ' }` returns `'bad_reason'` and changes nothing. A 501-character reason also returns `'bad_reason'`. `reason: 'Misleading claim'` gives `reviewStatus 'rejected'`, `rejectReason 'Misleading claim'` and `audience null`.
  - `an ad with no creatives cannot be approved` returns `'no_creatives'`.
  - `an AI reviewer is recorded as the AI`: `{ kind: 'ai', label: 'reviewer-v1' }` gives `reviewerKind 'ai'`, `reviewedBy null`, and the log's `reviewerLabel` is `'reviewer-v1'`.
  - `resetReview returns an approved ad to pending and logs a system reset`.

  In `ads-schema.test.ts`, assert that a new ad defaults to `reviewStatus 'pending'`, and that `ad_space_settings` and `ad_space_approvals` cascade when their element is deleted.
- [ ] **Step 2: Run them.** `cd apps/server && npx vitest run test/ads-review.test.ts test/ads-schema.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the shared types, the schema, the entrypoint block lines, and `review.ts`. Validate the reason after `trim()`.
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): ad review state, review log and owner ad space tables`

### Task 2: Serving honours review, audience and the owner setting

**Files:**
- Create: `apps/server/src/ads/content.ts`
- Modify: `apps/server/src/ads/select.ts`
- Test: `apps/server/test/ads-content.test.ts` (pure); `apps/server/test/ads-select.test.ts` and `apps/server/test/ads-serve.test.ts` (update their `mkAd` helpers to insert `reviewStatus: 'approved', audience: 'family'`, so step 1's tests keep their meaning)

**Interfaces:**
- Consumes: Task 1's columns and tables.
- Produces:
  - `adAllowed(content: AdContent, ad: { reviewStatus: AdReviewStatus; audience: AdAudience | null }, ownerDecision: 'approved' | 'declined' | null): boolean` in `content.ts`.
  - `spaceContentFor(elementIds: string[]): Promise<Map<string, AdContent>>` in `content.ts`. Each element id maps to its own setting, or else to its `clonedFromId`'s setting, or else to `AD_CONTENT_DEFAULT`.

The rule (this is the whole algorithm):

```ts
if (ad.reviewStatus !== 'approved') return false
if (content === 'approve') return ownerDecision === 'approved'
if (content === 'family') return ad.audience === 'family'
return true // 'all'
```

- [ ] **Step 1: Write the failing tests.**
  - In `ads-content.test.ts`, a table test of `adAllowed` covering all 3 settings × {pending, rejected, approved family, approved mature} × owner decision {null, approved, declined}. Assertions that matter: pending and rejected are always false; `approve` with null or declined is false; `approve` with an approved mature ad is true.
  - In `ads-select.test.ts`:
    - `mature and unreviewed ads never reach a family space`: one family space with no settings row. It gets a pending house ad, an approved mature house ad, and an approved family house ad, all in its shape. Only the family ad is served.
    - `allow all serves mature ads`.
    - `approve only serves only the ads the owner approved on that element`: of two approved ads, one approved by the owner, one declined, and one undecided, only the approved one is served. An ad approved by the owner on another element isn't served here.
    - `a booking clone uses its original's setting and approvals`: the original is `approve` with ad A approved. A clone (`clonedFromId` set, no rows of its own) serves A only.
    - `partner ads still win over house ads, after filtering`: a placed partner ad that the setting filters out leaves house ads serving, not an empty space.
- [ ] **Step 2: Run them.** `npx vitest run test/ads-content.test.ts test/ads-select.test.ts test/ads-serve.test.ts`. Expected: the new tests FAIL, and the existing tests still pass once the helpers are updated.
- [ ] **Step 3: Implement.** Select the review columns in `selectAdsForElements`. Load settings with `spaceContentFor`. Load approvals for all lookup ids (element and `clonedFromId`) in one query. An element's own approval row wins over its original's. Filter `fits` through `adAllowed` before choosing partner over house.
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): serve only reviewed ads that the space's owner setting allows`

### Task 3: Admin review API

**Files:**
- Modify: `apps/server/src/routes/admin-ads.ts`
- Test: `apps/server/test/admin-ads.test.ts`

**Interfaces:**
- Consumes: `recordReview` and `resetReview` from Task 1, and `spaceContentFor` from Task 2.
- Produces:
  - `POST /api/admin/ads/:id/review`, with body `{ decision: 'approved', audience: 'family' | 'mature' }` or `{ decision: 'rejected', reason: string }`. It returns `{ ad: AdminAd }`. Errors: 404 for an unknown ad, `400 ad_has_no_creatives`, `400 reason_required`, and `400 audience_required` for an approval without a valid audience.
  - `GET /api/admin/ads?review=pending` returns only pending ads, oldest first. Without the query parameter it returns all ads, as today.
  - `GET /api/admin/ads/spaces` includes `content` on each space.
  - Every `AdminAd` carries `review`.

- [ ] **Step 1: Write the failing tests.**
  - `a new ad is pending and the queue lists it`.
  - `approve with a label, reject with a reason`: check the response bodies and the 400 cases above. Add the review route to the existing "non-admins get 403" list.
  - `editing click url or creatives after approval sends the ad back to pending and stops it serving`. Approve an ad with a 1:1 creative. `selectAdsForElements` serves it on a 1:1 space. Then `PATCH { clickUrl }` makes it pending and it no longer serves. Re-approve it. Adding a creative makes it pending; re-approve; deleting a creative makes it pending. A `PATCH { name }` or `{ status }` leaves it approved.
  - `spaces report each space's content setting, family by default`.
- [ ] **Step 2: Run them.** `npx vitest run test/admin-ads.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Call `resetReview` inside the same request after a `clickUrl` change, a creative insert, or a creative delete. Call it only when the `clickUrl` value actually changes. Reviews are made by `{ kind: 'human', userId: request.user.id }`.
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): admin ad review queue; edits send an ad back to review`

### Task 4: Owner ad space API

**Files:**
- Create: `apps/server/src/routes/ad-spaces.ts`; register it in `apps/server/src/app.ts` next to `adminAdsRoutes`
- Test: `apps/server/test/ad-spaces.test.ts`

**Interfaces:**
- Consumes: Task 1's tables, Task 2's `spaceContentFor` and `adAllowed`, `getSceneAccess` and `isFullAccess` from `auth/permissions.ts`, and the same shape and format logic as `select.ts`. Export `spaceFor` from `select.ts` rather than copying it.
- Produces, in `@virvixr/shared`: `OwnerAdSpace = { elementId: string; content: AdContent; ads: OwnerAdCandidate[] }` and `OwnerAdCandidate = { adId: string; name: string; clickUrl: string; house: boolean; audience: AdAudience; creatives: { id: string; kind: 'image' | 'video'; url: string }[]; decision: 'approved' | 'declined' | null }`.
- Routes. All require authentication, and full access to the element's scene. Resolve a booking clone to its original element before reading or writing:
  - `GET /api/ad-spaces/:elementId` returns `{ space: OwnerAdSpace }`. The candidates are ads that Virvi has approved, that are active and within their dates, that have at least one creative in this space's shape and formats, and that are house ads or partner ads placed on this element. Each candidate lists only those matching creatives.
  - `PUT /api/ad-spaces/:elementId/content` with body `{ content: AdContent }` returns `{ space: OwnerAdSpace }`. An invalid value gets `400 content_must_be_family_all_or_approve`.
  - `PUT /api/ad-spaces/:elementId/approvals/:adId` with body `{ decision: 'approved' | 'declined' }` returns `{ space: OwnerAdSpace }`. An ad that isn't a current candidate gets `400 ad_not_a_candidate`.
  - An element that is neither an `ad_space` nor a video in an ads mode gets `404 not_an_ad_space`.

- [ ] **Step 1: Write the failing tests.**
  - `owner reads the setting, family by default, and changes it`.
  - `candidates are approved ads in the space's shape and formats; partner ads only where placed`.
  - `owner approves and declines; serving follows`. Set the space to `approve`, approve ad A and decline ad B. `selectAdsForElements` then serves only A.
  - `editors and booking grant holders cannot change the setting or decide ads`. Both get 403 on both PUTs, and the GET also returns 403 for them. A co-host and a global admin succeed.
  - `refuses decisions on ads that are not candidates for the space`: cover a wrong shape, a rejected ad, a pending ad, a partner ad not placed here, and an unknown ad id. Each gets 400 and writes no `ad_space_approvals` row. An element id from a scene the caller doesn't own gets 403.
  - `a decision made through a booking clone is stored on the original`.
- [ ] **Step 2: Run them.** `npx vitest run test/ad-spaces.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the routes, using upserts on both tables.
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(server): owner ad space setting and per-ad approvals`

### Task 5: Dashboard: the admin review queue and the owner's setting

**Files:**
- Modify: `apps/web/src/lib/api.ts` (client calls for the review and ad-space routes), `apps/web/src/lib/ads.ts` (labels), `apps/web/src/app/(dashboard)/admin/ads/page.tsx`, and `apps/web/src/app/(dashboard)/scenes/[sceneId]/client.tsx`
- Create: `apps/web/src/components/AdSpaceContent.tsx`
- Test: `apps/web/src/lib/ads.test.ts`

**Interfaces:**
- Consumes: the routes from Tasks 3 and 4, and the shared types.
- Produces, in `lib/ads.ts`:
  - `contentLabel(c: AdContent): string`, with exactly this copy:
    - `'family'` → `'Family-friendly only'`
    - `'all'` → `'Allow all (includes mature ads such as alcohol)'`
    - `'approve'` → `'Approve each ad'`
  - `reviewBadge(r: AdminAd['review']): { text: string; tone: 'pending' | 'ok' | 'bad' }`, with exactly this copy:
    - pending → `'Awaiting review'`
    - approved family → `'Approved · Family-friendly'`
    - approved mature → `'Approved · Mature'`
    - rejected → `'Rejected'`

- [ ] **Step 1: Write the failing test** `ads.test.ts`. It asserts `contentLabel` and `reviewBadge` for every case above.
- [ ] **Step 2: Run it.** `cd apps/web && npx vitest run src/lib/ads.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Admin page:**
    - A "Review queue (N)" section at the top. It lists pending ads with their creatives' previews, and the click URL as a link that opens in a new tab.
    - Each queued ad has Approve as Family-friendly, Approve as Mature, and Reject. Reject reveals a required reason field.
    - Each `AdCard` shows its `reviewBadge` and, when rejected, the reason.
    - The Placements list shows each space's `contentLabel`. Where a mature ad is placed on a family space, it marks the space "Won't show: family-friendly space".
    - After a creative or click-URL edit, the card shows "Back in review".
  - **`AdSpaceContent`:** it takes `elementId` and `api`.
    - A "Who can advertise here" select, using `contentLabel`.
    - In approve mode, a list of candidates with previews, the click URL, Approve and Decline buttons, and the current decision.
    - Empty state: "No approved ads fit this space yet."
    - Note: "Every ad is reviewed by Virvi before it can show anywhere."
    - Render it in `AdSpaceElementEditor`, and in the video editor when `offType` is an ads mode. The component loads `GET /api/ad-spaces/:elementId` itself, and renders nothing when that returns 403. That keeps it hidden from editors and booking renters without depending on the page's role state.
- [ ] **Step 4: Run** the unit test, then `npx tsc --noEmit` and `pnpm --filter @virvixr/web build`. Expected: PASS and a clean build.
- [ ] **Step 5: Commit.** `feat(web): admin ad review queue and owner ad space setting`

### Task 6: Docs

**Files:**
- Modify: `apps/docs/src/content/docs/dashboard/ad-spaces.md`

- [ ] **Step 1:**
  - Replace the line "Buying ads, owner payouts and per-space content rules are coming later." with a short section "Who can advertise here". It covers the three settings in the spec's words, says that Virvi reviews every ad first, and explains how approve-only works, including on booking copies of a space.
  - Keep "Buying ads and owner payouts are coming later."
- [ ] **Step 2: Run** `pnpm --filter @virvixr/docs build` and `node scripts/check-no-vlm.mjs`. Expected: build complete, 0 hits.
- [ ] **Step 3: Commit.** `docs: ad space content settings and review`

## Deferred to later steps (from the spec, deliberately not here)

- **AI reviewer:** it calls `recordReview` with `{ kind: 'ai', label }`, and sends uncertain cases to the human queue by leaving them pending.
- **Step 3:** buyer-submitted ads entering this same queue; network campaigns skipping approve-only spaces that haven't approved them; rentals waiting on owner approval, with refunds for rejection or decline; the buyer's mature flag at checkout; self-hosted instances syncing each space's setting to virvi.io.
- **A written ad content policy** for reviewers to apply. This is the owner's to write, not code.
