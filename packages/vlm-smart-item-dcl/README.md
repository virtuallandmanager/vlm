# vlm-dcl

[Virtual Land Manager](https://vlm.gg) for Decentraland SDK7 scenes: visitor analytics,
the in-world management HUD, and live scene content managed from the VLM dashboard.

Version 2 is a rewrite. It is not compatible with the 0.x (SDK6-era) API.

```sh
npm install vlm-dcl
```

## From code

```ts
import { createVLM } from 'vlm-dcl'

export async function main() {
  const vlm = await createVLM()
  vlm.track('scene_loaded') // optional custom analytics event
}
```

`createVLM()` starts analytics straight away, with no account or scene ID needed. Scene owners
get the management HUD (top right) and can claim the scene's analytics on vlm.gg later.

Analytics only (no HUD, no live content):

```ts
import { startVLMAnalytics } from 'vlm-dcl'

export function main() {
  startVLMAnalytics()
}
```

## Setting up your scene

Deploy, then walk into your scene with the wallet that owns, operates or deployed it. The VLM HUD
(top right) shows **Set up VLM here**: one press makes you the scene's host — no account or email
needed. Open **Roles** in the HUD (or the scene's Roles tab on vlm.gg) to make others co-hosts,
editors or viewers by wallet address.

## Images and 3D models

- Upload images (PNG, JPG, WebP, GIF up to 10 MB) and GLB models (up to 50 MB) on vlm.gg (Media),
  or place them from the in-world HUD (Assets → Place).
- Images appear live for everyone.
- Decentraland only loads 3D models that are deployed with your scene, so after adding a GLB run
  `npx vlm-dcl sync` in your scene folder (it downloads your VLM models into `models/vlm/`), then
  deploy as usual. After that, moving, scaling and showing/hiding models is live. The HUD tells you
  when models need a sync.
- `npx vlm-dcl sync --dry-run` shows what would change; `--server <url>` for self-hosted VLM.

## Creator Hub

1. In a terminal in your scene folder, run `npm install vlm-dcl`.
2. Copy `node_modules/vlm-dcl/creator-hub/VLMManager.ts` to `assets/scene/Scripts/VLMManager.ts`.
3. In Creator Hub, add an entity (e.g. "VLM Manager"), add a **Script** component, and pick
   `VLMManager.ts`.
4. Fill in the fields, or leave them as they are:

| Field | Default | Meaning |
|-------|---------|---------|
| sceneId | (blank) | VLM scene ID. Blank: set the scene up from the in-world HUD |
| env | `prod` | `prod`, `staging` or `dev` (anything else means `prod`) |
| serverUrl | (blank) | Only for self-hosted VLM servers |
| enableHud | on | In-world management HUD for scene owners |
| enableAnalytics | on | Visitor analytics |
| showBeacon | off | Show the VLM Manager entity's mesh (handy for finding it) |

## Requirements

`@dcl/sdk` 7.15 or later (Creator Hub's Script component needs 7.15+).
