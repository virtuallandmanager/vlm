# Design Studio Gift Codes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins make codes that give a studio user gifted prompts and free first-finalizes, with a use count and an optional expiry.

**Architecture:** Two new tables (codes, redemptions), a gifted-prompt column beside the bought balance, a free-finalize
balance per user, and a `gifts_held` count on finalize payments. Gifted prompts are spent after the day's allowance and
before bought prompts, and skip the daily cost ceiling. A free finalize is moved from the balance onto the payment when
the checkout is made, given back when that checkout expires or is replaced, and kept when it is paid.

**Tech Stack:** Fastify, Drizzle (Postgres), Vitest, Next.js (apps/web), Stripe Checkout.

**Spec:** `docs/superpowers/specs/2026-10-30-studio-gift-codes-design.md`

## Global Constraints

- Billing code changes only as far as this feature needs (owner's permission for this feature only): `apps/server/src/studio/{pricing,payments,quota}.ts`.
- A free-finalize credit is never spent twice or lost; an abandoned checkout gives it back; a paid one uses it exactly once; concurrent redeems and checkouts never over-grant.
- Codes are stored as SHA-256 hashes of the normalized code; the plain code is shown once, when made.
- Codes are case-insensitive, read-aloud friendly: alphabet `23456789ABCDEFGHJKMNPQRSTUVWXYZ` (no 0, O, 1, I, L), 12 characters shown as `XXXX-XXXX-XXXX`; spaces and hyphens are ignored when typed.
- Redeeming is rate-limited per account: 10 attempts an hour.
- New tables and columns are in `src/db/schema.ts` (drizzle-kit push) and in the raw-SQL fallback of `apps/server/entrypoint.sh` (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN IF NOT EXISTS`).
- New copy uses Virvi names; `node scripts/check-no-vlm.mjs` reports 0 hits.
- Commit trailers: `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_018ds2NZXw5KLxDpVm9B3ABD`.
- Tests run against `vlm_test` (the vitest config's default); never the dev DB `vlm`. Node 22: `export PATH=~/.nvm/versions/node/v22.23.3/bin:$PATH`.

## Review Focus

1. A person with gifted prompts who has hit the daily cost ceiling can still send prompts (and continue/fix runs) until the gifted ones are gone — Task 4 test `gifted prompts run past the cost ceiling`.
2. Opening a second checkout for the same design while the first still holds the free finalize must not leave the credit stuck or used twice — Task 5 test `a new checkout replaces the open one and takes over its free finalize`.
3. A free-finalize line whose revision was already paid by another checkout by grant time gives the credit back — Task 5 test `a gift line already paid elsewhere gives its credit back`.
4. Two people redeeming the last use at once: exactly one succeeds — Task 3 test `the last use goes to one of two concurrent redeems`.
5. A code typed in lowercase with spaces still redeems — Task 3 test `redeems a code typed in lowercase with spaces`.

---

### Task 1: Tables and code helpers

**Files:**
- Modify: `apps/server/src/db/schema.ts` (beside `studioPromptCredits`, `studioPayments`), `apps/server/entrypoint.sh`
- Create: `apps/server/src/studio/gift-codes.ts`
- Test: `apps/server/test/studio-gift-codes.test.ts`

**Interfaces:**
- Produces:
  - Tables: `studioGiftCodes` (`studio_gift_codes`: `id` uuid pk, `codeHash` text unique not null, `codeHint` text not null (last 4 characters), `note` text, `prompts` int not null, `finalizes` int not null, `maxUses` int not null, `uses` int not null default 0, `expiresAt` timestamptz null, `disabledAt` timestamptz null, `createdBy` uuid → users set null, `createdAt`); `studioGiftRedemptions` (`studio_gift_redemptions`: `id` uuid pk, `codeId` → codes cascade, `userId` → users cascade, `createdAt`; unique (`codeId`, `userId`)); `studioFinalizeCredits` (`studio_finalize_credits`: `userId` pk → users cascade, `balance` int not null default 0, `updatedAt`).
  - Columns: `studioPromptCredits.gifted` (`gifted` int not null default 0); `studioPayments.giftsHeld` (`gifts_held` int not null default 0).
  - `PaymentLine.gift?: boolean` — a first-finalize line paid by a free-finalize credit.
  - `newGiftCode(): string` → `'XXXX-XXXX-XXXX'`; `normalizeGiftCode(raw: string): string` (uppercase, drop spaces and hyphens); `hashGiftCode(raw: string): string` (sha256 hex of the normalized code).

- [ ] **Step 1: Write the failing tests**

```ts
it('makes 12-character codes from the read-aloud alphabet', () => {
  const c = newGiftCode()
  expect(c).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/)
  expect(new Set(Array.from({ length: 50 }, newGiftCode)).size).toBe(50)
})
it('hashes the normalized code', () => {
  expect(hashGiftCode('abcd efgh-jkmn')).toBe(hashGiftCode('ABCD-EFGH-JKMN'))
  expect(normalizeGiftCode(' ab-cd ')).toBe('ABCD')
})
```
Plus a schema round-trip: insert a code, a redemption, a finalize credit row; a second redemption of the same code by the same user throws a unique violation.

- [ ] **Step 2:** Run `pnpm exec vitest run test/studio-gift-codes.test.ts` in `apps/server`. Expected: FAIL (module not found).
- [ ] **Step 3:** Add the tables, columns and `PaymentLine.gift`; the entrypoint fallback lines; implement the three helpers with `crypto.randomInt`.
- [ ] **Step 4:** Run the same command. Expected: PASS. Then `pnpm exec tsc --noEmit -p .` clean.
- [ ] **Step 5:** Commit `feat(studio): gift code tables and code helpers`.

### Task 2: Admins make, list and turn off codes

**Files:**
- Modify: `apps/server/src/studio/gift-codes.ts`, `apps/server/src/routes/admin-studio.ts`
- Test: `apps/server/test/admin-studio.test.ts` (new `describe('gift codes')`)

**Interfaces:**
- Consumes: Task 1 tables and helpers.
- Produces:
  - `createGiftCode(by: string, input: { prompts: number; finalizes: number; maxUses: number; expiresAt: Date | null; note: string | null }, now: Date): Promise<{ code: string; id: string }>` — throws `GiftCodeError(400, 'invalid')` unless prompts 0–1000, finalizes 0–20, not both 0, maxUses 1–1000, expiresAt null or after now, note ≤ 200 characters.
  - `listGiftCodes(): Promise<Array<{ id, hint, note, prompts, finalizes, maxUses, uses, expiresAt, disabledAt, createdAt, redemptions: { email: string | null; name: string | null; at: Date }[] }>>`, newest first.
  - `disableGiftCode(id: string, now: Date): Promise<boolean>`.
  - `class GiftCodeError extends Error { status: number; code: string }`.
  - Routes (admin only): `POST /api/admin/studio/gift-codes` → 201 `{ id, code }`; `GET /api/admin/studio/gift-codes` → `{ codes }`; `POST /api/admin/studio/gift-codes/:id/off` → 204, 404 unknown.

- [ ] **Step 1: Write the failing tests:** a non-admin gets 403 on all three; create returns a code matching the Task 1 pattern and the row stores only its hash (`codeHash === hashGiftCode(code)`, no column holds the plain code); `{prompts:0, finalizes:0}` → 400; an expiry in the past → 400; list shows hint = last 4 characters and redemptions with the redeemer's email; off sets `disabledAt`.
- [ ] **Step 2:** Run `pnpm exec vitest run test/admin-studio.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement the service functions and routes, following the existing admin-studio route style.
- [ ] **Step 4:** Same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat(studio): admins make, list and turn off gift codes`.

### Task 3: Redeeming a code

**Files:**
- Modify: `apps/server/src/studio/gift-codes.ts`, `apps/server/src/routes/studio.ts`
- Test: `apps/server/test/studio-gift-codes.test.ts`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  - `redeemGiftCode(userId: string, raw: string, now: Date): Promise<{ prompts: number; finalizes: number }>`. One transaction: select the code by hash `FOR UPDATE`; refusals as `GiftCodeError`: 404 `unknown_code`, 410 `code_off`, 410 `code_expired` (`expiresAt <= now`), 410 `code_used_up` (`uses >= maxUses`), 409 `already_redeemed`. On success: insert the redemption, `uses + 1`, add `prompts` to `studio_prompt_credits.gifted` and `finalizes` to `studio_finalize_credits.balance` (upserts).
  - Route `POST /api/studio/gift-codes/redeem` `{ code: string }` behind `authenticate, studioOn` (not `notPaused`: a paused account may still redeem), route `rateLimit: { max: 10, timeWindow: '1 hour', hook: 'preHandler', keyGenerator: (r) => r.user.id }` → 200 `{ prompts, finalizes }`; refusals as `{ error: code }` with the status above.

- [ ] **Step 1: Write the failing tests:**
  - `redeems a code typed in lowercase with spaces` — gifted balance and finalize credits rise by the code's amounts.
  - each refusal code (unknown, off, expired, used up, already redeemed by this account).
  - `the last use goes to one of two concurrent redeems` — maxUses 1, two users `Promise.all`: one resolves, one rejects `code_used_up`; `uses` is 1.
  - route: the 11th attempt within the hour from one account → 429; another account is unaffected (build the app with rate limiting on, as `test/rate-limit.test.ts` does).
- [ ] **Step 2:** Run `pnpm exec vitest run test/studio-gift-codes.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3:** Implement. If route-level `hook` is not honoured by the installed `@fastify/rate-limit`, key on the bearer token's user inside a small preHandler counter instead, and ledger the ruling.
- [ ] **Step 4:** Same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat(studio): redeem a gift code for prompts and free finalizes`.

### Task 4: Gifted prompts in the quota

**Files:**
- Modify: `apps/server/src/studio/quota.ts`, `apps/server/src/studio/designs.ts` (`usage`)
- Test: `apps/server/test/studio-quota.test.ts`

**Interfaces:**
- Consumes: Task 1 `studioPromptCredits.gifted`.
- Produces:
  - `PromptSource = 'allowance' | 'gift' | 'credit'` (stored in `studio_jobs.counted_from`).
  - `reservePrompt` order: today's allowance (refused at the ceiling, as now) → one gifted prompt (**no ceiling check**) → one bought credit (ceiling as now). An uncounted reservation (`counted: false`) over the ceiling succeeds when `gifted > 0`, taking nothing.
  - `refundPrompt(…, 'gift')` gives the prompt back to `gifted`.
  - `promptStatus` adds `gifted`; `left = max(0, allowance - used) + credits + gifted`; `overCostCeiling` is `costUsd >= ceiling && gifted === 0`.
  - `usage()` adds `giftedPrompts: number` and `freeFinalizes: { available: number; held: number }` (`held` = sum of `giftsHeld` on this user's pending, unexpired finalize payments; `available` = `studio_finalize_credits.balance`).

- [ ] **Step 1: Write the failing tests:** `gifted prompts are spent after the allowance and before bought ones`; `gifted prompts run past the cost ceiling` (cost at the ceiling, gifted 2, credits 5: two counted reservations succeed from `gift`, the third is refused `cost_ceiling`; an uncounted one succeeds while gifted > 0); `a refunded gifted prompt goes back to the gifted balance`; `usage reports gifted prompts and free finalizes`.
- [ ] **Step 2:** Run `pnpm exec vitest run test/studio-quota.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement with single-statement `UPDATE … WHERE gifted > 0 RETURNING`, as the credit path does.
- [ ] **Step 4:** Same command, then `pnpm exec vitest run test/studio-routes.test.ts` (usage shape). Expected: PASS.
- [ ] **Step 5:** Commit `feat(studio): gifted prompts come after the allowance and skip the cost ceiling`.

### Task 5: Free finalizes at checkout

**Files:**
- Modify: `apps/server/src/studio/pricing.ts`, `apps/server/src/studio/payments.ts`, `apps/server/src/routes/studio.ts` (the finalize GET passes the user's gifts), `apps/server/test/helpers/studio.ts` (`fakeStripe` gains `checkout.sessions.expire`)
- Test: `apps/server/test/studio-payments.test.ts`, `apps/server/test/studio-pricing.test.ts`

**Interfaces:**
- Consumes: Task 1 (`studioFinalizeCredits`, `giftsHeld`, `PaymentLine.gift`).
- Produces:
  - `quoteFinalize(design, categories, waived, gifts = 0)` — marks up to `gifts` lines with `kind === 'first'` as `gift: true`, most expensive first (ties: piece order); `totalCents` excludes gift lines. Quote gains `giftsUsed: number`.
  - `giftsFor(userId: string, designId: string, now: Date, exec?: Exec): Promise<number>` = finalize-credit balance + `giftsHeld` of this design's pending, unexpired finalize payments. The finalize GET quotes with it.
  - `createFinalizeCheckout`: in one transaction, lock the user's `studio_finalize_credits` row (`FOR UPDATE`, inserting a 0 row if missing), quote with `giftsFor`, and:
    - reuse an open session only when its lines match exactly (`lineKey` includes the gift flag);
    - otherwise expire this design's other pending finalize sessions through Stripe (`checkout.sessions.expire`); each that expires is marked `expired` and its `giftsHeld` returns to the balance; one Stripe says is already complete is left alone and its gifts are not counted;
    - take `giftsUsed` from the balance and store it as the new payment's `giftsHeld` (the row lock makes the count exact, so a concurrent checkout quotes against what is left);
    - the zero-total path grants at once, as now.
    - If opening the Stripe session fails, the payment row is deleted (as now) and its `giftsHeld` returns to the balance in the same step.
  - `handleStudioSession` on `checkout.session.expired`: marking a pending payment `expired` returns its `giftsHeld` to the balance in the same transaction.
  - `grantPayment`: a gift line is charged 0 and owes nothing; a gift line whose revision was already paid for (not fresh) returns one credit to the balance.

- [ ] **Step 1: Write the failing tests:**
  - pricing: `a free finalize goes to the most expensive first-finalize line` (emote design: the emote line; wearable set: the $29 line, then a $19 one when gifts = 2); revision lines are never gift lines; `totalCents` excludes gift lines.
  - `a free finalize alone grants without Stripe and uses the credit` (balance 1 → 0, entitlement amount 0, no Stripe session).
  - `a mixed checkout sends only paid lines to Stripe and holds the credit` (balance 0, payment `giftsHeld` 1).
  - `an expired checkout gives its free finalize back` (webhook `checkout.session.expired` → balance 1).
  - `a failed Stripe session gives its free finalize back`.
  - `a new checkout replaces the open one and takes over its free finalize` (two checkouts with different pieces: the first is expired through Stripe, balance + holds still total 1, never 2).
  - `reopening the same checkout reuses it` (same URL; balance unchanged).
  - `a gift line already paid elsewhere gives its credit back`.
  - `two checkouts at once never use one credit twice` (`Promise.all`, balance 1: at most one payment has `giftsHeld` 1).
- [ ] **Step 2:** Run `pnpm exec vitest run test/studio-payments.test.ts test/studio-pricing.test.ts test/studio-finalize.test.ts`. Expected: new tests FAIL, old ones PASS.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Same command. Expected: PASS. Then the full server suite `pnpm exec vitest run` (~6 min) — all pass.
- [ ] **Step 5:** Commit `feat(studio): a free finalize from a gift code at checkout`.

### Task 6: The pages

**Files:**
- Create: `apps/web/src/app/(dashboard)/admin/studio/gift-codes/page.tsx`
- Modify: `apps/web/src/app/(dashboard)/admin/studio/page.tsx` (link to Gift codes), `apps/web/src/lib/api.ts`, `apps/web/src/lib/studio.ts`, `apps/web/src/app/(dashboard)/studio/page.tsx`, `apps/web/src/app/(dashboard)/studio/[designId]/Finalize.tsx`
- Test: `apps/web/src/lib/studio.test.ts`

**Interfaces:**
- Consumes: Task 2–5 routes and shapes.
- Produces:
  - `api.createGiftCode`, `api.listGiftCodes`, `api.disableGiftCode`, `api.redeemGiftCode(code)`.
  - `StudioUsage` gains `giftedPrompts`, `freeFinalizes`; `PaymentLine` type gains `gift?`; Quote gains `giftsUsed`.
  - `usageLine(usage)` appends `· N free finalizes` when available > 0, and `· 1 free finalize held by an open checkout` (plural as needed) when held > 0.
  - `dialogTotal` counts gift lines as 0.
  - `giftRedeemMessage(err)` → `unknown_code`: "That code isn't right. Check it and try again."; `code_off`: "That code has been turned off."; `code_expired`: "That code has expired."; `code_used_up`: "That code has been used up."; `already_redeemed`: "You've already used that code."; 429: "Too many tries. Try again in an hour."
  - `giftRedeemSuccess({ prompts, finalizes })` → e.g. "Added 20 prompts and 1 free finalize." (omit a zero part; plurals).

- [ ] **Step 1: Write the failing tests** for `usageLine`, `dialogTotal` with a gift line, `giftRedeemMessage` (every code) and `giftRedeemSuccess` (both parts, one part, plurals).
- [ ] **Step 2:** Run `pnpm exec vitest run src/lib/studio.test.ts` in `apps/web`. Expected: FAIL.
- [ ] **Step 3:** Implement the helpers, then the UI:
  - Studio list page: a "Have a code?" button beside the subtitle opens an inline field + Redeem; success and refusal text from the helpers; re-read usage on success.
  - Finalize dialog: a gift line shows its price struck through with "free (gift code)" in emerald, like a waived line.
  - Admin Gift codes page: a form (prompts, free finalizes, uses default 1, optional expiry date, optional note) whose success shows the full code once with a Copy button and "You won't see this code again"; a table of codes (hint as `…ABCD`, note, prompts, finalizes, uses `n / max`, expiry, status Active/Off/Expired/Used up, redeemers with dates) with Turn off.
- [ ] **Step 4:** Run `pnpm exec vitest run`, `pnpm exec tsc --noEmit -p .`, `pnpm build` in `apps/web`, and `node scripts/check-no-vlm.mjs` at the root. Expected: all pass, 0 hits.
- [ ] **Step 5:** Commit `feat(web): gift codes: admin page, redeem in the studio, free finalize lines`.
