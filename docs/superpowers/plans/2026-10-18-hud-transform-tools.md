# HUD Transform Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Editors move, rotate and resize placed items in-world by dragging, with Save/Revert, and other editors see unsaved drafts live while visitors only see saved results.

**Architecture:** All math and the edit-session state machine live in `packages/vlm-core/src/transform/` (platform-free, unit-tested). The scene room gains a small draft relay (editor-only, never persisted, one holder per instance); Save reuses the existing `scene_preset_update` instance update. `packages/vlm-adapter-dcl` adds the Decentraland-specific parts: editor-only pointer colliders, gizmo entities, a per-frame input system that turns pointer rays into session calls, and the HUD mode bar.

**Tech Stack:** TypeScript, Decentraland SDK7 (`@dcl/ecs` 7.21 in the test scenes; adapter peer `@dcl/sdk >=7.7.0`), React-ECS HUD, Colyseus 0.15 room, Fastify server, vitest.

**Spec:** `docs/superpowers/specs/2026-10-18-hud-transform-tools-design.md`

## Global Constraints

- Only accounts with `scene.edit` on the scene (editors, cohosts, hosts) can draft or save transforms; renters never. Keep the existing `scene-guard.ts` rule for instance updates unchanged.
- Modes: **Move / Rotate / Resize**; only the active mode's handles show.
- Move lock cycle on each Shift tap: **free → X → Y → Z → free**. Axes are the scene's fixed axes.
- Rotate: three rings around scene X, Y, Z. **Holding Shift snaps to 15°.**
- Resize: one corner handle (uniform) and three axis handles (one axis). **Holding Shift snaps:** uniform to 10% steps of the starting scale, one axis to 0.25 m steps of the resulting size (scale × 1 m reference).
- Colors: X red, Y green, Z blue.
- Save writes only the active preset's instance via the existing `scene_preset_update` `{action:'update', instance:true, instanceData:{sk, position, rotation, scale}}`. Revert restores the transform captured at selection.
- Drafts: sent at most every **100 ms** while dragging plus once on release; server relays only to clients with `scene.edit`, drops anything over **20 per second** per client, never persists them.
- One holder per instance: the first editor's draft holds it until Save, Revert or leave; others get the holder's display name.
- No keys besides the pointer and the Shift action confirmed in Task 1. Never E, F, or 1–4.
- Editor-only helpers (pointer colliders, gizmos, guide lines, sound markers, name labels) exist only on editors' clients, only in edit mode, only on `ColliderLayer.CL_POINTER`, never `CL_PHYSICS`.
- Transform changes call `adapter.setTransform` in place; never delete/recreate an entity to move it.
- Tests: Node 20 (`export PATH=~/.nvm/versions/node/v20.20.2/bin:$PATH`). Server: `cd apps/server && npx vitest run <file>`, never two server vitest runs at once. Core: `cd packages/vlm-core && npx vitest run`.
- `pnpm-lock.yaml` may only change by entries this plan adds; if pnpm re-resolves other packages (it has bumped `@dcl/*` before), restore the lockfile and hand-edit, then `pnpm install --frozen-lockfile`.
- Commits end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. No bare `git stash`. No push, deploy or npm publish.

## Review Focus

1. **Cursor locked (first-person crosshair)** — holding the mouse turns the camera; the item must follow the crosshair ray, not jump. (Task 1 confirms the ray; Task 6 uses camera transform + `PrimaryPointerInfo.worldRayDirection`, falling back to camera forward.)
2. **Ray hits nothing or runs parallel to the fallback plane** — the item must stay put, never fly to infinity or behind the player. (Task 2 test: `rayPlane` returns null for parallel/behind; Task 3 test: drag with a null hit leaves the draft unchanged; hits beyond 50 m ignored.)
3. **Tilt past 90°** — rotating on X through 90° must not flip or snap the item back after save/reload. (Task 2 test: Euler↔quaternion round trip at pitch 90° and 135° matches the DCL convention vectors.)
4. **Second editor grabs a held item** — they see "being moved by <name>", nothing moves, and when the holder saves, the second editor sees the saved transform. (Task 4 room test; Task 5 core test.)
5. **Save while disconnected** — the change must not be silently lost: Save reports an error and the item stays a draft. (Task 5 test.)

---

### Task 1: In-world input spike (gate — stops for the owner)

Throwaway probe to confirm the SDK facts the design rests on. Nothing from it ships.

**Files:**
- Create: `test-scenes/dcl-smart-item-test/src/transform-probe.ts` (deleted again in Step 4)
- Modify: `test-scenes/dcl-smart-item-test/src/index.ts` (call the probe from `main()`)
- Create: `docs/superpowers/spikes/2026-10-18-hud-transform-input.md`

- [ ] **Step 1: Write the probe.** On-screen React-ECS label (not console) showing live: `inputSystem.isPressed(InputAction.IA_WALK)`, every `InputAction` member that `isTriggered(…, PET_DOWN)` this frame (all 14), `isPressed(IA_POINTER)`, `PrimaryPointerInfo.getOrNull(engine.RootEntity)` (pointerType, screenCoordinates, worldRayDirection), and `Transform` of `engine.CameraEntity`. Add one box with `MeshCollider` on `CL_PHYSICS`, one `GltfContainer` (any model in `models/`, or `assets/`) with `visibleMeshesCollisionMask: ColliderLayer.CL_POINTER`, and a continuous `raycastSystem.registerGlobalDirectionRaycast` from the camera along `worldRayDirection` with `RQT_QUERY_ALL`, `collisionMask: CL_POINTER | CL_PHYSICS`, `maxDistance: 50`; show the hit entity ids and positions.
- [ ] **Step 2: Build it.** `cd test-scenes/dcl-smart-item-test && npm install && npx sdk-commands build` — expect success.
- [ ] **Step 3: STOP and hand to the owner.** Ask them to run `npx sdk-commands start` in that folder, open it in the current Decentraland client, and report: (a) which action lights up when they press and hold Shift; (b) whether `isPressed(IA_POINTER)` stays true while holding left mouse with the cursor locked, and with it unlocked; (c) whether `worldRayDirection` follows the crosshair (locked) and the cursor (unlocked); (d) whether the raycast lists the GLB and the box. Write their answers to the spike doc.
- [ ] **Step 4: Rule and clean up.** If no action reliably reports Shift, stop the plan and bring it to the owner (spec: do not substitute a number key). Otherwise record the action name as `SHIFT_ACTION` in the spike doc, delete the probe, restore `index.ts`, and commit the spike doc: `docs: HUD transform input spike findings`.

---

### Task 2: Transform math in vlm-core

**Files:**
- Create: `packages/vlm-core/src/transform/math.ts`
- Test: `packages/vlm-core/test/transform-math.test.ts`

**Interfaces:**
- Produces (all exported from `math.ts`; `Vec3` from `vlm-shared`):
  - `type Quat = { x: number; y: number; z: number; w: number }`
  - `type Ray = { origin: Vec3; direction: Vec3 }` (direction normalized)
  - `type Axis = 'x' | 'y' | 'z'`; `AXIS_VECTORS: Record<Axis, Vec3>`
  - `add, sub, scale, dot, cross, length, normalize` on `Vec3`
  - `eulerDegreesToQuat(e: Vec3): Quat` and `quatToEulerDegrees(q: Quat): Vec3` — **must match `@dcl/sdk/math` `Quaternion.fromEulerDegrees` / `Quaternion.toEulerAngles`**
  - `quatMultiply(a: Quat, b: Quat): Quat`, `quatFromAxisAngle(axis: Vec3, degrees: number): Quat`
  - `rayPlane(ray: Ray, planePoint: Vec3, planeNormal: Vec3): Vec3 | null` — null when parallel (|dot| < 1e-6) or the hit is behind the origin
  - `closestPointOnAxis(ray: Ray, axisPoint: Vec3, axis: Vec3): Vec3 | null` — point on the axis line closest to the ray; null when the ray is parallel to the axis
  - `angleOnRing(ray: Ray, center: Vec3, axis: Vec3): number | null` — signed angle in degrees of the ray's hit on the ring plane around `axis`, measured from a fixed reference direction per axis
  - `snap(value: number, step: number): number`

- [ ] **Step 1: Generate DCL convention vectors once.** In `test-scenes/dcl-smart-item-test` (which has `@dcl/sdk` installed), run a one-off node script that prints `Quaternion.fromEulerDegrees` for Eulers `(0,0,0) (0,90,0) (90,0,0) (0,0,90) (30,45,60) (90,30,0) (135,20,10) (-45,200,15)` and `toEulerAngles` of each result. Paste the numbers as constants in the test (no new dependency for vlm-core).
- [ ] **Step 2: Failing tests** in `transform-math.test.ts`:
  - `eulerDegreesToQuat` matches every pasted quaternion to 1e-5 (allowing q ≡ −q).
  - `quatToEulerDegrees(eulerDegreesToQuat(e))` re-encodes to the same quaternion for every vector, including pitch 90° and 135° (Review Focus 3).
  - `rayPlane` hits `(0,0,1)` for origin `(0,1,0)`, direction `normalize(0,-1,1)`, plane point `(0,0,0)`, normal `(0,1,0)`; returns null for a horizontal ray on a horizontal plane and for a plane behind the origin (Review Focus 2).
  - `closestPointOnAxis` from origin `(0,1.6,-5)` looking at `(2,1,0)` on axis x through `(0,1,0)` returns `(2,1,0)`; null when the ray is parallel to the axis.
  - `angleOnRing` returns 0 and 90 for hits on the reference direction and 90° from it, for each axis.
  - `snap(22, 15) === 15`, `snap(23, 15) === 30`, `snap(-8, 15) === -15`.
- [ ] **Step 3: Run** `cd packages/vlm-core && npx vitest run test/transform-math.test.ts` — expect FAIL (module missing).
- [ ] **Step 4: Implement** `math.ts`.
- [ ] **Step 5: Run** the same — expect PASS. Commit `feat(vlm-core): transform math for in-world editing`.

---

### Task 3: Edit session state machine in vlm-core

**Files:**
- Create: `packages/vlm-core/src/transform/session.ts`
- Test: `packages/vlm-core/test/transform-session.test.ts`

**Interfaces:**
- Consumes: Task 2 math.
- Produces:
  - `type TransformMode = 'move' | 'rotate' | 'resize'`; `type MoveLock = 'free' | Axis`
  - `type Handle = { kind: 'body' } | { kind: 'ring'; axis: Axis } | { kind: 'uniform' } | { kind: 'stretch'; axis: Axis }`
  - `type Selected = { element: 'image' | 'video' | 'model' | 'sound'; sk: string; name: string; transform: TransformData }`
  - `class TransformSession` with constructor `(opts: { now: () => number; onDraft: (d: { element; sk; transform: TransformData }) => void; draftIntervalMs?: number /* default 100 */ })` and:
    - `select(item: Selected): 'ok' | 'dirty'` (refuses while the current selection is dirty)
    - `get selected(): Selected | null`, `get draft(): TransformData | null`, `get dirty(): boolean`
    - `setMode(m: TransformMode)`, `get mode()`; `cycleLock(): MoveLock` (free→x→y→z→free), `get lock()`; `setSnap(on: boolean)`
    - `beginDrag(handle: Handle, ray: Ray, surfaceHit: Vec3 | null): void`
    - `drag(ray: Ray, surfaceHit: Vec3 | null): void` (updates `draft`; emits `onDraft` at most every `draftIntervalMs`)
    - `endDrag(): void` (always emits the final draft)
    - `takeSave(): { element; sk; transform } | null` (null when not dirty; marks clean and makes the draft the new baseline)
    - `revert(): TransformData | null` (returns the baseline; marks clean)
    - `clear(): void`

Behaviour the tests pin:
- Move, `free`: draft position = `surfaceHit` when given (hits farther than 50 m from the ray origin count as null), else `rayPlane(ray, startPosition, up)`; null result → draft unchanged.
- Move, axis lock: position moves only along that axis by `closestPointOnAxis` delta from the grab point.
- Rotate ring: rotation = `quatToEulerDegrees(quatMultiply(quatFromAxisAngle(axis, delta), startQuat))`; with snap on, `delta` is snapped to 15°.
- Uniform resize: factor = distance(ray hit on the camera-facing plane through the item, item) ÷ that distance at grab; scale = start × factor; snap → factor rounded to 0.1.
- Stretch: only that axis's scale changes, proportional to `closestPointOnAxis` distance from the item centre ÷ grab distance; snap → resulting size rounded to 0.25 m.
- Scale components never below 0.05.

- [ ] **Step 1: Failing tests** covering each rule above, plus: `select` returns `'dirty'` after a drag without save; `takeSave` returns null when nothing changed; `revert` returns the selection-time transform; with `now` stepping 30 ms per `drag`, `onDraft` fires on the first drag, then not again until ≥100 ms, and once more on `endDrag`; a drag with `surfaceHit` null and a ray parallel to the plane leaves `draft` unchanged (Review Focus 2).
- [ ] **Step 2: Run** `npx vitest run test/transform-session.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `session.ts`. Export both new modules from `packages/vlm-core/src/index.ts`.
- [ ] **Step 4: Run** — expect PASS. Commit `feat(vlm-core): transform edit session`.

---

### Task 4: Scene room draft relay

**Files:**
- Modify: `packages/vlm-shared/src/protocol.ts`
- Modify: `apps/server/src/ws/scene-guard.ts`
- Modify: `apps/server/src/ws/VLMSceneRoom.ts`
- Test: `apps/server/test/transform-draft-room.test.ts`

**Interfaces:**
- Produces (protocol, client → server):
  - `transform_draft`: `TransformDraftData = { element: 'image'|'video'|'model'|'sound'; sk: string; position: Vec3; rotation: Vec3; scale: Vec3 }`
  - `transform_end`: `TransformEndData = { sk: string; saved: boolean }`
- Produces (server → client):
  - `transform_draft` relayed as `TransformDraftData & { holderName: string; holderSessionId: string }`
  - `transform_draft_end`: `{ sk: string; saved: boolean }`
  - `transform_held`: `{ sk: string; holderName: string }`
- Guard: `case 'transform_draft'` and `case 'transform_end'` require `hasScope(access, 'scene.edit')` and that `sk` is an instance of this scene (reuse the instance lookup the `scene_preset_update` instance case uses); return `{ ok: true, broadcast: false }`.
- Room: `private draftHolders = new Map<string /* sk */, string /* sessionId */>()`; `private draftTimes = new Map<string /* sessionId */, number[]>()`; `private async relayToEditors(type, msg, except: Client)` sends to each other client whose `getAccess` has `scene.edit`.

Rules:
- Draft for an `sk` held by another session → send the sender `transform_held { sk, holderName }`, relay nothing.
- Otherwise record the holder and relay to editors except the sender. More than 20 drafts in the last 1000 ms from one session → drop silently.
- `transform_end` from the holder → release and relay `transform_draft_end { sk, saved }` to editors except sender. From a non-holder → ignore.
- `onLeave` → for each `sk` the session held, release and relay `transform_draft_end { sk, saved: false }` to editors.

- [ ] **Step 1: Failing tests** (pattern from `test/scene-room.test.ts`; owner = host, a second editor added via the scene-roles/collaborator factories, a `viewer` collaborator, and an anonymous visitor):
  - Owner's `transform_draft` reaches the editor with `holderName`, and `visitor.expectNone('transform_draft')`.
  - Viewer collaborator's draft → `vlm_error` `forbidden`; nobody receives it.
  - Draft for an `sk` from another scene → `vlm_error` `not_found`.
  - Editor drafts an `sk` the owner holds → editor gets `transform_held` with the owner's name; owner receives nothing (Review Focus 4).
  - Owner sends 30 drafts at once → editor receives at most 20.
  - Owner leaves mid-draft → editor gets `transform_draft_end { saved: false }`, and the editor can then draft that `sk`.
  - Owner `transform_end { saved: true }` after a normal `scene_preset_update` instance update → editor gets `transform_draft_end { saved: true }`, visitor gets the `scene_preset_update` with the new position, and the DB row has it.
  - No draft is ever written to the DB (row unchanged after drafts only).
- [ ] **Step 2: Run** `cd apps/server && npx vitest run test/transform-draft-room.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** protocol types, guard cases, room handlers via the existing `guarded(...)` helper.
- [ ] **Step 4: Run** the file and `test/scene-room.test.ts`, `test/scene-pass-room.test.ts` — expect PASS. Commit `feat(server): editor-only transform draft relay`.

---

### Task 5: Core wiring (scene manager + VLM API)

**Files:**
- Modify: `packages/vlm-core/src/SceneManager.ts` and the four managers (`ImageManager.ts`, video, model, sound)
- Modify: `packages/vlm-core/src/VLM.ts`
- Test: `packages/vlm-core/test/transform-wiring.test.ts` (reuse the `fakeAdapter` pattern from `test/scene-manager-upsert.test.ts`)

**Interfaces:**
- Consumes: Task 4 protocol types; Task 3 `Selected`.
- Produces:
  - `ElementManager` gains `listInstances(): { sk: string; entity: EntityHandle; transform: TransformData }[]`, `previewTransform(sk: string, t: TransformData): void` (adapter `setTransform` only, storage untouched), `restoreTransform(sk: string): void` (re-applies the stored transform).
  - `SceneManager.findByEntity(entity: EntityHandle): Selected | null`, `listEditable(): (Selected & { entity: EntityHandle })[]`, `previewTransform(element, sk, t)`, `restoreTransform(element, sk)`.
  - `VLM.editing` getter returning `{ scene: SceneManager-facing helpers above; sendDraft(d: TransformDraftData): void; endDraft(sk: string, saved: boolean): void; save(element, sk, t: TransformData): void }`. `save` sends `scene_preset_update` `{ action: 'update', element, instance: true, instanceData: { sk, position, rotation, scale } }` and applies it locally through `updateInstanceData`; it throws `Error('not_connected')` when there is no room.
  - Events on `vlm.events`: `'transform_draft'` (relayed payload), `'transform_draft_end'`, `'transform_held'`. On `transform_draft` the core also calls `previewTransform`; on `transform_draft_end` with `saved: false` it calls `restoreTransform`.

- [ ] **Step 1: Failing tests:** `previewTransform` calls `setTransform` and leaves storage unchanged; `restoreTransform` re-applies the stored transform; `findByEntity` maps an image entity to `{ element: 'image', sk, name }`; an incoming `transform_draft` previews, and `transform_draft_end { saved: false }` restores; `save` with no room throws `not_connected` and storage is unchanged (Review Focus 5); `save` with a fake room sends exactly the message above.
- [ ] **Step 2: Run** — expect FAIL. **Step 3: Implement.** **Step 4: Run** the file and the whole core suite — expect PASS. Commit `feat(vlm-core): editing API for transform drafts and saves`.

---

### Task 6: DCL edit mode — colliders, gizmos, input

**Files:**
- Create: `packages/vlm-adapter-dcl/src/transform/edit-mode.ts` (enter/exit, colliders, sound markers, name labels)
- Create: `packages/vlm-adapter-dcl/src/transform/gizmo.ts` (handle entities per mode)
- Create: `packages/vlm-adapter-dcl/src/transform/input.ts` (frame system)
- Modify: `packages/vlm-adapter-dcl/src/index.ts` (create the session and edit mode for members who can edit)

**Interfaces:**
- Consumes: `TransformSession`, `Handle`, `Ray` (Tasks 2–3); `vlm.editing` (Task 5); `SHIFT_ACTION` from the Task 1 spike doc.
- Produces: `class DclEditMode` with `enter(): void`, `exit(): void`, `get active(): boolean`, `setMode(m)`, `save(): void`, `revert(): void`, and an `onChange: () => void` hook the HUD reads (`session` state, lock, dirty, held message, error).

Rules:
- `enter`: for each `listEditable()` entity add a pointer collider on `CL_POINTER` — images/videos `MeshCollider.setPlane`, models set `GltfContainer.visibleMeshesCollisionMask = CL_POINTER` (restore the previous value on exit), sounds get a 0.3 m sphere marker entity (unlit, editor-only) with its own pointer collider. `exit` removes all of it and calls `session.clear()`; refuse exit while dirty (HUD asks Save/Revert).
- Gizmo per mode, positioned at the draft transform each frame: Move — guide line for the locked axis (thin box, axis color); Rotate — three rings of 32 thin box segments (radius = 0.6 × largest scale component, min 0.5 m); Resize — a cube at the +X+Y+Z corner and a cube at the end of each axis. All on `CL_POINTER`, unlit.
- Input system (registered with `adapter.registerSystem` only while `active`): ray = camera `Transform` position + `PrimaryPointerInfo.worldRayDirection` (fallback camera forward); a continuous global-direction raycast (`RQT_QUERY_ALL`, `CL_PHYSICS | CL_POINTER`, 50 m) supplies `surfaceHit` = first hit whose entity is not the selected item or a helper. Pointer down on an item → `select` (on `'dirty'` show the save-or-revert prompt), on a handle → `beginDrag(handle…)`, on the item body in Move → `beginDrag({kind:'body'})`; while `IA_POINTER` pressed → `drag`; release → `endDrag`. `SHIFT_ACTION` triggered in Move → `cycleLock()`; pressed in Rotate/Resize → `setSnap(true)`, released → `setSnap(false)`.
- Session `onDraft` → `vlm.editing.sendDraft` and apply locally via `previewTransform`. `save()` → `takeSave()` → `vlm.editing.save(...)` then `endDraft(sk, true)`; on `not_connected` keep the draft and surface the error. `revert()` → `restoreTransform` + `endDraft(sk, false)`.
- Remote drafts: show a `TextShape` label "being moved by <holderName>" 0.3 m above the item for editors; remove it on `transform_draft_end`. `transform_held` → HUD message, drag not started.

- [ ] **Step 1: Implement** the three files and the wiring.
- [ ] **Step 2: Verify** `pnpm turbo typecheck` (all green) and `cd packages/vlm-smart-item-dcl && npm run bundle && npm test` — expect success.
- [ ] **Step 3: Commit** `feat(vlm-adapter-dcl): in-world edit mode with move, rotate and resize gizmos`.

---

### Task 7: HUD mode bar and actions

**Files:**
- Modify: `packages/vlm-adapter-dcl/src/DclHUDRenderer.tsx`
- Modify: `packages/vlm-adapter-dcl/src/index.ts` (`setSceneActionHandler` actions)

**Interfaces:**
- Consumes: `DclEditMode` (Task 6).
- Produces: HUD state fields `editMode: { active: boolean; mode: TransformMode; lock: MoveLock; selectedName: string | null; dirty: boolean; message: string | null; prompt: boolean }` with setter `setEditMode(s)`; scene actions `edit_enter`, `edit_exit`, `edit_mode` `{mode}`, `edit_save`, `edit_revert`.

Rules:
- An **Edit layout** button in the Layout panel (editors only, `canEdit()`) sends `edit_enter`.
- While active, a floating bar (absolute `UiEntity`, bottom-centre, same style as `NotificationToast`): `Move` `Rotate` `Resize` (active one highlighted), the selected item's name, the lock label in Move (`Free` / `X` red / `Y` green / `Z` blue), `Save` and `Revert` (enabled only when dirty), `Done` (sends `edit_exit`; when dirty shows the prompt instead).
- Prompt text: `Save or revert changes to <name> first.` with Save / Revert buttons.
- `message` shows held/error text (`Being moved by <name>`, `Not connected — your change is still a draft`).

- [ ] **Step 1: Implement.** **Step 2: Verify** typecheck, bundle and smart-item tests as in Task 6. **Step 3: Commit** `feat(hud): edit layout mode bar with save and revert`.

---

### Task 8: Docs, version, in-world checklist

**Files:**
- Modify or create: the in-world HUD page under `apps/docs/src/content/docs/` (find it with `grep -rl "Media Library\|HUD" apps/docs/src/content/docs`)
- Modify: `packages/vlm-smart-item-dcl/package.json` (version `2.4.0`)
- Create: `docs/superpowers/spikes/2026-10-18-hud-transform-checklist.md`

- [ ] **Step 1: Docs:** a short "Moving things in-world" section: Edit layout, the three modes, Shift behaviour per mode, Save/Revert, who can use it, that visitors only see saved changes.
- [ ] **Step 2: Version** to 2.4.0; `npm run bundle && npm test` in `packages/vlm-smart-item-dcl`; `cd apps/docs && pnpm build`.
- [ ] **Step 3: Checklist** for the owner's in-world test: place a model, screen and sound; move each with free and each axis lock; hang a screen on a wall; tilt it 15° steps past 90°; resize uniform and one-axis with snap; Save, rejoin, confirm it stuck; Revert restores; second editor sees the draft label and can't grab a held item; a visitor sees nothing until Save; Done with unsaved changes prompts.
- [ ] **Step 4: Commit** `docs: in-world transform tools; vlm-dcl 2.4.0`.
