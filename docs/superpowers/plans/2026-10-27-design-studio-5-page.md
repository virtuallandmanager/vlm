# Design Studio Plan 5: the studio page

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Virvi users design wearables and emotes in the dashboard. They get a **Design Studio** page under Workspace with:
- a list of their designs;
- each design's two-column page: the conversation with the agent on the left, the rendered preview on the right;
- finalizing, paying, downloading and reporting agent mistakes, all on that page.

**Architecture:**
- **Code layout:** pure logic and types live in `apps/web/src/lib/studio.ts`, tested with vitest in node like every other `lib/*.test.ts`. The API calls go in `useApi()` and the live progress hook in `lib/colyseus.ts`. The pages are client components under `app/(dashboard)/studio/`, split into one component file per column part.
- **Design page route:** the dashboard is a static export, so the design page is `studio/[designId]` with the single exported param `_`. The server serves `/studio/<id>` from it, as it does `/u/<code>`, and the page reads the id from the URL.
- **Server additions:** two small ones the page needs: the last prompt's outcome, and when each render was made.

**Tech Stack:** Next.js 15 (static export), React 19, Tailwind 4, `colyseus.js` 0.15, vitest 3 (node environment); server side, Fastify 5 and vitest on the real test database.

**Spec:** `docs/superpowers/specs/2026-10-24-design-studio-design.md`: "Who uses it and how", "Screen layout", "The preview: rendered, not downloaded" and "Paying". The API it calls is Plans 3 and 4 (`docs/superpowers/plans/2026-10-25-design-studio-3-server.md`, `…-4-payments.md`): `apps/server/src/routes/studio.ts`, and the `virvi_studio` room (`apps/server/src/ws/VirviStudioRoom.ts`), which sends `studio_event` messages (`apps/server/src/studio/events.ts`).

**Not in this plan:**
- Plan 6 (the revision log admin page).
- **The "whole set" preview.** The spec's call is for the preview to show one piece or the whole set together. Rendering several pieces on one avatar needs a new render job shape in the worker and new server storage, so this plan shows one piece at a time and leaves the set toggle out. Task 9's handoff names it as the next studio step.
- Deploying.

## Global Constraints

- **Style:** the dashboard's existing style, from `@/components/ui`: `PageHeader`, `Badge`, `PrimaryButton`, `EmptyState`, `Skeleton`. Dark theme, Tailwind classes as the other pages use them. No new UI dependencies.
- **Where it shows:** the nav item is **Design Studio** in the **Workspace** section, after Giveaways. It shows only when `GET /api/studio/usage` answers 200: the studio is off outside cloud mode and answers 404 there.
- **Agents:** "Claude Code" (`claude`) and "Codex" (`codex`), plus "Grok Build" shown greyed with the badge "Coming soon", which can't be selected.
- **Copy**, exactly. The page never shows the cost ceiling's numbers.

  | When | Copy |
  |---|---|
  | allowance spent, no credits | `You’ve used today’s prompts. More at midnight UTC (in <h> h <m> min).` with a **Buy 10 prompts for $5** button (prices from `GET /usage`, Task 2) |
  | `cost_ceiling` | `The studio needs a rest for today. Come back tomorrow.` |
  | `busy` | `The agent is still working on your last message.` |
  | `open_design_limit` | `Your plan has room for one open design. Archive or finalize the one you have, or upgrade.` with a link to `/settings` |
  | `checks_failed` | `<categories> failed the checker. Ask the agent to fix it: it doesn’t use a prompt.` |
  | `payments_unavailable` | `Payments aren’t available right now.` |
  | `stripe_error` | `Stripe didn’t answer. Try again in a moment.` |
  | the finalize strip | `Finalize to get the GLBs, thumbnail, Builder settings, listing text, curation report, renders and a promo clip.` (emote design: `Finalize to get the GLB, thumbnail, emote report, renders and a promo clip.`) |
- **Progress text:** `phase` events show as `Building…`, `Running the checks…`, `Rendering the preview…`, `Saving…`, `Packaging your files…`. A `progress` event is shown unless its text starts with `Running:` (an agent command). Any `/work/…`, `/opt/…` or `/tmp/…` path in it is shortened to its last segment.
- **Frames:**
  - Signed frame URLs are fetched with the design detail, and the detail is re-read every 45 minutes while the page is open (URLs last at least an hour).
  - Frames are preloaded before a view replaces the one on the stage.
  - A wearable view is dragged through (one stage width is one full turn). An emote view plays on a loop at 12 frames a second and can also be dragged.
- **Downloads** use the authenticated route through `fetch` with the bearer token, saved via a blob link, as `downloadArMarkerFile` does. No package URL is ever put in the page.

## Review Focus

1. **A message sent while the agent is still working, or the room dropping mid-prompt.** Expect the send box to say it's busy; when the room reconnects or the job ends, the page re-reads the design (Task 4 `progressFor` and `nextPoll` tests).
2. **The page left open for hours.** Expect frame URLs to be refreshed before they expire, with no broken images (Task 3 `refreshDue` test).
3. **Coming back from Stripe** (`?payment=<id>`) **before the webhook lands.** Expect "Payment received, packaging your files" and polling until the paid revision shows, then a download button (Task 7 `paymentBanner` test).
4. **A design with no pieces yet, or a piece whose render failed.** Expect an empty stage with plain words, never a broken image or a blank box (Task 5 `stageState` test).
5. **A proposal whose recommended slots are all unticked.** Expect "Build these" to be disabled, never an empty `selectedSlots` (the server refuses that with 400) (Task 4 `slotSelection` test).

---

### Task 1: Server additions the page needs

**Files:**
- Modify: `apps/server/src/app.ts` (next to `/u/:code`), `apps/server/src/studio/designs.ts` (`designDetail`)
- Test: `apps/server/test/studio-routes.test.ts`, `apps/server/test/ar-pages.test.ts`

**Interfaces:**
- **Produces:**
  - `GET /studio/:designId` and `/studio/:designId/` serve `studio/_/index.html`.
  - `designDetail` adds `lastPrompt: { jobId: string; outcome: string | null; status: string } | null`, the design's newest prompt job (`outcome` from its result).
  - Each `pieces[].renders[viewKey]` adds `renderedAt: string`, the render row's `createdAt`.
- [ ] **Step 1: Write the failing tests:**
  - `ar-pages.test.ts`: `serves the design page for /studio/:id`. With a dashboard dir holding `studio/_/index.html` = `STUDIO`, both `/studio/<uuid>` and `/studio/<uuid>/` answer 200 with `STUDIO`.
  - `studio-routes.test.ts`: `design detail names the last prompt's outcome and when each view rendered`. After a prompt finished with `ceiling`, `lastPrompt` is `{ outcome: 'ceiling', status: 'done' }`. A ready view has `renderedAt` as an ISO string.
- [ ] **Step 2: Run them; expect FAIL.** Run `t.sh test/ar-pages.test.ts test/studio-routes.test.ts`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them; expect PASS.** Then run the server suite.
- [ ] **Step 5: Commit** `feat(studio): design page route; last prompt outcome and render times in the detail`

### Task 2: Types, API calls and copy

**Files:**
- Create: `apps/web/src/lib/studio.ts`, `apps/web/src/lib/studio.test.ts`
- Modify: `apps/web/src/lib/api.ts` (a `// Design Studio` block in `useApi()`)

**Interfaces:**
- **Produces, in `lib/studio.ts`:**
  - **Types:** `StudioUsage`, `StudioDesign`, `StudioPiece`, `StudioView`, `StudioMessage`, `StudioProposal`, `StudioDetail`, `FinalizedRevision`, `Quote` and `QuoteLine`, matching the server's JSON. Read them from `routes/studio.ts`, `studio/designs.ts`, `studio/pricing.ts` and `studio/payments.ts`.
  - **`AGENTS`:** `[{id: 'claude', label: 'Claude Code'}, {id: 'codex', label: 'Codex'}, {id: 'grok', label: 'Grok Build', soon: true}]`.
  - **`refusalMessage(err: {status?: number; body?: {code?: string; resetsAt?: string; categories?: string[]}}, now: Date): {text: string; action?: 'topup' | 'settings' | 'fix'}`:** the copy table, keyed by `body.code`. Anything else gives `Something went wrong. Try again.`
  - **`formatCents(cents: number): string`:** `2900 → '$29'`, `1950 → '$19.50'`.
  - **`untilReset(resetsAt: string, now: Date): string`:** `'3 h 20 min'`; under an hour, `'20 min'`.
  - `designIdFromPath(pathname: string, param?: string): string | null`, like `codeFromPath` in `u/[code]`.
- **`useApi()` gains:**
  - `getStudioUsage()`, `getStudioDesigns(archived)`, `createStudioDesign({kind, agent, name?})`, `getStudioDesign(id)`, `updateStudioDesign(id, {name?, agent?, archived?})`;
  - `sendStudioPrompt(id, {text?, selectedSlots?, continue?, fixChecks?})`, `requestStudioRender(id, {category, bodyShape, outfit, emote})`;
  - `getStudioQuote(id)`, `finalizeStudio(id, {categories?, reports?})`, `buyStudioPrompts(packs)`, `reportStudioMistake(id, category, n, text)`, `retryStudioPackage(id, category, n)`;
  - `downloadStudioPackage(id, category, n): Promise<{blob, filename}>`.

  The server's `topupCents` and `topupPrompts` aren't sent today: Step 3 adds them to `GET /usage` as `topup: {cents, prompts}` (a one-line server change, tested in `studio-routes.test.ts`).
- [ ] **Step 1: Write the failing tests** (`studio.test.ts`):
  - **Copy:** `refusalMessage` gives the exact copy for `allowance` (with `resetsAt` two hours and five minutes out: `in 2 h 5 min`), `cost_ceiling` (no digits in the text), `busy`, `open_design_limit` (`action: 'settings'`), `checks_failed` with `['hat','feet']` (`hat and feet failed the checker…`, `action: 'fix'`), `payments_unavailable`, `stripe_error`, and an unknown code.
  - **Money:** `formatCents(2900) === '$29'` and `formatCents(1950) === '$19.50'`.
  - **Time:** `untilReset` gives `'20 min'` for 20 minutes out and `'3 h 0 min'` for 3 hours out.
  - **URLs:** `designIdFromPath('/studio/2f1c…uuid/')` gives the uuid; `'_'` and non-uuids give null.
  - **Server:** in `studio-routes.test.ts`, `usage names the top-up price`: `topup` is `{cents: 500, prompts: 10}`.
- [ ] **Step 2: Run them; expect FAIL.** Run `cd apps/web && pnpm exec vitest run src/lib/studio.test.ts`.
- [ ] **Step 3: Implement** `lib/studio.ts`, the `useApi` block and the `usage` field.
- [ ] **Step 4: Run them; expect PASS.** Run the web suite (`pnpm exec vitest run`) and `pnpm exec tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(web): Design Studio types, API calls and copy`

### Task 3: The designs list, the nav item and new designs

**Files:**
- Create: `apps/web/src/app/(dashboard)/studio/page.tsx`
- Modify: `apps/web/src/app/(dashboard)/layout.tsx` (the nav item), `apps/web/src/components/icons.tsx` (a `SparkleIcon`, in the file's existing style), `apps/web/src/lib/studio.ts`
- Test: `apps/web/src/lib/studio.test.ts`

**Interfaces:**
- **Produces:**
  - `useStudioAvailable(): boolean | null`, in `lib/studio.ts`. It probes `GET /api/studio/usage` once per page load, with the result cached in a module variable.
  - `refreshDue(fetchedAt: number, now: number): boolean`: true after 45 minutes (`FRAME_REFRESH_MS`).
  - `designBadge(d: StudioDesign): {label: string; tone: Tone}`:

    | When | Label | Tone |
    |---|---|---|
    | archived | `Archived` | neutral |
    | finalized | `Finalized` | success |
    | building | `Building` | info |
    | otherwise | `Draft` | violet |
- **The page:**
  - `PageHeader` with the title "Design Studio" and a subtitle line: `<plan> plan · <n> prompts left today` (`· <c> bought` when credits > 0).
  - An Open / Archived toggle, and design cards (name, kind, badge, agent, last activity) linking to `/studio/<id>`.
  - A **New design** form: kind is Wearable or Emote; the agent radio group uses `AGENTS`, with Grok disabled and badged; the name is optional.
  - Creating navigates to the new design. Refusals show `refusalMessage`.
  - `EmptyState` with no designs: "Describe a wearable or an emote and an agent builds it on a Decentraland avatar."
- [ ] **Step 1: Write the failing tests:** `refreshDue` gives false at 44 minutes and true at 46. `designBadge` covers each state, with archived winning over finalized.
- [ ] **Step 2: Run them; expect FAIL.**
- [ ] **Step 3: Implement** the helpers, page, icon and nav item.
- [ ] **Step 4: Run them; expect PASS.** Then run the web suite and the typecheck.
- [ ] **Step 5: Commit** `feat(web): Design Studio list, nav item and new designs`

### Task 4: The design page and the conversation

**Files:**
- Create:
  - `apps/web/src/app/(dashboard)/studio/[designId]/page.tsx`: `generateStaticParams` returns `[{designId: '_'}]`; renders `<StudioDesignPage />`;
  - `apps/web/src/app/(dashboard)/studio/[designId]/client.tsx`: the page shell, which owns the detail, usage and quote state;
  - `apps/web/src/app/(dashboard)/studio/[designId]/Conversation.tsx`.
- Modify: `apps/web/src/lib/colyseus.ts` (`useStudioRoom`), `apps/web/src/lib/studio.ts`
- Test: `apps/web/src/lib/studio.test.ts`

**Interfaces:**
- **Produces:**
  - `useStudioRoom(designId: string | null, token: string | null, onEvent: (e: StudioEvent) => void): {connected: boolean}`. It joins `virvi_studio` with `{designId, sessionToken}`. On leave, it rejoins after 2, 4 and then 8 s (8 s from then on).
  - **`progressFor(events: StudioEvent[], jobId: string): string | null`:** the line under the "agent is working" bubble. It is the newest shown progress text for that job, else its phase's copy. It applies the Global Constraints filtering.
  - **`slotSelection(proposal: StudioProposal, ticked: Set<string>): {canBuild: boolean; slots: string[]}`:** the slots come in the proposal's order, and `canBuild` is false when none are ticked.
  - **`initialTicks(proposal): Set<string>`:** the recommended slots.
  - **`nextPoll(detail: StudioDetail, connected: boolean): number | null`:** milliseconds until the next re-read: 5 000 while a job is active and the room is down, 30 000 while a job is active and the room is up, null when idle.
  - **`composerState(detail, usage): {mode: 'send' | 'busy' | 'continue' | 'out'; note: string}`:**
    - `busy` while `activeJob` is a prompt;
    - `continue` when `lastPrompt.outcome === 'ceiling'`, which shows a **Continue** button sending `{continue: true}`;
    - `out` when `promptsLeft === 0`, with the allowance copy;
    - else `send`.
    - The note under the box is `<n> prompts left today · <plan> plan`.
- **The page layout:** on large screens, two columns: conversation on the left, preview on the right. They stack on small screens.
- **The conversation column:**
  - **Agent picker:** a segmented control from `AGENTS`, which PATCHes `agent`. Switching is allowed while idle.
  - **Messages:**
    - user messages on the right;
    - agent messages on the left, labelled with the agent;
    - system messages as a centred muted line.
  - **Proposals:** an agent message with a proposal shows tick-boxes (category label, with "recommended" when it is) and a **Build these** button. That button sends `{text: 'Build these: <slots>', selectedSlots}`.
  - **While working:** while a prompt job is active, the page shows a working bubble with `progressFor`.
  - **The message box:** a textarea (1–4000 characters; Enter sends, Shift+Enter adds a new line). Its state and note come from `composerState`.
  - **Refusals** show `refusalMessage` inline.
  - **Fixing failures:** a **Fix the checker failures (free)** button shows when any piece's revision has `checker.pass === false`. It sends `{fixChecks: true}`.
- **Live updates:** a `job` event with status `done` or `failed` re-reads the detail and usage, and so does a reconnect. Polling follows `nextPoll`.
- [ ] **Step 1: Write the failing tests:**
  - **`progressFor`:** a `Running: blender …` event is skipped for the agent note before it. `/work/design/out/hat/cap.glb` shows as `cap.glb`. With only a `phase: 'checking'` event, the line is `Running the checks…`.
  - **`slotSelection`:** none ticked gives `canBuild: false`. Ticking eyewear and feet from a four-slot proposal gives `slots: ['eyewear','feet']`, in the proposal's order. `initialTicks` gives the recommended slots.
  - **`nextPoll`:** idle gives null; active with the room down gives 5000; active with it up gives 30000.
  - **`composerState`:** an active prompt gives busy; a ceiling outcome gives continue; zero prompts left gives out; otherwise send, with the note `3 prompts left today · free plan`.
- [ ] **Step 2: Run them; expect FAIL.**
- [ ] **Step 3: Implement** the helpers, `useStudioRoom`, the page shell and `Conversation.tsx`.
- [ ] **Step 4: Run them; expect PASS.** Then run the web suite and the typecheck.
- [ ] **Step 5: Commit** `feat(web): the design page and its conversation`

### Task 5: The preview

**Files:**
- Create: `apps/web/src/app/(dashboard)/studio/[designId]/Preview.tsx`, `apps/web/src/app/(dashboard)/studio/[designId]/SpinStage.tsx`
- Modify: `apps/web/src/lib/studio.ts`
- Test: `apps/web/src/lib/studio.test.ts`

**Interfaces:**
- **Produces:**
  - **`viewKey(kind, {bodyShape, outfit, emote}): string`:** the same format as the server's.
  - **`frameAt(start: number, dx: number, width: number, frames: number): number`:** `mod(start - round(dx / width * frames), frames)`. Dragging right by one stage width turns the item one full turn the way the cursor moves.
  - **`stageState(piece: StudioPiece | undefined, key: string, pending: Set<string>): {kind: 'frames'; urls: string[]; renderedAt: string} | {kind: 'rendering'} | {kind: 'empty'; text: string}`:**
    - with no piece: `The agent hasn’t built anything yet. Describe what you want on the left.`;
    - a failed view: `That view didn’t render. Pick it again to retry.`;
    - a view not asked for yet: `rendering` once asked.
  - **`pieceTabStatus(piece, detail): 'ready' | 'building' | 'new'`:** `building` while a prompt job is active and the piece has no revision, or this job will change it (any active prompt counts); `ready` with a revision.
- **The preview column:**
  - **Piece tabs:** category label plus a status `Badge`. The badge is `Building` (info) while a prompt runs, `Ready` (success) when the piece has a revision, `Checker found problems` (warning) when `checker.pass === false`.
  - **The stage:** a square box running `SpinStage`.
    - It preloads all the URLs of the view it's about to show, then swaps.
    - Pointer drag uses `frameAt`; an emote view also loops at 12 fps.
    - Under the stage: `Revision <n> · rendered <relative time>`.
  - **Emote buttons** (wearable designs only): Idle, Wave, Dance, Clap, Walk.
  - **Avatar buttons:** Male and Female, then the outfits Default, Outfit 2 and Outfit 3.
  - **Picking a view:**
    - A view whose `renders[key]` is ready swaps at once.
    - Otherwise the page calls `requestStudioRender`. A `ready` answer swaps; `queued` marks the button `Rendering…` until a `job` done event arrives, then calls again.
- [ ] **Step 1: Write the failing tests:**
  - **`viewKey`:** matches the server's examples (`spin-male-default`, `spin-female-outfit-2-dance`, `emote-male-default`).
  - **`frameAt`:** `(0, 0, 400, 36)` gives 0; `(0, 400, 400, 36)` gives 0 (a full turn); `(0, 100, 400, 36)` gives 27; `(5, -60, 400, 36)` gives 10.
  - **`stageState`:** covers no piece, ready, failed, and pending.
  - **`pieceTabStatus`:** covers its three cases.
- [ ] **Step 2: Run them; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them; expect PASS.** Then run the web suite and the typecheck.
- [ ] **Step 5: Commit** `feat(web): the studio preview: piece tabs, drag-to-spin, emotes and avatars`

### Task 6: Finalizing and paying

**Files:**
- Create: `apps/web/src/app/(dashboard)/studio/[designId]/Finalize.tsx`
- Modify: `apps/web/src/lib/studio.ts`
- Test: `apps/web/src/lib/studio.test.ts`

**Interfaces:**
- **Produces:**
  - **`finalizeStrip(quote: Quote | null, kind): {unlocks: string; button: string | null; blocked: string | null}`:**
    - `unlocks` is the strip copy;
    - `button` is `Finalize · $29`, the quote's total over its payable lines, or null when nothing is payable;
    - `blocked` is the checks-failed copy when the quote has blocked pieces.
  - **`checkoutBody(reports: Record<string, string>): {reports?: Record<string, string>}`:** only reports of 10–2000 characters, after trimming, are sent. The checkout covers every payable piece (`categories` omitted).
  - **`dialogTotal(quote, reported: string[]): number`:** the quote's total minus the reported (waived) lines. Waiving a line changes no other line's price (`priceLines` prices by order, waived or not), so this matches the server exactly.
- **The strip:** it sits at the bottom of the preview column. It shows the unlock copy and the **Finalize** button.
- **The finalize dialog:**
  - **Lines:** one per payable piece, with the piece name, a price label (`First finalize`, `Extra piece`, `Revision`) and the amount. Every payable piece is finalized together: unticking one would change which other piece is the first, so the dialog doesn't offer it.
  - **Revision lines** also offer "This revision fixes the agent’s mistake". Ticking it opens a textarea and strikes the price ("refunded").
  - **Notes:** the quote's `notes` are shown above the total.
  - **Total:** `dialogTotal`.
- **The Pay button:**
  - It calls `finalizeStudio`.
  - A `url` result sends the browser there (`window.location.assign`).
  - A `granted` result closes the dialog and re-reads the detail.
- **Coming back from Stripe:** with `?payment=` in the URL, a banner shows `Payment received. Packaging your files…`. The page polls the detail every 5 s (up to 2 minutes) until a finalized revision appears, then the banner reads `Your files are ready below.` once the entitlement is `ready`.
- [ ] **Step 1: Write the failing tests:**
  - **`finalizeStrip`:** for a wearable quote of 2900 it gives `Finalize · $29`; with nothing payable, `button: null`; a blocked quote gives the copy.
  - **`checkoutBody`:** drops a 5-character report and trims the rest; with none left, it sends `{}`.
  - **`dialogTotal`:** a 1500 + 1000 revision quote with the 1500 line reported gives 1000.
  - **`paymentBanner(searchPayment: string | null, detail, startedAt, now)`:**
    - gives `packaging` until a finalized revision exists;
    - gives `ready` once it is ready;
    - gives `slow` after 2 minutes with nothing, with the copy `Stripe hasn’t confirmed the payment yet. This page will update when it does.`
- [ ] **Step 2: Run them; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them; expect PASS.** Then run the web suite and the typecheck.
- [ ] **Step 5: Commit** `feat(web): finalize and pay from the studio`

### Task 7: Downloads, retries and mistake reports

**Files:**
- Create: `apps/web/src/app/(dashboard)/studio/[designId]/PaidRevisions.tsx`
- Modify: `apps/web/src/lib/studio.ts`
- Test: `apps/web/src/lib/studio.test.ts`

**Interfaces:**
- **Produces:**
  - **`revisionActions(f: FinalizedRevision, now: Date): {download: boolean; retry: boolean; packaging: boolean; report: 'open' | 'done' | 'closed' | 'none'}`:**
    - `report` is `open` within `reportableUntil`;
    - `done` once a report exists, shown as `Refunded` or `Waived`;
    - `closed` past the window;
    - `none` for a first finalize.
- **The panel:** for the selected piece, under the strip, it lists its paid revisions:
  - `Revision <n>`, `First finalize` or `Revision`, the amount paid and the paid date;
  - **Download** (ready), `Packaging…` (packaging) or **Try again** (failed: retry, then re-read).
  - **Report a mistake** opens a form: "What did the agent get wrong?" (10–2000 characters) and "Refund this revision". Sending it shows `Refunded <amount>.` A refusal shows `refusalMessage`.
- [ ] **Step 1: Write the failing tests:** `revisionActions` covers each status, an open report window, a window closed by date, a first finalize, and an existing report.
- [ ] **Step 2: Run them; expect FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them; expect PASS.** Then run the web suite and the typecheck.
- [ ] **Step 5: Commit** `feat(web): studio downloads, free retries and mistake reports`

### Task 8: A seeded local studio for looking at the page

**Files:**
- Create: `apps/server/scripts/studio-seed-page.ts`
- Modify: `apps/server/scripts/studio-local.md` (a "Looking at the page without an agent" section)

**Interfaces:**
- **Produces:** `pnpm exec tsx scripts/studio-seed-page.ts`. It is local only, with the same guard as `studio-local-design.ts`. It creates the user `studio-local@virvi.test` and prints `{accessToken, designs: {wearable, emote, empty}}`. The designs are:
  - **a wearable set:**
    - `hat`: revision 2, 36 spin frames ready, a paid revision 1 that is `ready` with a small `package.zip` in the store, and a reportable paid revision 2;
    - `feet`: `checker.pass: false`;
    - messages, including an agent reply with a slot proposal and a ceiling system note (so **Continue** shows);
  - **an emote design** with 36 frames;
  - **an empty design.**

  Frames are written into the `file://` studio store by `python3` with Pillow: 36 webp images of a coloured bar turning, so dragging visibly works.
- [ ] **Step 1: Write the script and the section.**
- [ ] **Step 2: Run it** against the local server from `studio-local.md` (step 2). Expected: JSON with three design ids, and `GET /api/studio/designs/<wearable>` (bearer) lists `hat` with 36 signed URLs.
- [ ] **Step 3: Commit** `chore(studio): a seeded local studio for the page`

### Task 9: The real page, end to end

No new code unless it finds a bug. Every bug gets a failing `lib/studio.test.ts` test, or a server test, before its fix.

- [ ] **Step 1: The static export builds.** Run `cd apps/web && NODE_ENV=production pnpm exec next build`. Expected: success, with `out/studio/index.html` and `out/studio/_/index.html`.
- [ ] **Step 2: Run the page with seeded data.** Use the local server plus `next dev`, signed in with the seed's access token, and drive it in Chrome. Record a GIF named `studio-page.gif`. Check:
  - the nav item shows;
  - the list shows three designs with their badges;
  - the wearable's page shows the conversation with the tick-boxes, the Continue button and the fix button;
  - dragging the stage turns the bar;
  - the piece tabs and badges are right;
  - Download saves a zip;
  - **Report a mistake** answers `Stripe didn’t answer…`, with a dummy Stripe key set on the server;
  - **Finalize** shows the dialog with the re-curation note and the total;
  - the emote design plays;
  - the empty design says so.
- [ ] **Step 3: One real prompt from the page.** Run the Docker worker from `studio-local.md` (step 4), with Codex. On a new wearable design, type "a neon cap with a glowing visor" and pick the hat if a proposal comes. Expected:
  - live progress lines;
  - a spin of the hat on the stage;
  - picking Dance renders and plays it.

  This costs about $0.20 of agent API.
- [ ] **Step 4: Commit any fixes.** In the handoff, say what was checked, and that the whole-set preview is the next studio step.
