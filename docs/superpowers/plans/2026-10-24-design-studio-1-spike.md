# Design Studio, Plan 1: Measurement Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure what one studio prompt really costs, in money and time, for Claude Code and Codex. Also find out whether Decentraland's wearable-preview renders headless on a Fly machine. These numbers set the allowances, machine size and renderer for Plans 2–6.

**Architecture:**
- A new `apps/studio-worker/` holds a Linux image: Blender 4.4, Python with numpy, Chrome and Playwright, Node 22, the two agent CLIs, and `dcl-avatar-skills` at a pinned commit.
- A small Python harness runs one fixed brief through one agent inside that image. It records cost, tokens, time, turns and checker results to `result.json`.
- A preview probe renders a finished GLB through wearable-preview, first with WebGPU and then with the Babylon renderer, and checks whether the frames are blank.
- Everything runs in local Docker first, then on a Fly machine.
- The results go into a findings document.

**Tech Stack:**
- Docker (linux/amd64)
- Blender 4.4
- Python 3.11, numpy, pytest, Playwright with Chrome stable
- Node 22
- `@anthropic-ai/claude-code`, run with `claude -p --output-format json`
- `@openai/codex`, run with `codex exec --json`
- Fly Machines (`fly` CLI)

**Spec:** `docs/superpowers/specs/2026-10-24-design-studio-design.md`

## Plan sequence (this is Plan 1 of 6)

1. **Measurement spike:** this plan.
2. **Studio worker:** the production image, plus the run protocol between the server and the worker.
3. **Server core:**
   - the designs, pieces, revisions and conversation data;
   - prompt quota;
   - starting machines on Fly;
   - websocket progress;
   - R2 storage, with only renders ever exposed to the browser.
4. **Payments:**
   - finalize checkout;
   - half-price revisions;
   - mistake reports, with automatic Stripe refunds inside 30 days;
   - downloads gated by entitlement;
   - prompt top-ups.
5. **Studio page:** the two-column UI, drag-to-spin, the emote and outfit buttons, and the agent picker with Grok shown as "coming soon".
6. **Revision log:** the admin page.

Plans 2–6 are written after this plan's findings are in, because the findings decide the renderer, the machine size and the numbers.

## Global Constraints

- **Pinned skills:** clone `dcl-avatar-skills` at commit `3430ce2` (pin by full SHA in the Dockerfile), and record that SHA in every `result.json`.
- **Blender version:** exactly 4.4.x. This is the version the skills name.
- **Platform:** the image builds for `linux/amd64` (Fly's architecture).
- **No secrets in git:** `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` come from the environment. Locally that's a git-ignored `apps/studio-worker/.env`; on Fly, they're Fly secrets that the owner sets themselves. Never commit them or print them.
- **Base avatar files:** the official Decentraland avatar `.blend` files are fetched from Decentraland's docs into `apps/studio-worker/assets/`, which is git-ignored. Don't commit them until their license has been checked.
- **No public GLB URLs:** the preview loads GLBs as in-page blob URLs, the way `preview_wearable.py` already does. Nothing is uploaded to a public URL.
- **Spend caps:** each agent run has a hard 25-minute timeout. Claude Code also gets `--max-turns 80`. A run that hits either limit is recorded as `"outcome": "timeout"`, not retried.
- **Spike scope:** the spike code lives under `apps/studio-worker/spike/` and is throwaway. Plan 2 decides what survives.

## Review Focus

1. **A hung agent run.** The CLI never exits, for example because it's waiting on a permission prompt. The harness must kill it at the timeout and still write `result.json` with the outcome `timeout`. Test: `test_run_times_out_and_records`.
2. **Blank frames in headless Chrome.** WebGPU silently fails and the frames come back black or as the empty backdrop. This must not be reported as a success. Test: `test_blank_frame_detected` (Task 4).
3. **A Codex run with no usage events** (a crash early on). The cost must be `null` with an error, not `0`, which would make Codex look free. Test: `test_codex_no_usage_is_null`.
4. **The agent produces no GLB.** `checker` must be `{"ran": false}` and the outcome `no_output`, not a pass. Test: `test_no_glb_is_no_output`.
5. **Price drift.** Prices are read from `spike/prices.json`, with a `source` and an `asOf` date that the findings quote. They're never hard-coded in the parsing code. Test: `test_cost_uses_price_table`.

---

### Task 1: Worker image that builds and passes a smoke check

**Files:**
- Create: `apps/studio-worker/Dockerfile`
- Create: `apps/studio-worker/smoke.sh`
- Create: `apps/studio-worker/.gitignore` (lists `.env`, `assets/`, `runs/`)
- Create: `apps/studio-worker/README.md` (how to build and run the spike; short)

**Interfaces:**
- Produces:
  - the image tag `vlm-studio-worker:spike`;
  - inside the image: `/opt/skills` (the pinned skills repo), installed for both agents with `bash /opt/skills/install.sh claude codex --project /work`;
  - the `blender` binary on the PATH;
  - Chrome stable, plus the Playwright Python package;
  - the `claude` and `codex` binaries on the PATH;
  - `/work` as the working directory.

- [ ] **Step 1: Write `smoke.sh`.** It prints one line per tool and exits non-zero if any are missing:
  - `blender --version` must report 4.4;
  - `python3 -c "import numpy, playwright"`;
  - `google-chrome --version`;
  - `claude --version`;
  - `codex --version`;
  - `/work/.claude/skills/creating-dcl-wearables/SKILL.md` and `/work/.agents/skills/creating-dcl-wearables/SKILL.md` must both exist.

- [ ] **Step 2: Run the smoke check before the image exists to confirm it fails.**
  Run: `docker run --rm vlm-studio-worker:spike /opt/smoke.sh`
  Expected: an error (`Unable to find image`).

- [ ] **Step 3: Write the Dockerfile.**
  - Base: `debian:bookworm-slim`.
  - Install Blender from the official 4.4 Linux x64 tarball. It needs the X/GL libraries it loads even when headless: `libxi6 libxxf86vm1 libxfixes3 libxrender1 libgl1 libxkbcommon0 libsm6`.
  - Python: `python3-pip`, then `pip install numpy playwright pytest`.
  - Chrome: `google-chrome-stable` from Google's apt repository, and `playwright install-deps chromium`.
  - Node 22, then `npm i -g @anthropic-ai/claude-code @openai/codex`.
  - Skills: `git clone` the skills repo, check out the pinned SHA, and run the installer.
  - Copy `smoke.sh` to `/opt/smoke.sh`.
  - `WORKDIR /work`.

- [ ] **Step 4: Build and smoke-test.**
  Run: `docker build --platform linux/amd64 -t vlm-studio-worker:spike apps/studio-worker && docker run --rm vlm-studio-worker:spike /opt/smoke.sh`
  Expected: six OK lines and exit code 0.

- [ ] **Step 5: Commit.**
  ```bash
  git add apps/studio-worker
  git commit -m "feat(studio-worker): spike image with Blender 4.4, Chrome, agent CLIs and pinned dcl-avatar-skills"
  ```

### Task 2: Run harness that records cost, time and checks for one brief

**Files:**
- Create: `apps/studio-worker/spike/harness.py`
- Create: `apps/studio-worker/spike/prices.json`
- Create: `apps/studio-worker/spike/test_harness.py`
- Create: `apps/studio-worker/spike/fixtures/claude_result.json`, `codex_events.jsonl`, `codex_no_usage.jsonl` (trimmed real CLI output shapes)

**Interfaces:**
- Consumes: the Task 1 image.
- Produces:
  - `python3 /work/spike/harness.py --agent {claude|codex} --brief <file> --out <dir> [--resume <dir>]`. It writes `<out>/result.json` with these keys:
    - `agent`, `model`, `brief`, `skillsSha`;
    - `outcome`: `ok` | `timeout` | `no_output` | `error`;
    - `wallSec`, `turns`;
    - `tokens`: `{ input, cachedInput, cacheWrite, output }`;
    - `costUsd`: a number or null;
    - `checker`: `{ ran, pass, warnings, failures, report }`;
    - `glbs`: a list of file names.
  - `parse_claude_result(obj: dict) -> Usage`
  - `parse_codex_events(lines: list[str]) -> Usage | None`
  - `cost_usd(usage: Usage, prices: dict, model: str) -> float | None`
  - `Usage` is a dataclass with `input, cached_input, cache_write, output, turns: int`, plus `cost_usd: float | None` (Claude reports its own cost).

- [ ] **Step 1: Write the failing tests** in `test_harness.py`:
  - `test_parse_claude_result`: the fixture returns `turns == obj['num_turns']`, and `cost_usd == obj['total_cost_usd']`.
  - `test_parse_codex_events`: the token counts from the fixture's `turn.completed` events are summed.
  - `test_codex_no_usage_is_null`: on `codex_no_usage.jsonl`, `parse_codex_events` returns `None`, and `result.json` has `costUsd: null` and `outcome: "error"`.
  - `test_cost_uses_price_table`:
    - `cost_usd(Usage(input=1_000_000, cached_input=0, cache_write=0, output=0, turns=1), prices, 'm')` equals `prices['m']['input']`;
    - changing the table changes the result.
  - `test_run_times_out_and_records`: with `timeout=1`, run the harness against a fake agent command (`sleep 30`). It writes `outcome: "timeout"` and returns within 5 s.
  - `test_no_glb_is_no_output`: a run that exits 0 but leaves no `*.glb` gives `outcome: "no_output"` and `checker.ran: false`.

- [ ] **Step 2: Run them to confirm they fail.**
  Run: `docker run --rm -v $PWD/apps/studio-worker/spike:/work/spike vlm-studio-worker:spike pytest -q /work/spike`
  Expected: failures with `ModuleNotFoundError: harness`.

- [ ] **Step 3: Implement `harness.py`.**
  - **Claude command:** `claude -p <brief> --output-format json --max-turns 80 --dangerously-skip-permissions`. This is only safe because it runs inside the throwaway container.
  - **Codex command:** `codex exec --json --dangerously-bypass-approvals-and-sandbox <brief>`.
  - **Resuming a conversation:**
    - Claude: `--resume <session_id>`, read from the previous `result.json`.
    - Codex: `codex exec resume <id>`.
  - **Execution:** run with `subprocess.run(timeout=1500)`.
  - **After the run:**
    - find every `*.glb` under the out directory;
    - run `check_wearable.py` or `check_emote.py` from `/opt/skills`, depending on the brief's `kind` line;
    - read PASS, WARN and FAIL from its output.
  - **Prices:** `prices.json` holds per-model `input`, `cachedInput`, `cacheWrite` and `output` in dollars per million tokens, plus `source` and `asOf`.
    - Fill in Claude Opus 5.5 at 4.00, 0.20, 5.00 and 20.00.
    - Look up the Codex model's prices on OpenAI's pricing page on the day of the run, and record that URL and date.

- [ ] **Step 4: Run the tests to confirm they pass.**
  Same command. Expected: `6 passed`.

- [ ] **Step 5: Commit.**
  ```bash
  git add apps/studio-worker/spike
  git commit -m "feat(studio-worker): spike harness records agent cost, time and checker results"
  ```

### Task 3: Fixed briefs, and local runs for both agents

**Files:**
- Create:
  - `apps/studio-worker/spike/briefs/01-hat-build.md`
  - `apps/studio-worker/spike/briefs/02-hat-tweak.md`
  - `apps/studio-worker/spike/briefs/03-set-jacket-build.md`
  - `apps/studio-worker/spike/briefs/04-emote-build.md`
- Results go to `apps/studio-worker/runs/` (git-ignored). Copy them to `spike/results/<agent>-<brief>.json`, the `result.json` only, and commit those.

**Interfaces:**
- Consumes: `harness.py` (Task 2).
- Produces: eight committed `spike/results/*.json` files (4 briefs × 2 agents).

Each brief starts with a `kind: wearable|emote` line. The text below it is what a user would type, followed by the studio's fixed closing instruction. That instruction is: "Use the dcl-avatar-skills. Build it in Blender, export the GLBs to ./out, run the checker, and stop." The briefs:

| Brief | Kind | What it asks for |
|---|---|---|
| 01 | wearable | "A rounded cyberpunk cap with a glowing neon visor strip" (category hat, both body shapes). A new build. |
| 02 | wearable | Resumes 01: "make the visor strip pink and the cap matte black". A tweak. |
| 03 | wearable | "A padded courier jacket with glowing seams" (upper_body). The biggest kind of build. |
| 04 | emote | "A friendly two-handed wave, 3 seconds, loop". |

- [ ] **Step 1: Write the four briefs.**

- [ ] **Step 2: The owner provides the base avatar files and keys.** Put the official avatar `.blend` files from Decentraland's docs into `apps/studio-worker/assets/`, and the two API keys into `apps/studio-worker/.env`.
  - The implementer stops and asks the owner to do this. They never handle the keys themselves.
  - Check: `ls apps/studio-worker/assets/*.blend` lists at least the BaseMale and BaseFemale files.

- [ ] **Step 3: Run all eight locally, one at a time.**
  ```bash
  docker run --rm --env-file apps/studio-worker/.env \
    -v $PWD/apps/studio-worker/assets:/work/assets:ro \
    -v $PWD/apps/studio-worker/spike:/work/spike \
    -v $PWD/apps/studio-worker/runs:/work/runs \
    vlm-studio-worker:spike \
    python3 /work/spike/harness.py --agent claude --brief /work/spike/briefs/01-hat-build.md --out /work/runs/claude-01
  ```
  - Repeat for each combination.
  - Brief 02 uses `--resume /work/runs/<agent>-01`.
  - Expected: each run writes a `result.json`. Any outcome is a valid finding, but `error` outcomes are re-run once after their cause is noted.

- [ ] **Step 4: Copy each `result.json` to `spike/results/` and commit.**
  ```bash
  git add apps/studio-worker/spike/briefs apps/studio-worker/spike/results
  git commit -m "chore(studio-worker): spike briefs and local run results"
  ```

### Task 4: Headless wearable-preview probe

**Files:**
- Create: `apps/studio-worker/spike/preview_probe.py`
- Create: `apps/studio-worker/spike/test_preview_probe.py`
- Create: `apps/studio-worker/spike/fixtures/blank.png` (a uniform backdrop) and `apps/studio-worker/spike/fixtures/avatar.png` (a real preview frame)

**Interfaces:**
- Consumes:
  - `/opt/skills/skills/curating-dcl-wearables/scripts/preview_wearable.py`, which has `--use-angle=metal` hard-coded;
  - the GLBs that Task 3 produced.
- Produces:
  - `python3 preview_probe.py --mode {webgpu|babylon} --angle {vulkan|swiftshader} --category hat --male <glb> --female <glb> --out <dir> --frames 36`;
  - it writes `<dir>/probe.json` with these keys:
    - `mode`, `angle`, `ok`;
    - `framesWritten`, `blankFrames`;
    - `bootSec`, `secPerFrame`;
    - `error`.
  - `is_blank(png_path: str, threshold: float = 4.0) -> bool`: true when the standard deviation of the pixels is below the threshold.

- [ ] **Step 1: Write the failing tests.**
  - `test_blank_frame_detected`: `is_blank('fixtures/blank.png')` is `True`.
  - `test_real_frame_not_blank`: `is_blank('fixtures/avatar.png')` is `False`.
  - `test_all_blank_is_not_ok`: a probe run where every frame is blank writes `ok: false`.

- [ ] **Step 2: Run them to confirm they fail.**
  Run: `docker run --rm -v $PWD/apps/studio-worker/spike:/work/spike vlm-studio-worker:spike pytest -q /work/spike/test_preview_probe.py`
  Expected: an import failure.

- [ ] **Step 3: Implement `preview_probe.py`.**
  - Copy `preview_wearable.py` to a temporary path and replace `--use-angle=metal` with `--use-angle=<angle>`. Add `--babylon` when the mode is `babylon`.
  - Run it with `--frames 36 --anims idle`.
  - Time the boot and the frames, run `is_blank` on every PNG, and write `probe.json`.
  - Use numpy and the PNG reader that ships with Playwright's dependencies. If none is available, add `pillow` to the Dockerfile.

- [ ] **Step 4: Run the tests to confirm they pass**, then probe locally in all three combinations:
  - `webgpu/vulkan`;
  - `webgpu/swiftshader`;
  - `babylon/swiftshader`.

  Use the GLBs from `runs/claude-01`.

  Then probe the emote from `runs/claude-04` in whichever mode worked. Pass `--emote <glb>`, which `preview_probe.py` hands to the preview's emote parameter. The skills note that Babylon plays emote GLBs faithfully.

  Copy each `probe.json` to `spike/results/preview-local-<mode>-<angle>.json`, and the emote probe to `preview-local-emote.json`.
  Expected: the tests pass, and there are four probe files. Any `ok` value is a valid finding.

- [ ] **Step 5: Commit.**
  ```bash
  git add apps/studio-worker/spike apps/studio-worker/Dockerfile
  git commit -m "feat(studio-worker): headless wearable-preview probe with blank-frame detection"
  ```

### Task 5: The same runs on Fly

**Files:**
- Create: `apps/studio-worker/fly.spike.toml` (app `vlm-studio-spike`, region `iad`, no services, since nothing is exposed)

**Interfaces:**
- Consumes: the image from Task 1, the harness from Task 2 and the probe from Task 4.
- Produces:
  - `spike/results/fly-<size>-<agent>-01.json`;
  - `spike/results/fly-<size>-<agent>-03.json`;
  - `spike/results/preview-fly-<size>-<mode>-<angle>.json`.

- [ ] **Step 1: Create the app and push the image.**
  - Run `fly apps create vlm-studio-spike`.
  - The owner runs `fly secrets set -a vlm-studio-spike ANTHROPIC_API_KEY=… OPENAI_API_KEY=…` themselves.
  - Push the image with `fly deploy --config apps/studio-worker/fly.spike.toml --build-only --push`.
  - The base avatar files go up as a Fly volume, or are copied in with `fly ssh sftp`. They are not baked into a public image.
  - Check: `fly image show -a vlm-studio-spike` lists the image.

- [ ] **Step 2: Run on two machine sizes.** Use `fly machine run <image> --vm-size performance-4x` and `--vm-size performance-8x`, each with the command `sleep infinity`. Then `fly ssh console` in and run:
  - harness briefs 01 and 03 for both agents;
  - all three preview probe modes.
  Expected: a `result.json` and a `probe.json` for each run. Record the machine's start time and wall time.

- [ ] **Step 3: Only if both WebGPU modes failed on CPU machines,** repeat the WebGPU probe once on a GPU machine (`--vm-gpu-kind a10`) and record it.

- [ ] **Step 4: Destroy every spike machine, and confirm none are left.**
  Run: `fly machine list -a vlm-studio-spike`
  Expected: an empty list.

- [ ] **Step 5: Copy the results into `spike/results/` and commit.**
  ```bash
  git add apps/studio-worker/fly.spike.toml apps/studio-worker/spike/results
  git commit -m "chore(studio-worker): spike results from Fly machines"
  ```

### Task 6: Findings, and the numbers for Plans 2–6

**Files:**
- Create: `docs/superpowers/specs/2026-10-24-design-studio-spike-findings.md`
- Create: `apps/studio-worker/spike/summarize.py` (reads `spike/results/*.json` and prints the tables)
- Create: `apps/studio-worker/spike/test_summarize.py`

**Interfaces:**
- Consumes: every `spike/results/*.json`.
- Produces: the findings document. Plans 2–6 cite it for:
  - the renderer;
  - the machine size;
  - per-prompt cost bands;
  - the recommended allowances and prices.

- [ ] **Step 1: Write the failing test.** `test_summary_table`: given two fixture results for the same brief, `summarize(results)` returns a row per agent and brief with `costUsd`, `wallSec`, `turns` and `pass`, and leaves out runs whose outcome isn't `ok` from the average cost.

- [ ] **Step 2: Run it to confirm it fails, implement `summarize(results: list[dict]) -> list[dict]` with a table printer, then run it again to confirm it passes.**
  Run: `pytest -q apps/studio-worker/spike/test_summarize.py`
  Expected: a failure first, then `1 passed`.

- [ ] **Step 3: Write the findings document.** It covers:
  - **Agent results:** for each agent and brief, the cost, time, turns and checker result, plus how often the agent reached a passing GLB at all.
  - **Cost bands:** a big build versus a tweak, and the cost of a finished piece at 6–10 prompts.
  - **Preview:** which mode worked, on which machine, the seconds per frame, and the time for 36 frames.
  - **Renderer recommendation:** wearable-preview, Babylon, or the toon-matched Blender fallback described in the spec.
  - **Machine size** and its cost per hour.
  - **Recommended allowances and prices:** checked against the spec's proposal, and marked "owner to confirm against current plan prices".
  - **Surprises:** anything the spike found that changes the spec.

- [ ] **Step 4: Commit.**
  ```bash
  git add docs/superpowers/specs/2026-10-24-design-studio-spike-findings.md apps/studio-worker/spike/summarize.py apps/studio-worker/spike/test_summarize.py
  git commit -m "docs(spec): Design Studio spike findings"
  ```
