# Studio worker contract

How a studio worker machine talks to VLM's API. This file is the source of truth: `studio_worker/api.py` is the
worker's side, `tests/fake_api.py` implements VLM's side for tests, and the server routes (Plan 3) implement it for
real.

One machine works on one design. It restores the design's workspace, takes that design's jobs one at a time, and
exits after `STUDIO_IDLE_EXIT_SEC` with no job, which stops the machine. The worker always pulls; VLM never calls
the machine.

## Machine environment

| Variable | Meaning |
|---|---|
| `VLM_API_URL` | VLM's API origin, such as `https://api.vlm.gg`. Its host is added to the proxy allowlist. |
| `STUDIO_WORKER_TOKEN` | Bearer token scoped to this one design. Never handed to an agent, never logged. |
| `STUDIO_DESIGN_ID` | The design this machine works on. |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Fly secrets. Each agent gets only its own (Codex as `CODEX_API_KEY`). |
| `STUDIO_IDLE_EXIT_SEC` | Seconds with no job before the worker exits. Default 600. |

## Endpoints

All under `$VLM_API_URL/api/studio/worker`, with `Authorization: Bearer $STUDIO_WORKER_TOKEN`. A token for another
design gets 403. Path segments are URL-encoded.

| Call | Body | Answers |
|---|---|---|
| `GET /designs/{designId}/workspace` | | 200 with the workspace tar.gz, or 404 for a new design |
| `PUT /designs/{designId}/workspace` | the workspace tar.gz (`application/gzip`) | 2xx |
| `GET /designs/{designId}/jobs/next` | | 200 with a Job, or 204 when there is none. Handing out a job marks it taken. |
| `POST /jobs/{jobId}/events` | an Event (JSON) | 2xx |
| `PUT /jobs/{jobId}/files/{path}` | the file's raw bytes, with its content type | 2xx |
| `POST /jobs/{jobId}/result` | a Result (JSON) | 2xx; the job is finished |

The worker retries a call 3 times on a 5xx or connection error. It retries the result `POST` until it succeeds or
10 minutes pass. A 4xx is never retried. VLM should time out a taken job that has no result after the job's
`limits.timeoutSec` plus 15 minutes.

### Workspace

A gzip tar with two top-level folders:

- `design/`: the agent's working files, `out/`, and the agents' session homes (`.claude-home/`, `.codex-home/`). The
  agent owns this folder and can write anything in it.
- `state/`: the worker's own records, `state.json` (the conversation, sessions, running usage and the hashes of the
  pieces VLM has). It lives outside the agent's reach, so an agent can't change what it's charged or what counts as
  changed.

Only regular files and folders are stored: a symlink the agent made is left out, and the worker refuses a workspace
holding links, absolute paths or `..`. The skills come from the image, never from a workspace. VLM stores the
workspace as an opaque blob, privately.

### Files

| Path | What | Who may see it |
|---|---|---|
| `pieces/<category>/<name>_male.glb`, `_female.glb` or `<name>.glb` | a piece's GLBs | paid downloads only |
| `pieces/<category>/piece.json` | the piece's settings, as below | VLM only |
| `checks/<category>.txt` | the skills checker's full report | VLM only |
| `renders/<category>/<viewKey>/<nnn>.webp` | render frames, `000` up | the browser |

Render frames are the only files the browser ever receives. A `viewKey` is `<mode>-<bodyShape>-<outfit>`, plus
`-<emote>` when the view plays a base emote: `spin-male-default`, `spin-female-outfit-2-dance`,
`emote-male-default`.

## Job

```json
{
  "jobId": "job_123",
  "type": "prompt",
  "kind": "wearable",
  "agent": "claude",
  "model": "claude-opus-5-5",
  "prompt": "a neon cap with a glowing visor",
  "selectedSlots": ["hat"],
  "limits": {"timeoutSec": 1500, "maxTurns": 80, "costCeilingUsd": 3.0},
  "render": null
}
```

- `type`: `"prompt"` runs the agent; `"render"` renders a view of the current pieces.
- `kind`: `"wearable"` or `"emote"`.
- `agent`: `"claude"` or `"codex"`; `model`: the model id the agent runs (`claude-opus-5-5`, `gpt-6.1-sol`). Both
  are null on a render job.
- `selectedSlots`: the categories to build, or null when the user hasn't chosen yet. With null, the agent may answer
  with a slot proposal instead of building.
- `limits`: defaults `timeoutSec` 1500, `maxTurns` 80, `costCeilingUsd` 3.0. Claude is stopped once its running cost
  passes the ceiling; Codex reports usage only at the end of a turn, so time alone caps it.
- `render`, on a render job: `{"categories": ["hat"], "bodyShape": "male"|"female", "outfit": "default"|"outfit-2"|
  "outfit-3", "emote": null|"idle"|"wave"|"dance"|"clap"|"walk"}`. A wearable view is a 36-frame spin; an emote
  design's view is 36 frames through its animation.

Switching agent between prompts is allowed: the new agent is given the conversation it missed.

## Event

```json
{"type": "phase", "phase": "building"}
{"type": "progress", "text": "Running: blender -b /opt/assets/AvatarShape_A.blend --python build_cap.py"}
```

A prompt job's phases come in order: `building`, `checking`, `rendering` (only when a piece changed), `saving`. A
render job sends `rendering`. Progress texts are the agent's messages and the commands it runs. Events are best
effort: one that fails to send is dropped.

## Result

```json
{
  "jobId": "job_123",
  "outcome": "ok",
  "agent": "claude",
  "model": "claude-opus-5-5",
  "skillsSha": "3430ce2ef5b7f9d388fcb7c923f50e0dcb505420",
  "wallSec": 412.3,
  "tokens": {"input": 2100, "cachedInput": 820000, "cacheWrite": 61000, "output": 18000},
  "costUsd": 0.74,
  "reply": "I built a rounded cap with a neon visor strip...",
  "proposal": null,
  "pieces": [
    {
      "category": "hat",
      "changed": true,
      "changeKind": "new",
      "meta": {"name": "Neon Cap", "description": "...", "category": "hat", "hides": [], "replaces": [],
               "tags": ["cyberpunk"], "changeKind": "new"},
      "checker": {"pass": true, "failures": 0, "warnings": 1},
      "files": ["pieces/hat/neon_cap_male.glb", "pieces/hat/neon_cap_female.glb", "pieces/hat/piece.json",
                "checks/hat.txt"],
      "renders": {"spin-male-default": 36}
    }
  ],
  "error": null
}
```

`outcome`:

| Outcome | When |
|---|---|
| `ok` | at least one piece changed, and every changed piece rendered |
| `needs_input` | the agent wrote a slot proposal (`proposal` is set); nothing was rendered |
| `no_change` | the agent finished without changing any piece's GLBs |
| `ceiling` | Claude was stopped at the cost ceiling |
| `timeout` | the agent was stopped at the time limit |
| `error` | anything else; `error` says what. Includes a wrong output layout (GLBs outside `out/<category>/`, a piece file that is a link), a failed render, and a workspace that couldn't be saved. |

- **Pieces are keyed by category.** A design holds at most one piece per category, and an emote design has the one
  category `emote`. `pieces` lists every piece in the design (none on `ceiling`, `timeout`, a wrong layout or a failed save).
- **A piece's `files` and `renders` are set only when this job uploaded it.** An unchanged piece has empty lists, and
  the files VLM already has for it stand. A changed piece is uploaded only once it has rendered and no proposal is
  pending; until then it stays "changed", so a later prompt uploads it. Files are never uploaded by a job whose
  result is not `ok`, apart from a render failure on another piece of the same job.
- `changeKind`, from the agent: `"new"`, `"fix"` (a fix to a published piece) or `"design"` (a design change).
- `checker.pass` false means the skills checker found a FAIL. The piece is still reported.
- `costUsd` and `tokens` are this prompt's share only, even when the agent resumed a session. They are null for a
  render job.
- **The workspace is saved before the result is posted.** If the save fails, the outcome is `error` and `pieces` is
  empty: nothing claims the revision is saved.
- On a render job, `pieces` holds `{"category", "renders": {viewKey: frames}}` for each requested category.

### Proposal

```json
{"slots": [{"category": "hat", "recommended": true, "reason": "the visor is the idea"},
           {"category": "eyewear", "recommended": false, "reason": "goggles would match"}]}
```

These become the tick-boxes. The user's choice comes back as the next prompt job's `selectedSlots`.
