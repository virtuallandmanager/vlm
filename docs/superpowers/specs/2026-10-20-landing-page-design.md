# VLM Landing Page: design

Status: agreed with the owner in conversation, 2026-10-20.
Mockup: `.superpowers/brainstorm/66058-1792536831/content/page-a-full.html` in the main checkout (not committed). This document describes it in full.
Related: `2026-10-19-ad-platform-design.md` on `feature/ad-platform-design` (the ad platform, including the separate `vlm.gg/advertise` page).

## Intent

Today the page someone sees before signing in (`apps/web/src/app/page.tsx`) is only a sign-in box. It doesn't tell a new visitor what VLM is.

The new page is the front door for two groups:

- **Advertisers**: brands that aren't in the metaverse yet, and creators inside Decentraland, such as an emote maker advertising in someone's mall. They get the loudest call to action, which leads to VLM's ad platform.
- **Builders and venue owners**: they get most of the page, because they create the ad supply. The ad platform design names "not enough clients building with VLM" and an empty marketplace as the main risk. Every feature on the page is a reason to build with VLM, and ads give owners a new one: "your scene can pay you."

The page sends advertisers on to the ad platform and doesn't try to sell ads itself.

## Goals

- A first-time visitor understands within one screen that VLM serves both groups, and which door is theirs.
- "Advertise with VLM" is the most prominent button on the page.
- Builders see the full feature set, plus earning from ads, as reasons to sign up.
- Sign-in and registration keep working exactly as they do now: email/password, wallet, Google and Discord, and the `?next=` and scene pass behaviour.

## Non-goals

- Selling ads on this page. Campaign building, prices and checkout belong to `vlm.gg/advertise` (ad platform step 3).
- A public pricing page. None exists today; tiers are shown in Settings.
- A redesign of the dashboard or the docs site.

## Anti-goals

- **Claims VLM can't back up.** No traffic numbers, prices, customer logos or testimonials until there is real data. Production has two VLM scenes and very little traffic.
- **Shipping ahead of the ad platform.** The owner decided the page goes live together with the ad platform, not before it, so the ad sections describe ad features as live. VLM has no users yet, so there's no audience to mislead in between.
- **Breaking sign-in.** Existing links to `/?next=…` (for example from the in-world HUD and auth handoff) must still end with the user signed in and at their destination.

## Audience decisions (from the conversation)

- The page leads with **metaverse-native advertisers** and **curious brands and agencies**. General business owners who first need convincing that the metaverse matters aren't targeted yet.
- The advertiser door speaks to people with no wallet and no Decentraland account, as the ad design does.

## Page structure (Layout A, "two doors", chosen by the owner)

The look is the dashboard's graphite-and-cyan theme (merged to `main` from `feature/dashboard-visual`), so the landing page and the dashboard look like one product. The page is dark only, like the dashboard.

1. **Nav.** VLM logo; links to Features (anchor), Advertise, Docs; a "Sign in" button; a cyan "Get started" button that opens registration.
2. **Two doors.** Two cards side by side; they stack on narrow screens, with the advertiser card first.
   - **Advertiser card**: wider, cyan border and tint. Tag "For brands & creators". Headline "Put your brand where people actually hang out in the metaverse". Body: image and video ads on screens and billboards in live Decentraland scenes; every ad reviewed; pay only for real views; no wallet or Decentraland account needed. Large cyan "Advertise with VLM →" button. Small previews of the four ad shapes (16:9, 1:1, 9:16, 2:5).
   - **Builder card**: tag "For builders & venue owners". Headline "Run every scene you own from one dashboard". Body: change screens, streams and events live without redeploying; turn screens into ad spaces and keep 90% of what brands pay. Outline button "Start building, it's free", which opens registration.
3. **Features** (anchor target for the nav). Heading "Everything your scene needs, live". Six tiles:
   - Live scene control: edit videos, images, models and sounds from the dashboard; visitors see it in milliseconds.
   - Live streaming: stream from OBS to every screen in the scene; late arrivals join live.
   - Analytics: visits, time spent, movement heatmaps and clicks, with no setup; claim a scene's data with a wallet.
   - Events & giveaways: schedule events and hand out NFTs to attendees across worlds.
   - Manage from inside the world: the in-world HUD.
   - One dashboard, many worlds: Decentraland and Hyperfy, together from the command center.
   - Below the tiles, one line: media hosting · one-click deploy · teams & roles · API keys · self-hosting.
   - Hyperfy hosting, in-world upload, the model catalog and the analytics dashboard are all on `main` and can be named in the tiles or the line.
4. **"Your scene can pay you"** band, for owners. Turn any VLM screen into an ad space or place a billboard; choose family-friendly only, allow all, or approve each ad; ads pause during live streams and venue bookings. Three stat tiles: "90% of ad revenue goes to you", "You decide which ads show", "Muted video ads, with frequency caps".
5. **"Ads that prove they were seen"**, for advertisers. Four tiles for the measurement levels: in scene, on screen (highlighted: "this is what you pay for"), looked at, clicked. A second "Advertise with VLM →" button, with the note "Counted from verified wallets only, once per day."
6. **Closing bar.** "Ready to build? Free plan, no card needed." Sign in and Get started buttons.
7. **Footer.** Docs · Advertise · Discord · Privacy (the docs site's privacy page). No Terms link: no Terms page exists yet. *(My call.)*

All copy above is a first draft, taken mostly from the ad platform design's wording. The builder can tighten it, but must not add claims.

## The "Advertise with VLM" button

Its target depends on whether `vlm.gg/advertise` exists yet.

- **Until `/advertise` exists:** the button opens an early-access form (agreed with the owner). The ad design makes checkout invite-only at first, with an admin letting buyers in, so the list feeds that directly.
  - Fields: email (required), name, company or project, website, and a free-text "What would you like to advertise?".
  - A short line under the form: VLM will only use this to contact them about advertising, with a link to the privacy page. Store the time they submitted it as their consent. *(My call.)*
  - On submit: a thank-you message saying VLM will be in touch.
  - Stored server-side in a new table, behind a new public, rate-limited endpoint. Admins can see the list on the admin page.
- **Once `/advertise` ships:** the button links there instead. Switching should be a one-line change, or a config/system flag.

## Sign-in

- Sign-in and registration move off the root to their own screen (for example `/signin`). Every method stays: email/password, wallet, Google, Discord. Both forms keep the current look and logic.
- `/` shows the landing page to signed-out visitors. A signed-in visitor (without a scene pass) is sent to their destination as today.
- `/?next=…` must keep working: forward to the sign-in screen with `next` preserved, then to the destination.
- OAuth callbacks, `/auth/handoff`, `/auth/invite` and password-reset links that land on `/` must still work.

## Constraints

- `apps/web` is a Next.js static export in production (`output: 'export'`), so the page is static plus client code; there is no server rendering.
- Build on the existing Tailwind 4 setup and `globals.css` theme tokens.
- Responsive down to phone width.
- The page must work when the API is unreachable. The sign-in providers fetch already fails silently, and the early-access form shows an error.

## Before launch (not code)

- The privacy policy covers the advertiser early-access list. This joins the legal review the ad platform design already requires before launch.

## Left to the builder

- Final copy within the claims above, icons, and visual polish within the dashboard theme.
- The sign-in route name and how the redirect from `/?next=` is done.
- The early-access table shape, endpoint path, rate limit, and how the admin list looks.
- Whether the form is a modal or its own page.
