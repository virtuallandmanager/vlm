# HUD transform tools: move, rotate, resize in-world

Date: 2026-10-18. Status: design, awaiting owner approval.

## Why

Scene editors place things in their Decentraland scene with the in-world HUD, but the HUD can't move anything once it's placed. The only way to change an item's position, rotation or size is typing numbers into the web dashboard. The owner's words: "the user shouldn't even need to think about coordinates ideally." Placing something should feel like grabbing it and putting it where it looks right.

## Goals

- An editor can select any placed item in-world and **move**, **rotate** and **resize** it by dragging, with no numbers.
- Precision when wanted: one-axis locks for moving, 15° steps for rotating, round steps for resizing.
- Changes are drafts until the editor presses **Save**; **Revert** puts the item back.
- Other editors present see drafts live; visitors see only saved results.

## Non-goals

- Venue renters (grant holders) never get these tools. Renters swap certain images, change presets, and later control lights (a separate panel). The server's existing rule stays: transform changes need `scene.edit`.
- No numeric entry in the HUD.
- No multi-select, grouping, duplicate, or copy/paste.
- No parent/child instance editing (the DCL client ignores `parent` today).
- No changes to the web dashboard.
- No scene-wide locking between editors (only the short per-item hold below).
- No syncing a move across presets.

## Anti-goals (would be a failure even if it works)

- Taking over keys a scene might use (E, F, 1-4). The owner rejected number-key hotkeys for this reason.
- Visitors seeing items jitter around while an editor experiments.
- Moving an item rebuilding its entity on every update (flicker, video restarts).
- Making visitors' clicks or walking collide with editor-only helpers.

## Decided with the owner

1. **Three modes** in a small bar shown while an item is selected: **Move / Rotate / Resize**. Only that mode's handles show on the item.
2. **Move:** click and hold an item and it follows the pointer. The item goes where the pointer ray hits scene geometry (floor, wall, table); aiming at empty space keeps its current height and follows sideways. Releasing leaves it there (still a draft).
3. **Shift cycles the move lock:** each tap goes **free → X → Y → Z → free**. Axes are the scene's fixed directions, not the viewer's. The HUD shows the current lock, and a colored guide line through the item shows the locked axis. While locked, the item moves only along that axis (projected from the pointer ray).
4. **Rotate:** three grabbable rings, one per axis (the owner needs pan, tilt and yaw). Dragging along a ring turns the item around that axis. **Holding Shift snaps to 15° steps.** Rings align with the scene's axes.
5. **Resize:** a corner handle scales evenly; three axis handles stretch along one axis (screens and images need width/height). **Holding Shift snaps** to round steps.
6. **Save / Revert.** Save stores the new transform. Revert restores the transform the item had when it was selected. Selecting another item with unsaved changes asks to save or revert first.
7. **Draft visibility.** Unsaved changes are shown only to editors, cohosts and hosts in the scene room; visitors see the item jump to its new spot on Save. Other editors see a label like "being moved by <name>". If the editor leaves or disconnects without saving, the draft is reverted for the other editors.
8. **Who:** editors, cohosts, hosts (anyone with `scene.edit` on the scene, as today). Renters: no.
9. **Save changes only the preset that's live.** Each preset holds its own copy of every instance (booking presets are deep copies made by `clonePreset`, `apps/server/src/venues/service.ts`). A saved move changes only the active preset's instance; the default layout and other presets keep theirs. No cross-preset sync. The owner expects venues to need almost no transform changes once built (renters swap textures), so this is mainly for building scenes.

## Calls made without the owner (check these)

- **One editor holds an item while drafting.** The first editor to grab an item holds it until they Save, Revert or leave. Other editors see "being moved by <name>" and can't grab it meanwhile. It's a short hold on one item, not a scene-wide lock, and it stops one person's Revert from wiping another's work.
- **No auto-turning onto walls.** Dragging onto a wall moves the item there but doesn't turn it to face out.
- **Edit mode helpers are editor-only.** Click areas, handles and sound markers exist only on editors' clients.

## How it fits what exists (from reading `main`)

- **Placement already exists:** the Media Library "Place" button creates an element and instance 2 m in front of the player, facing them (`packages/vlm-adapter-dcl/src/index.ts`, `placementInFrontOfPlayer`). Models land at foot level, images at eye height. The new tools start from there.
- **Transforms** live on instances (`SceneElementInstance.position/rotation/scale`, `packages/vlm-shared/src/types/elements.ts`). Metres, scene-local; rotation is Euler degrees; scale is a Vec3. Item types with transforms on the DCL client: video, image, model, sound.
- **Cheap live path:** the scene room accepts `scene_preset_update` `{action:'update', instance:true, instanceData:{sk, position?, rotation?, scale?}}`, persists it and relays it to other clients, who call `manager.updateInstanceData` → `adapter.setTransform` in place. The REST `PUT /api/instances/:id` path instead broadcasts a full element `upsert` that clients rebuild (delete + create); avoid it for this feature.
- **Permissions:** `apps/server/src/ws/scene-guard.ts` requires `scene.edit` for instance changes. Keep it.
- **Nothing is clickable today:** placed items get no colliders or pointer events. Selection needs editor-only pointer colliders.
- **Keys:** the HUD uses only the mouse today. No `InputAction` keys are taken.
- **HUD UI:** React-ECS in `packages/vlm-adapter-dcl/src/DclHUDRenderer.tsx`, a module-level `HUDState`, re-rendered every frame. An unused stub `packages/vlm-hud/src/panels/SceneLayoutPanel.ts` already has `'move'|'rotate'|'scale'` modes, and `HUDRenderer.showTransformGizmo` is a no-op on DCL; reuse or replace freely.
- **Models** only render after `npx vlm-dcl sync` + redeploy (DCL can't load GLBs from URLs). The tools only apply to items that are visible.

## Server changes

- **Draft relay (new room messages):** the editor's client sends draft transforms for one instance; the room checks `scene.edit` and relays them only to clients whose access has `scene.edit`, tagged with the sender's display name. Drafts are never persisted.
- **Draft hold:** the room tracks one draft owner per instance; a second editor's draft for a held instance is refused with the holder's name.
- **Draft end:** on Save, the room persists the transform through the existing instance-update path and broadcasts it to everyone (existing behaviour), plus tells editors the draft ended. On Revert, or when the drafting client leaves, it tells editors to restore the saved transform.
- Rate-limit drafts per client (they arrive several times a second).

## Constraints and risks to check first

1. **Which key is Shift in SDK7.** In the current Decentraland client Shift is *run*. The builder must confirm which `InputAction` (if any) a scene can read for Shift in the current explorer before building on it. If none can be read reliably, stop and bring it back to the owner; don't silently substitute a number key.
2. **Pointer during drag.** With the cursor locked, the pointer is the screen-center crosshair and holding the mouse turns the camera; with it unlocked, it's the cursor. Dragging must work both ways using the pointer's world ray each frame.
3. **Ring and handle meshes.** SDK7 `MeshRenderer` has box, sphere, cylinder and plane (no torus). Rings can be built from segments or shipped as small GLBs in the smart item; builder's call.
4. **Model click areas.** Selecting a model needs its visible mesh on the pointer collision layer (`GltfContainer` collision masks) in edit mode only; sizing a box around a model isn't possible without bounds.
5. **Helpers must not touch visitors.** Every editor-only entity (handles, rings, guide lines, sound markers, pointer colliders) exists only on editors' clients and only while edit mode is on, on the pointer layer, never physics.

## Left to the builder

- Draft send rate (around 10 per second is fine) and the server rate limit.
- Exact snap step for resize (e.g. 10% for even scaling, 0.25 m for one axis), ring and handle size relative to the item, colors (red X, green Y, blue Z is the convention).
- How "aiming at empty space" picks the plane.
- Sound markers: a small editor-only speaker shape at each sound's position, selectable like other items.
- Where the mode bar sits on screen and how edit mode is entered from the HUD.
- Message names and payload shapes for the draft relay.
- Tests: room relay permission tests (visitor never receives drafts; non-editor can't send them), draft end on leave, and HUD logic tests in `packages/vlm-core` / adapter tests for axis projection and snapping.

## Success

The owner places a model, a screen and a sound in a live scene without typing a number. A screen ends up hung on a wall, tilted toward the crowd, at the size they want. A visitor standing nearby never sees it until Save.
