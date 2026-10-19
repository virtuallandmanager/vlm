# VLM Ad Platform: design

Status: draft for review, 2026-10-19.
Mockup of the buyer path: `.superpowers/brainstorm/43048-1792443491/content/buyer-flow.html` in the release-deploy worktree. It is not committed; this document describes it in full.

## Intent

Scene owners earn money from the builds they already run on VLM. Brands, and creators inside Decentraland, buy space on screens and billboards in those scenes. VLM sets the prices, reviews every ad, measures what each ad delivered, and pays owners.

The owner sees this as a core part of VLM's economy and part of VLM's comeback. Ads are meant to bring new people onto the platform from two directions:

- **Owners** have a new reason to build with VLM, because their scenes can pay them.
- **Buyers** who have never built anything in the metaverse arrive to advertise. They are then invited to build a branded space of their own with VLM.

Examples the owner gave:

- A vodka brand buys the screen in one nightclub, or buys "nightclubs" and rotates through every club's ad spaces.
- An emote creator buys an ad in someone's mall build, and it links to the emote's marketplace page.

## Goals

- An owner turns any VLM video screen into an ad space, or places a standalone ad space, in a few clicks.
- A buyer with no wallet and no Decentraland account can sign up with email, pay by card, and have an ad live after review.
- Buyers get a report that proves what they paid for: in scene, on screen, looked at, clicked.
- Owners get 90% of what buyers pay, paid out through their own Stripe account.
- An owner's first ad space pays off quickly, so ads become a reason to adopt VLM.

## Non-goals (for now)

- 3D model ads, audio ads, or ads that are interactive beyond a click-through link.
- Crypto payments from buyers, or crypto payouts to owners. A later USDC payout to the owner's verified wallet is expected, after a legal check.
- An AI reviewer. It comes later; the review queue is built so it can slot in without changing anything for buyers or owners.
- Bidding or auctions. VLM sets prices.
- Ads outside Decentraland (Hyperfy, Second Life and the other adapters). The data model shouldn't rule them out.

## Anti-goals: failing even if it technically works

- **Ads that make scenes worse.** Video ads fighting a club's music, the same ad on loop, frame-rate drops, or ads covering a stream. Visitors leave, and owners lose more than they earn.
- **Numbers buyers can't trust.** Self-reported views padded by alt accounts, bots or idle avatars. The first buyer who notices tells the rest.
- **Owners who never see money.** Payout minimums or holds so high that a small owner never gets a payout.
- **An empty marketplace.** A polished self-serve store with no ad spaces that get traffic. Today production has two VLM scenes and very little traffic. The owner's own answer to "what went wrong in six months" was "not enough clients building with VLM".

## Decisions made with the owner

### Ad formats and shapes

- **Formats:** an ad is an image or a video.
- **Shapes:** every ad space has exactly one shape: **16:9** landscape, **1:1** square, **9:16** portrait, or **2:5** tall. 2:5 matches the format Decentraland already uses for event images, so event organizers can reuse their art.
- **One version per shape:** a buyer uploads a version of their ad for each shape they want to show in. A campaign never shows in a shape it has no version for. Ads are never stretched or cropped.
- **Click-through:** every ad has a link.

### Ad spaces

There are two kinds of ad space.

1. **Video screens** (the existing `video` element) get two new offline modes, next to today's none, image, playlist and live (`VideoSourceType`):
   - **Ads:** while no stream is live, the screen plays a rotation of image and video ads.
   - **Playlist + ads:** the owner's playlist plays, with ads slotted in between.
2. **Standalone ad spaces** are a new element: a poster or billboard. The owner sets it to **images only**, **videos only**, or **both**, and can give it a **fallback image**.

### Live-stream rule

Video ads only play when no stream is live and enabled in the scene, because they would conflict with it. While one is live:

- A standalone space set to **both** shows image ads only.
- A **video-only** space shows its fallback image. With no fallback image, it **disappears completely**: no blank panel and no leftover collider.
- Video screens in an ads mode switch to the stream, as they do today.

Everything resumes when the stream ends.

### Owner controls, per ad space

Each ad space has one of three settings:

- **Family-friendly only:** only ads reviewed as safe for all ages.
- **Allow all:** any approved ad, including mature ones such as alcohol.
- **Approve only:** nothing shows until the owner approves that specific ad.

Buyers' campaigns respect these settings:

- A **network** campaign skips approve-only spaces that haven't approved it.
- A **rental** of an approve-only space needs the owner's approval before it starts.

### Review

VLM reviews every ad before it can show anywhere.

- **At first:** a human review queue in the admin dashboard. The reviewer approves the ad, or rejects it with a reason, and labels it family-friendly or mature.
- **Later:** an AI reviewer goes through the queue first. It passes clear cases, rejects clear violations, and sends uncertain ones to a human.
- **States:** an ad moves from pending to approved or rejected, and records who decided it: a named person, or the AI.

### Pricing and buying

VLM sets prices from traffic. Buyers choose one of two ways to buy:

- **Per thousand views:** the buyer sets a budget and dates. They target either the **network**, meaning venue types such as nightclubs, festivals, malls or galleries, or **specific spaces**. Network buying is the cheaper, broader option; specific spaces cost more and are priced from their own traffic. The campaign rotates until the budget or the dates run out.
- **Time rental:** the buyer rents a specific space for a block of time, such as a week. They get it to themselves for that time, and the price comes from that space's typical traffic. They pay the same whether the week turns out busy or quiet.

Rented spaces are locked to their renter. Every other ad space fills its rotation from per-view campaigns.

### Measurement

The report has four levels, from broadest to strongest:

1. **In scene:** the player was in the scene while the ad was showing.
2. **On screen:** the ad was in the player's camera view and close enough to read.
3. **Looked at:** the player's crosshair rested on the ad, using the SDK's hover-enter and hover-leave pointer events, with how long it stayed there. An object in front of the ad can block hover, so this level slightly undercounts.
4. **Clicked:** the player opened the ad's link.

The report shows these numbers by space and by day, with unique viewers and click rate.

**The paid view is "on screen" (level 2).** Per-thousand prices and owners' per-view earnings both count on-screen views, with the safeguards below applied (verified wallets, once per ad per day, moving players). It matches the "viewable impression" advertisers pay for on the web: "in scene" would overcharge buyers and "looked at" would underpay owners. The other levels are in the report but don't affect money. *(My recommendation, flagged for the owner to confirm.)* Because it is billing-grade, the on-screen count needs server-side dedupe and a record a dispute can be checked against.

### Money

- **Payments:** buyers pay VLM by card through Stripe, using VLM's existing Stripe account.
- **Owner accounts:** owners who want to earn connect their own Stripe account through Stripe Connect. Stripe handles identity checks, bank details, tax forms and payouts.
- **Split:** VLM keeps **10%** and owners get **90%** of what the buyer paid. Stripe's card fee, about 2.9% plus 30¢, comes out of VLM's 10%.
- **Earnings:** an owner's balance builds up as their spaces deliver, per view for per-view campaigns and the rental price for rentals.
- **Payouts:** monthly, after the campaign has delivered and a holding period has passed, once the balance is over a minimum.
- **Who gets paid:** the scene's organization if it belongs to one, otherwise the scene's owner. The Stripe Connect account attaches to that user or org. *(My call.)*
- **Separate from billing:** this is a new payment flow. It must not change the existing subscription billing (`routes/billing.ts`, `integrations/stripe.ts` subscription paths). It may reuse the Stripe client.

### Charges and refunds

*(My recommendation, flagged for the owner to confirm.)*

The buyer is charged up front, when they submit the campaign. Refunds are automatic:

- **Rejected in review:** full refund.
- **Rental declined by an approve-only owner:** full refund.
- **Campaign ends with budget unspent:** the unspent part is refunded. Per-view campaigns are only charged for views that were actually delivered.
- **Rental interrupted:** if the rented space isn't showing because the owner went live, hid it, deleted it or redeployed without it, the buyer gets back that share of the rental. The owner earns only for the time the ad actually ran. A rental means "the space is yours while it's showing", not guaranteed airtime, and the buyer is told that before paying.

The earnings ledger records delivered views and rental time per space. An owner's earnings count as settled once the campaign has ended and the holding period has passed.

### Venue bookings come first

*(My recommendation, flagged for the owner to confirm.)*

VLM already has venue bookings (`venues`, `bookings`, and `access_grants` with a `screens` scope), where an event renter controls a venue's screens.

- **During a booking, the renter's content wins.** Ads on that venue's screens pause.
- **No overlaps.** Ad rentals can't be booked over a venue booking, and network ads skip those screens for the duration.
- **Separate systems.** Ad rentals are their own records, not venue bookings, but they check bookings for conflicts.

### Launch gating

*(My recommendation, flagged for the owner to confirm.)*

- **Landing page:** public from the start.
- **Checkout:** invite-only at first. An admin lets buyers in, so VLM can sell deals personally while the number of spaces is small.
- **Spend cap:** a campaign's budget can't be more than the matching spaces are estimated to deliver over its dates.
- **Opening up:** checkout opens to everyone later, as an admin switch.

### Self-hosted VLM instances

The owner confirmed this belongs in the plan.

Scenes run on a self-hosted VLM (single or scalable mode) can take part in the ad network.

- **Ads and measurement go to vlm.gg.** The ad spaces in a self-hosted scene fetch ads from vlm.gg and report views directly to vlm.gg. They use Decentraland signed requests, so vlm.gg verifies each player's wallet itself. The self-hosted server never counts paid views, because whoever runs it could inflate them.
- **The owner joins with a vlm.gg account.** They connect Stripe there and link the self-hosted scene with an API key. vlm.gg checks that the scene is really deployed where it claims, through the Decentraland directory it already uses for analytics.
- **Review stays central.** One queue and one content policy everywhere.
- **The self-hosted server keeps placement.** It still places ad spaces and holds each space's settings (shape, formats, family-friendly / allow all / approve only), and syncs them to vlm.gg.
- **If vlm.gg can't be reached,** the space behaves as it does during a live stream: fallback image, or hidden.
- **Its own endpoint from the start.** Because of this, ad serving and ad measurement get their own endpoint on vlm.gg in step 1, even for cloud scenes. They are not mixed into the normal scene connection, because that would be hard to separate later.
- **Timing.** Self-hosted scenes join once buying exists (step 3), since before that there's no money to share.

### Buyer's path

The owner approved this path from the mockup.

1. **Landing page at `vlm.gg/advertise`.**
   - It speaks to people who aren't in the metaverse yet: "Put your brand where people actually hang out in the metaverse."
   - It shows live network numbers: ad spaces, weekly visitors, and the starting price per 1,000 views.
   - It has two buttons, "Start a campaign" and "Browse ad spaces", and says no wallet or Decentraland account is needed.
2. **Where and how to buy.**
   - The buyer picks network or specific spaces, the venue types, and whether the ad is mature (for example alcohol). A mature ad only goes to spaces that allow it.
   - The page shows how many spaces match and an estimate of weekly views.
3. **The ad.**
   - The buyer uploads a version per shape, adds the click-through link, and sets the budget and dates. Missing shapes are skipped.
   - They pay, then submit for review.
   - Charges and refunds follow the rules under "Charges and refunds" below.
4. **Report.**
   - The four measurement levels, top spaces, and progress.
   - Underneath sits the onramp: "Want a place of your own? Build a branded space in Decentraland with VLM", linking to the scene builder (a separate planned project).

## Safeguards built into the first versions

These come from the risk review. The owner agreed they belong in the design.

- **House ads.** VLM's own promotions and partners' events fill any rotation with no paid campaign, so a new space is never empty. House ads pay owners nothing.
- **Counting views honestly:**
  - Only **verified-wallet** players count toward paid numbers.
  - Each wallet counts **once per ad per day** at each level.
  - Players who **haven't moved** for a while stop counting.
  - Unverified players and guests still appear as a separate, unpaid number in the report.
- **New spaces start on the network.** A space joins the network right away, and only becomes rentable or buyable as a specific space once it has a few weeks of traffic data.
- **Placement checks.**
  - Ad spaces have a minimum size.
  - A space that is almost never on screen gets few or no network ads, so tiny or hidden placements don't pay.
- **Player experience:**
  - **Audio:** video ads play muted by default.
  - **Frequency cap:** one visitor sees the same ad only a limited number of times.
  - **Video limit:** only a limited number of video ads play at once per scene.
  - **Ad label:** every ad shows a small visible "Ad" tag.
- **Payout timing.** Owners are paid after a campaign ends plus a holding period, so refunds and chargebacks don't leave VLM out of pocket.

## Must happen before launch (not code)

- **Legal review:**
  - Alcohol and other mature advertising. Decentraland has no age verification.
  - Ad disclosure rules.
  - Wallet-level tracking as personal data under GDPR and similar laws, and the privacy policy update that follows.
  - Running a marketplace that pays others through Stripe Connect.
- **Content policy:** a written ad content policy that the review queue enforces, aligned with Decentraland's content rules.

## Build order

The work is four projects, built in this order. Each is usable on its own.

1. **Ad spaces and in-world delivery.**
   - The standalone ad space element and the two video screen modes.
   - The live-stream rule, all four measurement levels, house ads, and the player-experience safeguards.
   - An admin way to create an ad and point it at spaces by hand, so VLM can run partner deals before buying exists.
   - Step 1 records exactly what each space delivered. Partner deals placed by hand are paid to owners manually until step 4. *(My call.)*
   - Ad serving and measurement on their own vlm.gg endpoint, ready for self-hosted scenes.
2. **Review queue.**
   - The admin queue, the family-friendly and mature labels, and the owner's per-space setting, including approving ads on approve-only spaces.
   - Structured so an AI reviewer can be added later.
3. **Buying.**
   - Self-hosted instances joining the network, with API key linking and settings sync.
   - Invite-only checkout and spend caps.
   - The landing page, the campaign builder, card payment, per-view campaigns and rentals, network targeting by venue type, pricing from traffic, and the buyer report with the build-your-own-space onramp.
4. **Owner payouts.**
   - Stripe Connect onboarding, the earnings balance, the 90/10 split, payout holds and the minimum, monthly payouts, and an owner earnings page.

## What exists to build on

- **Elements.** `video` and `image` already exist (`packages/vlm-shared/src/types/elements.ts`, `ElementType`). Video has `offType` (`VideoSourceType`: NONE, IMAGE, PLAYLIST, LIVE), `playlist`, `liveSrc`, `enableLiveStream` and `isLive`. Clickable images and videos already get a pointer collider.
- **Analytics.**
  - Collection runs through `routes/ingest.ts` and `analytics/writer.ts`.
  - The tables `analytics_sessions`, `analytics_events` (with type and data) and `analytics_positions` hold the data.
  - `ANALYTICS_EVENT_TYPES` is in `packages/vlm-shared/src/analytics.ts`, and clicks already count as high priority.
  - Sessions already know whether a player is verified and guest-free, and position samples already know whether they are moving.
- **Accounts.** Verified wallets come from DCL signed fetch and dashboard sign-in. In-world visitors get viewer accounts (commit 4b270a6). Buyers would sign up with email, which already exists.
- **Stripe.** The client lives in `integrations/stripe.ts`. Subscriptions live in `routes/billing.ts` and must not change.
- **Venue categories.** The model catalog's `CATALOG_VENUES` vocabulary in vlm-shared (cafe, club, gallery, shop, beach and others) is a natural starting point for network venue types.

## Left to the builder

- The exact rotation length for image ads (about 10 seconds was suggested), and how often ads come up in playlist + ads mode.
- The exact numbers: frequency cap, idle timeout, minimum size, how many weeks of data a space needs before it can be sold as a specific space, payout minimum, holding period, and the per-scene video ad limit.
- How "on screen" is computed from the camera transform: a view cone and a distance, or a projected size.
- How prices are derived from traffic.
- Data model, API shape, and how ad events fit the existing analytics pipeline.
- How an owner tags their scene's venue type for network targeting.
