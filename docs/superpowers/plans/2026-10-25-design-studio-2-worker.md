# Design Studio Plan 2: the studio worker

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A worker image that, on a Fly machine for one design, takes prompt and render jobs from VLM's API. It runs Claude Code or Codex with `dcl-avatar-skills`, checks the pieces, renders the preview, and reports back. The browser never gets a model file.

**Architecture:**
- **One Python package, `apps/studio-worker/studio_worker/`, runs as root on the machine.** It:
  - restores the design's workspace from VLM's API;
  - polls for jobs, and runs each agent as the unprivileged `agent` user with only its own key;
  - streams progress events;
  - runs the skills' checkers;
  - renders the preview with Decentraland's wearable-preview (Babylon, headless Chrome on SwiftShader);
  - uploads renders and files to VLM's API;
  - saves the workspace and exits after an idle period, so the machine stops.
- **Locked-down networking:** all outbound traffic goes through a local proxy with a domain allowlist.
- **This plan writes the worker and its HTTP contract (`CONTRACT.md`).** Plan 3 (server core) implements the API side and starts the machines.

**Tech Stack:**
- Python 3.11 with pytest, numpy, Pillow and Playwright, driving Chrome stable;
- Blender 4.4.3;
- Node 22 with `@anthropic-ai/claude-code@2.1.310` and `@openai/codex@0.164.0`;
- tinyproxy and iptables;
- Docker linux/amd64 and Fly Machines.

**Spec:** `docs/superpowers/specs/2026-10-24-design-studio-design.md`

**Not in this plan:**
- **The `finalize` job:** the clean GLB package, thumbnail, Builder settings, `listing-dcl-wearables` and `curating-dcl-wearables` output, polished Blender renders and promo clip. Plan 4 (payments) adds it to this worker as a third job type, on this contract.
- **Starting and stopping machines, the websocket, storage in R2 and every server route:** Plan 3.

**Findings this plan rests on:** `docs/superpowers/specs/2026-10-24-design-studio-spike-findings.md`. They settle the renderer, the machine size, the CLI quirks and the deferred minors.

## Global Constraints

- **Agents:**
  - Claude Code (`claude-opus-5-5`) and Codex (`gpt-6.1-sol`), with the model named in each job. The CLI versions are pinned: `@anthropic-ai/claude-code@2.1.310` and `@openai/codex@0.164.0`.
  - Grok is "coming soon" and isn't part of this plan.
- **Skills:**
  - `dcl-avatar-skills` is pinned by full SHA in the Dockerfile. It starts at `3430ce2ef5b7f9d388fcb7c923f50e0dcb505420`.
  - Every result records the SHA, which must be readable by the worker. Today it comes back null because of git's safe.directory rule.
- **Blender:** 4.4.x.
- **Platform:** linux/amd64 on Fly `performance-4x`.
- **Renderer:** wearable-preview at `https://wearable-preview.decentraland.org/`, in Babylon mode (no `unity=true`).
  - Chrome is launched with `--use-angle=swiftshader`.
  - GLBs enter the page as in-page blob URLs. No model file is ever served over HTTP, even locally.
- **The browser only ever receives render images.** GLBs, `.blend` files and listing files go to VLM's API under paths the API serves only to paid downloads (Plan 3).
- **Keys:**
  - `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are Fly secrets. Never commit them, print them or log them.
  - Each agent's environment holds only its own key: Claude gets `ANTHROPIC_API_KEY`, and Codex gets it as `CODEX_API_KEY`.
  - No agent's environment ever holds `STUDIO_WORKER_TOKEN`.
- **Agents run as user `agent` (uid 1000). The worker runs as root.**
- **Network:** the only outbound traffic allowed goes through the local proxy. Its allowlist is the agents' APIs, VLM's API host, and wearable-preview and the Decentraland hosts it loads.
- **Limits:**
  - Each prompt job's `limits` sets its timeout (default 1500 s), max turns (default 80) and cost ceiling (default $3.00).
  - A render job has a 300 s watchdog.
  - The worker exits after 600 s idle (`STUDIO_IDLE_EXIT_SEC`).
- **The agent never renders in Blender.** It looks at its work with `studio-preview` (Task 5) instead. Findings: the agent's own Blender renders were most of Claude's wall time.
- **Local, git-ignored files:** `.env` (the owner's keys), `assets/` (the base avatar `.blend` files) and `runs/` (the spike's raw runs) live in `/Users/unknower/-VLM/vlm-v2/.worktrees/hud-test/apps/studio-worker/`. Before Task 1, copy `.env` and `assets/` into this worktree's `apps/studio-worker/`. Copy with `cp`, never print, and keep `chmod 600` on `.env`.
- **The spike stays as it is.** `apps/studio-worker/spike/` is the record behind the findings. Code moves from it into `studio_worker/` and nothing imports the spike.
- **Tests:**
  - `python3 -m pytest -q apps/studio-worker/tests` runs offline, with fake CLIs, a fake API and no network. Each task's tests join that suite.
  - Tests that spend money or need Docker or Fly are scripts under `apps/studio-worker/e2e/`, run by hand.

## Review Focus

1. **A tweak that exports nothing**, or re-exports the same files. The piece must report `changed: false`, and the job's outcome must be `no_change`, never `ok` on the previous revision's GLBs. Test: `test_unchanged_piece_not_reported_changed` (Task 4).
2. **The agent writes its GLBs somewhere other than `out/<category>/`**, or leaves out `piece.json`. The result must say so in `error` with the outcome `error`, not report a design with no pieces as ready. Test: `test_glb_outside_pieces_is_an_error` (Task 4).
3. **Chrome hangs or the item never loads.** The render must stop at its watchdog and report `item_not_loaded` or `timeout`, never hang the machine, and never upload frames of a bare avatar as the design. Tests: `test_render_watchdog_kills_hung_preview` and `test_item_not_loaded_is_reported` (Task 5).
4. **The machine stops or the network drops after the agent finished.** The workspace upload must succeed before the result is posted. If it fails, the result is `error` and nothing claims the revision is saved. Test: `test_result_waits_for_workspace_save` (Task 6).
5. **A prompt that runs away on cost.** Claude is stopped once its running cost passes the job's ceiling, with the outcome `ceiling`. Codex reports usage only at the end of a turn, so it's capped by time alone. Test: `test_claude_stopped_at_cost_ceiling` (Task 2).

---

### Task 1: Production image and package skeleton

**Files:**
- Modify: `apps/studio-worker/Dockerfile`
- Modify: `apps/studio-worker/.dockerignore`
- Modify: `apps/studio-worker/smoke.sh`
- Create: `apps/studio-worker/studio_worker/__init__.py`
- Create: `apps/studio-worker/studio_worker/config.py`
- Create: `apps/studio-worker/tests/test_config.py`
- Create: `apps/studio-worker/pytest.ini` (`testpaths = tests`, `pythonpath = .`)

**Interfaces:**
- Produces:
  - `config.SKILLS = Path('/opt/skills')`;
  - `config.DESIGN = Path('/work/design')`, the workspace, owned by `agent`;
  - `config.AGENT_USER = 'agent'`;
  - `config.PREVIEW_URL = 'https://wearable-preview.decentraland.org/'`;
  - `config.OUTFITS: dict[str, str]`, mapping each outfit name to a wearable-preview `profile` value. The values are `{'default': 'default1', 'outfit-2': 'default2', 'outfit-3': 'default3'}`.
  - `config.BASE_EMOTES = ('idle', 'wave', 'dance', 'clap', 'walk')`;
  - `config.skills_sha() -> str | None`.
  - Image tag `vlm-studio-worker:dev`, with entrypoint `/opt/entrypoint.sh` (Task 7 fills it; until then it runs `exec python3 -m studio_worker`).

- [ ] **Step 1: Write the failing test.** `test_skills_sha_reads_a_root_owned_repo(tmp_path)`:
  - Make a git repo, then call `config.skills_sha(repo)`.
  - It equals `git rev-parse HEAD` for that repo.
  - `skills_sha(tmp_path / 'missing')` is `None`.
- [ ] **Step 2: Run it to confirm it fails.** Run `python3 -m pytest -q apps/studio-worker/tests/test_config.py`. Expected: an import error.
- [ ] **Step 3: Implement `config.py`, with `skills_sha(repo: Path = SKILLS) -> str | None`.** Use `git -c safe.directory=* -C <repo> rev-parse HEAD`: the repo is root-owned and the CLI may run as another user.
- [ ] **Step 4: Update the Dockerfile.**
  - Pin both CLIs, `@anthropic-ai/claude-code@2.1.310` and `@openai/codex@0.164.0`.
  - `git config --system --add safe.directory /opt/skills`.
  - `apt-get install tinyproxy iptables`.
  - Create `agent` (uid 1000) with `/work/design` owned by it.
  - Copy `assets/*.blend` to `/opt/assets/`, readable by all. Remove `assets/` from `.dockerignore`. The registry is private: Fly's per-app registry.
  - Copy `studio_worker/` to `/opt/studio_worker/`, with `PYTHONPATH=/opt`.
  - Install `/usr/local/bin/studio-preview`, a two-line shell wrapper for `python3 -m studio_worker.render "$@"`.
  - Stay `USER root`, and set `ENTRYPOINT ["/opt/entrypoint.sh"]`.
  - `spike/`, `tests/`, `e2e/`, `.env` and `runs/` stay out of the build context.
- [ ] **Step 5: Extend `smoke.sh`.**
  - Check the pinned CLI versions exactly.
  - Check that `runuser -u agent -- python3 -c 'from studio_worker import config; print(config.skills_sha())'` prints the full SHA.
  - Check that `/opt/assets/AvatarShape_A.blend` exists.
  - Check that `tinyproxy -v` and `iptables -V` run.
- [ ] **Step 6: Build, smoke-test and run the suite.**
  - Run `docker build --platform linux/amd64 -t vlm-studio-worker:dev apps/studio-worker && docker run --rm --platform linux/amd64 --entrypoint /opt/smoke.sh vlm-studio-worker:dev`. Expected: every line reads `OK`.
  - Run `python3 -m pytest -q apps/studio-worker/tests`. Expected: `1 passed`.
- [ ] **Step 7: Commit:** `feat(studio-worker): production image with pinned CLIs, base avatars and a readable skills SHA`

### Task 2: Agent runner

**Files:**
- Create: `apps/studio-worker/studio_worker/agent.py`
- Create: `apps/studio-worker/tests/test_agent.py`
- Create: `apps/studio-worker/tests/fakes/` (fake `claude` and `codex` scripts that replay JSONL fixtures)

**Interfaces:**
- Consumes: `config.DESIGN` and `config.AGENT_USER`. Move the spike's `Usage`, `parse_claude_result`, `parse_codex_events`, `cost_usd` and the session-total subtraction from `spike/harness.py` here; they're already verified.
- Produces:
  - `@dataclass AgentRun`, with fields:
    - `outcome: str`, which is one of `'ok'`, `'timeout'`, `'ceiling'` or `'error'`;
    - `reply: str`, the agent's last message;
    - `session: str | None`;
    - `usage: Usage | None`, this prompt's share only;
    - `session_total: Usage | None`;
    - `cost_usd: float | None`;
    - `wall_sec: float`;
    - `error: str | None`.
  - `run_agent(agent: str, model: str, prompt: str, session: str | None, before: Usage | None, limits: dict, on_progress: Callable[[str], None], command: list[str] | None = None, as_user: str | None = AGENT_USER) -> AgentRun`.
  - `agent_env(agent: str, base: Mapping[str, str]) -> dict[str, str]`.

- [ ] **Step 1: Write the failing tests.**
  - `test_agent_env_has_only_its_key`:
    - The base has both keys, `STUDIO_WORKER_TOKEN` and `HTTPS_PROXY`.
    - The Claude env has `ANTHROPIC_API_KEY` but neither `OPENAI_API_KEY` nor `STUDIO_WORKER_TOKEN`.
    - The Codex env has `CODEX_API_KEY` (the OpenAI key) but neither `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` nor `STUDIO_WORKER_TOKEN`.
    - Both keep `HTTPS_PROXY`.
    - Claude's env has `CLAUDE_CONFIG_DIR == str(DESIGN / '.claude-home')` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC == '1'`.
    - Codex's env has `CODEX_HOME == str(DESIGN / '.codex-home')`.
  - `test_progress_streams_from_claude`: the fake replays `stream-json` lines. `on_progress` gets each assistant text block in order, and tool uses become `'Running: <first 80 chars of the command>'`.
  - `test_progress_streams_from_codex`: from `item.completed` events, `agent_message` texts and `command_execution` commands reach `on_progress`.
  - `test_claude_stopped_at_cost_ceiling`:
    - The fake streams assistant messages whose summed usage passes $0.05, then sleeps.
    - With `limits={'costCeilingUsd': 0.05, 'timeoutSec': 30, 'maxTurns': 80}`, the outcome is `'ceiling'` within 5 s.
    - The process group is gone.
  - `test_timeout_kills_the_process_group`: the fake starts a child `sleep 60`, then sleeps. After the 1 s timeout, the outcome is `'timeout'` and the child pid no longer exists.
  - `test_resumed_prompt_is_charged_its_share`: with `before` set, `usage` and `cost_usd` are the session total minus `before`. This is the spike's verified rule.
- [ ] **Step 2: Run them to confirm they fail.** Run `python3 -m pytest -q apps/studio-worker/tests/test_agent.py`. Expected: an import error.
- [ ] **Step 3: Implement `agent.py`.**
  - **Claude command:** `claude -p <prompt> --output-format stream-json --verbose --max-turns <maxTurns> --model <model> --dangerously-skip-permissions [--resume <session>]`.
  - **Codex command:** `codex exec --json --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox -m <model> [resume <session>] <prompt>`.
  - **How it runs:**
    - The process starts in a new session (`start_new_session=True`) so its whole group can be killed.
    - Its working directory is `DESIGN`, with stdin closed.
    - It runs as `runuser -u agent --` when `as_user` is set. Tests pass `as_user=None`.
  - **Reading output:**
    - stdout is read line by line in a thread.
    - **Claude's running cost** is the sum of each assistant message's `usage`, priced with `cost_usd()` at the `claude-opus-5-5` row of `prices.json`.
    - Copy `prices.json` into `studio_worker/` with the Codex row.
  - **Stopping:** at the ceiling or the timeout, send `os.killpg(SIGTERM)`, then `SIGKILL` 5 s later.
  - **Final usage:**
    - Claude's comes from the final `result` line.
    - Codex's comes from the last `turn.completed`.
    - `reply` is the last assistant or `agent_message` text.
- [ ] **Step 4: Run the tests to confirm they pass.** Run `python3 -m pytest -q apps/studio-worker/tests`. Expected: all pass.
- [ ] **Step 5: Commit:** `feat(studio-worker): agent runner with per-agent keys, live progress, cost ceiling and group kill`

### Task 3: Workspace and design state

**Files:**
- Create: `apps/studio-worker/studio_worker/workspace.py`
- Create: `apps/studio-worker/tests/test_workspace.py`

**Interfaces:**
- Produces:
  - `pack(design: Path) -> bytes`: a gzip tar of the whole design directory, agent homes included.
  - `unpack(data: bytes, design: Path) -> None`: rejects members with absolute paths or `..`, and chowns to `agent` when running as root.
  - `@dataclass State`, stored at `design/.studio/state.json`, with fields:
    - `sessions: dict[str, str]`, the agent's session id;
    - `totals: dict[str, dict]`, the agent's running `Usage` as a dict;
    - `messages: list[dict]`, entries of `{'role': 'user'|'agent', 'agent': str, 'text': str}`;
    - `last_agent: str | None`;
    - `hashes: dict[str, dict[str, str]]`, mapping each category to its GLB names and their sha256.
  - `load_state(design: Path) -> State` and `save_state(design: Path, state: State) -> None`.
  - `prompt_with_context(state: State, agent: str, words: str) -> str`: the prompt an agent receives when the previous prompt went to another agent.

- [ ] **Step 1: Write the failing tests.**
  - `test_pack_unpack_round_trip`: the files, `.claude-home` and the state survive the round trip.
  - `test_unpack_rejects_path_escape`: a tar with the member `../evil` raises `ValueError`, and nothing is written outside.
  - `test_switching_agent_carries_the_conversation`:
    - Two messages to and from Claude are followed by a prompt to Codex.
    - The Codex prompt starts with `Conversation so far:` and contains both texts, then the user's words.
    - The same agent again gets the user's words only.
  - `test_state_survives_missing_file`: `load_state` on a fresh directory returns an empty `State`.
- [ ] **Step 2: Run them to confirm they fail.** Expected: an import error.
- [ ] **Step 3: Implement `workspace.py`.** `prompt_with_context` includes only the messages since this agent's own last turn. The agent already has its own earlier turns in its session.
- [ ] **Step 4: Run the suite.** Expected: all pass.
- [ ] **Step 5: Commit:** `feat(studio-worker): design workspace packing and conversation state across agents`

### Task 4: Pieces, checks and the agent's instructions

**Files:**
- Create: `apps/studio-worker/studio_worker/pieces.py`
- Create: `apps/studio-worker/studio_worker/instructions.py`
- Create: `apps/studio-worker/tests/test_pieces.py`

**Interfaces:**
- Consumes: `State.hashes` (Task 3), and the skills' `check_wearable.py` and `check_emote.py` under `config.SKILLS`.
- Produces:
  - `closing(kind: str, selected_slots: list[str] | None) -> str`: the fixed instruction appended to every prompt.
  - `collect(design: Path, kind: str, hashes: dict) -> tuple[list[Piece], dict | None, str | None]`: returns the pieces, the slot proposal, and an error.
  - `@dataclass Piece`, with fields:
    - `category: str`;
    - `glbs: list[Path]`;
    - `meta: dict`, read from `piece.json`;
    - `changed: bool`;
    - `checker: dict`, with keys `ran`, `pass`, `failures`, `warnings` and `report`.
  - `check(piece: Piece, kind: str) -> dict`.
  - `new_hashes(pieces: list[Piece]) -> dict`.
- **Piece layout the agent must write:** `out/<category>/`, holding:
  - the GLBs: `<name>_male.glb` and `<name>_female.glb`, or one `<name>.glb` for an emote or a unisex piece;
  - `piece.json`, with fields:
    - `name`;
    - `description`;
    - `category`;
    - `hides`;
    - `replaces`;
    - `tags`;
    - `changeKind`, which is `"new"`, `"fix"` or `"design"`;
    - `loop`, for emotes only.
- **Proposal layout**, for when the agent proposes slots instead of building: `out/proposal.json`, as `{"slots": [{"category": str, "recommended": bool, "reason": str}]}`.
- `closing()` must say, in plain words:
  - use the skills;
  - the base avatars are in `/opt/assets`;
  - Blender runs headless;
  - build only these slots: `<selected>`;
  - write the layout above;
  - never render in Blender;
  - run `studio-preview out/<category>` and look at the four views before finishing: fix clipping, or ask the user whether a hat should hide the hair;
  - run the checker;
  - when the concept isn't settled and no slots are selected, shape the idea with `shaping-dcl-item-ideas` and write `out/proposal.json` instead of building.

- [ ] **Step 1: Write the failing tests.**
  - **Fixtures**, committed to `tests/fixtures/` and each about 50 KB:
    - the checker-passing cap pair, as `cap/`, from `/Users/unknower/-VLM/vlm-v2/.worktrees/hud-test/apps/studio-worker/runs/codex-01/out/`;
    - one jacket GLB, as `jacket.glb`, from `/Users/unknower/-VLM/vlm-v2/.worktrees/hud-test/apps/studio-worker/runs/codex-03/out/`;
    - `wave.glb`, from `/Users/unknower/-VLM/vlm-v2/.worktrees/hud-test/apps/studio-worker/runs/claude-04/out/Friendly_Wave.glb`.
  - `test_collects_pieces_and_runs_checker`: `collect` on the cap, laid out as `out/hat/` with a `piece.json`, returns one `hat` piece with `changed=True` and `checker['pass'] is True`.
  - `test_unchanged_piece_not_reported_changed`: when `hashes` already hold the same sha256s, `changed is False`.
  - `test_glb_outside_pieces_is_an_error`: a GLB at `out/cap.glb` with no `out/<category>/piece.json` gives an `error` that names the stray path, and `pieces == []`.
  - `test_proposal_is_read`: `out/proposal.json` is returned as the proposal, with no error.
  - `test_checker_fail_is_recorded`: the jacket GLB under `out/hat/`, with `piece.json` category `hat`, is over the hat triangle budget. It gives `checker['pass'] is False` with `failures >= 1`.
  - `test_closing_names_the_slots_and_forbids_renders`: `closing('wearable', ['hat','eyewear'])` contains `hat`, `eyewear`, `studio-preview` and `never render`.
- [ ] **Step 2: Run them to confirm they fail.** Expected: an import error.
- [ ] **Step 3: Implement `pieces.py` and `instructions.py`.**
  - The checker command comes from the spike's `run_checker`, with `--category` and `--hides` taken from `piece.json`.
  - A piece is `changed` when its set of GLB sha256s differs from `hashes[category]`.
- [ ] **Step 4: Run the suite.** Expected: all pass.
- [ ] **Step 5: Commit:** `feat(studio-worker): piece collection, checker gate, change detection and the agent's closing instruction`

### Task 5: Preview renderer and `studio-preview`

**Files:**
- Create: `apps/studio-worker/studio_worker/render.py` (the module and its CLI)
- Create: `apps/studio-worker/studio_worker/preview_page.js` (the in-page item builder and controller calls)
- Create: `apps/studio-worker/tests/test_render.py`

**Interfaces:**
- Consumes: `config.PREVIEW_URL`, `config.OUTFITS` and `config.BASE_EMOTES`, plus the spike's `is_blank` (move it here).
- Produces:
  - `render(pieces: list[dict], view: dict, out: Path, frames: int = 36, size: int = 512, watchdog_sec: int = 300) -> dict`.
    - **Each piece:** `{'category': str, 'glbs': {'male': Path, 'female': Path} | {'unisex': Path}, 'meta': dict}`.
    - **The view:** `{'bodyShape': 'male'|'female', 'outfit': str, 'emote': str | None, 'mode': 'spin'|'emote'|'look'}`.
    - **It returns:** `{'ok': bool, 'frames': [Path], 'error': None | 'timeout' | 'item_not_loaded' | 'blank', 'bootSec': float}`.
  - The CLI `studio-preview <piece dir>... [--out review]` writes `look` views: front, right, back and left, for each body shape the piece has. It prints their paths, so the agent can open the images.
- **How it renders:**
  - Open `PREVIEW_URL?profile=<OUTFITS[outfit]>&bodyShape=<urn>&disableAutoRotate=true&disableBackground=false&emote=<emote or idle>`, with no `unity` parameter.
  - Chrome stable runs headless with `--use-angle=swiftshader --enable-unsafe-swiftshader`.
  - Send the items as base64 definitions (an emote travels as `emoteDataADR74`, as in the spike).
  - **Readiness comes from messages, not fixed waits.** Wait for the page's `ready` message, then the `load` message after the update. Then call the controller `scene.getMetrics()`.
  - **The item has loaded** only when the triangle count is greater than a bare-avatar baseline, taken from the same page before the update. Otherwise the error is `item_not_loaded`.
  - **Controller calls** are `postMessage({type: 'controller_request', payload: {id, namespace, method, params}})`. The page answers itself with `controller_response`.
  - **`spin`:** 36 steps of `scene.changeCameraPosition({alpha: 2π/36})`, a screenshot after each.
  - **`emote`:** call `emote.pause()`, then `emote.getLength()`, then `goTo(i * length / frames)` and screenshot for each frame.
  - **`look`:** 4 steps of π/2.
  - **Frames** are saved as webp at quality 80.
  - **A watchdog thread** kills the browser at `watchdog_sec`.
  - **Any blank frame** fails the render with `blank`.

- [ ] **Step 1: Write the failing tests.**
  - `test_render_watchdog_kills_hung_preview`: point `PREVIEW_URL` at a local `http.server` page that never sends `ready`. `render(..., watchdog_sec=3)` returns `{'ok': False, 'error': 'timeout'}` within 10 s.
  - `test_item_not_loaded_is_reported`: a local stub page sends `ready` and `load`, and answers `getMetrics` with the same triangle count before and after the update. The result is `item_not_loaded`.
  - `test_spin_sends_36_rotations`: the stub page records the controller requests. 36 `changeCameraPosition` calls arrive, each with `alpha ≈ 0.1745`, and 36 webp frames are written.
  - `test_emote_frames_step_through_length`: the stub reports `getLength = 3.0`. With `frames=10`, `goTo` is called at 0.0, 0.3, … 2.7.
  - The stub page is a file under `tests/fixtures/preview_stub.html` that implements just the message protocol above.
- [ ] **Step 2: Run them to confirm they fail.** Expected: an import error.
- [ ] **Step 3: Implement `render.py` and `preview_page.js`.**
- [ ] **Step 4: Run the suite.** Expected: all pass.
- [ ] **Step 5: Check it against the real preview, in the image.** Run `apps/studio-worker/e2e/render_real.sh`. This task creates it: it renders the fixture cap's spin and the spike's wave emote (`tests/fixtures/wave.glb`, from Task 4) in Docker. Expected:
  - Spin and emote both `ok`, with 36 frames each.
  - Frames 0 and 9 differ, which shows the camera turned.
  - Boot is under 20 s. The spike's fixed 37 s waits are gone.
  - Look at frame 0 and frame 18 of the spin, and record what they show in the commit message.
- [ ] **Step 6: Commit:** `feat(studio-worker): wearable-preview renderer with controlled spin, emote frames, load check and watchdog`

### Task 6: API client, job loop and the contract

**Files:**
- Create: `apps/studio-worker/studio_worker/api.py`
- Create: `apps/studio-worker/studio_worker/jobs.py`
- Create: `apps/studio-worker/studio_worker/__main__.py`
- Create: `apps/studio-worker/CONTRACT.md`
- Create: `apps/studio-worker/tests/fake_api.py`
- Create: `apps/studio-worker/tests/test_jobs.py`

**Interfaces:**
- Consumes: everything in Tasks 2–5.
- Produces the contract that Plan 3 implements. `CONTRACT.md` is its source of truth, and the fake API in `tests/fake_api.py` implements exactly it.
  - **Machine env:**
    - `VLM_API_URL`;
    - `STUDIO_WORKER_TOKEN`, scoped to the design;
    - `STUDIO_DESIGN_ID`;
    - `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`;
    - `STUDIO_IDLE_EXIT_SEC`, default 600.
  - **Endpoints:** all under `$VLM_API_URL/api/studio/worker`, with `Authorization: Bearer $STUDIO_WORKER_TOKEN`.
    - `GET /designs/{designId}/workspace` returns a tar.gz, or 404 when the design is new.
    - `PUT /designs/{designId}/workspace` takes a tar.gz.
    - `GET /designs/{designId}/jobs/next` returns a Job, or 204 when there is none.
    - `POST /jobs/{jobId}/events` takes `{"type": "progress", "text": str}` or `{"type": "phase", "phase": "building"|"checking"|"rendering"|"saving"}`.
    - `PUT /jobs/{jobId}/files/{path}` takes the raw body. The paths are:
      - `pieces/<category>/<file>` for the GLBs and `piece.json`, which are private;
      - `checks/<category>.txt`, private;
      - `renders/<category>/<view key>/<nnn>.webp`, the only paths the browser may see.
      - A view key is `<mode>-<bodyShape>-<outfit>[-<emote>]`.
    - `POST /jobs/{jobId}/result` takes a Result.
  - **Job:**
    - `jobId`;
    - `type`, which is `"prompt"` or `"render"`;
    - `kind`, which is `"wearable"` or `"emote"`;
    - `agent` and `model`;
    - `prompt`;
    - `selectedSlots`, a list of strings or null;
    - `limits`, with `timeoutSec`, `maxTurns` and `costCeilingUsd`;
    - `render`, which is `{"categories": [..], "bodyShape", "outfit", "emote"}` or null.
  - **Result:**
    - `jobId`;
    - `outcome`, which is one of `"ok"`, `"needs_input"`, `"no_change"`, `"ceiling"`, `"timeout"` or `"error"`;
    - `agent`, `model` and `skillsSha`;
    - `wallSec`, `tokens` and `costUsd`;
    - `reply`;
    - `proposal`, or null;
    - `pieces`: a list of `{category, changed, changeKind, meta, checker: {pass, failures, warnings}, files: [paths], renders: {viewKey: frameCount}}`;
    - `error`, or null.
  - **Pieces are keyed by category within a design.** A set holds at most one piece per category, and an emote design has the one category `emote`. The server maps a category to its piece row.
  - `run_job(job: dict, client: Api, design: Path) -> dict` returns the Result. `main() -> int` exits 0 after the idle time.
- **The order for a prompt job:**
  1. Phase `building`.
  2. `run_agent`, with progress forwarded as events.
  3. Phase `checking`.
  4. `collect` and `check`.
  5. Phase `rendering`: for each changed piece, a spin for male (or the emote's own frames) with the `default` outfit.
  6. Upload the files and renders.
  7. Phase `saving`.
  8. Update the state's messages, sessions, totals and hashes.
  9. `PUT` the workspace.
  10. Only then, `POST` the result.
- **The outcome:**
  - `needs_input` when there's a proposal;
  - `no_change` when nothing changed and there's no error;
  - otherwise `ok`.
- **A render job** renders the requested view for the named categories from the workspace's current GLBs, uploads the frames, and posts `ok` or `error`. It doesn't run an agent and doesn't save the workspace.

- [ ] **Step 1: Write the failing tests.** Each test runs `run_job` against `fake_api.serve()`, a real local HTTP server that implements CONTRACT.md and records every call. It uses the fake agent CLIs from Task 2 and a fake `render` injected as a parameter.
  - `test_prompt_job_end_to_end`: one hat built.
    - The fake API saw the phases in order: building, checking, rendering, saving.
    - It saw GLB uploads under `pieces/hat/`, 36 webp files under `renders/hat/spin-male-default/`, and the workspace `PUT`.
    - The result `ok` came last.
  - `test_result_waits_for_workspace_save`: the fake API answers the workspace `PUT` with 500. The result is posted with `outcome: "error"` and `"workspace"` in `error`. No result says `ok`.
  - `test_proposal_needs_input`: the agent writes `out/proposal.json`. The outcome is `needs_input`, the proposal is in the result, and nothing is rendered.
  - `test_render_job_renders_requested_view`: frames are uploaded under `renders/hat/spin-female-outfit-2/`, and no agent runs.
  - `test_idle_exit`: with `STUDIO_IDLE_EXIT_SEC=1` and an API that always returns 204, `main()` returns 0 within 5 s.
  - `test_token_never_logged`: the worker's captured stderr and stdout don't contain the token value.
- [ ] **Step 2: Run them to confirm they fail.** Expected: an import error.
- [ ] **Step 3: Implement `api.py`, `jobs.py`, `__main__.py` and `CONTRACT.md`.**
  - `api.py` uses `urllib.request`, with no new dependency.
  - It retries 3 times on 5xx and connection errors, except for the result `POST`. That's retried until it succeeds or 10 minutes pass, because the result must not be lost.
- [ ] **Step 4: Run the suite.** Expected: all pass.
- [ ] **Step 5: Commit:** `feat(studio-worker): job loop, VLM API client and the worker contract`

### Task 7: Network lockdown

**Files:**
- Create: `apps/studio-worker/entrypoint.sh`
- Create: `apps/studio-worker/tinyproxy.conf`
- Create: `apps/studio-worker/allowlist.txt`
- Create: `apps/studio-worker/e2e/network.sh`

**Interfaces:**
- Consumes: the image from Task 1.
- Produces: the `entrypoint.sh` that the image runs.
  1. It writes `allowlist.txt`, plus the host from `VLM_API_URL`, into tinyproxy's filter.
  2. It starts tinyproxy as user `tinyproxy` on 127.0.0.1:8888.
  3. It sets iptables `OUTPUT` rules, in order:
     - accept `lo`;
     - accept established traffic;
     - accept uid `tinyproxy`;
     - reject everything else, over IPv4 and IPv6.
  4. It exports `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY=localhost,127.0.0.1`.
  5. It execs `python3 -m studio_worker`.
  - `render.py` passes `--proxy-server=http://127.0.0.1:8888` to Chrome.
- **`allowlist.txt` starts with:**
  - `api.anthropic.com`
  - `api.openai.com`
  - `wearable-preview.decentraland.org`
  - `peer.decentraland.org`
  - `cdn.decentraland.org`
  - The real hosts the preview loads are found in Step 2.

- [ ] **Step 1: Write `e2e/network.sh`.** It runs the image with `--cap-add NET_ADMIN`, overriding the final exec with a check script.
  - As `agent`, `curl -sS https://example.com` fails.
  - As `agent`, `curl https://api.anthropic.com/v1/models` reaches the API through the proxy (HTTP 401 without a key is a pass).
  - As root, without the proxy, `curl --noproxy '*' https://example.com` fails.
  - `studio-preview` on the fixture cap succeeds through the proxy.
- [ ] **Step 2: Run it.** Run `bash apps/studio-worker/e2e/network.sh`. Expected: the first three checks pass.
  - If the preview fails, read tinyproxy's denied hosts from its log, then add the Decentraland hosts the preview needs to `allowlist.txt`.
  - Re-run until all four pass.
  - The final allowlist is the record: every host on it gets a one-line comment saying why.
- [ ] **Step 3: Run the suite.** Run `python3 -m pytest -q apps/studio-worker/tests`. Expected: all pass, unaffected.
- [ ] **Step 4: Commit:** `feat(studio-worker): outbound traffic only through an allowlisting proxy`

### Task 8: Real agents, locally and on Fly

**Files:**
- Create: `apps/studio-worker/e2e/real_prompt.py`: runs `fake_api` in-process plus the worker, against a real agent, with brief 01 then brief 02.
- Create: `apps/studio-worker/e2e/fly.sh`
- Modify: `apps/studio-worker/README.md`
- Create: `apps/studio-worker/fly.toml` (app `vlm-studio-worker`, org `vlm-worlds`, region `iad`, no services)

**Interfaces:**
- Consumes: everything.
- Produces:
  - A verified image in Fly's registry, `registry.fly.io/vlm-studio-worker:<git sha>`, which Plan 3 starts machines from.
  - The README says how to build it, test it, run the e2e scripts, and roll out a new skills SHA.

- [ ] **Step 1: Run locally with real agents.** Run `docker run --rm --platform linux/amd64 --cap-add NET_ADMIN --env-file apps/studio-worker/.env --entrypoint /opt/entrypoint.sh vlm-studio-worker:dev python3 /opt/e2e/real_prompt.py --agent claude`, then the same with `--agent codex`. Expected: for each agent:
  - brief 01 is `ok`, with a passing hat and 36 non-blank spin frames;
  - brief 02 is `ok`, with the hat `changed` and its cost under $0.50;
  - the conversation continues;
  - the result's `skillsSha` is the full SHA.
  - This spends about $2.
- [ ] **Step 2: Agent switch.** Run `real_prompt.py --agent claude --then codex`. Expected: Codex's tweak succeeds on Claude's hat, and its prompt carried the conversation.
- [ ] **Step 3: Run on Fly.**
  1. Create the app `vlm-studio-worker`.
  2. The owner imports the secrets from `.env` themselves (`fly secrets import -a vlm-studio-worker < apps/studio-worker/.env`).
  3. Push the image with `fly deploy --build-only --push --image-label <git sha>`.
  4. `e2e/fly.sh` starts one `performance-4x` machine with `real_prompt.py --agent codex` as its command, follows its logs to the result, and then destroys it.
  - Expected:
    - the result is `ok`;
    - the network checks from `e2e/network.sh` pass inside Firecracker (`fly.sh` runs them first);
    - `fly machine list -a vlm-studio-worker` is empty afterwards.
- [ ] **Step 4: Update the README, then commit:** `chore(studio-worker): real-agent e2e locally and on Fly; worker image in the registry`
