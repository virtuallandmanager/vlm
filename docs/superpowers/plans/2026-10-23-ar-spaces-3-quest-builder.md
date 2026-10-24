# AR spaces 3: Quest builder mode and Store — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a scene's owner and editors stand in the real place with a Quest, sign in by pairing, line the scene up with the room, record and check its rings, and lay the scene out with a Decentraland-style HUD (Layout and Assets), saving to the shared scene or to just this place; then get the app ready for Meta Horizon Store review.

**Architecture:** Builder mode sits on top of plan 2's visitor app. A paired device (personal or shared) mints a 15-minute AR scene pass per space from plan 1's API, kept in encrypted storage. Pure Kotlin units (pairing session policy, draft store, transform session port, surface snapping, ring checks, placement) are JVM-tested; the Spatial SDK wiring (picking, grabbing, gizmos, panels) is checked on the headset.

**Tech Stack:** Meta Spatial SDK 0.14.0, MRUK, Compose panels, `androidx.security:security-crypto`, kotlinx-serialization, JUnit 4, MockWebServer.

**Spec:** `docs/superpowers/specs/2026-10-22-ar-builder-and-visitor-modes-design.md` (Builder mode, Edits in a scene shown in several places, Getting placement right, Input), with the AR spaces and ring marker designs. Needs plan 1 (all tasks) and plan 2 (all tasks) on the branch first.

## Global Constraints

- Worktree `/Users/unknower/-VLM/vlm-v2/.worktrees/ar-spaces`, branch `feature/ar-spaces`. Never bare `git stash`; never push, publish, upload to the Store or merge without the owner's say-so.
- Never log tokens, device secrets or pairing codes. The device secret and pass live only in `EncryptedSharedPreferences`.
- Who can build: the scene's owner, admins, cohosts and editors (the server enforces it; the app shows the server's `no_access` as "This account can't edit this scene").
- Drafts are kept on the headset for 10 minutes after it's taken off. A shared headset signs out after 2 minutes off.
- Snapping and limits copied from the Decentraland tools (`packages/vlm-core/src/transform/session.ts`): rotate snap 15°, uniform scale snap 0.1, stretch snap 0.25; port the move snap and any other constants from that file as they are.
- Ring checks warn above 5 cm or 1°. Alignment is refused from further than 1.5 m (`VisitorTuning.MAX_LOCK_DISTANCE_M`). Printed-size check warns above 3%.
- Exact builder copy (word for word):
  - Banner: "Builder: visitors don't see your changes until you save"
  - Booking: "A booking's layout is live: changes save to that booking only"
  - Several places: "This scene is also shown at <other places>: changes set to Everywhere move things there too."
  - Pairing choices are made on the website (plan 1, Task 11).
  - Size: "This ring looks about <n>% <smaller|larger> than its recorded size: was it printed at 100%?"
  - Ring check: "This ring is <d> cm and <a>° from where it should be"
  - Switch: "Everywhere" / "Just this place"; reset button "Reset to shared"
- Commit trailers on every commit:
  ```
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_018ds2NZXw5KLxDpVm9B3ABD
  ```

## Review Focus

1. **The pass expiring mid-edit** (15 minutes) while drafts are unsaved: the app re-mints silently with the device secret before saving; drafts are never lost to a 401 `Session expired`. Pinned in Task 2.
2. **Saving after another editor changed the same item from Decentraland**: the save wins (last write, as in Decentraland), but the HUD redraws from the feed, so the builder sees the result. A `transform_held` / 409 `held` while drafting shows "<name> is moving this" and keeps the item unpicked. Pinned in Task 4.
3. **A "Just this place" edit on an item later deleted in the shared scene**: the item disappears from the HUD and its local draft is dropped without an error. Pinned in Task 4.
4. **Snapping near a corner** (two walls within range): it snaps to the nearer wall only, never between them. Pinned in Task 8.
5. **Recording a ring far from the aligned one** (tracking drift): refused past the recording radius with a message to align from this ring instead. Pinned in Task 6.

---

### Task 1: Checks before building

These are the design's step-1 checks that change how input and notifications are built. Write findings in `apps/quest/README.md` under "Builder checks".

- [ ] **Step 1: Hand input in Spatial SDK 0.14.0**

Find, in the SDK docs and samples (Meta's Spatial SDK samples repo, e.g. the toolkit's `Grabbable` and `IsdkGrabbable`, the ISDK feature), whether: (a) a pinch on a mesh fires a usable event with the hit point; (b) a hand grab can carry an entity (ISDK `IsdkGrabbable` or toolkit `Grabbable`), and its release is observable; (c) wrist/palm pose is readable for a wrist menu. Build a throwaway check into a debug-only branch of `MainActivity` if docs are unclear, run it on the headset with the owner, then remove it.

- [ ] **Step 2: Notifications by place**

Search Meta's docs for app notifications from Horizon OS / the Meta Horizon app, and any proximity triggers (Wi-Fi or Bluetooth). Record what's possible. Building notifications is out of this plan either way; the finding goes to the owner.

- [ ] **Step 3: Rulings**

Record in the ledger, per finding: if (a) and (b) work, Tasks 7 and 8 use ISDK for hands and controllers alike; if not, controllers use the toolkit's `Grabbable` and ray hits, and hands use the system pointer pinch only. If (c) works, move plan 2's "⋯" menu button to the left wrist.

- [ ] **Step 4: Commit the findings**

```bash
git add apps/quest/README.md
git commit -m "docs(quest): builder input and notification checks"
```

---

### Task 2: Pairing, the device secret and the AR pass

**Files:**
- Create: `apps/quest/app/src/main/java/gg/vlm/spaces/builder/DeviceAuth.kt`, `builder/SecureStore.kt`, `builder/PairingPanel.kt` (Compose)
- Modify: `app/build.gradle.kts` (`androidx.security:security-crypto:1.1.0-alpha06`), `api/ArApi.kt` (pairing calls)
- Test: `apps/quest/app/src/test/java/gg/vlm/spaces/builder/DeviceAuthTest.kt`

**Interfaces:**
- `interface SecureStore { fun get(key: String): String?; fun put(key: String, value: String?) }` with `EncryptedSecureStore(context)` and an in-memory test double.
- `ArApi` additions (plan 1, Task 5 routes): `startPairing(secretHash, deviceName)`, `claim(code, secret)`, `mintPass(deviceId, secret, spaceId)`, `endSession(deviceId, secret)`.
- `class DeviceAuth(api: ArApi, store: SecureStore, clock: () -> Long)`:
  - `val state: StateFlow<AuthState>`; `sealed interface AuthState { SignedOut; Pairing(code: String, approveUrl: String, expiresAtMs: Long); Paired(deviceId: String, kind: DeviceKind); }`; `enum class DeviceKind { PERSONAL, SHARED }`.
  - `suspend fun beginPairing()` — makes a 32-byte random secret, stores it, sends its SHA-256; then polls `claim` every 2 s until approved, refused or expired (10 minutes).
  - `suspend fun passFor(spaceId: String): PassResult` — returns a cached pass with more than 60 s left, else mints; `sealed interface PassResult { Ok(token: String, sceneId: String); NoAccess; Revoked; Offline }`. `Revoked` clears the store and goes to `SignedOut`.
  - `suspend fun endSession()` — shared: calls `end`, clears the store; personal: drops only the cached pass.
- Pairing panel: the code in large letters (formatted `XXX-XXX`), a QR of `approveUrl` (generate with a tiny QR encoder dependency, `io.nayuki:qrcodegen:1.8.0`), "Approve on vlm.gg on your phone or computer", and Cancel.

- [ ] **Step 1: Write the failing tests (MockWebServer)**

- `pairs and stores the device` — start → claim pending, pending, approved(PERSONAL) → `Paired`; the store holds the device id and secret.
- `refused or expired goes back to signed out`.
- `re-mints a pass before it expires` — pass with 30 s left → `passFor` calls mint again.
- `revoked clears everything` — mint 401 `device_revoked` → `Revoked`, store empty, `SignedOut`.
- `a 401 Session expired during a save is retried once with a fresh pass` — via a small `withPass { token -> ... }` helper on `DeviceAuth` that retries once on 401.
- `the secret never appears in the request log` — assert the recorded `startPairing` body holds only the hash.

- [ ] **Step 2: Run them to see them fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run them to see them pass**

- [ ] **Step 5: Commit**

```bash
git add -A apps/quest
git commit -m "feat(quest): pair a headset and mint AR passes from encrypted storage"
```

---

### Task 3: Builder session policy

**Files:**
- Create: `apps/quest/app/src/main/java/gg/vlm/spaces/builder/BuilderSession.kt`
- Test: `apps/quest/app/src/test/java/gg/vlm/spaces/builder/BuilderSessionTest.kt`

**Interfaces:**
- `class BuilderSession(kind: DeviceKind, clock: () -> Long)`:
  - `fun headsetOff()`, `fun headsetOn(): Resume` — `enum class Resume { RESUME_WITH_DRAFTS, RESUME_DRAFTS_EXPIRED, SIGNED_OUT }`.
  - Personal: back within 10 minutes → `RESUME_WITH_DRAFTS`; later → `RESUME_DRAFTS_EXPIRED` (drafts dropped, still signed in).
  - Shared: back within 2 minutes → `RESUME_WITH_DRAFTS`; later → `SIGNED_OUT` (the caller runs `DeviceAuth.endSession()` and returns to visitor mode with nothing loaded).
  - `fun done()` / `fun signOut()` end the session.
  - `fun tick(): Boolean` — true when a shared session's 2 minutes off have passed while still off (the app ends the session without waiting for the headset to come back).

- [ ] **Step 1: Write the failing tests** — one per rule, using a fake clock: personal 9 min → resume; 11 min → drafts expired; shared 1 min → resume; 3 min → signed out; shared `tick()` at 2 min 1 s while off → true.

- [ ] **Step 2: Run them to see them fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run them to see them pass**

- [ ] **Step 5: Commit**

```bash
git add -A apps/quest
git commit -m "feat(quest): builder session rules for personal and shared headsets"
```

---

### Task 4: Drafts, Save, Revert and Done

**Files:**
- Create: `apps/quest/app/src/main/java/gg/vlm/spaces/builder/DraftStore.kt`, `builder/BuilderApi.kt`
- Test: `apps/quest/app/src/test/java/gg/vlm/spaces/builder/DraftStoreTest.kt`, `BuilderApiTest.kt`

**Interfaces:**
- `BuilderApi(api: ArApi, auth: DeviceAuth)` (all through `auth.withPass`): `scene(sceneId)` (`GET /api/scenes/:id`, for preset and booking info), `updateInstance(id, position, rotation, scale)` (`PUT /api/instances/:id`), `putAdjustment(spaceId, instanceId, Adjustment)`, `deleteAdjustment(spaceId, instanceId)`, `draft(sk, element, position, rotation, scale): DraftAnswer` (`POST /api/ar/drafts`; `sealed interface DraftAnswer { Ok; Held(name: String); Unavailable }`), `endDraft(sk, saved)`, `library(sceneId)`, `placeModel` / `placeImage` (create element then instance; delete the element if the instance fails, as the Hyperfy HUD's `placeModel` does), `savePose(markerId, MarkerPose, heightAboveFloorM): List<String>` (warnings).
- `data class ItemTransform(position: Vec3, rotation: Vec3, scale: Vec3)` (scene coordinates, degrees).
- `enum class Scope { EVERYWHERE, JUST_HERE }`.
- `class DraftStore(clock: () -> Long)`:
  - `fun edit(sk: String, element: String, base: ItemTransform, adjustment: Adjustment?, now: ItemTransform, scope: Scope)` — records or updates a draft. `base` is the shared (unadjusted) transform: the feed's `arShared` for an instance with `arAdjusted: true`, else the instance's own transform. `adjustment` is the feed's `arAdjustment` (null when none). `now` is what the builder sees (shared plus adjustment).
  - `fun drafts(): List<Draft>`; `data class Draft(sk, element, base, now, scope, editedAtMs)`.
  - `fun saveOps(): List<SaveOp>` — `sealed interface SaveOp { UpdateInstance(sk, ItemTransform); PutAdjustment(sk, Adjustment); EndDraft(sk, saved: Boolean) }`. `EVERYWHERE` → `UpdateInstance(shared)` where, if the item has an adjustment, `shared = now` with the adjustment taken back out (position − dPosition, rotation − dRotation, scale ÷ scaleFactor) so this place keeps its offset and other places get the move; with no adjustment, `shared = now`. `JUST_HERE` → `PutAdjustment` with `dPosition = now.position − base.position`, `dRotation = now.rotation − base.rotation`, `scaleFactor = now.scale / base.scale` (component-wise; a zero base component gives factor 1).
  - `fun revert(): List<SaveOp>` — `EndDraft(saved = false)` for each draft, then clears.
  - `fun dropMissing(present: Set<String>)` — forgets drafts whose `sk` left the feed (Review Focus 3).
  - `fun expire(olderThanMs: Long)`.
- Done = Save if there are drafts and the builder confirms, else Revert; then leave builder mode.
- A draft is sent to `draft(...)` at most 10 times a second while an item moves (the server allows 20). Drafts relay only for `EVERYWHERE` edits; for `JUST_HERE` the headset may still send them, but saving the adjustment ends the draft on the server (plan 1 final fix), so `saveOps` for `JUST_HERE` needs no `EndDraft`.
- Tests also cover: an Everywhere save of an adjusted item writes `now` minus the adjustment; a Just-here edit of an adjusted item replaces the adjustment with the full offset from `base` (not the increment).

- [ ] **Step 1: Write the failing tests**

`DraftStoreTest`: everywhere → `UpdateInstance` + `EndDraft(true)`; just here → `PutAdjustment` with the right deltas (base (1,0,0) rot (0,90,0) scale (2,2,2), now (1.5,0,0) rot (0,100,0) scale (1,2,2) → d (0.5,0,0), (0,10,0), factor (0.5,1,1)); revert ends each draft unsaved; `dropMissing` forgets a deleted item; `expire(10 min)` drops old drafts.

`BuilderApiTest` (MockWebServer): a 409 `held` maps to `Held(name)`; 503 → `Unavailable`; `placeModel` deletes the element when the instance call fails.

- [ ] **Step 2: Run them to see them fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run them to see them pass**

- [ ] **Step 5: Commit**

```bash
git add -A apps/quest
git commit -m "feat(quest): builder drafts with Everywhere / Just this place, save and revert"
```

---

### Task 5: Alignment and the printed-size check

**Files:**
- Create: `apps/quest/app/src/main/java/gg/vlm/spaces/builder/Alignment.kt`, `builder/AlignPanel.kt` (Compose)
- Test: `apps/quest/app/src/test/java/gg/vlm/spaces/builder/AlignmentTest.kt`

**Interfaces:**
- Consumes: `rootFromMarker`, `markerInScene` (plan 2, Task 3); `wallHeading`, `PoseAverager` (`RingPose.kt`).
- `fun defaultRoot(markerWorld: Vec3, headingWorldDeg: Double, floorHeightM: Double, markerHeightAboveFloorM: Double): RootPose` — the first visit's starting spot: the ring at scene point `(8, floorHeightM + markerHeightAboveFloorM, 0)` facing +Z (scene north wall's centre, facing into the scene). Uses `rootFromMarker` with that saved pose.
- `fun nudge(root: RootPose, dx: Double, dz: Double, dYawDeg: Double, pivot: Vec3): RootPose` — moves the scene in world x/z and turns it about a world pivot (the ring), for the drag-and-turn controls.
- `fun sizeRatio(rangeFromEllipseM: Double, rangeFromDepthM: Double): Double` — `rangeFromEllipse / rangeFromDepth`. The ellipse range assumes the recorded diameter, so a print scaled by `s` reads `1/s` as far: ratio > 1 means the print is smaller than recorded. `fun sizeWarning(ratio: Double): String?` — null within 3%, else the exact size copy with `n = round(|1/ratio − 1| × 100)` and "smaller" when ratio > 1.
- Align panel flow: "Look at the ring" → (steady, within 1.5 m) the scene appears at `defaultRoot` → the builder grabs a handle at the ring (or uses the thumbstick: left stick moves, right stick turns, each 1 cm / 0.5° per step with the grip held for fine steps) → **Save alignment** → `savePose(markerId, markerInScene(root, ringWorld, heading), heightAboveFloorM)`; show "Floor height doesn't match <floor name> (<h> m): check the floor" for `floor_height_off`. Refuse Save beyond 1.5 m with "Step closer to the ring to save". The depth range for the size check comes from MRUK: the distance along the camera ray to the ring's wall plane (`readWalls()`), checked once per alignment.

- [ ] **Step 1: Write the failing tests**

- `defaultRoot puts the ring at scene (8, h, 0) facing north` — `markerInScene(defaultRoot(w, hd, 0.0, 1.5), w, hd)` = (8, 1.5, 0, 0).
- `nudge turns about the ring` — turning 10° about the ring leaves the ring's scene position unchanged under `markerInScene` (within 1e-9) and changes its heading by −10°.
- `sizeRatio and sizeWarning` — ratio 1.02 → null; 1.087 → "This ring looks about 8% smaller than its recorded size: was it printed at 100%?"; 0.95 → "…about 5% larger…".

- [ ] **Step 2: Run them to see them fail**

- [ ] **Step 3: Implement the math and the panel; wire Builder → Align when the floor's ring has no pose**

- [ ] **Step 4: Run tests; on the headset, align a floor and save; reload as a visitor and check it lines up**

- [ ] **Step 5: Commit**

```bash
git add -A apps/quest
git commit -m "feat(quest): align a floor from its ring, with floor-height and printed-size checks"
```

---

### Task 6: Record, check and re-record the floor's other rings

**Files:**
- Create: `apps/quest/app/src/main/java/gg/vlm/spaces/builder/RingCheck.kt`
- Modify: `builder/AlignPanel.kt`
- Test: `apps/quest/app/src/test/java/gg/vlm/spaces/builder/RingCheckTest.kt`

**Interfaces:**
- `const val RECORD_RADIUS_M = 4.0` — a ring may be recorded only within this straight-line distance of the last ring the scene was anchored from (keeps drift small; ruling for "a few metres").
- `data class CheckResult(distanceM: Double, headingDeg: Double, warn: Boolean)`; `fun checkRing(expected: MarkerPose, measured: MarkerPose): CheckResult` — horizontal and vertical distance combined, heading via `angleDiffDeg`; warn above 0.05 m or 1°.
- `fun mayRecord(ringWorld: Vec3, lastAnchorWorld: Vec3): Boolean`.
- Panel, when a builder looks at a ring of the current floor:
  - no pose yet → **Record this ring** (refused past `RECORD_RADIUS_M` with "Too far from the last ring to record accurately: walk back, or align from this ring instead");
  - has a pose → the check line with the exact copy, and if `warn`, **Re-record this ring** (saves only this ring's pose; refused past `RECORD_RADIUS_M` like Record, since drift from the anchor is what the check measures);
  - a floor with one ring → "Add a second ring on this floor so visitors stay lined up".

- [ ] **Step 1: Write the failing tests** — 3 cm / 0.5° → no warn; 6 cm → warn; 1.2° → warn; `mayRecord` at 3.9 m true, 4.1 m false; check copy formats `d` to whole centimetres and `a` to one decimal.

- [ ] **Step 2: Run them to see them fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests; on the headset record a second printed ring, then check it from the first**

- [ ] **Step 5: Commit**

```bash
git add -A apps/quest
git commit -m "feat(quest): record and check a floor's other rings"
```

---

### Task 7: The builder HUD, picking and the transform bar

**Files:**
- Create: `apps/quest/app/src/main/java/gg/vlm/spaces/builder/BuilderHud.kt` (Compose: tabs Layout and Assets, banner, warnings, list), `builder/TransformSession.kt` (port of `packages/vlm-core/src/transform/session.ts`), `builder/Gizmo.kt` (entities), `builder/Picking.kt`
- Modify: `SceneRenderer.kt` (in builder mode, give item meshes `Hittable` collision and an outline for the picked item; visitors keep `NoCollision`)
- Test: `apps/quest/app/src/test/java/gg/vlm/spaces/builder/TransformSessionTest.kt`, `BuilderHudTextTest.kt`

**Interfaces:**
- `TransformSession` — the same modes (`MOVE`, `ROTATE`, `RESIZE`), axis handling, snapping constants and Exact-field rules as `session.ts`; inputs are drag deltas along a handle axis in scene metres or degrees. Port its unit tests from `packages/vlm-core` (find them next to `session.ts`) as `TransformSessionTest`, case for case.
- `fun hudWarnings(activePresetIsBooking: Boolean, otherPlaces: List<String>): List<String>` — exact booking and several-places copy; empty when neither applies. Other places = names of the scene's other AR spaces, from `GET /api/scenes/:sceneId/ar/spaces` (readable with the AR pass, plan 1 Task 3).
- HUD: floats 0.6 m to the builder's left, grabbable, with the banner always on top. **Layout** lists the scene's items (name, kind, a dot for `arAdjusted` with **Reset to shared**). Picking an item (ray + trigger, or pinch per Task 1's finding) outlines it and shows the bar: **Move / Rotate / Resize**, **Exact** (position, rotation, scale fields), the **Everywhere / Just this place** switch (default Everywhere), and **Save / Revert / Done**. While the scene has one AR space the switch still shows and the warning doesn't.
- Gizmo: three axis handles for Move, three rings for Rotate, corner handles for Resize, sized as `gizmo.ts` (`HANDLE_SIZE 0.12`, `RING_THICKNESS 0.04`, `RING_MIN_RADIUS 0.5`); dragging a handle with the ray feeds `TransformSession`. Held grip = snap on, as Shift in Decentraland.
- Every change goes to `DraftStore.edit` and, rate-limited, to `BuilderApi.draft`; `Held(name)` drops the pick and shows "<name> is moving this".

- [ ] **Step 1: Port the transform session tests; write `BuilderHudTextTest`**

`BuilderHudTextTest`: booking only → the booking line; two other places "Gallery", "Shop" → "This scene is also shown at Gallery and Shop: changes set to Everywhere move things there too."; three → "A, B and C"; none → empty.

- [ ] **Step 2: Run them to see them fail**

- [ ] **Step 3: Implement the session port and HUD text, then the HUD, picking and gizmo wiring**

- [ ] **Step 4: Run tests; on the headset pick, move, rotate and resize an image and a model; Save; check Decentraland shows the change (Everywhere) or doesn't (Just this place)**

- [ ] **Step 5: Commit**

```bash
git add -A apps/quest
git commit -m "feat(quest): builder HUD with Layout, picking, Move/Rotate/Resize and Exact"
```

---

### Task 8: Direct grab and snapping to real surfaces

**Files:**
- Create: `apps/quest/app/src/main/java/gg/vlm/spaces/builder/SurfaceSnap.kt`
- Modify: `builder/Picking.kt` (grab), `MainActivity.kt` (MRUK surfaces: walls, floor, tables via their labels)
- Test: `apps/quest/app/src/test/java/gg/vlm/spaces/builder/SurfaceSnapTest.kt`

**Interfaces:**
- `data class Surface(kind: SurfaceKind, centre: Vec3, normal: Vec3, halfWidth: Double, halfHeight: Double)`; `enum class SurfaceKind { WALL, FLOOR, TABLE }` — built from MRUK planes (`WALL_FACE`, `FLOOR`, `TABLE`) in world space.
- `const val SNAP_DISTANCE_M = 0.15`.
- `fun snap(position: Vec3, yawDeg: Double, halfDepthM: Double, halfHeightM: Double, surfaces: List<Surface>): SnapResult` — `data class SnapResult(position: Vec3, yawDeg: Double, snappedTo: SurfaceKind?)`:
  - Only surfaces whose plane is within `SNAP_DISTANCE_M` of the item and whose rectangle contains the item's projection count; the nearest wins (Review Focus 4).
  - WALL: position moved onto the plane plus `halfDepthM` along the normal; yaw set to face along the normal (images face out of the wall).
  - FLOOR/TABLE: y set to the surface's height plus `halfHeightM`; yaw unchanged.
- World-space results convert back to scene coordinates through the current `RootPose` before going to `DraftStore`.
- Direct grab: grip (or a hand grab, per Task 1) on a picked item carries it with the hand or controller, moving and turning it together; on release it snaps unless the trigger/pinch modifier for "no snap" is held (ruling: holding the other hand's grip turns snapping off, since grip already carries). Thumbstick while carried turns the item 15° per flick.

- [ ] **Step 1: Write the failing tests**

- `snaps flush to a wall and faces out` — wall at z = 2 facing −z; item at z = 1.9, half depth 0.01 → z = 1.99, yaw 180.
- `ignores a wall 20 cm away`.
- `sits on a table` — table top y 0.75; item half height 0.1 at y 0.8 → y 0.85.
- `picks the nearer of two walls in a corner` — walls at x = 0 and z = 0, item at (0.05, 1, 0.1) → snaps to x = 0 wall only.
- `ignores a wall whose rectangle doesn't contain the item`.

- [ ] **Step 2: Run them to see them fail**

- [ ] **Step 3: Implement snapping, then the grab wiring**

- [ ] **Step 4: Run tests; on the headset carry an image to a real wall and see it land flush; carry a model onto a table**

- [ ] **Step 5: Commit**

```bash
git add -A apps/quest
git commit -m "feat(quest): carry items by hand or controller and snap them to real walls, floors and tables"
```

---

### Task 9: Assets: place from the library

**Files:**
- Create: `apps/quest/app/src/main/java/gg/vlm/spaces/builder/AssetsTab.kt`, `builder/Placement.kt`
- Test: `apps/quest/app/src/test/java/gg/vlm/spaces/builder/PlacementTest.kt`

**Interfaces:**
- `fun placeAhead(head: Vec3, headYawDeg: Double, root: RootPose, distanceM: Double = 1.0): ItemTransform` — 1 m ahead at eye height, facing the builder, converted to scene coordinates (rotation y = head yaw + 180 − root yaw, normalised).
- Assets tab lists `BuilderApi.library(sceneId)` (images, videos, models, with thumbnails where the library gives them); **Place** creates the item at `placeAhead`, then picks it for moving straight away. Placing always goes to the shared scene (a new item has no shared position to be "just here" against); the switch applies to later edits.

- [ ] **Step 1: Write the failing tests** — head at world (0, 1.6, 0) yaw 0 with identity root → position (0, 1.6, 1), rotation y 180; with root yaw 90 the scene position and rotation are rotated back accordingly (round-trip through `RootPose` gives the world spot).

- [ ] **Step 2: Run them to see them fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests; on the headset place an image and a model, then move them**

- [ ] **Step 5: Commit**

```bash
git add -A apps/quest
git commit -m "feat(quest): place images, videos and models from the scene's library"
```

---

### Task 10: Builder mode end to end

**Files:**
- Modify: `MainActivity.kt` (menu **Builder** → `DeviceAuth` pairing or resume → the space of the ring in view, or a pick list), `visitor/VisitorMenu.kt` (builder-only **Keep the scene loaded between visitors** switch writing `AppPrefs.keepLoadedBetweenVisitors`, and **Sign out**), `api/ArApi.kt` (`deviceSpaces(deviceId, secret)` for plan 1's `POST /api/ar/devices/:id/spaces`)
- Modify: `apps/quest/README.md` (builder mode, checks)

**Interfaces:** wires Tasks 2–9.
- Entering: if a ring of a space is in view, that space and floor; otherwise a pick list from `deviceSpaces`.
- Entering shows the banner and HUD and starts `BuilderSession`. A floor whose ring has no pose goes to the Align panel first (Task 5).
- `onPause`/`onResume` go to `BuilderSession.headsetOff/On`. `SIGNED_OUT` returns to visitor mode at the hint card with nothing loaded. **Done** returns to visitor mode with the space still shown.

- [ ] **Step 1: Wire builder mode; run unit tests; install**

Run: `./gradlew :app:testDebugUnitTest :app:installDebug`
Expected: PASS; installs.

- [ ] **Step 2: Full headset run with the owner, recorded in the README**

Pair as personal; align a floor; record a second ring; move an image Everywhere and another Just this place; take the headset off for 1 minute and back (drafts kept); Save; check Decentraland and the AR feed; pair a second time as shared, take it off for 3 minutes, and confirm it's signed out and back at the hint card; revoke the personal headset from the website and confirm the next save asks to pair again.

- [ ] **Step 3: Commit**

```bash
git add -A apps/quest
git commit -m "feat(quest): builder mode end to end"
```

---

### Task 11: Ready for Horizon Store review

**Files:**
- Modify: `apps/quest/app/build.gradle.kts` (release `signingConfig` reading `VLM_QUEST_KEYSTORE`, `VLM_QUEST_KEYSTORE_PASSWORD`, `VLM_QUEST_KEY_ALIAS`, `VLM_QUEST_KEY_PASSWORD` from `~/.gradle/gradle.properties`; minify off unless the SDK documents its keep rules), `AndroidManifest.xml` (no cleartext in release; permission rationale strings in `res/values/strings.xml`)
- Create: `apps/quest/STORE.md` (listing text, age rating answers, data-use answers, the review checklist), and a privacy section in the web app's privacy page (`apps/web/src/app/privacy/` — find the page the landing work added)

**Interfaces:**
- Permission wording (strings): camera — "VLM Spaces looks for VLM rings through the headset's cameras to line a space up with the room. Camera images stay on the headset."; spatial data — "Your room's walls and surfaces are used on the headset to hide virtual things behind real ones and to snap items to walls. They aren't uploaded."
- Privacy page section "VLM Spaces on Quest": what the app sends (marker lookups, the space feed, anonymous visit events in scene coordinates; for builders, their edits and the device pairing) and what it never sends (camera images, room scans).

- [ ] **Step 1: Make a release key outside the repo (owner runs it in their own Terminal)**

Give the owner: `keytool -genkeypair -v -keystore ~/.android/vlm-quest-release.jks -alias vlm-quest -keyalg RSA -keysize 4096 -validity 10000`, and the four `gradle.properties` lines to add. Never put the key or passwords in the repo or the conversation.

- [ ] **Step 2: Build the release bundle and APK**

Run: `./gradlew :app:bundleRelease :app:assembleRelease`
Expected: signed outputs under `app/build/outputs/`. Check with `apksigner verify --print-certs` and give the owner the SHA-256 fingerprint for `ANDROID_CERT_SHA256` (plan 1, Task 12) — that's a deploy setting they apply.

- [ ] **Step 3: Write `STORE.md` and the privacy section; run Meta's VRC checks that apply (the Meta Quest Developer Hub's pre-submission checks) and record results**

- [ ] **Step 4: Commit**

```bash
git add -A apps/quest apps/web
git commit -m "chore(quest): release signing, permission wording, privacy and Store notes"
```

Uploading to the Store is the owner's step, with their Meta developer account.
