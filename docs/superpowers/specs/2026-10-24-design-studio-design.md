# Design Studio: AI-built Decentraland wearables and emotes

Status: approved by the owner, 2026-10-24.

Items marked **(owner)** were decided by the owner in conversation. Items marked **(call)** are the author's calls, open to change.

## Intent

A VLM user describes a Decentraland wearable, a set of wearables, or an emote in plain language. An AI agent builds it in Blender using the `dcl-avatar-skills`, and the user refines it by talking to the agent. They see the real result on a Decentraland avatar at every step. Designing is free within a daily prompt allowance. They pay to finalize and receive the GLBs and everything needed to upload to the Decentraland Builder.

The skills (`/Users/unknower/-Decentraland/dcl-avatar-skills`, public repo) keep improving. The studio is also how VLM learns where they fall short: every agent mistake a customer reports is logged against the agent and skills version that made it.

## Goals

- Someone with no Blender skill can go from a concept to a curation-ready wearable, set or emote.
- The preview shows the design exactly as it will look, so people trust it enough to pay. **(owner)**
- The finished files can't be obtained without paying. **(owner)**
- Agent mistakes cost the customer nothing, and VLM gets a reviewable record of them. **(owner)**
- Prices and allowances cover what the agents cost to run, including sessions that never finalize.

## Where it's available

The studio is available in the VLM cloud (`VLM_MODE=cloud`) only. Self-hosted VLM doesn't show it, because it runs on VLM's agent keys and payments. **(call)**

## Non-goals (this version)

- Grok Build as a working agent. It appears in the picker as "coming soon". **(owner)**
- Submitting to the Decentraland Builder or curation on the user's behalf. The user uploads the files themselves. **(call)**
- Editing the model by hand in the browser. All changes go through the agent.
- Users bringing their own API keys. VLM's keys pay for every run. **(owner: "I can provide API keys")**

## Anti-goals

- A preview that looks worse than the final item. That undersells what they're paying for. **(owner)**
- Any route by which the browser receives a GLB, `.blend` or other model file before finalization, including signed URLs, preview meshes and debug endpoints. **(owner)**
- Keeping payment for a revision that fixed the agent's own mistake, once the customer reports it. **(owner)**
- Arguing with the customer about whether it was a mistake. **(owner)**

## Who uses it and how

### A session

The studio lives in the VLM dashboard as a new **Design Studio** page under Workspace. It uses the dashboard's existing style: `PageHeader`, cards and badges. **(call)**

1. The user starts a design and picks an agent: **Claude Code** or **Codex**, with Grok greyed out as "coming soon". **(owner)** The choice is per design, and it can be switched between prompts. **(call)**
2. They describe a concept. The agent uses `shaping-dcl-item-ideas` to ask what it needs. For wearables, it recommends which slots to make, for example eyewear, upper_body, feet and hands_wear for "cyberpunk courier". **(owner)** The recommendation appears as tick-boxes the user can change before building starts. **(call)**
3. The agent builds each piece using `creating-dcl-wearables` or `creating-dcl-emotes`, runs the skills' checkers, and renders the preview.
4. The user asks for changes in plain language. Each message is one prompt from the daily allowance.
5. When they're happy, they finalize and pay, then download.

One design can hold one wearable, a whole set **(owner)**, or one emote. Each piece in a set is built and revised on its own. It has a tab showing whether it's ready or still building, and the preview can show one piece or the whole set together. **(call)**

### Screen layout

Two columns (approved from a mockup):

- **Left: the conversation.** At the top, the agent picker. Below that, the chat, with the slot tick-boxes inline in the agent's reply. At the bottom, the message box, with the count of prompts left today and the plan name underneath.
- **Right: the preview.**
  - Piece tabs with ready/building status, and a toggle between "this piece" and "whole set".
  - The preview stage, showing the revision number and when it was rendered.
  - Emote buttons: Idle, Wave, Dance, Clap, Walk.
  - Avatar buttons: base male, base female, and a few base outfits.
  - At the bottom, a strip that says what finalizing unlocks, and the **Finalize** button with its price.

For an emote design, the stage plays the emote itself, so the emote buttons don't apply. The avatar buttons still do. **(call)**

### The preview: rendered, not downloaded

The preview is **server-rendered images and video only**. **(owner)** It should look like the Decentraland Builder's wearable editor. **(owner)**

So the preview is rendered with Decentraland's own renderer, the hosted wearable-preview, driven by headless Chrome on the worker the way the skills' `preview_wearable.py` does it. That renderer is the truth: Decentraland's toon shading looks darker than a Blender render, and the preview must match what the item looks like in-world. **(call)** The polished listing renders and promo clip unlocked at finalize are Blender renders. **(call)**

If headless Chrome with WebGPU won't run on a Fly machine, the fallback is Blender with a look matched to Decentraland's toon shading, checked side by side against wearable-preview. The first build step (the cost measurement) tests this too. **(call)**

What gets rendered:

- **Spin:** about 36 frames around the avatar. Dragging on the stage flips through the frames, so it feels like rotating a 3D model.
- **Emotes:** a short clip for each basic emote. For an emote design, the emote itself.
- **Outfits:** a set of renders for each base avatar or outfit.

Spin frames for the default avatar render with every revision. Each other emote or outfit renders the first time it's picked, is cached for that revision, and is instant after that. **(call)** The browser shows "rendering…" on a button whose render is still running.

## Paying

### What finalizing unlocks

For each piece:
- the clean GLBs (male and female where the slot needs both);
- a thumbnail;
- the Builder settings: category, hides and replaces, and tags;
- the `listing-dcl-wearables` output: suggested rarity, name, description and tags;
- the `curating-dcl-wearables` report;
- polished listing renders and a short promo clip.

Finalizing gives access to that revision's files. They can download them again later. **(call)**

**Emotes ship in the first release.** **(owner)** The listing and curation skills cover wearables only, so a finalized emote includes what the skills support today **(call)**:
- the GLB (with its prop and audio where it has them);
- a thumbnail;
- the `check_emote.py` report;
- polished renders and a clip.

The agent also writes a suggested name and description. When the skills gain emote listing and curation, the emote package grows with them, at no change to the price. **(call)**

**Checks gate finalizing.** **(call)**
- A piece whose checker reports a hard FAIL can't be finalized. Examples are the triangle budget, forbidden names, the skeleton, and the emote length. The agent is told to fix it, and that fix doesn't use a prompt.
- Warnings are shown, but they don't block finalizing.
- The curation report says plainly which gates the studio can't run, such as the Builder upload and the in-world self-preview, and what the user does next for each.

### Prices **(call, numbers are settings)**

| | First finalize | Design change after publishing |
|---|---|---|
| Wearable piece | $29 | $15 |
| Emote | $39 | $20 |
| Each extra piece in the same set | $19 | $10 |
| Revision that fixes the agent's mistake | — | refunded once reported **(owner)** |

The half-price rule is the owner's. The amounts are the author's proposal. Payment is a one-time Stripe Checkout payment, next to the existing subscription checkout in `apps/server/src/integrations/stripe.ts`.

### Daily prompt allowance **(owner: per plan; numbers are calls and settings)**

| Plan | Prompts per day |
|---|---|
| Free | 3, and only one open design (a design counts as open until it's finalized or archived; Free users can archive) |
| Creator | 15 |
| Pro | 40 |
| Studio | 100 |
| Enterprise | custom |

- **Top-ups:** 10 more prompts for $5. **(call)**
- **Reset:** the allowance resets at midnight UTC. **(call)**
- **Counting:** a prompt counts when the agent accepts the message. Messages that fail because of a system error don't count. **(call)**
- **Cost ceiling:** each account also has a hidden daily cost ceiling in dollars. A single prompt that runs past a per-prompt ceiling stops and asks the user before continuing. **(call)** This protects against one prompt costing far more than estimated.

### Cost basis (estimates, to be measured)

- **Model rates:** Claude Opus 5.5 costs $4 per million input tokens and $20 per million output, with cache reads at $0.20 per million.
- **Estimated cost per prompt:**
  - a big build (the first version of a piece, about 40 Blender steps) costs roughly $3–6;
  - a tweak costs roughly $0.50–1.50;
  - Fly machine time and renders add cents.
- **Codex:** not yet measured.
- **Per finished piece:** about 6–10 prompts, or $10–20, before payment.
- **Risk:** a Creator who uses all 15 prompts every day could cost about $30 a day.

The plan prices live only in Stripe, and the allowances must be set against them. **The first build step measures real costs, and the allowances and prices are tuned before launch.**

## Revisions after publishing

People come back after the item is live on the marketplace. They want to change colors, or fix clipping or animation they didn't notice before. **(owner)**

- They reopen the same design, with the whole conversation and every earlier revision. **(call)**
- Revision prompts come from the same daily allowance. **(call)**
- **Every finalize after the first one for a piece is a paid revision, at half price.** **(owner)** VLM can't see when an item goes live on the marketplace, so "after publishing" means "after it was first finalized".
- **Agent mistakes are refunded, not pre-judged.** **(owner)** On a paid revision, the customer can say it fixed the agent's mistake. They write down what was wrong, for example "the sleeve clips through the arm when waving". That revision's payment is then refunded in full through Stripe. The refund is automatic once the report is submitted: the customer gets the benefit of the doubt, and VLM reviews the logs afterwards. **(owner)**
- The report can be made when paying, or later for the same revision. A 30-day window keeps refunds tied to recent work. **(call)**
- The agent also adds its own note to each revision saying whether it thinks the change is a fix or a design change. This goes into the log only, never into the price. **(call)**
- Mistakes the curation committee rejects later count as agent mistakes when the customer reports them. **(call)**
- Decentraland may send an edited published item back through curation, possibly with a fee. This needs to be confirmed against Decentraland's docs while building. If it does, the studio says so before they pay. **(call)**

### The revision log **(owner: log both kinds; owner reviews)**

Each entry records:
- the request;
- the agent's own note on whether it was a fix or a design change;
- whether the customer reported an agent mistake, their description, and the refund;
- the agent (Claude Code or Codex) and its model;
- the skills version (commit);
- before and after renders;
- what it cost.

An admin page under Admin lists entries. It filters by label, override, agent and skills version, and counts which mistake kinds recur. Reviewing never charges anyone after the fact. It's for spotting abuse and improving the skills. **(call)**

## How it runs **(call: owner delegated)**

VLM has no Blender pipeline today. The build reuses what VLM already has:
- short-lived Fly Machines (`apps/server/src/hyperfy/fly.ts`, already used for hosted Hyperfy worlds);
- R2 storage;
- Stripe;
- plan tiers (`TIER_LIMITS`, `getTierLimits`);
- websocket updates.

### The studio worker

- **One image** containing:
  - Blender 4.4 headless (the version the skills name);
  - Python with numpy, for the skills' checkers;
  - the Decentraland avatar `.blend` and base animations the skills reference;
  - the base outfits used for previews;
  - a pinned commit of `dcl-avatar-skills`;
  - the Claude Code CLI and Codex CLI, run non-interactively.
- **One Fly machine per active design.** It starts on the first prompt, sleeps between prompts, and is destroyed after a period idle. The workspace is restored from R2 when a machine starts.
- **One prompt is one agent run on that machine**, with:
  - the design's conversation;
  - its working files;
  - the skills;
  - an instruction to finish by exporting, running the checkers and writing the preview renders.
- **Agent keys:** the API keys are VLM's. They live as Fly secrets on the worker, never in the browser and never in the repo.
- **Network:** the worker can reach only:
  - the agents' APIs;
  - VLM's API and R2;
  - Decentraland's wearable-preview and the assets it loads.

  The model files the preview loads are served to Chrome from the worker's own local address, never from a public URL. **(call)**
- **Results:** every revision's `.blend`, GLBs, checker output and renders go to R2 under the design. Only render images and clips are ever served to the browser. GLBs and listing files are served only through an authenticated download for a paid revision.
- **Progress:** messages stream to the page over the existing websocket: the agent's progress notes, "building", "rendering", "ready".
- **Updating skills:** to roll out an improved skills version, rebuild the image with a new pinned commit. Every revision records which commit it used.

### Data the server keeps (shape left to the builder)

- Designs: owner, kind (wearable set or emote), agent, status.
- Pieces in a design, each with its slot.
- Revisions of each piece, with links to its stored files and renders.
- The conversation.
- Prompt usage per account per day, plus top-ups.
- Payments, with what each payment unlocked.
- The revision log.

## Left to the builder

- The schema, route names, and how the worker reports back: callback or polling.
- How the drag-to-spin control loads and caches frames.
- The exact run limits and timeouts for an agent run.
- Which Fly machine size to use, and how long a machine stays idle before it's destroyed.
- How the agent's slot recommendation is turned into tick-boxes: structured output from the agent, or parsing.

## Open, for the owner later

- Current plan prices in Stripe, to set the final allowances (see Cost basis).
- Grok Build: when its keys arrive, it becomes a third worker CLI, with no other design change.
