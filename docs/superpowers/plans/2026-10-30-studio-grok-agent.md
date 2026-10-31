# Design Studio Grok Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grok Build becomes a working third Design Studio agent, Codex is preselected, and a turn-limit stop offers
Continue instead of an error.

**Architecture:**
- **Worker:** `agent.py` gains a `grok` branch, covering env, command, stream parsing and cost. The key proxy gets a
  third port for `api.x.ai` that refuses search requests, and the image installs a pinned Grok binary.
- **Server:** it accepts `grok` and picks the model and turn limit per agent. It also learns a new `turns` outcome
  that Continue can follow, as it follows `ceiling` today.
- **Web:** the picker becomes the selected agent plus a "Change agent" menu, and new designs default to Codex.

**Tech Stack:**
- Worker: Python 3, pytest, with the fake CLIs in `tests/fakes/replay.py`.
- Server: Fastify, Drizzle and vitest.
- Web: Next.js and vitest. Only `lib/` is tested, not components.

**Spec:** `docs/superpowers/specs/2026-10-30-studio-grok-agent-design.md`

## Global Constraints

- Agent id `grok`, label `Grok Build`. Model setting `STUDIO_GROK_MODEL`, default `grok-build-0.1`.
- Grok's `maxTurns` is 150; Claude and Codex keep 80. Every agent's `costCeilingUsd` stays 3 and `timeoutSec`
  stays 1500.
- `prices.json` row `grok-build-0.1`: input 1.00, cachedInput 0.20, cacheWrite 0, output 2.00 (USD per million tokens).
- Key proxy xAI port is **8892**, upstream `https://api.x.ai`, header `authorization` (Bearer).
  - Exact paths: `/`, `/v1/chat/completions`, `/v1/responses`, `/v1/models`, `/v1/api-key`.
  - Prefix: `/v1/models/`.
- Grok env:
  - `XAI_API_KEY=studio-proxy`;
  - `GROK_XAI_API_BASE_URL=http://127.0.0.1:8892/v1`;
  - `GROK_HOME=<design>/.grok-home`;
  - `GROK_DISABLE_AUTOUPDATER=1`, `DISABLE_TELEMETRY=1`, `GROK_TELEMETRY_ENABLED=0`.
- Grok command, exactly:
  ```
  grok -p <prompt> --output-format streaming-json --permission-mode bypassPermissions --max-turns <n> -m <model>
       --trust --disable-web-search --disallowed-tools image_gen,image_edit,image_to_video,reference_to_video,web_search
       [-r <session>]
  ```
- Turn-limit note, exact copy: `The agent stopped at this prompt’s step limit. Press Continue to carry on where it stopped: it doesn’t use a prompt.`
  It uses the curly apostrophe, like the existing ceiling note.
- The new outcome is named `turns`. It is not refunded, pieces aren't collected, and Continue is allowed after it.
- Codex is the default agent everywhere a default applies.
- Never handle, print or commit an API key. `XAI_API_KEY` is already a Fly secret, so set nothing.
- Shell Node is 16: run vitest and tsc with `PATH=$HOME/.nvm/versions/node/v22.23.3/bin:$PATH`.

## Review Focus

1. **A Grok prompt killed at the timeout or the cost ceiling, before its `end` event, must still report a cost.** The
   cost comes from its summed `usage` events, so it counts toward the daily ceiling. The test is
   `test_grok_stopped_before_end_still_reports_cost` (Task 2).
2. **A resumed Grok prompt is charged only its own run.** The `end` event's `total_cost_usd` is per run, so `_share`
   must not subtract the earlier session total. The test is `test_grok_resumed_prompt_is_not_double_subtracted`
   (Task 2).
3. **Grok's max-turn exit (code 1, `stopReason` `max_turn_requests`) must come out as `turns`, not `error`.** The
   test is `test_grok_max_turns_is_turns` (Task 2).
4. **A design switched from Claude to Grok gets the conversation it missed, and starts a fresh Grok session.** The
   test is `test_switch_to_grok_carries_the_conversation` (Task 2, in `test_jobs.py`).
5. **The proxy must forward a normal Grok request whose function tools are merely named `search_tool`.** The search
   refusal checks a tool's `type`, never its name. The test is `test_xai_function_tool_named_search_is_forwarded`
   (Task 3).

---

### Task 1: Turn-limit stops become `turns` (worker, Claude)

**Files:**
- Modify: `apps/studio-worker/studio_worker/agent.py` (`AgentRun.outcome`, the outcome computation in `run_agent`)
- Create: `apps/studio-worker/tests/fakes/claude_max_turns.jsonl`
- Modify: `apps/studio-worker/CONTRACT.md` (outcome table)
- Test: `apps/studio-worker/tests/test_agent.py`, `apps/studio-worker/tests/test_jobs.py`

**Interfaces:**
- Produces: `AgentRun.outcome` may be `'turns'`, with `error = 'stopped at the step limit'`. `jobs.py` passes it
  through like `ceiling` (it does already, via `run.outcome != 'ok'`), and the result's `outcome` is `'turns'` with
  `pieces: []`.

- [ ] **Step 1: Write the fake and failing tests**
  - Fake: an init event, one assistant message with usage, then a `result` event:
    `{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":80,"total_cost_usd":0.4,"session_id":"sess-claude-mt",...}`.
    Model the remaining fields on `claude_builds_hat.jsonl`'s result line.
  - `test_claude_max_turns_is_turns`:
    `r = run(tmp_path, 'claude', 'claude_max_turns.jsonl')`, then
    `assert r.outcome == 'turns' and r.error == 'stopped at the step limit' and r.cost_usd == 0.4`.
  - `test_jobs.py::test_turns_outcome_collects_no_pieces`: following the existing ceiling test in that file,
    assert `result['outcome'] == 'turns'` and `result['pieces'] == []`.
- [ ] **Step 2: Run and see them fail**
  - Run: `cd apps/studio-worker && python3 -m pytest -q tests/test_agent.py -k max_turns tests/test_jobs.py -k turns`
  - Expected: FAIL, with outcome `'error'`.
- [ ] **Step 3: Implement**
  - In `run_agent`, a Claude `result` with `subtype == 'error_max_turns'` sets the outcome to `'turns'`, before the
    `failed` check.
  - Add `'turns'` to the `AgentRun.outcome` comment and to CONTRACT's outcome table: "the agent reached the prompt's
    turn limit; Continue resumes it".
- [ ] **Step 4: Run the worker suite**
  - Run: `python3 -m pytest -q`
  - Expected: all pass.
- [ ] **Step 5: Commit**
  - Message: `feat(studio-worker): a turn-limit stop is its own outcome, not an error`

### Task 2: Grok in `agent.py`

**Files:**
- Modify: `apps/studio-worker/studio_worker/agent.py`
- Modify: `apps/studio-worker/studio_worker/prices.json`
- Create: `apps/studio-worker/tests/fakes/grok_builds_hat.jsonl`, `grok_max_turns.jsonl`, `grok_runaway.jsonl`
- Test: `apps/studio-worker/tests/test_agent.py`, `apps/studio-worker/tests/test_jobs.py`

**Interfaces:**
- Consumes: `'turns'` (Task 1).
- Produces:
  - `agent_env('grok', base, design)` and `command_for('grok', model, prompt, session, max_turns)`, as in Global
    Constraints.
  - `parse_grok_end(e: dict) -> Usage`.
  - `GROK_BASE_URL = 'http://127.0.0.1:8892/v1'`.
  - `run_agent` creates and chowns `.grok-home` next to the other homes.

- [ ] **Step 1: Write the fakes**
  - Event shapes, from the spike:
    - `{"type":"text","data":"<token>"}`
    - `{"type":"tool_call","toolName":"run_terminal_command","rawInput":{"command":"blender -b ..."}}`
    - `{"type":"usage","usage":{"input_tokens":N,"output_tokens":N,"cache_read_input_tokens":N,"cache_creation_input_tokens":0,"reasoning_tokens":0}}`
    - `{"type":"end","stopReason":"end_turn","sessionId":"sess-grok-1","usage":{...same keys...},"num_turns":12,"total_cost_usd":0.9,"modelUsage":{...}}`
  - `grok_builds_hat.jsonl`: text tokens, a tool call, a `{"copy": ...}` of the cap fixture the way
    `claude_builds_hat.jsonl` does, more text tokens (the reply "Built a cap."), usage events, and an `end`.
  - `grok_max_turns.jsonl`: the same, ending with `stopReason` `max_turn_requests`. The fake must exit 1: use
    `{"exit": 1}` (see Step 3).
  - `grok_runaway.jsonl`: usage events whose priced total passes $3, followed by `{"sleep": 30}` and no `end`.
- [ ] **Step 2: Write failing tests**
  - `test_grok_env_holds_no_real_key`:
    - `XAI_API_KEY == 'studio-proxy'`, `GROK_XAI_API_BASE_URL == 'http://127.0.0.1:8892/v1'`,
      `GROK_HOME == str(agent.DESIGN / '.grok-home')`, and the three telemetry and updater flags set.
    - No real `XAI_API_KEY` value passes through.
  - `test_grok_command_turns_off_search_and_images`: the command equals the Global Constraints list, and with a
    session it ends `['-r', 'sess']`.
  - `test_progress_streams_from_grok`:
    - A `tool_call` gives `Running: blender -b ...`.
    - Text tokens before a tool call arrive as one joined progress line.
    - `r.reply == 'Built a cap.'`, `r.session == 'sess-grok-1'`, and `r.cost_usd == 0.9`.
  - `test_grok_max_turns_is_turns`: outcome `'turns'`, despite exit code 1.
  - `test_grok_stopped_before_end_still_reports_cost`: with `grok_runaway.jsonl`, the outcome is `'ceiling'` and
    `r.cost_usd` is the summed usage priced from the `grok-build-0.1` row, greater than 3.
  - `test_grok_resumed_prompt_is_not_double_subtracted`:
    - With `before=Usage(..., cost_usd=0.95)` and an `end` of `total_cost_usd` 0.9, the result is
      `r.cost_usd == 0.9` and `r.session_total.cost_usd == 1.85`.
    - The `run()` helper picks `'grok-build-0.1'` for grok.
  - `test_jobs.py::test_switch_to_grok_carries_the_conversation`:
    - The design's state has a Claude session and messages, and the job's `agent` is `grok`.
    - The fake receives a prompt containing `Conversation so far:`, and no `-r`.
    - Use the fake's `{"env": path}` control or argv capture, whichever the existing switch test uses.
- [ ] **Step 3: Run and see them fail**
  - Run: `python3 -m pytest -q tests/test_agent.py -k grok tests/test_jobs.py -k grok`
  - Expected: FAIL; `agent_env` treats grok as codex.
- [ ] **Step 4: Implement**
  - `replay.py`: an `{"exit": n}` control line, which exits with `n` after flushing. Document it in the docstring.
  - `agent_env` and `command_for`: explicit `grok` branches. Make Codex `elif agent == 'codex'`, not `else`.
  - `_Stream._grok(e)`:
    - Buffer `text` `data` tokens.
    - On `tool_call`, flush the buffer as a progress line if it isn't blank, reset the reply buffer, and emit
      `Running: <rawInput.command, or toolName plus rawInput path/pattern>`, up to 80 characters.
    - Collect `usage` events under the lock.
    - On `end`, keep the event as `self.result` and set the session from `sessionId`.
    - The reply is the text buffered since the last tool call.
  - The live ceiling covers Claude and Grok. Grok's running cost is
    `cost_usd(summed usage events, table, model)`; `None` means there's no price row and no live stop.
  - The outcome:
    - An `end` event with `stopReason == 'max_turn_requests'` is `'turns'`.
    - Otherwise, Grok failed if it exited non-zero, or ended without an `end` event.
  - `parse_grok_end`:
    - The `end` event's `usage` is mapped to `Usage`: input, cache_read to cached_input, cache_creation to
      cache_write, and output.
    - `turns=num_turns` and `cost_usd=total_cost_usd`.
    - That gives this run's usage. `_session_total` for grok returns `_add(before, run)`, and the share is `run`.
    - When there's no `end` event, use the summed usage events priced from the table, as Claude's
      stopped-before-result path does.
  - `prices.json`: the `grok-build-0.1` row from Global Constraints.
- [ ] **Step 5: Run the worker suite**
  - Run: `python3 -m pytest -q`
  - Expected: all pass.
- [ ] **Step 6: Commit**
  - Message: `feat(studio-worker): Grok Build as a third agent`

### Task 3: The xAI key proxy port, the search refusal, the network lock

**Files:**
- Modify: `apps/studio-worker/studio_worker/keyproxy.py`, `apps/studio-worker/entrypoint.sh`,
  `apps/studio-worker/allowlist.txt`, `apps/studio-worker/e2e/network_checks.sh`
- Test: `apps/studio-worker/tests/test_keyproxy.py`

**Interfaces:**
- Produces:
  - `XAI_PORT = 8892`, `XAI_PATHS`.
  - `asks_for_search(body: bytes) -> bool`.
  - `serve(..., allowed=None, refuse_body=None)`, where `refuse_body: Callable[[bytes], bool] | None` makes
    `_forward` answer 403 when it returns True.

- [ ] **Step 1: Write failing tests**, using the file's `upstream` fixture:
  - `test_proxy_forwards_only_xais_agent_endpoints`:
    - `/v1/responses`, `/v1/chat/completions` and `/v1/models` are forwarded.
    - `/v1/images/generations` and `/v1/files` get 403.
  - `test_xai_search_tool_is_refused`:
    - A POST body of `{"tools":[{"type":"web_search"}]}` gets 403, and so does `{"search_parameters":{"mode":"on"}}`.
    - The upstream receives nothing.
  - `test_xai_function_tool_named_search_is_forwarded`: a body of
    `{"tools":[{"type":"function","function":{"name":"search_tool"}}]}` is forwarded.
  - `test_non_json_body_is_forwarded`: a body of `b'not json'` is forwarded.
  - `asks_for_search` rule: the body parses as a JSON object, and either it has the key `search_parameters`, or some
    tool's `type` isn't `function` and contains `search`.
- [ ] **Step 2: Run and see them fail**
  - Run: `python3 -m pytest -q tests/test_keyproxy.py`
  - Expected: FAIL; the names don't exist yet.
- [ ] **Step 3: Implement**
  - `keyproxy.main` serves the third port from `XAI_API_KEY` with `refuse_body=asks_for_search`, pops that key too,
    and logs all three ports.
  - `entrypoint.sh`:
    - Keep `XAI_API_KEY` in the key proxy's environment.
    - Wait for 8892 as well.
    - Unset `XAI_API_KEY` afterwards.
  - `allowlist.txt`: `api.x.ai  # Grok Build's model API`.
  - `network_checks.sh`:
    - "agent reaches xAI through the key proxy (HTTP 200)" on `http://127.0.0.1:8892/v1/models` with
      `authorization: Bearer studio-proxy`.
    - Extend the worker-env key grep to `^(ANTHROPIC|OPENAI|XAI)_API_KEY=`.
- [ ] **Step 4: Run the worker suite**
  - Run: `python3 -m pytest -q`
  - Expected: all pass.
- [ ] **Step 5: Commit**
  - Message: `feat(studio-worker): an xAI key proxy port that refuses search, and api.x.ai on the allowlist`

### Task 4: The image and the deploy check

**Files:**
- Modify: `apps/studio-worker/Dockerfile`, `apps/studio-worker/e2e/real_prompt.py`, `apps/studio-worker/e2e/fly.sh`,
  `apps/studio-worker/CONTRACT.md`

**Interfaces:**
- Consumes: Tasks 2–3.
- Produces: `real_prompt.py --agent grok`. The tweak budget depends on the agent: `TWEAK_BUDGET = {'claude': 0.5,
  'codex': 0.5, 'grok': 1.5}`. Each job's limits use `maxTurns` 150 for grok.

- [ ] **Step 1: Pin the binary**
  - Download `https://x.ai/cli/grok-1.0.70-linux-x86_64` to the scratchpad and run `shasum -a 256` on it. That URL
    is fixed by the spec, not by observed content.
  - Add `ARG GROK_VERSION=1.0.70` and `ARG GROK_SHA256=<that hash>` to the Dockerfile. A `RUN` step uses `curl` to
    fetch the file, checks it with `sha256sum -c`, and installs it at `/usr/local/bin/grok` with mode 755. Put it
    beside the agent CLIs.
  - Name Grok in the header comment.
- [ ] **Step 2: Update `real_prompt.py`**
  - `MODELS['grok'] = 'grok-build-0.1'`.
  - Per-agent `maxTurns` and tweak budget.
  - The check reads `tweak under $<budget>`.
- [ ] **Step 3: Update `fly.sh`**
  - The machine runs `network_checks.sh`, then `real_prompt.py --agent codex --out /tmp/out`, then
    `real_prompt.py --agent grok --out /tmp/out-grok`. It prints `E2E-PASSED` only if all three pass.
  - Update its header: it spends about $3.
- [ ] **Step 4: Update CONTRACT.md**
  - `agent` may be `grok`.
  - Grok stops on cost while running, like Claude.
  - The `turns` outcome (Task 1) is already listed.
- [ ] **Step 5: Run the worker suite**
  - Run: `python3 -m pytest -q`
  - Expected: all pass.
- [ ] **Step 6: Build and run on Fly**
  - Build: `fly deploy --build-only --push --remote-only --image-label <sha>` from
    `/Users/unknower/-VLM/vlm-v2/.worktrees/studio-grok/apps/studio-worker`, after copying `assets/*.blend` from
    `.worktrees/hud-test/apps/studio-worker/assets/`. Those files are gitignored; never commit them.
  - Then run `bash apps/studio-worker/e2e/fly.sh registry.fly.io/vlm-studio-worker:<sha>`. Retry once on a
    `MANIFEST_UNKNOWN`.
  - Expected: `E2E-PASSED`, with Grok's network checks, Grok's build and tweak passing the checker, and Grok's
    tweak under $1.50.
  - Record a real Grok stream from this run to check the fakes. If an event shape differs from Task 2's fakes, fix
    the parser and fakes with a RED→GREEN test, and ledger it.
  - Also check that the `grok` tweak's `costUsd` is close to the sum of its `usage` events priced from the row. That
    confirms the per-run reading of `total_cost_usd` and the price row.
- [ ] **Step 7: Commit**
  - Message: `feat(studio-worker): the image ships Grok Build; the deploy check runs it`

### Task 5: The server accepts Grok and follows `turns`

**Files:**
- Modify: `apps/server/src/routes/studio.ts` (`AGENTS`, `agentError`), `apps/server/src/config.ts`
  (`studioGrokModel`), `apps/server/src/studio/designs.ts` (model and limits per agent, Continue after `turns`),
  `apps/server/src/studio/results.ts` (`OUTCOMES`, the `ContractResult.outcome` type, `systemNote`),
  `apps/server/src/db/schema.ts` (the `agent` comment: `claude | codex | grok`), `apps/server/src/studio/README.md`
  (the `STUDIO_GROK_MODEL` setting)
- Test: `apps/server/test/studio-routes.test.ts`, the results tests (look for `systemNote`, `'ceiling'` cases)

**Interfaces:**
- Produces:
  - `modelFor(agent: string): string`.
  - `promptLimits(agent: string): typeof PROMPT_LIMITS`, which is `{ ...PROMPT_LIMITS, maxTurns: 150 }` for grok.
  - `CONTINUABLE = ['ceiling', 'turns']`.
  - All in `designs.ts`.

- [ ] **Step 1: Write failing tests**
  - Creating a design with `agent: 'grok'` returns 201. `agent: 'gpt'` returns 400 with
    `agent must be claude, codex or grok`.
  - A grok design's queued job payload has `model: 'grok-build-0.1'` and `limits.maxTurns: 150`. A codex job's has
    `maxTurns: 80`.
  - A `turns` result:
    - The job is `done`.
    - The prompt isn't refunded.
    - The system note equals the Global Constraints copy.
    - `continue: true` afterwards queues an uncounted job; after `ok` it is still refused with
      `nothing_to_continue`.
- [ ] **Step 2: Run and see them fail**
  - Run: `cd apps/server && PATH=$HOME/.nvm/versions/node/v22.23.3/bin:$PATH npx vitest run test/studio-routes.test.ts <results test file>`
  - Expected: FAIL.
- [ ] **Step 3: Implement** the Interfaces above, and the copy from Global Constraints.
- [ ] **Step 4: Run the server suite and typecheck**
  - Run: `PATH=... pnpm --filter @virvixr/server test` and its `tsc --noEmit`.
  - Expected: all pass, clean.
- [ ] **Step 5: Commit**
  - Message: `feat(studio): accept Grok Build; Continue after a turn-limit stop`

### Task 6: The web picker, the Codex default, Continue after `turns`

**Files:**
- Modify:
  - `apps/web/src/lib/studio.ts`: `StudioAgent`, `AGENTS` without `soon`, `DEFAULT_AGENT`, `otherAgents`, and
    `composerState`.
  - `apps/web/src/app/(dashboard)/studio/AgentPicker.tsx`.
  - `apps/web/src/app/(dashboard)/studio/page.tsx`, at `useState(DEFAULT_AGENT)`.
- Test: `apps/web/src/lib/studio.test.ts`

**Interfaces:**
- Consumes: the server accepts `grok` and sends `lastPrompt.outcome` `'turns'` (Task 5).
- Produces:
  - `DEFAULT_AGENT: StudioAgent = 'codex'`.
  - `otherAgents(value: string): typeof AGENTS`, which returns every agent except `value`.

- [ ] **Step 1: Write failing tests**
  - `DEFAULT_AGENT === 'codex'`.
  - `otherAgents('codex')` lists the ids `['claude','grok']`.
  - `AGENTS.every((a) => !('soon' in a))`.
  - `composerState` with `lastPrompt.outcome: 'turns'` gives mode `'continue'`.
- [ ] **Step 2: Run and see them fail**
  - Run: `cd apps/web && PATH=... npx vitest run src/lib/studio.test.ts`
  - Expected: FAIL.
- [ ] **Step 3: Implement**
  - `AgentPicker` keeps its props. It shows the selected agent's label, plus a "Change agent" button that opens a
    small menu of `otherAgents(value)`. Choosing one calls `onChange` and closes the menu.
  - It is disabled when `disabled`, and closes on Escape or a click outside.
  - Use the dashboard's existing components and styles, and drop the `Badge` import if it's no longer used.
- [ ] **Step 4: Run the web suite, typecheck, and look at it**
  - Run the web tests and `tsc`. Expected: all pass, clean.
  - Then run the local dashboard, as in the scope-guard browser check. Create a design: the picker shows Codex with
    "Change agent", and the menu lists Claude Code and Grok Build. On a design page, switch to Grok Build.
- [ ] **Step 5: Commit**
  - Message: `feat(web): Codex preselected, other agents behind Change agent; Continue after a turn-limit stop`

## After the plan

- Final whole-branch review, then merge to `main` locally (always, per the owner).
- Deploy only when the owner approves it, in the spec's order:
  1. Worker image, `fly.sh`, `scope_eval.py`, then `STUDIO_WORKER_IMAGE`.
  2. Server and web, with one `railway up` from release-deploy.
