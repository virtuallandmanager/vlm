# Design Studio: measurement spike findings

**Date:** 2026-10-25
**Plan:** `docs/superpowers/plans/2026-10-24-design-studio-1-spike.md`
**Spec:** `docs/superpowers/specs/2026-10-24-design-studio-design.md`
**Raw data:** `apps/studio-worker/spike/results/` (one file per run). `python3 apps/studio-worker/spike/summarize.py` prints the agent table.

Plans 2–6 cite this document for the renderer, the machine size, the per-prompt cost bands, and the allowances and prices.

## What was run

- **Image:** Debian bookworm with Blender 4.4.3, Chrome 156, Claude Code 2.1.310, Codex CLI 0.164.0, and `dcl-avatar-skills` at `3430ce2`.
- **Models:**
  - Claude Code on `claude-opus-5-5`.
  - Codex on `gpt-6.1-sol`, Codex's default.
  - Both are pinned on the command line.
- **Briefs:**
  - 01: a neon-visor cap, both body shapes.
  - 02: a recolour of that cap, resuming 01's conversation.
  - 03: a padded jacket, both body shapes.
  - 04: a 3-second looping wave emote.
- **Where:**
  - Locally: all four briefs, with brief 01 twice. The Mac is arm64, so the amd64 image ran under emulation, and local times are slow.
  - On Fly `performance-4x` and `performance-8x` machines in `iad`: briefs 01 and 03 on both agents, plus all three preview probes.
- **Totals:** 20 agent runs and 10 preview probes. The model spend for the recorded runs was about $7.60.

## Agent results

**Every agent run reached checker-passing GLBs: 20 of 20.**
- No run had a FAIL.
- One run had warnings: Codex's jacket on the 4x machine, with 2 WARNs.
- Brief 02 changed the existing cap, as asked.
- In Babylon, the wave emote plays on both shapes.

| Brief | Claude Code cost | Claude Code wall time | Codex cost | Codex wall time |
|---|---|---|---|---|
| 01 hat build (4 runs each) | $0.40–0.89, mean $0.73 | 2–19 min | $0.15–0.19, mean $0.17 | 1.5–2 min |
| 02 hat recolour (resumed) | $0.13 | 2.4 min | $0.11 | 1.8 min |
| 03 jacket build (3 runs each) | $0.68–0.96, mean $0.84 | 3.5–10 min | $0.13–0.23, mean $0.18 | 1–3.3 min |
| 04 wave emote | $0.55 | 3.2 min | $0.15 | 1.9 min |

- **Codex costs a quarter to a fifth of what Claude Code costs**, and it finishes faster.
  - Codex works in one long turn: its `turns` is 1 per prompt.
  - Claude Code took 10–30 tool turns.
  - The turn counts aren't comparable between the agents.
- **Claude's wall time varied from 2 to 19 minutes for the same brief.**
  - Model time was only about 2 minutes in each of those runs.
  - Most of the rest went on the agent's own Blender renders. In one local session, a single render took 4 minutes.
  - The studio renders the preview itself, so these renders are wasted.
  - **Plan 2 tells the agent not to render, or to use only a quick Workbench viewport render.**
- **Prices and tokens:**
  - Claude prices are what the CLI reports, and they match Anthropic's list prices.
  - Codex prices are tokens × $2 in / $0.10 cached / $10 out per million. That rate is from third-party pages quoting OpenAI. Re-check it before launch.
  - Every run records its tokens, so its cost can be recomputed.

## Cost bands (per prompt, model only)

| | Spec estimate | Measured, Claude Code | Measured, Codex |
|---|---|---|---|
| Big build (first version of a piece) | $3–6 | $0.40–0.96 | $0.13–0.23 |
| Tweak | $0.50–1.50 | $0.13 (one sample) | $0.11 (one sample) |
| Finished piece: 1 build + 5–9 tweaks | $10–20 | about $1.50 typical, $4 worst | about $0.75 typical, $2 worst |

- **Typical and worst cases:**
  - The typical case assumes tweaks around $0.15.
  - The worst case assumes $0.30 per tweak, because each tweak re-reads a longer conversation. Brief 02 read 270k cached tokens for a recolour.
- **The tweak sample is thin.** It's one trivial recolour. "Fix the sleeve clipping when waving" will cost more. Plan for tweaks of **$0.10–0.50**.
- **Ceiling:** the most expensive run seen was $0.96. A per-prompt ceiling of **$3** is about three times that.
- **Machine time adds cents.** A prompt is 1–19 minutes on a `performance-4x` at $0.17 an hour, so $0.003–0.05. The preview render adds about $0.006.

## Preview

| Renderer | Local, emulated | Fly 4x | Fly 8x |
|---|---|---|---|
| wearable-preview, Unity, WebGPU with Vulkan | one shape fine, the other blank on the second run | all blank | all blank |
| wearable-preview, Unity, WebGPU with SwiftShader | all blank | all blank | all blank |
| **wearable-preview, Babylon, SwiftShader** | **works** | **works**: 38 s boot, 0.66 s/frame | **works**: 38 s boot, 0.60 s/frame |

- **Unity needs a GPU, and Fly no longer offers GPU machines.** `fly machine run --vm-gpu-kind` fails with "GPU machines are no longer supported". So the plan's GPU step couldn't be run.
- **Babylon renders the same item on the same toon-shaded avatar**, and it works on plain CPU machines.
  - **36 frames for one body shape take about 62 s.** That's 38 s of boot, of which 37 s are the script's fixed waits, plus 36 × 0.65 s.
  - **Both shapes take about 2 minutes per revision.**
  - The fixed waits (25 s boot and 12 s settle) are a first thing to tune.
- **Custom emotes work in Babylon** when sent as an `emoteDataADR74` definition. That's the format `wearable-preview` checks for in `src/lib/emote.ts`. The skills' `preview_wearable.py` can't do this: its `emote=` only names a built-in animation.
- **The probe frames don't spin.** `preview_wearable.py` sets `disableAutoRotate=true`, so its 36 frames are idle-animation frames. **Plan 2 has to find how to turn the camera or the avatar** for the spin.

## Renderer recommendation

**Use wearable-preview in Babylon mode, headless Chrome with SwiftShader, on the worker.** Keep the spec's model-file rule: GLBs are served to Chrome from the worker's own local address.
- The Blender toon-matched fallback isn't needed.
- Babylon and Unity differ in places. The skills note that the clap emote plays chin-high in one and chest-high in the other.
- So the preview is *Decentraland's* renderer, though not the exact one the Builder uses.
- A Unity-mode preview would need GPU hosting outside Fly. That can be revisited if customers report mismatches.

## Machine size

**Use `performance-4x`** (4 CPUs, 8 GB, $0.1722 an hour in `iad`, billed per second).
- **The 8x was not reliably faster.** Its Claude jacket took longer than the 4x's, and its Codex jacket was shorter.
- **Agent time is mostly model latency plus the agent's own Blender work.** Removing the agent's own renders matters more than adding CPUs.
- A `performance-2x` wasn't tested.
- **Cold start:** 59 s for the first machine, including a 30 s image pull, and 32 s once the image was cached on the host. The image is 1.2 GB.
- **Stop machines between prompts rather than destroying them.** The spec's "sleeps between prompts" already says this. A stopped machine restarts without the image pull.

## Allowances and prices

**Owner to confirm against the current plan prices in Stripe.**

The measured costs are about one fifth of the spec's estimates, so the spec's allowances and prices have room:
- **Creator, 15 prompts a day, all spent on big Claude builds:** about $14 a day, the worst case. The spec feared $30. A realistic day of one build and a dozen tweaks is $2–5.
- **Free, 3 prompts a day:** up to about $3 a day, worst case, with no revenue. Recommendation: keep 3, with a hidden daily cost ceiling of **$1.50**. Only a Free user who maxes out their builds every day hits it.
- **Hidden daily cost ceilings**, about the worst-case day at the allowance:
  - Creator **$15**
  - Pro **$40**
  - Studio **$100**
  - Per prompt **$3**: it stops and asks.
- **Top-up of 10 prompts for $5:** covers a typical mix ($1.50–3). It only loses money if all 10 are big Claude builds. Keep it.
- **Finalize prices ($29 per piece, $39 per emote, $19 per extra set piece, half after the first):** the model cost behind a finished piece is about $1.50–4. The spec's prices leave a wide margin. They also leave room to cover Free-tier sessions that never finalize, and the refunded agent-mistake revisions. The costs would also support lower prices, if the owner wants them for conversion. This is a business call, not a cost constraint.

## Surprises that change the spec or later plans

1. **Passing the checker doesn't mean it looks right.** All 20 runs passed the checker. Yet the brief 01 cap rendered with the default hair poking through it on the female shape. The spec's goal is a preview good enough that people pay. So Plan 2 should add a look step before a revision is shown: the agent views the preview frames, and fixes clipping, or asks whether the hat should hide the hair. That step is a few cents of tokens. The shaping skill should also ask about hair for hats.
2. **Both CLIs report the whole conversation's usage when resumed.** Claude reports it in `modelUsage` and `total_cost_usd`. Codex reports it in `turn.completed`. So per-prompt cost tracking (Plan 3) must subtract the previous prompt's running total. The harness's `score()` shows how.
3. **Claude's top-level `usage` field under-counts.** In one run it missed calls that `modelUsage` and the reported cost include. Use `modelUsage`.
4. **CLI quirks the worker must handle:**
   - **Claude Code** refuses `--dangerously-skip-permissions` as root, so the agents run as a normal user.
   - **Codex reads its key from `CODEX_API_KEY`**, not `OPENAI_API_KEY`.
   - **Codex waits on stdin** unless stdin is closed.
   - **Codex stores absolute session paths, so resuming writes into the original home.** Each design needs one fixed `CODEX_HOME`, and one `CLAUDE_CONFIG_DIR`. Claude files sessions by working directory, so each design should keep a fixed working directory.
   - Any path given to an agent must be absolute.
5. **Fly has no GPUs.** This settles the renderer (see above).
6. **Grok wasn't tested.** It's "coming soon" in the spec.
7. **Claude's wall time is long and variable**, up to 19 minutes for a hat. The studio page needs live progress, such as streamed agent messages or step names. A static "building…" isn't enough. The spec doesn't cover this yet.
