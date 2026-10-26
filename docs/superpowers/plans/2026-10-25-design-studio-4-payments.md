# Design Studio Plan 4: payments

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People pay once to finalize a design's pieces and download a curation-ready package for each. Each later finalize of a piece is a half-price revision, refunded automatically when the customer reports it fixed the agent's mistake. People can also buy prompt top-ups.

**Architecture:**
- **Money:** a new `apps/server/src/studio/payments.ts` prices a checkout (`pricing.ts`), opens a one-time Stripe Checkout session beside the existing subscription checkout, and applies Stripe's webhook once per payment.
- **Entitlements:** a paid revision gets an *entitlement*. The entitlement queues a new worker job type, `finalize`, which builds that revision's package from the exact files that were paid for. The package is then the only model file a browser can ever download, through an authenticated route.
- **Worker:** the worker builds the package deterministically, with no agent run. It makes the thumbnail, runs the skills' curation checks, packs the Builder zip, makes the polished renders and promo clip, writes the report, and uploads one `package.zip` per piece.

**Tech Stack:**
- server: TypeScript, Fastify 5, Drizzle on Postgres, `stripe` ^17 (API `2024-12-18.acacia`), vitest on the real test database;
- worker: Python 3.11, Blender 4.4 (Cycles CPU), the skills' scripts, Playwright and wearable-preview, ffmpeg.

**Spec:** `docs/superpowers/specs/2026-10-24-design-studio-design.md` (sections "Paying", "Revisions after publishing", "Daily prompt allowance"). Also read:
- `docs/superpowers/plans/2026-10-25-design-studio-3-server.md`: the server core this extends. Its Global Constraints still hold.
- `apps/studio-worker/CONTRACT.md`: binding. Task 7 extends it, and the worker and server both follow the new text.
- `apps/server/src/studio/README.md`.

**Not in this plan:**
- Plan 5 (the studio page): all UI, including the finalize strip, checkout redirect, downloads and the report form.
- Plan 6 (the revision log admin page). This plan stores everything that page lists.
- Deploying: Stripe webhook events, prices and the image push are the owner's (README, Task 10).

## Global Constraints

- **Cloud only.** Every new route answers 404 unless `config.studioEnabled`. Routes that need Stripe answer 503 `{code: 'payments_unavailable'}` when `config.stripeSecretKey` is unset.
- **Prices, in US cents.** They are settings in `config.studioPrices` (env names in Task 1). Defaults:

  | Line | Env | Default |
  |---|---|---|
  | first wearable piece in a design | `STUDIO_PRICE_WEARABLE_CENTS` | 2900 |
  | each further first-finalized piece in that design | `STUDIO_PRICE_EXTRA_PIECE_CENTS` | 1900 |
  | emote, first finalize | `STUDIO_PRICE_EMOTE_CENTS` | 3900 |
  | wearable revision, first line in a checkout | `STUDIO_REVISION_WEARABLE_CENTS` | 1500 |
  | each further wearable revision in that checkout | `STUDIO_REVISION_EXTRA_PIECE_CENTS` | 1000 |
  | emote revision | `STUDIO_REVISION_EMOTE_CENTS` | 2000 |
  | prompt top-up pack | `STUDIO_TOPUP_CENTS` / `STUDIO_TOPUP_PROMPTS` | 500 for 10 |
- **First finalize vs revision.** A piece's first finalize is the first entitlement on any of its revisions. Every later entitlement on that piece is a revision ("after publishing" means after first finalized, per the spec).
- **Checks gate finalizing.** A piece whose latest revision has `checker.pass === false` can't be finalized: `409 {code: 'checks_failed', categories}`. Warnings never block.
- **What is paid for is a revision.** An entitlement belongs to one `studio_revisions` row. Downloading later always serves that revision's package, whatever was built since.
- **Mistake reports:**
  - only on a revision entitlement with a charge above 0;
  - one per entitlement, 10–2000 characters, within 30 days of payment;
  - the refund is the full line amount, issued through Stripe at once, with no review;
  - a report made at checkout waives that line instead of charging and then refunding it.
- **Top-ups.** Credits never expire and are used only after today's allowance is spent. The hidden daily cost ceiling still applies to them. A counted prompt that is given back returns to where it came from (allowance or credit).
- **A finalized design is not open.** `openDesignCount` leaves out designs with `finalizedAt`, including ones being revised.
- **Re-curation copy:** a quote that includes a revision line carries `notes: ['Decentraland’s curators review a change to a published item again before it goes live. Decentraland doesn’t charge for that review.']`. The owner confirmed this on 2026-10-25; the docs list no change fee.
- **The browser never receives a model file** except `package.zip` from the download route, for an entitled revision. There are no signed URLs to packages.
- **Stripe Checkout:**
  - `mode: 'payment'`, inline `price_data` (USD), `expires_at` = now + 30 minutes;
  - `metadata` and `payment_intent_data.metadata` both hold `{vlm_user_id, vlm_studio_payment_id}`;
  - `success_url` is `${config.publicUrl}/studio/<designId>?payment=<paymentId>` (`/studio?payment=<id>` for a top-up), and `cancel_url` is the same path without the query.
- **The finalize job's limits** are `{timeoutSec: 1800, maxTurns: 0, costCeilingUsd: 0}`. The sweep already times jobs out from `payload.limits.timeoutSec`.

## Review Focus

1. **A webhook delivered twice, or a session paid twice for the same revision.** Expect one entitlement, one finalize job, and an automatic refund of the duplicate (Task 3 test `duplicate payment for an entitled revision is refunded`).
2. **A prompt after paying, before packaging runs.** Expect the package to be built from the paid revision's stored files, never the workspace (Task 6 `finalize inputs are the paid revision's files only`, Task 8 `builds from inputs, not the workspace`).
3. **A user asking for another user's package, report or quote, or one for a revision that wasn't paid.** Expect 404 for someone else's design and 402 for an unpaid revision (Task 6 tests; route walk in Task 9).
4. **A finalize job that fails or is lost.** Expect the entitlement to show `failed`, a free retry, and no second charge (Task 6 `a lost finalize job fails its entitlements; retry is free`).
5. **A refund that Stripe rejects.** Expect no report stored, a 502 so the user can try again, and the same Stripe idempotency key on the retry (Task 5 `a refused refund stores no report`).

---

### Task 1: Data, prices and finalized designs

**Files:**
- Modify: `apps/server/src/db/schema.ts` (after `studioUsageDays`), `apps/server/src/config.ts`, `apps/server/src/studio/designs.ts` (`openDesignCount`, `publicDesign`)
- Test: `apps/server/test/studio-schema.test.ts`, `apps/server/test/studio-routes.test.ts`

**Interfaces:**
- Produces:
  - **Columns:** `studioDesigns.finalizedAt` (timestamptz, null) and `studioJobs.countedFrom` (text, null: `'allowance' | 'credit'`).
  - **`studioPayments`** (`studio_payments`):
    - `id` uuid pk, `userId` → users cascade, `designId` → studioDesigns cascade (null for a top-up);
    - `kind` `'finalize'|'topup'`, `status` `'pending'|'paid'|'expired'` (default `pending`);
    - `amountCents` int, `lines` jsonb `PaymentLine[]` (default `[]`), `prompts` int (default 0);
    - `stripeSessionId` text unique (null when nothing was charged), `stripeSessionUrl` text, `stripePaymentIntent` text, `refundedCents` int (default 0);
    - `createdAt`, `expiresAt`, `paidAt`.
  - **`studioEntitlements`** (`studio_entitlements`):
    - `id` uuid pk, `revisionId` → studioRevisions cascade, **unique**;
    - `paymentId` → studioPayments, `userId`, `designId` → studioDesigns cascade, `category` text;
    - `kind` `'first'|'revision'`, `amountCents` int;
    - `status` `'packaging'|'ready'|'failed'`, `jobId` uuid null, `packageKey` text null, `checks` jsonb null;
    - `createdAt`.
  - **`studioMistakeReports`** (`studio_mistake_reports`):
    - `id`, `entitlementId` → studioEntitlements cascade, **unique**, `userId`;
    - `text`, `refundCents` int, `status` `'refunded'|'waived'`, `stripeRefundId` text null;
    - `createdAt`.
  - **`studioPromptCredits`** (`studio_prompt_credits`): `userId` pk → users cascade, `balance` int not null default 0, `updatedAt`.
  - **`config.studioPrices`:**

    ```ts
    {
      wearable, extraPiece, emote,
      revisionWearable, revisionExtraPiece, revisionEmote,
      topupCents, topupPrompts,
    }
    ```

    Each value is a number, read with the env names and defaults in Global Constraints. A value that isn't a whole number ≥ 0 throws at startup.
  - **`type PaymentLine`**, exported from schema.ts:

    ```ts
    {
      category: string
      revisionId: string
      revisionNumber: number
      pieceName: string
      priceKind: 'first' | 'first_extra' | 'revision' | 'revision_extra'
      amountCents: number
      waived: boolean
      reportText?: string   // a waived line's mistake report, stored as a report at grant time
    }
    ```

    An entitlement's `kind` comes from its line: `first` and `first_extra` give `'first'`; `revision` and `revision_extra` give `'revision'`.
  - **`publicDesign`** adds `finalizedAt`.

- [ ] **Step 1: Write the failing tests**
  - `studio-schema.test.ts` › `payment tables hold one entitlement per revision and one report per entitlement`: inserting a second entitlement for the same `revisionId` throws `23505`; so does a second report for the same entitlement. `studioPromptCredits` defaults `balance` to 0.
  - `studio-routes.test.ts` › `a finalized design is not open`: a free user (`studioOpenDesigns` 1) with one design whose `finalizedAt` is set can create another design (201), and `GET /api/studio/usage` shows `openDesigns: 1`.
  - `config.test.ts` (or the existing config test file) › `studio prices default and refuse bad values`: the defaults match the table, and `STUDIO_PRICE_EMOTE_CENTS=abc` throws.
- [ ] **Step 2: Run them and watch them fail.** Run `t.sh test/studio-schema.test.ts test/studio-routes.test.ts`. Expected: FAIL (no tables, no column).
- [ ] **Step 3: Implement** the tables and columns, `config.studioPrices` (a small `cents(name, def)` reader beside the existing `env()`), `openDesignCount` adding `isNull(studioDesigns.finalizedAt)`, and `publicDesign` adding `finalizedAt`. Tests use `drizzle-kit push` through the existing setup.
- [ ] **Step 4: Run them.** Expected: PASS. Then run the whole server suite. Expected: green.
- [ ] **Step 5: Commit** `feat(studio): payment, entitlement, report and credit tables; prices as settings`

### Task 2: Quotes and the checker gate

**Files:**
- Create: `apps/server/src/studio/pricing.ts`
- Modify: `apps/server/src/routes/studio.ts`
- Test: `apps/server/test/studio-pricing.test.ts`

**Interfaces:**
- Consumes: Task 1's tables and `config.studioPrices`.
- Produces:
  - **`quoteFinalize(design: Design, categories: string[] | null, waived: string[]): Promise<Quote>`.** `null` means every payable piece. `Quote` is:

    ```ts
    {
      pieces: QuotePiece[]
      lines: PaymentLine[]
      totalCents: number
      blocked: string[]   // categories whose checker failed
      notes: string[]
    }
    ```

    and each `QuotePiece` is:

    ```ts
    {
      category, name, revisionNumber, revisionId,
      state: 'payable' | 'entitled' | 'blocked' | 'none'
      kind: 'first' | 'revision'
      checker
    }
    ```

  - **`QuoteError`:** an error class whose `code` is `'checks_failed' | 'nothing_to_pay' | 'unknown_piece' | 'not_waivable'`, plus `categories: string[]`.
  - **Route:** `GET /api/studio/designs/:id/finalize` → the quote for every payable piece, with `waived: []`.
- **Pricing rule:**
  - Lines are sorted by category.
  - First-finalize lines: an emote is `emote`. For a wearable, the first line is `wearable` when no piece of the design has an entitlement yet, and every other first line is `extraPiece`.
  - Revision lines: an emote is `revisionEmote`. For a wearable, the first revision line in the quote is `revisionWearable` and the rest are `revisionExtraPiece`.
  - A category in `waived` must be a revision line (else `not_waivable`). Its `amountCents` is kept, `waived: true`, and it isn't counted in `totalCents`.

- [ ] **Step 1: Write the failing tests** (`studio-pricing.test.ts`; build designs, pieces and revisions with `test/helpers/studio.ts`):
  - `a new three-piece set is 2900 + 1900 + 1900`: total 6700, and the lines' `priceKind` are `first`, `first_extra`, `first_extra`.
  - `an emote is 3900, its revision 2000`.
  - `a piece added to a finalized set is an extra piece`: the design has an entitlement on `hat`, and a new `feet` piece is `first_extra` at 1900.
  - `revisions are 1500 then 1000`: two pieces that are both entitled on an older revision give 1500 + 1000, and the quote's `notes` has the re-curation sentence.
  - `an entitled latest revision is not payable`: its state is `entitled`, and asking for only that category throws `nothing_to_pay`.
  - `a failed checker blocks`: `checker.pass === false` gives `blocked: ['hat']` in the full quote, and asking for `['hat']` throws `checks_failed` with `categories: ['hat']`.
  - `waiving a revision line removes it from the total`.
  - `waiving a first finalize is refused`: throws `not_waivable`.
  - `GET /finalize on someone else's design is 404; with the studio off it is 404`.
- [ ] **Step 2: Run and watch them fail.** Expected: module not found.
- [ ] **Step 3: Implement `pricing.ts` and the GET route.** The route returns the quote. A `QuoteError` maps to `409 {error: code, code, categories}`, apart from `unknown_piece`, which is a 400.
- [ ] **Step 4: Run them.** Expected: PASS. Then run the suite.
- [ ] **Step 5: Commit** `feat(studio): finalize quotes, half-price revisions and the checker gate`

### Task 3: Checkout and the webhook

**Files:**
- Create: `apps/server/src/studio/payments.ts`
- Modify:
  - `apps/server/src/integrations/stripe.ts`: export `setStripe(client | null)`, which `getStripe` returns when set; extract `ensureCustomer(userId, email): Promise<string>` from `createCheckoutSession`; dispatch studio events in `handleWebhookEvent`.
  - `apps/server/src/routes/studio.ts`
- Test: `apps/server/test/studio-payments.test.ts`, and add `fakeStripe()` to `apps/server/test/helpers/studio.ts`.

**Interfaces:**
- Consumes: `quoteFinalize`, and from Plan 3 `startWorker`. Export `startWorker` from `designs.ts`; it's module-private today.
- **`fakeStripe()`** records `checkout.sessions.create` calls and answers `{id: 'cs_test_<n>', url: 'https://checkout.stripe.test/<n>'}`. It records `refunds.create(params, opts)` and answers `{id: 're_<n>'}`, or throws when `failRefunds` is set. `customers.create` answers `{id: 'cus_<n>'}`.
- **Produces:**
  - `createFinalizeCheckout(design, user: {id, email}, categories: string[] | null, reports: Record<string, string>, now): Promise<{url: string} | {granted: true, paymentId}>`
  - `createTopupCheckout(user, packs: number, now): Promise<{url}>`
  - `handleStudioSession(event): Promise<boolean>` (true when the event was a studio one)
  - `grantPayment(paymentId, paymentIntent: string | null, now): Promise<'granted' | 'already'>`
  - `queueFinalize(designId, entitlementIds: string[], now): Promise<string>`. This creates the job (Task 6 fills in its payload), sets those entitlements to `packaging` with `jobId`, publishes `{type: 'job', status: 'queued'}`, and calls `startWorker`.
- **Routes:**
  - `POST /api/studio/designs/:id/finalize` with body `{categories?: string[], reports?: {[category]: string}}` → 200 `{url}` or `{granted: true}`;
  - `POST /api/studio/topups` with body `{packs?: 1..10}` (default 1) → `{url}`.
- **Rules:**
  - **An open checkout is reused.** If there is a `pending`, unexpired finalize payment for this design with the same revision ids, return its `stripeSessionUrl` rather than opening another session.
  - **The payment row comes first.** The `pending` payment row (with its lines) is inserted before the Stripe call. A Stripe failure deletes it and answers 502 `{code: 'stripe_error'}`.
  - **Reports at checkout are stored.** `reports` is stored as the waived lines' report text, at grant time.
  - **A fully waived checkout skips Stripe.** When `totalCents` is 0 (every line waived), `grantPayment` runs at once with no Stripe call.
- **`grantPayment`** runs in one transaction:
  1. Claim the payment: `pending → paid` with a conditional update, else return `'already'`.
  2. For a finalize payment, insert one entitlement per line (`kind` from `priceKind`, `amountCents` 0 when waived), `ON CONFLICT (revision_id) DO NOTHING`. A line whose revision was already entitled is a duplicate: sum those amounts into `refundedCents`.
  3. Insert a `waived` report for each waived line, with its `reportText` from the line (stored on the payment at checkout).
  4. Set `finalizedAt` if it is null.
  5. For a top-up, add `prompts` to `studio_prompt_credits` with an upsert.

  After the transaction commits, refund `refundedCents` through `refunds.create({payment_intent, amount}, {idempotencyKey: 'studio-dup-' + paymentId})` when it is above 0. Then call `queueFinalize` for the new entitlements.
- **Webhook events:**
  - `checkout.session.completed` and `checkout.session.async_payment_succeeded` with `metadata.vlm_studio_payment_id` and `payment_status === 'paid'` → `grantPayment(id, session.payment_intent)`;
  - `checkout.session.expired` → a `pending` payment becomes `expired`.

  Subscription handling is unchanged: a session with `mode === 'subscription'` never reaches studio code.

- [ ] **Step 1: Write the failing tests** (`studio-payments.test.ts`; `config.stripeSecretKey` is set and `setStripe(fakeStripe())` is used). Send webhooks through `POST /api/billing/webhook`, signed with `Stripe.webhooks.generateTestHeaderString` and `config.stripeWebhookSecret` set, as `billing-webhook.test.ts` does.
  - `checkout opens one Stripe session at the quoted price`: one `sessions.create` call with `mode: 'payment'`, line `unit_amount` values `[2900]`, both metadata ids, the `success_url` path `/studio/<designId>?payment=<id>`, and an `expires_at` about 1800 s out. The payment row is `pending`.
  - `a second click reuses the open session`: same url, one `sessions.create` call.
  - `the paid webhook grants entitlements and queues one finalize job`: one entitlement `packaging`; one `finalize` job queued; `finalizedAt` set; `fakeFly` got a start.
  - `the same webhook twice changes nothing`: still one entitlement and one job.
  - `duplicate payment for an entitled revision is refunded`: two sessions for the same revision are both paid; the second gets a `refunds.create` for its line amount with the `studio-dup-` key, and still one entitlement.
  - `an expired session expires its payment`.
  - `a fully waived checkout grants at once`: a revision line with a report gives `{granted: true}`, no `sessions.create`, an entitlement with `amountCents` 0, and a `waived` report holding the text.
  - `a blocked piece can't be bought`: 409 `checks_failed`, and no payment row.
  - `a top-up adds credits when paid`: `packs: 2` gives `unit_amount` 500 with quantity 2; after the webhook the balance is 20.
  - `without Stripe the routes answer 503`.
  - `subscription checkouts still activate a subscription` (keep the existing behaviour, one assertion).
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement** `setStripe`, `ensureCustomer`, `payments.ts`, the routes and the webhook dispatch. `queueFinalize` can insert a placeholder `finalize` payload here; Task 6 completes it.
- [ ] **Step 4: Run them, then the suite.** Expected: green, with `billing-webhook.test.ts` unchanged.
- [ ] **Step 5: Commit** `feat(studio): one-time checkout for finalizing and top-ups, applied once from the webhook`

### Task 4: Top-up credits in the quota, and the free fix prompt

**Files:**
- Modify: `apps/server/src/studio/quota.ts`, `apps/server/src/studio/results.ts` (refund call sites), `apps/server/src/studio/designs.ts` (`queuePrompt`, `usage`), `apps/server/src/routes/studio.ts` (prompt body)
- Test: `apps/server/test/studio-quota.test.ts`, `apps/server/test/studio-routes.test.ts`

**Interfaces:**
- Produces:
  - **`reservePrompt`** returns `{ok: true, day, from: 'allowance' | 'credit' | null}` (`null` when not counted). Once the allowance is spent, and when the cost ceiling isn't reached, it takes a credit with `UPDATE studio_prompt_credits SET balance = balance - 1 WHERE user_id = $1 AND balance > 0 RETURNING balance`, in the same `exec`.
  - **`refundPrompt(userId, day, from, exec?)`**: `'credit'` adds one to the balance; `'allowance'` (or null, for older rows) does what it does today.
  - **`promptStatus`** adds `credits`, and `left = max(0, allowance - used) + credits`. `usage()` passes `credits` through.
  - **`queuePrompt`** stores `countedFrom`, and accepts `input.fixChecks: boolean`.
  - **Route:** `POST …/prompts {fixChecks: true}` (no text) queues an uncounted prompt whose text is exactly `` `Fix every FAIL the checker reported for: ${categories.join(', ')}. Change nothing else.` ``, with `selectedSlots: null`. The categories are those whose latest revision has `checker.pass === false`. With none it answers `409 {code: 'nothing_to_fix'}`.
- [ ] **Step 1: Write the failing tests:**
  - `credits are used after the allowance`: a free user (3 a day) with 2 credits gets prompts 4 and 5, and is refused at 6 with `allowance`.
  - `an error refund returns a credit`: the job's `countedFrom` is `credit`, and after an `error` result the balance is back.
  - `credits never pass the cost ceiling`.
  - `usage shows credits`: `promptsLeft` is 3 + credits.
  - `a fix prompt is free and names the failing pieces`: the job is not counted, and its payload `prompt` is the exact text.
  - `a fix prompt with nothing failing is 409`.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, then the suite.**
- [ ] **Step 5: Commit** `feat(studio): prompt top-ups after the daily allowance; free checker-fix prompts`

### Task 5: Mistake reports and refunds

**Files:**
- Modify: `apps/server/src/studio/payments.ts`, `apps/server/src/routes/studio.ts`
- Test: `apps/server/test/studio-payments.test.ts`

**Interfaces:**
- Produces:
  - `reportMistake(design, category, revisionNumber, text, now): Promise<{status: 'refunded', refundCents} | {error: code, status}>`
  - **Route:** `POST /api/studio/designs/:id/pieces/:category/revisions/:number/report {text}` → 200 `{status: 'refunded', refundCents}`.
- **Refusals:**

  | Status | Code | When |
  |---|---|---|
  | 400 | — | text that isn't 10–2000 characters |
  | 402 | `not_paid` | no entitlement |
  | 409 | `not_a_revision` | a first finalize |
  | 409 | `nothing_charged` | `amountCents` 0 |
  | 409 | `already_reported` | the entitlement already has a report |
  | 409 | `report_window_closed` | the payment's `paidAt` is over 30 days ago |
  | 502 | `stripe_error` | Stripe refuses the refund |
- **Order:** call `refunds.create({payment_intent, amount: amountCents, metadata: {vlm_studio_entitlement_id}}, {idempotencyKey: 'studio-report-' + entitlementId})` first. Then insert the report (`refunded`, `stripeRefundId`) and add the amount to the payment's `refundedCents`. If Stripe throws, nothing is stored.
- [ ] **Step 1: Write the failing tests:**
  - `a report refunds the revision's line in full`: 1000 cents for a `revision_extra` line, refunded once with the `studio-report-` key; the report row holds the text.
  - `a second report is 409 already_reported`.
  - `a first finalize can't be reported`.
  - `after 30 days the window is closed`.
  - `a refused refund stores no report`: with `failRefunds`, the answer is 502, there's no row, and a retry uses the same idempotency key.
  - `the customer keeps the files after a refund`: the entitlement is unchanged.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, then the suite.**
- [ ] **Step 5: Commit** `feat(studio): agent-mistake reports refund a paid revision automatically`

### Task 6: The finalize job and downloads (server side)

**Files:**
- Modify:
  - `apps/server/src/studio/store.ts`: `checkFilePath` gains the kind `'final'` for `final/<category>/package.zip`;
  - `apps/server/src/studio/results.ts`: `parseResult`, `applyResult` and `failJobs` for `finalize`;
  - `apps/server/src/studio/payments.ts`: the `queueFinalize` payload;
  - `apps/server/src/routes/studio-worker.ts`: the inputs route;
  - `apps/server/src/routes/studio.ts`: download and retry;
  - `apps/server/src/studio/designs.ts`: `designDetail`.
- Test: `apps/server/test/studio-finalize.test.ts`, `apps/server/test/studio-store.test.ts`

**Interfaces:**
- **The finalize job payload** (the contract's Job, Task 7):

  ```json
  {"type": "finalize", "kind": "wearable", "agent": null, "model": null, "prompt": null, "selectedSlots": null,
   "limits": {"timeoutSec": 1800, "maxTurns": 0, "costCeilingUsd": 0}, "render": null,
   "finalize": {"designName": "Neon set", "pieces": [
     {"category": "hat", "revision": 2, "files": ["pieces/hat/neon_cap_male.glb", "pieces/hat/neon_cap_female.glb",
       "pieces/hat/piece.json", "checks/hat.txt"], "sourceJobId": "<uuid>"}]}}
  ```

  `files` and `sourceJobId` come from the entitled revision (`studio_revisions.files` and `jobId`).
- **The worker inputs route:** `GET /api/studio/worker/jobs/:jobId/inputs/*`. It is authenticated like the other worker routes (the token's design must own the job, the job must be `taken`, `type === 'finalize'`), and the path must be in one payload piece's `files`. It streams `jobFileKey(designId, sourceJobId, path)` with the stored content type. Anything else answers 404.
- **`applyResult` for `finalize`:**
  - Each entitlement with `jobId` = this job becomes `ready`, with `packageKey = jobFileKey(designId, jobId, 'final/<category>/package.zip')` and `checks` = that piece's `finalize` summary from the result, when the result lists that file for its category. Otherwise it becomes `failed`.
  - A failed one adds a system message: `` `Packaging ${name} failed. You can try again at no charge.` ``
  - A finalize job never touches the quota, the cost or the design's `status`.
- **`failJobs` for `finalize`:** its entitlements become `failed`, with the same message.
- **The download route:** `GET /api/studio/designs/:id/pieces/:category/revisions/:number/package`, for the owner. It answers:
  - 402 `not_paid` with no entitlement;
  - 409 `packaging` while packaging;
  - 409 `failed` when packaging failed;
  - otherwise it streams the package with `Content-Type: application/zip`, `Content-Disposition: attachment; filename="<slug(pieceName)>-r<n>.zip"` and `Cache-Control: private, no-store`.
- **The retry route:** `POST …/revisions/:number/package/retry`. On a `failed` entitlement it calls `queueFinalize(designId, [id])` → 202. Otherwise it answers 409 `not_failed`.
- **`designDetail`** adds `pieces[].finalized: [{revision, kind, status, amountCents, paidAt, report: {status, createdAt} | null, reportableUntil}]`, newest first, and `design.finalizedAt`. The package is never linked there; Plan 5 calls the download route.
- [ ] **Step 1: Write the failing tests:**
  - `studio-store.test.ts`: `final/hat/package.zip` is `{kind: 'final', category: 'hat'}`, and `final/hat/x.glb` and `final/hat/../package.zip` are refused.
  - `studio-finalize.test.ts` (use `issueWorker` and `queueJob`):
    - `the finalize job names the paid revision's files`: after a paid webhook, `jobs/next` returns `type: 'finalize'` with the revision's files and `limits.timeoutSec` 1800.
    - `finalize inputs are the paid revision's files only`: the GLB bytes are the stored ones, even after a later prompt made revision 2. A path not in the payload is 404, another design's token is 403, and a prompt job's id is 404.
    - `a result with the package marks the entitlement ready`: this needs an upload to `final/hat/package.zip`, then the result.
    - `a missing package fails that piece`, with the system message.
    - `a lost finalize job fails its entitlements; retry is free`: `failJobs` gives `failed`, the retry answers 202, a new job is queued, and no `sessions.create` call is made.
    - `the owner downloads the zip`: the exact bytes and the headers.
    - `another user gets 404; an unpaid revision is 402; packaging is 409`.
    - `designDetail lists finalized revisions without links`: `finalized[0].status`, no `packageKey`, and no URL containing `package`.
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them, then the suite.**
- [ ] **Step 5: Commit** `feat(studio): finalize jobs build the paid revision's package; authenticated downloads`

### Task 7: The contract

**Files:**
- Modify: `apps/studio-worker/CONTRACT.md`, `apps/studio-worker/tests/fake_api.py`

**Interfaces:**
- **Produces (the CONTRACT.md text):**
  - **Endpoints:** add `GET /jobs/{jobId}/inputs/{path}` → 200 with the file's bytes. It answers only for a taken finalize job, and only for the paths it lists.
  - **Job:** `type` adds `"finalize"`, which builds the paid revision's package and saves no workspace. `finalize` is `{designName, pieces: [{category, revision, files}]}` (`sourceJobId` is VLM's and is ignored). `agent`, `model` and `prompt` are null.
  - **Files:** add `final/<category>/package.zip`, the paid package, for paid downloads only.
  - **Result for a finalize job:**
    - `pieces` holds `{category, files: ["final/<category>/package.zip"], finalize: {thumbnail: {pass}, listing: {pass} | null, clipping: {pass, failed: [clip]} | null, emoteCheck: {pass} | null}}` for each piece packaged.
    - `outcome` is `ok` when every piece was packaged, else `error`; the pieces that did package are still listed.
    - `costUsd` and `tokens` are null.
  - **Package layout** (inside `package.zip`):
    - `<name>_male.glb` / `<name>_female.glb` / `<name>.glb`, as built;
    - `thumbnail.png`;
    - `builder.json`: `{name, category, hides, replaces, tags}`;
    - `listing.json`: `{name, rarity, description, tags}`;
    - `item.zip`: the Builder upload, from `package_item.py`; wearables only;
    - `renders/<bodyShape>-<front|right|back|left>.png`, at 1024 px;
    - `promo.mp4`;
    - `REPORT.md`.
  - **`REPORT.md` sections:**
    - Wearable checker (or Emote checker) and Thumbnail;
    - Listing and Clipping through Decentraland's animations (wearables);
    - "Not run here", with what to do next: upload `item.zip` in the Builder, Builder preview, in-world self-preview in the desktop explorer, and Decentraland's `wearable-validator`.
- **Piece settings:** `piece.json` gains `"rarity"` for wearables, one of the Builder's rarities. Its `description` is at most 64 characters, and `name`, `description`, `tags` and `rarity` follow `listing-dcl-wearables`.
- [ ] **Step 1: Edit CONTRACT.md.** Add `inputs` to `fake_api.py`, serving from a dict the test sets.
- [ ] **Step 2: Commit** `docs(studio-worker): contract for finalize jobs and packages`

### Task 8: The worker's finalize job

**Files:**
- Create: `apps/studio-worker/studio_worker/finalize.py`, `apps/studio-worker/studio_worker/thumbnail_blend.py` (runs inside Blender)
- Modify:
  - `api.py`: `get_input(job_id, path) -> bytes`;
  - `jobs.py`: dispatch `finalize`;
  - `render.py`: a `thumbnail` mode;
  - `instructions.py`: the piece.json fields;
  - `Dockerfile`;
  - `e2e/drive_worker.py`: fake tools.
- Test: `apps/studio-worker/tests/test_finalize.py`, `tests/test_jobs.py`, `tests/test_render.py`

**Interfaces:**
- Consumes: Task 7's text.
- **Produces:** `finalize_job(job, client, design, render_fn, tools: Tools, result) -> None`, called from `run_job`. `Tools` is a dataclass whose callables each return `(ok: bool, output: str)`:

  ```python
  blender(args, timeout)
  python(script, args, timeout)
  ffmpeg(args, timeout)
  ```

  `Tools.real()` runs the real binaries (`blender`, `sys.executable`, `ffmpeg`). `jobs.run_job` gains `tools: Tools | None = None`.
- **Per piece, in a fresh root-owned stage folder** (never `design/`, and no workspace save):
  1. **Inputs.** Download each listed file with `get_input`. A missing GLB or `piece.json` fails that piece.
  2. **Thumbnail:**
     - Wearable: `tools.blender(['-b', '--factory-startup', '--python', thumbnail_blend.py, '--', '--glb', <first GLB>, '--out', thumbnail.png, '--size', '256'], 300)`. `thumbnail_blend.py` imports the GLB into an empty scene and renders it with Cycles on the CPU, at 32 samples, with a transparent film, a 3/4 front orthographic camera fitted to the item's bounding box with a 10% margin, and soft studio lighting.
     - Emote: `render_fn(..., view {mode: 'thumbnail', bodyShape: 'male', outfit: 'default'}, size=512)`. The `thumbnail` mode pauses the emote at half its length, loads with `disableBackground=true`, screenshots with `omit_background=True`, and saves `thumbnail.png` at 256 px.

     Then `tools.python(SKILLS/…/check_thumbnail.py, [thumbnail.png], 60)`, where exit 0 is a pass.
  3. **Listing** (wearables): write `listing.json` as the skill's input, `{collection: designName, items: [{file, name, category, rarity (default 'epic'), description, utility: '', tags, hides}]}`, then run `check_listing.py`.
  4. **Clipping** (wearables), per body shape:

     ```
     tools.blender([ASSETS/<AvatarShape_A.blend male | AvatarShape_B.blend female>, '-b', '--python',
                    check_clipping.py, '--', '--glb', g, '--category', c, '--hides', ',' .join(hides),
                    '--anims', '/opt/dcl-animations', '--json', clip_<shape>.json], 900)
     ```

     A unisex GLB runs on both. Use its exit code and JSON (the failing clip names).
  5. **Builder zip** (wearables): run `package_item.py item.zip --name … --category … --rarity … --male/--female or --unisex … --thumbnail … --description … --hides … --replaces … --tags …`. A failure here fails the piece.
  6. **Renders:** `render_fn(…, {mode: 'look', bodyShape, outfit: 'default', emote: None}, size=1024)` for each body shape the piece has, renamed to `renders/<shape>-<view>.png`. An emote uses the `look` mode with its emote playing (its midpoint).
  7. **Promo:**
     - render a 72-frame, 720 px clip: a wearable spins with `emote: 'dance'`; an emote plays itself (`mode: 'emote'`);
     - then `tools.ffmpeg(['-y', '-framerate', '24', '-i', '<dir>/%03d.webp', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', promo.mp4], 300)`.

     A render or ffmpeg failure fails the piece.
  8. **Report:** write `REPORT.md` as in Task 7. Copy in the revision's `checks/<category>.txt` as the checker section, and summarise each check as PASS or FAIL with its output, cut to 200 lines.
  9. **Package:** write `package.zip` with `zipfile` (deflate) and upload it as `final/<category>/package.zip` (`application/zip`).

  Checks that fail (thumbnail, listing, clipping) are reported, not fatal: the customer has paid, and `REPORT.md` tells them plainly.
- **`instructions.py`:** `LAYOUT`'s piece.json line gains `"rarity": "common" | "uncommon" | "rare" | "epic" | "legendary" | "exotic" | "mythic" | "unique"` for wearables, and the instruction "Name, describe (at most 64 characters), tag and pick a rarity for each piece with the listing-dcl-wearables skill."
- **Dockerfile:**
  - add `ffmpeg` to the apt line;
  - after the skills clone, `RUN python3 /opt/skills/skills/curating-dcl-wearables/scripts/fetch_dcl_animations.py /opt/dcl-animations && chmod -R a+rX /opt/dcl-animations`.
- [ ] **Step 1: Write the failing tests** (`test_finalize.py`; use `fake_api.py`, the fake render, and a `FakeTools` that writes the expected output files and records the calls):
  - `test_package_has_every_file`: the uploaded `final/hat/package.zip` lists exactly the Task 7 layout for a male+female hat.
  - `test_builds_from_inputs_not_workspace`: a different GLB in `design/out/hat/` isn't the one packaged.
  - `test_failed_checks_are_reported_not_fatal`: clipping exits 1 with `Dance` failing, so the outcome is `ok`, `clipping.pass` is false, and `REPORT.md` names Dance.
  - `test_render_failure_fails_only_that_piece`: two pieces, one renders blank, so the outcome is `error` and the other piece is listed with its package.
  - `test_emote_package`: no `item.zip` or `listing.json`, `emoteCheck` comes from `checks/emote.txt`, and the thumbnail comes from the render.
  - `test_missing_input_fails_piece`.
  - `test_jobs.py` › `test_finalize_saves_no_workspace`: no `put_workspace` call.
  - `test_render.py` › `test_thumbnail_mode_query`: `disableBackground=true` is in the URL query for the `thumbnail` mode.
- [ ] **Step 2: Run** `cd apps/studio-worker && python3 -m pytest -q` and watch them fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the worker suite.** Expected: all pass (55 + new).
- [ ] **Step 5: Commit** `feat(studio-worker): finalize jobs build the curation-ready package`

### Task 9: The real worker against the real routes, and the route walk

**Files:**
- Modify: `apps/server/test/studio-contract.test.ts`, `apps/studio-worker/e2e/drive_worker.py`, `apps/server/test/cross-account-walk.test.ts`, `apps/server/test/scene-pass-guard.test.ts` (if it lists studio routes)
- Create: `apps/studio-worker/e2e/finalize_real.sh`

**Interfaces:**
- **`drive_worker.py`:** passes `tools=FakeTools()` when `STUDIO_FAKE_TOOLS=1`. Its fakes write tiny valid files, and its thumbnail is a 256 px transparent PNG, so `check_thumbnail.py` runs for real.
- **`finalize_real.sh`:** in the local Docker image, with no agent keys needed, runs one finalize job on the fixture hat from `tests/fixtures` against `fake_api.py`. That covers real Blender, real wearable-preview, real ffmpeg and the real checks. It prints the package listing and `REPORT.md`.
- [ ] **Step 1: Extend the contract test.** `the python worker packages a paid revision`: after the prompt from the existing test, the test marks a payment paid through `grantPayment` (fake Stripe), runs the worker with `STUDIO_FAKE_TOOLS=1`, waits for the entitlement to be `ready`, downloads the package through the route, and finds `REPORT.md` and both GLBs in it.
- [ ] **Step 2: Extend the route walk.**
  - Add the payment tables to `TABLES` and B's fixtures: a payment, an entitlement and a report.
  - The new user routes must 404 for A on B's design: `GET`/`POST /finalize`, `/report`, `/package` and `/package/retry`.
  - `POST /api/studio/topups` only ever acts on the caller, so add it to `NOT_CROSS_ACCOUNT` with that reason.
  - Add the inputs route to the worker-token list.
- [ ] **Step 3: Run the server suite and the worker suite.** Expected: green.
- [ ] **Step 4: Real run.** Build the image (`docker build --platform linux/amd64 -t vlm-studio-worker:dev apps/studio-worker`, with the `.blend` assets copied into `assets/`), then run `e2e/finalize_real.sh`. Expected: `package.zip` with every Task 7 file; `check_thumbnail` PASS; `REPORT.md` with a clipping section; a playable `promo.mp4` (`ffprobe` shows h264, 72 frames). If the `thumbnail` mode's background is not transparent for emotes, rule on the smallest fix (for example an alpha key on the preview's flat background) and ledger it.
- [ ] **Step 5: Commit** `test(studio): the real worker packages a paid revision; route walk covers payments`

### Task 10: Deploy notes

**Files:**
- Modify: `apps/server/src/studio/README.md`, `apps/studio-worker/README.md`

- [ ] **Step 1: README.md (server).**
  - Add `payments.ts` and `pricing.ts` to the file table.
  - Add the owner's steps:
    - enable the webhook events `checkout.session.completed`, `checkout.session.async_payment_succeeded` and `checkout.session.expired` on the existing endpoint;
    - prices are the `STUDIO_PRICE_*` / `STUDIO_REVISION_*` / `STUDIO_TOPUP_*` variables, and nothing needs creating in Stripe;
    - run `drizzle-kit push` for the four new tables;
    - push the new worker image (it adds ffmpeg and the baked animations).
- [ ] **Step 2: README.md (worker).** Add the finalize job and `finalize_real.sh`.
- [ ] **Step 3: Commit** `docs(studio): payments deploy steps`
