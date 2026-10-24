# Design Studio worker (spike)

The image a Design Studio prompt runs in: Blender 4.4, Chrome for Decentraland's wearable-preview, the Claude Code and Codex CLIs, and `dcl-avatar-skills` at a pinned commit. This is the measurement spike from `docs/superpowers/plans/2026-10-24-design-studio-1-spike.md`; Plan 2 decides what survives.

```bash
# Build (Fly runs amd64) and check the tools are all there
docker build --platform linux/amd64 -t vlm-studio-worker:spike apps/studio-worker
docker run --rm --platform linux/amd64 vlm-studio-worker:spike /opt/smoke.sh
```

Not in git (see `.gitignore`):

- `.env`: `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`, for local runs. On Fly they are secrets.
- `assets/`: the official Decentraland base avatar `.blend` files from Decentraland's docs.
- `runs/`: each run's working files. The `result.json` worth keeping is copied to `spike/results/`.
