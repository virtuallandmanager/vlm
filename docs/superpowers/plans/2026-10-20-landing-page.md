# VLM Landing Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the sign-in box at `/` with a public landing page: two doors (advertisers get the loudest button, builders most of the page), the feature set, and an advertiser early-access form. Sign-in moves to `/signin`.

**Architecture:** A new `advertiser_leads` table holds the early-access list. The server gets one public, rate-limited `POST /api/advertiser-leads` and one admin-only `GET /api/admin/advertiser-leads`. In `apps/web`, the current `page.tsx` moves to `/signin` unchanged in behaviour. `/` becomes a client page that forwards old `/?next=` links and signed-in users, and otherwise renders the landing sections from `src/app/_landing/`. Pure routing and link decisions live in small `src/lib` modules with vitest tests, because the web tests run in a node environment with no component rendering.

**Tech Stack:** Fastify 5, Drizzle (schema pushed with `drizzle-kit push`, no migration files), Postgres, vitest; Next.js 15 static export, React 19, Tailwind 4 with the graphite/cyan tokens in `apps/web/src/styles/globals.css`.

**Spec:** `docs/superpowers/specs/2026-10-20-landing-page-design.md`

## Global Constraints

- The page launches with ad platform step 1 only. Copy must not promise the review queue or per-space ad settings (step 2), self-serve buying or prices (step 3), or payouts and the 90% split (step 4). No traffic numbers, prices, logos or testimonials.
- "Advertise with VLM" is the most prominent button on the page. At launch it opens the early-access form. It switches to `/advertise` by setting `ADVERTISE_PAGE` in `apps/web/src/lib/site.ts`, and nothing else.
- Sign-in keeps every method (email/password, wallet, Google, Discord), the `?next=` handling via `safeNextPath`, and the scene pass behaviour exactly as in today's `apps/web/src/app/page.tsx`.
- `apps/web` is a static export (`output: 'export'`). No server components that fetch, no route handlers, no middleware.
- Dark only, using the existing theme: Tailwind `gray-*`/`blue-*` classes, `bg-accent text-accent-ink` for the primary call to action, plus the `clip-corner` and `corner-notch` utilities.
- Responsive down to 360px wide with no horizontal scroll. On narrow screens the two-door cards stack with the advertiser card first.
- Don't add a Terms link. Footer links whose URL isn't configured are left out.

## Review Focus

1. **The same email submitted twice** (an advertiser who comes back): one row, updated with the newer details, and the second submit still succeeds. Tested in Task 1.
2. **Bots filling the form:** a filled honeypot field gets the normal success response and stores nothing. A sixth submit from one IP within an hour gets 429, and the form shows "Too many tries — please try again later." Tested in Tasks 1 and 3.
3. **Old `/?next=` links** (the dashboard layout, `lib/handoff.ts`, in-world links already out there): they land on `/signin` with `next` preserved, and after sign-in at the destination. Tested in Task 2.
4. **The API is down when someone submits:** the form shows an error and keeps everything they typed. Tested in Task 3 (message); the input is kept because the component only clears on success.
5. **A signed-in user opens `/`:** they go to `/scenes` without the landing page flashing first. A scene pass visitor sees the landing page, so they can sign in properly. Tested in Task 2.

---

### Task 1: Advertiser leads table and public submit endpoint

**Files:**
- Modify: `apps/server/src/db/schema.ts` (append after the ad tables)
- Create: `apps/server/src/routes/advertiser-leads.ts`
- Modify: `apps/server/src/app.ts` (register next to `adminAdsRoutes`)
- Modify: `packages/vlm-shared/src/ads.ts` (types)
- Test: `apps/server/test/advertiser-leads.test.ts`

**Interfaces:**
- Produces (vlm-shared, `ads.ts`):
  ```ts
  export interface AdvertiserLeadInput { email: string; name?: string; company?: string; website?: string; message?: string; consent: true; nickname?: string /* honeypot */ }
  export interface AdminAdvertiserLead { id: string; email: string; name: string | null; company: string | null; website: string | null; message: string | null; consentAt: string; createdAt: string; updatedAt: string }
  ```
- Produces (schema): `advertiserLeads = pgTable('advertiser_leads', …)` with `id uuid pk defaultRandom`, `email text notNull unique` (stored lowercased and trimmed), `name`, `company`, `website`, `message` (nullable text), `consentAt timestamptz notNull`, `createdAt`/`updatedAt timestamptz notNull defaultNow`.
- Produces (route): `POST /api/advertiser-leads` → `201 { ok: true }`; `400 { error: 'invalid_email' | 'consent_required' | 'invalid_website' | 'too_long' }`.

- [ ] **Step 1: Write the failing tests** in `apps/server/test/advertiser-leads.test.ts`, using `resetDb`, `testApp` and `app.inject` as `admin-ads.test.ts` does:
  - `stores a lead with consent time` — POST `{ email: ' Ana@Brand.example ', name: 'Ana', company: 'Brand', website: 'brand.example', message: 'Vodka in nightclubs', consent: true }` → 201 `{ ok: true }`. The row has `email: 'ana@brand.example'`, `website: 'https://brand.example'`, and `consentAt` within 5 s of now.
  - `same email twice updates one row` — submit the email above, then `{ email: 'ANA@brand.example', company: 'Brand Co', consent: true }` → both 201. There is one row, with `company: 'Brand Co'`, `name: 'Ana'` (unchanged because it wasn't sent), and `updatedAt > createdAt`.
  - `rejects bad input` — missing email, `'not-an-email'`, and a 255-char email give 400 `invalid_email`. `consent: false` or a missing consent gives 400 `consent_required`. `website: 'javascript:alert(1)'` gives 400 `invalid_website`. A 201-char `name` or a 2001-char `message` gives 400 `too_long`. Nothing is stored.
  - `honeypot answers success and stores nothing` — a valid body with `nickname: 'x'` → 201 `{ ok: true }`, zero rows.
  - `rate limits a sixth submit per IP per hour` — build with `buildApp({ logger: false, backfill: false })` (rate limiting on). Five valid submits from one `remoteAddress` give 201, and the sixth gives 429.

- [ ] **Step 2: Run them.** `cd apps/server && npx vitest run test/advertiser-leads.test.ts`. Expected: FAIL (route not found / table missing).

- [ ] **Step 3: Implement.** Add the types and the table. Write `advertiserLeadRoutes(app: FastifyInstance)` in `routes/advertiser-leads.ts`, with route config `{ rateLimit: { max: 5, timeWindow: '1 hour' } }`. Limits: email ≤ 254 chars and matching `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`; `name`/`company`/`website` ≤ 200; `message` ≤ 2000; every string trimmed, and empty strings stored as null. For the website, prefix `https://` when there's no scheme, then accept only `http:`/`https:`. Upsert with `onConflictDoUpdate` on `email`, setting only the fields that were sent, plus `consentAt` and `updatedAt` = now. Register it in `app.ts` next to `adminAdsRoutes`.

- [ ] **Step 4: Run them.** Same command. Expected: PASS. Then `cd apps/server && npx tsc --noEmit`: no errors.

- [ ] **Step 5: Commit.**
  ```bash
  git add apps/server/src/db/schema.ts apps/server/src/routes/advertiser-leads.ts apps/server/src/app.ts packages/vlm-shared/src/ads.ts apps/server/test/advertiser-leads.test.ts
  git commit -m "feat(server): advertiser early-access leads with consent, honeypot and rate limit"
  ```

### Task 2: Admin list of advertiser leads

**Files:**
- Modify: `apps/server/src/routes/advertiser-leads.ts`
- Modify: `apps/web/src/lib/api.ts` (useApi, next to `getAdminAds`)
- Create: `apps/web/src/app/(dashboard)/admin/advertisers/page.tsx`
- Modify: `apps/web/src/app/(dashboard)/admin/page.tsx:138` (a link next to "Ads")
- Test: `apps/server/test/advertiser-leads.test.ts`

**Interfaces:**
- Consumes: `advertiserLeads`, `AdminAdvertiserLead` (Task 1).
- Produces: `GET /api/admin/advertiser-leads` → `{ leads: AdminAdvertiserLead[] }`, newest `createdAt` first; `useApi().getAdminAdvertiserLeads(): Promise<{ leads: AdminAdvertiserLead[] }>`.

- [ ] **Step 1: Write the failing tests:**
  - `admin lists leads newest first` — two leads submitted → the admin GET returns 2, with the later one first, ISO timestamps, and every `AdminAdvertiserLead` field present.
  - `non-admins get 403, anonymous gets 401`.
- [ ] **Step 2: Run them.** `cd apps/server && npx vitest run test/advertiser-leads.test.ts`. Expected: the two new tests FAIL.
- [ ] **Step 3: Implement the route** with `preHandler: [authenticate, requireAdmin]`, copying `requireAdmin` from `admin-ads.ts`. Add `getAdminAdvertiserLeads` to useApi. Build the page as a table (email as a `mailto:` link, name, company, website as an external link, message, submitted date) plus a "Copy emails" button that copies the comma-separated emails. Style it like `admin/ads/page.tsx`. Add an "Advertisers" link on the admin page.
- [ ] **Step 4: Run them.** Expected: PASS. `cd apps/web && npx tsc --noEmit`: no errors.
- [ ] **Step 5: Commit.** `git commit -m "feat(admin): advertiser early-access list"`

### Task 3: Early-access form

**Files:**
- Create: `apps/web/src/lib/site.ts`
- Create: `apps/web/src/lib/advertiser-leads.ts`
- Create: `apps/web/src/app/_landing/EarlyAccessForm.tsx`
- Test: `apps/web/src/lib/site.test.ts`, `apps/web/src/lib/advertiser-leads.test.ts`

**Interfaces:**
- Consumes: `POST /api/advertiser-leads`, `AdvertiserLeadInput` (Task 1).
- Produces (`site.ts`):
  ```ts
  export const ADVERTISE_PAGE: string | null = null // set to '/advertise' when ad step 3 ships
  export function siteLinks(env?: { docs?: string; discord?: string }): { docs: string | null; privacy: string | null; discord: string | null }
  ```
  `env` defaults to `NEXT_PUBLIC_DOCS_URL` / `NEXT_PUBLIC_DISCORD_URL`. `privacy` is `${docs without trailing slash}/privacy/`, or null when docs is null.
- Produces (`advertiser-leads.ts`): `submitAdvertiserLead(input: AdvertiserLeadInput, fetchImpl = fetch): Promise<void>`, which throws `Error(message)` with a message from `leadErrorMessage`. Also `leadErrorMessage(status: number | null, code?: string): string`.
- Produces (component): `<EarlyAccessForm open: boolean onClose: () => void />`, a modal.

- [ ] **Step 1: Write the failing tests:**
  - `siteLinks`: `{ docs: 'https://docs.example/' }` gives `privacy: 'https://docs.example/privacy/'`; `{}` gives all three null.
  - `leadErrorMessage`: `(429)` gives `'Too many tries — please try again later.'`; `(400, 'invalid_email')` gives `'Please enter a valid email address.'`; `(400, 'invalid_website')` gives `'Please check the website address.'`; `(400, 'too_long')` gives `'One of the fields is too long.'`; `(null)` (network failure) gives `"We couldn't reach VLM. Please try again."`; anything else gives `'Something went wrong. Please try again.'`.
  - `submitAdvertiserLead` with a stub fetch: it POSTs JSON to `${API_URL}/api/advertiser-leads` without an Authorization header; resolves on 201; rejects with the 429 message on 429; rejects with the network message when fetch throws.
- [ ] **Step 2: Run them.** `cd apps/web && npx vitest run src/lib/site.test.ts src/lib/advertiser-leads.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the two lib modules and the component.
  - Fields: Email (required, `type="email"`), Name, Company or project, Website, and "What would you like to advertise?" (textarea).
  - A hidden honeypot input `nickname`: off-screen, `tabIndex={-1}`, `autoComplete="off"`, `aria-hidden`.
  - Consent text above the submit button: "We'll only use this to contact you about advertising on VLM." followed by a "Privacy" link when `siteLinks().privacy` is set. Submitting counts as consent and sends `consent: true`.
  - Submit button: "Request early access", in `bg-accent text-accent-ink`.
  - On success, replace the form with "Thanks — we'll be in touch soon." On error, show the message and keep every field.
  - Escape and the backdrop close the modal; focus moves to the email field when it opens.
- [ ] **Step 4: Run them.** Expected: PASS. `npx tsc --noEmit`: no errors.
- [ ] **Step 5: Commit.** `git commit -m "feat(web): advertiser early-access form"`

### Task 4: Sign-in moves to /signin; / forwards

**Files:**
- Create: `apps/web/src/app/signin/page.tsx` (today's `app/page.tsx`, moved)
- Create: `apps/web/src/lib/landing-route.ts`
- Modify: `apps/web/src/app/(dashboard)/layout.tsx:56,63,124`; `apps/web/src/lib/handoff.ts:56`; `apps/web/src/app/auth/invite/page.tsx:100,114`; `apps/web/src/app/auth/reset-password/page.tsx:19,32`; `apps/web/src/app/auth/callback/page.tsx:49`
- Test: `apps/web/src/lib/landing-route.test.ts`; update `apps/web/src/lib/handoff.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function signinPath(next?: string | null, mode?: 'register'): string // '/signin', '/signin?next=%2Fx', '/signin?mode=register'
  export function landingRoute(a: { search: string; loading: boolean; signedIn: boolean; scenePass: boolean }): { go: string } | 'wait' | 'show'
  ```
  `landingRoute` rules: a `next` param that passes `safeNextPath` → `{ go: signinPath(next) }`, even while loading. `loading` → `'wait'`. `signedIn && !scenePass` → `{ go: '/scenes' }`. Otherwise `'show'`. An unsafe `next` (such as `//evil.com`) is ignored.

- [ ] **Step 1: Write the failing tests** in `landing-route.test.ts`: one per rule above, including `?next=%2Fanalytics%2F%3Fscene%3Dabc` → `{ go: '/signin?next=%2Fanalytics%2F%3Fscene%3Dabc' }`, `?next=//evil.com` while signed out → `'show'`, and signed-in with a scene pass → `'show'`. Change the `handoff.test.ts` expectations from `/?next=` to `/signin?next=`.
- [ ] **Step 2: Run them.** `cd apps/web && npx vitest run src/lib/landing-route.test.ts src/lib/handoff.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `git mv apps/web/src/app/page.tsx apps/web/src/app/signin/page.tsx`.
  - In the sign-in page, set the initial mode from `?mode=register`, and add a "← Back to VLM" link to `/` above the card. Change nothing else.
  - Point every caller listed under Files at `signinPath(...)`. "Back to login" links become `/signin`.
  - Add `landing-route.ts`.
  - Write a temporary `app/page.tsx` that applies `landingRoute` with `router.replace`, renders nothing for `'wait'` and redirects, and renders a placeholder `<main />` for `'show'`. Task 5 replaces the placeholder. Wrap it in `Suspense` for `useSearchParams`, as the sign-in page does.
- [ ] **Step 4: Run them.** `npx vitest run` (the whole web suite): PASS. `npx tsc --noEmit`: no errors. Run `grep -rn "'/?next\|\`/?next\|href=\"/\"" apps/web/src`: the only hits are the landing page's own links.
- [ ] **Step 5: Commit.** `git commit -m "feat(web): sign-in moves to /signin; / forwards next links and signed-in users"`

### Task 5: Landing page

**Files:**
- Create: `apps/web/src/app/_landing/{Nav,Doors,Features,EarnBand,Measurement,Closing,Footer}.tsx`
- Modify: `apps/web/src/app/page.tsx` (render the sections for `'show'`, own the `EarlyAccessForm` open state)
- Modify: `apps/web/src/app/layout.tsx` (metadata description)

**Interfaces:**
- Consumes: `ADVERTISE_PAGE`, `siteLinks` (Task 3); `EarlyAccessForm` (Task 3); `signinPath` (Task 4).
- Produces: `onAdvertise: () => void`, passed to `Doors` and `Measurement`. It navigates to `ADVERTISE_PAGE` when that's set, and otherwise opens the form.

- [ ] **Step 1: Build the sections**, in order, with the spec's copy (spec section "Page structure", items 1–7). The copy is pinned here where the spec's copy changed for step 1:
  - **Nav:** VLM logo: copy `/Users/unknower/-VLM/3_Design/VLM Branding/VLM-Logo.svg` (white, 370×162 viewBox) to `apps/web/public/vlm-logo.svg` and render it 28px tall with `alt="VLM"`. `apps/web/public` doesn't exist yet, so create it. Features (`#features`), Advertise (calls `onAdvertise`), Docs (only when set), "Sign in" → `/signin`, "Get started" → `signinPath(null, 'register')`.
  - **Doors** (`grid md:grid-cols-[1.3fr_1fr]`, advertiser first in the DOM):
    - Advertiser card (`relative corner-notch`, cyan border): "Put your brand where people actually hang out in the metaverse" / "Image and video ads on screens and billboards inside live Decentraland scenes. Advertising is in early access: we set up each campaign with you and report what it delivered. No wallet or Decentraland account needed." Button "Advertise with VLM →" (`bg-accent text-accent-ink clip-corner`, the largest button on the page). Below it, four shape outlines labelled 16:9 · 1:1 · 9:16 · 2:5.
    - Builder card: "Run every scene you own from one dashboard" / "Change screens, streams and events live, without redeploying. Then turn your screens into ad spaces and earn from the campaigns we place in them." Outline button "Start building — it's free" → `signinPath(null, 'register')`.
  - **Features** (`id="features"`, heading "Everything your scene needs, live"): six tiles with the spec's text. The extras line: "Also: media hosting · model catalog · one-click deploy · Hyperfy world hosting · teams & roles · API keys · self-hosting". In-world upload goes in the "Manage from inside the world" tile text.
  - **EarnBand:** "Your scene can pay you" / the spec's item 4 text / tiles "Any screen becomes an ad space", "Ads never interrupt your stream", "Muted video ads, labelled and capped".
  - **Measurement:** "Ads that prove they were seen", with four tiles (the on-screen tile highlighted, "This is what campaigns are measured by"), the second "Advertise with VLM →" button, and the note "Counted from verified wallets only, once per day."
  - **Closing:** "Ready to build?" / "Free plan, no card needed." Buttons for Sign in and Get started.
  - **Footer:** VLM · Docs · Advertise · Discord · Privacy, leaving out any link whose `siteLinks` value is null.
- [ ] **Step 2: Typecheck and test.** `cd apps/web && npx tsc --noEmit && npx vitest run`: no errors, PASS.
- [ ] **Step 3: Look at it.** Run `pnpm dev` (server on :3010, web on :3000).
  - Check `/` at 1280px and at 375px: no horizontal scroll, and the advertiser card comes first.
  - Submit the form: the thank-you message appears, and the lead shows at `/admin/advertisers`.
  - Stop the server and submit: the network error appears, with the fields kept.
  - Open `/?next=/analytics`: you land on `/signin`, sign in, and arrive at `/analytics`.
  - Open `/` while signed in: you go straight to `/scenes`.
- [ ] **Step 4: Production build.** `cd apps/web && NODE_ENV=production npx next build`: the export succeeds, and `out/index.html` and `out/signin/index.html` exist.
- [ ] **Step 5: Commit.** `git commit -m "feat(web): public landing page with advertiser and builder doors"`

## Before launch (not code)

- Set `NEXT_PUBLIC_DOCS_URL` (and `NEXT_PUBLIC_DISCORD_URL` if there's an invite link) in the web build, so the Docs, Privacy and Discord links appear.
- Update the privacy page to cover the advertiser early-access list (this joins the ad platform's legal review).
- Run `drizzle-kit push` against production to create `advertiser_leads`.
