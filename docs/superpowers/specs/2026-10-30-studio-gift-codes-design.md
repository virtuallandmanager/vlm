# Design Studio gift codes

## Why

The owner wants to hand someone a code that lets them explore the AI Design Studio on their own and come out with a
finished piece, without paying. The first case: a friend the owner promised to help with a wearable, who doesn't yet
know what she wants. The owner would rather she get somewhere with the studio first than steer every step.

Success: the owner makes a code in under a minute, sends it, and the person redeems it, prompts until they have
something they like, and finalizes one piece without paying.

## What a code is

A code carries, each set separately by the admin who makes it:

- **Prompts:** a number of prompts added to the redeemer's prompt balance (the existing bought-prompt credits,
  `studio_prompt_credits`). They are used the same way as bought prompts: after the day's plan allowance.
- **Free finalizes:** a number of free-finalize credits. Each covers one piece's **first** finalize: a wearable piece
  or an emote. It never covers a paid revision.
- **Uses:** how many people can redeem it. 1 for a personal code, more for a group. Every redeemer gets the full
  prompts and free finalizes.
- **Expiry (optional):** after this date the code can't be redeemed. What it already gave is unaffected.

Either amount may be zero (a prompts-only code, a finalize-only code), but not both.

## Rules (decided with the owner)

- Only admins make codes.
- A person redeems a code in the studio, signed in.
- A person can redeem a given code once, even when it has uses left.
- What a code gives never expires: prompts and free-finalize credits stay on the account until used.
- **Gifted prompts skip the plan's daily cost ceiling** (`studioDailyCostCeilingUsd`, about $6 on the free plan, which
  `reservePrompt` in `quota.ts` applies today even to bought credits). The code's prompt count is the cap, and only
  admins make codes. Bought prompts and plan-allowance prompts keep the ceiling exactly as now, so the account must know
  which of its balance was gifted. A prompt spends the day's allowance first, then gifted prompts, then bought ones
  (Claude's call: the owner's gift goes before money the person paid). The plan's open-design limit is unchanged.
- At checkout a free-finalize credit applies automatically to the most expensive eligible line (a first finalize;
  an emote is $39, a set's first wearable piece $29, each further piece $19). Its line shows as free in the finalize
  dialog before the person confirms, like a waived mistake-report line does today.
- Paid revisions are never covered. Fixes for the agent's mistakes stay free through the existing "report a mistake"
  flow, with its existing limit (a piece's first two reports are refunded at once; later ones wait for the owner).

## The pieces

**Admin page:** a Gift codes page beside the existing admin Studio pages. Make a code (prompts, free finalizes, uses,
optional expiry, optional note such as "for Sam"); see each code's uses left, expiry, and who redeemed it and when;
turn a code off so it can't be redeemed any more (what was given stays).

**Redeeming:** a "Have a code?" entry in the studio (near the prompt balance) where a signed-in person types a code.
On success they see what they got. Failures say plainly why: unknown, expired, used up, turned off, or already
redeemed by this account.

**Seeing the balance:** the studio's usage line already shows prompts left; it also shows free finalizes left when
there are any.

**Checkout:** the finalize quote marks one line free per available free-finalize credit (most expensive eligible line
first). The existing zero-total path grants a finalize without Stripe; a mixed checkout sends only the paid lines to
Stripe, as waived lines are today.

## Constraints

- This changes billing code (`apps/server/src/studio/pricing.ts`, `payments.ts`, `quota.ts`, including the daily-ceiling check for gifted prompts). The owner gave
  permission for this feature only; touch nothing in billing beyond what it needs.
- A free-finalize credit must never be spent twice or lost. A Stripe checkout the person abandons must give the credit
  back; one that completes must use it exactly once. Two redeems of the last use, or two checkouts at once, must not
  over-grant.
- Codes are secrets of a sort: store them so a database read doesn't hand out unused codes (hash, or a lookup that
  doesn't need the plain text), unless the builder finds the admin page must show the full code again later, in which
  case say so in the plan.
- Codes are case-insensitive and easy to read aloud or type (no 0/O, 1/I/l confusion).
- Redeeming is rate-limited per account so codes can't be guessed.
- New tables are ensured in `apps/server/entrypoint.sh`, as other tables are.
- New copy uses Virvi names; `node scripts/check-no-vlm.mjs` must report 0 hits.

**Builder's call (settled by Claude):** a free-finalize credit held by an unfinished Stripe checkout comes back when that
checkout expires (about 31 minutes, `CHECKOUT_TTL_MS`), not the moment the person cancels. Reopening the same
checkout reuses it, as today. While a credit is held, the studio says so ("1 free finalize held by an open checkout").

## Non-goals

- Codes that anyone other than an admin can make (no gifting between users).
- Discounts or percentages off: a code gives whole prompts and whole free finalizes only.
- Covering paid revisions.
- Codes tied to one email address in advance.

## Left to the builder

The code's length and alphabet, the table shapes, how a pending checkout holds a credit, the exact admin and studio
layouts (following the existing admin Studio pages and studio usage line), and the API route names.
