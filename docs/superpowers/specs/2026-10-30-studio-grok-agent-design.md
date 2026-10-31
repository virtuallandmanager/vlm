# Design Studio: Grok Build as a third agent

## Intent

The owner wants to offer more choice of agent. Grok Build joins Claude Code and Codex as a working option, at the
same price to the customer. Grok costs Virvi more per prompt than Codex. The owner accepts that, expecting Claude
and Codex usage to offset it. The cheapest agent, Codex, is the one preselected, and the others are a step away so
most people stay on it.

Today the picker (`apps/web/src/app/(dashboard)/studio/AgentPicker.tsx`) shows Claude Code and Codex as a row of
buttons and Grok Build greyed out as "Coming soon". The server refuses `grok` (`agentError` in
`apps/server/src/routes/studio.ts`).

## Goals

- A customer can pick Grok Build when creating a design, or switch to it on the design page, exactly as they can
  switch between Claude Code and Codex today. That includes handing the conversation so far to the new agent, the way
  `jobs.py` already does when the agent changes.
- Codex is preselected on new designs. The picker shows the selected agent and a small "Change agent" control that
  opens a menu with the other two. The design page uses the same control, disabled while a job runs, as it is now.
- A Grok prompt is one prompt. It is counted, quoted and refunded like any other, under the same daily allowance and
  daily cost ceiling per plan.
- Grok runs under the same protections as the others:
  - the locked-down network (only `api.x.ai` is added to the allowlist);
  - no real key in the agent's reach (the key proxy adds it);
  - the scope check before the prompt, and the design-only closing rules;
  - the checker, and the same outcomes (`ok`, `timeout`, `ceiling`, `error`, `off_topic`, `declined`).

## Non-goals

- No price difference between agents, and no notice to the customer about Grok's cost.
- No change to the daily caps or plan limits.
- No model choice within Grok. The model is a server setting, like the other two.

## Anti-goals

- A Grok prompt must never reach a host other than `api.x.ai`, generate or edit images (its image tools invent
  renders), search the web, or read the real xAI key.
- Grok must not become the preselected agent by accident: the default is Codex, wherever a default is applied.

## Decisions (the owner's)

- Model: `grok-build-0.1`, the cheaper of the two measured models (see Measurements).
- Same price for every agent.
- Codex preselected; the other agents behind a "Change agent" menu.

## Decisions (mine, for the owner to check)

- **Turns:** Grok counts each tool call as a turn, and the test build hit the 80-turn limit. Grok prompts get 150
  turns. The server sends `maxTurns` per job, so this is a per-agent value there. The other agents keep 80.
- **Cost ceiling:** Grok gets the same $3 per-prompt ceiling and stops on cost while running, like Claude.
  - Its per-call `usage` events are priced from a `grok-build-0.1` row in `prices.json`: $1.00 per million input
    tokens, $0.20 cached input, $2.00 output, and no cache-write charge.
  - These are the published rates as aggregators report them in mid-2026. The builder checks them against
    docs.x.ai and against the `end` event's `total_cost_usd`.
  - The same row prices a run killed before its `end` event, so a timed-out Grok prompt still counts toward the
    daily cost ceiling.
- **Web search:**
  - The CLI flags turn search off: `--disable-web-search` and `web_search` in `--disallowed-tools`.
  - xAI can also run search on its own side if a request asks for it, and the network allowlist can't see that.
    So the key proxy refuses any xAI request whose body asks for a search tool, such as a `tools` entry of a
    search type, or `search_parameters`.
  - This goes further than for Claude, where the flags alone are trusted. It's worth it because `--trust` makes
    Grok read config in the design folder, which the agent can write to.
  - Image generation is already covered by refusing `/v1/images/generations`.
- **Deploy check:** `e2e/fly.sh` gains a Grok run of the same brief and tweak. Grok's tweak may cost up to $1.50, and
  the others keep the $0.50 limit. It adds about $2 to each worker deploy.
- **Server setting:** `STUDIO_GROK_MODEL` defaults to `grok-build-0.1`, alongside `STUDIO_CLAUDE_MODEL` and
  `STUDIO_CODEX_MODEL`.

## Measurements (2026-10-30 spikes, Grok Build CLI 1.0.70, worker image, network locked down)

- `grok-build-0.1`:
  - The e2e cap brief took 293 s and $0.95, and hit 80 turns. The hat passed the checker for both body shapes.
  - The resumed tweak took 235 s, 41 turns and $0.98, and passed.
- `grok-4.7`:
  - The build took 721 s, 79 turns and $3.73.
  - The tweak took 52 s, 7 turns and $0.48.
  - It was rejected on build cost.
- Codex tweak: about $0.04.

## How Grok runs (from the spike; the builder verifies each against the pinned version)

- **Install:**
  - A single static binary from `https://x.ai/cli/grok-<version>-linux-x86_64`, pinned by version and SHA-256 in the
    Dockerfile like Blender.
  - Version 1.0.70 is the one measured.
  - On the agent's PATH.
- **Key:**
  - `GROK_XAI_API_BASE_URL=http://127.0.0.1:<port>/v1` with `XAI_API_KEY=studio-proxy`.
  - A third key-proxy port forwards to `https://api.x.ai` with an `authorization` header.
  - Allowed paths: `/v1/chat/completions`, `/v1/responses`, `/v1/models`, `/v1/api-key`, and `/`, the paths the
    spike saw.
  - Refused: `/v1/images/generations` and everything else.
  - `XAI_API_KEY` joins the keys the entrypoint passes to the key proxy and then unsets. It is already a Fly secret
    on `vlm-studio-worker`.
- **Environment:**
  - `GROK_HOME=<design>/.grok-home`, one per design. It is kept with the workspace like `.claude-home` and
    `.codex-home`, so `-r <sessionId>` resumes.
  - `GROK_DISABLE_AUTOUPDATER=1`, `DISABLE_TELEMETRY=1`, `GROK_TELEMETRY_ENABLED=0`.
- **Command:**
  ```
  grok -p <prompt> --output-format streaming-json --permission-mode bypassPermissions --max-turns <n> -m <model>
       --trust --disable-web-search --disallowed-tools image_gen,image_edit,image_to_video,reference_to_video,web_search
       [-r <session>]
  ```
  `--trust` is what makes Grok load the skills already installed in `.claude/skills` and `.agents/skills`; without it
  none load.
- **Events (NDJSON):**
  - `text` with `data` holding one token. The reply is the text after the last `tool_call`, joined.
  - `tool_call` with `toolName` and `rawInput`, which gives progress lines like the other agents' "Running: …".
  - `usage` per model call.
  - `end` with `stopReason`, `sessionId`, `num_turns`, `total_cost_usd` and `modelUsage`.
  - At max turns: exit code 1, "Error: max turns reached" on stderr, and `stopReason` `max_turn_requests`.
  - The builder decides how that maps to an outcome, consistently with how the other agents' max-turn stops are
    treated today.
- **To verify:**
  - Whether `total_cost_usd` on a resumed run is that run's cost or the session's running total. The spike's tweak,
    $0.98 after a $0.95 build, suggests per run. `agent.py` charges each prompt its share (`_share`) and must do the
    right thing either way.
  - Whether Grok honours the closing rules (`out/declined.json`, `out/proposal.json`) and reads the skills, as it did
    in the spike.

## Where it touches

- **Worker** (`apps/studio-worker`):
  - `agent.py`: Grok's env, command, stream parsing, usage and cost.
  - `keyproxy.py` and `entrypoint.sh`: the third port and key.
  - `allowlist.txt`: `api.x.ai`.
  - `Dockerfile`: the pinned binary.
  - `workspace.py`: the new home is kept like the others.
  - `prices.json`, `CONTRACT.md`, and `e2e/real_prompt.py` (a `grok` model, and the per-agent tweak budget and turn
    limit).
  - `e2e/fly.sh`; the network checks (Grok reaches only `api.x.ai`); tests with a recorded Grok stream as a fake, like
    the existing `claude_*.jsonl` fakes.
- **Server** (`apps/server`):
  - `AGENTS` and `agentError` accept `grok`.
  - The model per agent comes from config (`designs.ts` picks the model today with a two-way ternary).
  - `PROMPT_LIMITS.maxTurns` is set per agent.
  - The schema comments listing `claude | codex`.
  - Tests.
- **Web** (`apps/web`):
  - `AGENTS` in `lib/studio.ts` drops `soon`, and `StudioAgent` gains `grok`.
  - `AgentPicker` becomes the selected agent plus a "Change agent" menu.
  - The new-design page defaults to `codex`.
  - Tests.

## Deploy order

Grok must never be offered before a worker image that runs it is live, so the worker goes first. That is harmless
because no design can ask for Grok yet.

1. Worker image: build from `.worktrees/hud-test/apps/studio-worker` (the `.blend` assets aren't in git), then run
   `fly.sh` with the Grok run, then `scope_eval.py`, then set `STUDIO_WORKER_IMAGE` on Railway.
2. Server and web together, one `railway up`, since the Dockerfile builds both. The server accepts `grok` and the
   picker offers it in the same deploy.

## Left to the builder

- The exact menu control and its styling, within the dashboard's existing components.
- How Grok's progress lines read, matching the other agents'.
- The internal shape of the per-agent model and turn settings on the server.
- Recording a real Grok stream for the test fakes, during the first image test.
