# AR spaces 2: Quest visitor mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the Quest spike into the shipping VLM Spaces app's visitor side: open it, look at a ring, and the space's published scene appears lined up with the room, with no sign-in, no world key and no settings.

**Architecture:** The spike (`apps/quest-spike`) moves to `apps/quest` and keeps its proven pieces: Camera2 passthrough capture, the Kotlin ring detector and tracker, pose math, MRUK walls, occlusion and the renderer. New pure-Kotlin units (alignment math, the visitor flow state machine, lock-on gate, tracking-jump watch, AR API client) carry the logic and are unit-tested on the JVM; `MainActivity` wires them to the Spatial SDK. Visitor mode is the app's default and the state it always returns to.

**Tech Stack:** Meta Spatial SDK 0.14.0 (Kotlin, MRUK, Compose panels), Camera2 + Passthrough Camera API, kotlinx-serialization, JUnit 4.

**Spec:** `docs/superpowers/specs/2026-10-22-ar-builder-and-visitor-modes-design.md` (Visitor mode, Finding the place before arriving, Getting placement right → For visitors), with `2026-10-22-ring-marker-design.md` for detection and pose. Plan 1 (`2026-10-23-ar-spaces-1-server-and-dashboard.md`) provides the API; this plan needs plan 1's Tasks 3, 4 and 8 merged into the branch first.

## Global Constraints

- Same worktree and branch as plan 1: `/Users/unknower/-VLM/vlm-v2/.worktrees/ar-spaces`, `feature/ar-spaces`. Never use bare `git stash`; never push, publish or merge without the owner's say-so.
- Don't modify `apps/ar-spike/tools/make_markers.py` or the QR test markers.
- App id `gg.vlm.spaces`; Quest 3 and 3S only; Horizon OS v74+; permissions `android.permission.CAMERA` and `horizonos.permission.HEADSET_CAMERA`, plus scene/anchor permissions already in the manifest. No location permission.
- Server base URL `https://vlm.gg`, overridable only in debug builds.
- Visitor mode never shows builder tools, drafts or settings beyond the small menu.
- Wrong placement is worse than a delay: the scene appears only from a steady pose with the ring within about 1.5 m, and it hides rather than drifts when tracking jumps.
- Exact visitor copy (keep it word for word):
  - Hint: "Look for a ring like this, at eye level near the entrance."
  - Too far: "Step closer to the ring"
  - Space page: "Look at the ring when you get there"
  - Menu: "Look at the ring again", "Hide behind walls", "Live depth", "Off", "Spaces", "Builder"
- Unit tests run with `./gradlew :app:testDebugUnitTest` from `apps/quest`.
- Commit trailers on every commit:
  ```
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_018ds2NZXw5KLxDpVm9B3ABD
  ```

## Review Focus

1. **A ring from another space, or an unregistered ring, while a space is shown** (a second venue's ring, a printed test marker): it never re-anchors the current scene and never swaps spaces mid-visit unless the visitor chooses "Look at the ring again". Pinned in Task 5.
2. **The feed failing after the ring was read** (offline, 429, 404 for an unpublished space): the hint card says so in plain words and the app keeps looking; no half-loaded scene. Pinned in Task 2 and Task 5.
3. **The headset taken off and put back on** mid-visit: on return the scene is hidden until a ring is seen again (personal or shared). Pinned in Task 5.
4. **A space whose ring has no saved alignment yet**: visitors get "This space isn't set up yet", never a scene at a guessed spot. Pinned in Task 5.
5. **A link to a space opened while the visitor is already in another**: the new space's page shows, and the old scene is cleared. Pinned in Task 7.

---

### Task 1: Promote the spike to `apps/quest`

**Files:**
- Move: `apps/quest-spike` → `apps/quest` (`git mv`)
- Modify: `apps/quest/settings.gradle.kts` (root project name `VLMSpaces`), `apps/quest/app/build.gradle.kts` (`applicationId` and `namespace` `gg.vlm.spaces`, `versionCode 1`, `versionName "0.1.0"`, `ringTestset` task path), Kotlin package `gg.vlm.spaces.quest` → `gg.vlm.spaces` across `app/src`, `AndroidManifest.xml` (`usesCleartextTraffic` only in a debug manifest overlay)
- Modify: `apps/ring-marker/ringmarker/testset.py` (`FOCAL_PX = 867.0`), `apps/quest/app/src/test/.../ring/RingPoseTest.kt` and `RingDetectorTest.kt` (read the focal length from `testset/manifest.json` instead of hardcoding 760)
- Delete: `apps/quest/set-key.sh`

- [ ] **Step 1: Move and rename**

```bash
cd /Users/unknower/-VLM/vlm-v2/.worktrees/ar-spaces
git mv apps/quest-spike apps/quest
```

Then rename the package directories and `package` lines, and fix the paths in `build.gradle.kts`.

- [ ] **Step 2: Make the testset use the Quest 3's measured focal length**

Set `FOCAL_PX = 867.0` (the device's `fx = fy = 866.9`, README). Have `testset.py` write `focal_px` into `manifest.json` if it doesn't already, and have both Kotlin tests read it.

- [ ] **Step 3: Run the Python and Kotlin tests**

Run: `cd apps/ring-marker && python3 -m pytest -q && cd ../quest && ./gradlew :app:testDebugUnitTest`
Expected: PASS. If a range case now fails at 1.8 m, that's information for the range test, not a reason to change detector thresholds here: record it in the ledger and mark that case as expected-to-fail with a comment naming the range test.

- [ ] **Step 4: Build and install on the headset**

Run: `./gradlew :app:installDebug`
Expected: the app installs as "VLM Spaces" beside the old spike (different id). The owner uninstalls `gg.vlm.spaces.quest` when convenient.

- [ ] **Step 5: Commit**

```bash
git add -A apps/quest apps/quest-spike apps/ring-marker
git commit -m "chore(quest): promote the spike to apps/quest as gg.vlm.spaces; testset at fx 867"
```

---

### Task 2: AR API client

**Files:**
- Create: `apps/quest/app/src/main/java/gg/vlm/spaces/api/ArApi.kt`, `api/ArModels.kt`, `api/ArFeed.kt`
- Delete: `FeedClient.kt` (its parsing and backoff move into `ArFeed`), `FeedParseTest.kt` (replaced)
- Test: `apps/quest/app/src/test/java/gg/vlm/spaces/api/ArModelsTest.kt`, `ArFeedTest.kt`
- Modify: `app/build.gradle.kts` (test dependency `com.squareup.okhttp3:mockwebserver:4.12.0`; keep `HttpURLConnection` in the app)

**Interfaces:**
- `ArModels.kt` (kotlinx-serialization, mirroring plan 1's `vlm-shared/src/ar.ts`):
  - `data class MarkerPose(x: Double, y: Double, z: Double, headingDeg: Double)`
  - `data class ArMarker(id: String, ringId: Long, code: String, diameterMm: Double, whereText: String?, pose: MarkerPose?)`
  - `data class ArFloor(id: String, name: String, heightM: Double, sortOrder: Int, markers: List<ArMarker>)`
  - `data class ArSpace(id: String, name: String, place: String?, published: Boolean, floors: List<ArFloor>)` with `fun markerByRing(ringId: Long): Pair<ArFloor, ArMarker>?`
  - `data class MarkerLookup(spaceId: String, floorId: String, markerId: String, spaceName: String, whereText: String?)`
  - `fun parseFeed(body: String): ArFeedSnapshot?` where `data class ArFeedSnapshot(version: String, space: ArSpace, scene: JsonObject?)`; null unless `v == 1`.
- `ArApi(baseUrl: String, userAgentVersion: Int = 1)`:
  - `suspend fun lookup(code: String): ApiResult<MarkerLookup>`
  - `sealed interface ApiResult<out T> { data class Ok<T>(val value: T); data object NotFound; data object RateLimited; data object Offline; data class Failed(val status: Int) }`
  - Sends `X-VLM-App-Version: 1`; a bearer token only when one is given (plan 3).
- `ArFeed(scope: CoroutineScope, api: ArApi, onStatus: (FeedStatus) -> Unit, onSnapshot: (ArFeedSnapshot) -> Unit)` with `start(spaceId: String, token: (() -> String?)? = null)` and `stop()`: long-polls `GET /api/ar/spaces/:id/feed?since=`, connect timeout 15 s, read timeout 40 s, backoff 1 s doubling to 30 s, as the spike's `FeedClient` did. `enum class FeedStatus { CONNECTING, LIVE, OFFLINE, RATE_LIMITED, NOT_FOUND }`.

- [ ] **Step 1: Write the failing tests**

- `parses a feed with a space, floors, markers and a scene` — a JSON fixture shaped like plan 1's `ArFeedResponse`; `space.markerByRing(0x2E3D4C5B)` returns the floor and marker; a marker without a pose has `pose == null`.
- `refuses an unknown feed version` — `v: 2` → null.
- `lookup maps 404, 429 and connection failure` — MockWebServer returns 404, then 429, then shuts down: `NotFound`, `RateLimited`, `Offline`.
- `the feed long-polls with since and stops on NOT_FOUND` — first response v1 version "a", second request carries `since=a`; a later 404 reports `NOT_FOUND` and stops polling.

- [ ] **Step 2: Run them to see them fail**

Run: `./gradlew :app:testDebugUnitTest --tests 'gg.vlm.spaces.api.*'`

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run them to see them pass**

- [ ] **Step 5: Commit**

```bash
git add -A apps/quest
git commit -m "feat(quest): AR space API client and long-poll feed"
```

---

### Task 3: Placing the scene from a ring's saved pose

**Files:**
- Create: `apps/quest/app/src/main/java/gg/vlm/spaces/space/SpaceAlignment.kt`
- Modify: `SceneRenderer.kt` (replace `place(centre, yaw)` with `setRoot(root: RootPose)`)
- Test: `apps/quest/app/src/test/java/gg/vlm/spaces/space/SpaceAlignmentTest.kt`

**Interfaces:**
- `data class RootPose(position: Vec3, yawDeg: Double)` — the scene's origin in world space and its turn about +Y. A scene point `s` lands at `position + R_y(yawDeg)·s`.
- `fun rootFromMarker(markerWorld: Vec3, headingWorldDeg: Double, saved: MarkerPose): RootPose` — `yaw = headingWorld − saved.headingDeg`; `position = markerWorld − R_y(yaw)·(saved.x, saved.y, saved.z)`. Headings are degrees from +Z toward +X (the convention of `wallHeading` in `RingPose.kt`); `R_y(θ)` maps +Z to `(sin θ, 0, cos θ)`. The scene stays level: no pitch or roll ever.
- `fun markerInScene(root: RootPose, markerWorld: Vec3, headingWorldDeg: Double): MarkerPose` — the inverse, used by plan 3's alignment and ring checks.
- `fun angleDiffDeg(a: Double, b: Double): Double` — shortest signed difference in (−180, 180].

- [ ] **Step 1: Write the failing tests**

- `identity` — saved (8, 1.5, 0, 0), seen at (8, 1.5, 0) heading 0 → root (0,0,0), yaw 0.
- `turned and moved` — saved (8, 1.5, 0, 0) seen at (1, 1.5, 2) heading 90 → yaw 90; scene point (8, 1.5, 0) maps back to (1, 1.5, 2); scene point (8, 1.5, 1) maps to (2, 1.5, 2).
- `round trip` — for 50 random roots and markers, `markerInScene(rootFromMarker(w, h, s), w, h)` equals `s` within 1e-9 and heading within 1e-9 (mod 360).
- `heading wraps` — saved heading 350, seen 10 → yaw 20.
- `angleDiffDeg(10, 350) == 20`, `angleDiffDeg(350, 10) == -20`, `angleDiffDeg(0, 180) == 180`.

- [ ] **Step 2: Run them to see them fail**

- [ ] **Step 3: Implement; change `SceneRenderer` to use `setRoot`**

`setRoot` sets the root entity's `Transform` to `Pose(position, Quaternion from yaw)` and nothing else; delete the old `(8,0,8)` centring, which `rootFromMarker` makes unnecessary.

- [ ] **Step 4: Run them to see them pass**

- [ ] **Step 5: Commit**

```bash
git add -A apps/quest
git commit -m "feat(quest): place the scene from a ring's saved pose in scene coordinates"
```

---

### Task 4: "Step closer": seeing a ring the detector can't read yet

**Files:**
- Modify: `apps/quest/app/src/main/java/gg/vlm/spaces/ring/RingDetector.kt`
- Test: `apps/quest/app/src/test/java/gg/vlm/spaces/ring/RingDetectorTest.kt`

**Interfaces:**
- `data class RingFrame(val detections: List<RingDetection>, val unreadable: List<UnreadableRing>)`; `data class UnreadableRing(cx: Double, cy: Double, semiMajor: Double)`.
- `fun detectFrame(gray: ByteArray, width: Int, height: Int, rowStride: Int = width): RingFrame` — the existing pipeline, also reporting candidates that passed the finder-ring-and-dot pairing (step 2 of the detector) but failed decoding. `detect(...)` stays as `detectFrame(...).detections`.

- [ ] **Step 1: Write the failing tests**

- `a ring too small to read is reported unreadable` — take `range-RING140-1.2-0.png`, downscale it by 0.35 (nearest is fine), run `detectFrame`: `detections` is empty and `unreadable` has one entry near the ring's centre (within 10 px of the scaled true centre from the manifest).
- `a readable ring is not also unreadable` — the unscaled image gives one detection and no unreadable entries.
- `a blank frame and the decoys report nothing` — mid-grey frame and every `decoy-*` image: `unreadable` empty. If a decoy does produce an unreadable candidate, that only shows "Step closer" — acceptable — but record which in the ledger and loosen this one test to the blank frame.
- `still fast` — the existing `fastEnough` median under 40 ms holds with `detectFrame`.

- [ ] **Step 2: Run them to see them fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run them to see them pass**

- [ ] **Step 5: Commit**

```bash
git add -A apps/quest
git commit -m "feat(quest): report rings seen but not readable, for 'Step closer'"
```

---

### Task 5: The visitor flow

**Files:**
- Create: `apps/quest/app/src/main/java/gg/vlm/spaces/visitor/VisitorFlow.kt`, `visitor/LockGate.kt`, `visitor/TrackingWatch.kt`, `visitor/VisitorTuning.kt`
- Test: `apps/quest/app/src/test/java/gg/vlm/spaces/visitor/VisitorFlowTest.kt`, `LockGateTest.kt`, `TrackingWatchTest.kt`

**Interfaces:**
- `object VisitorTuning` — one place for the numbers the range test will adjust: `MAX_LOCK_DISTANCE_M = 1.5`, `MIN_FRAMES = 5`, `MAX_SPREAD_M = 0.01`, `MAX_HEADING_SPREAD_DEG = 1.0`, `JUMP_DISTANCE_M = 0.25` (per tick), `JUMP_YAW_DEG = 25.0` (per tick), `NOT_FOUND_RETRY_MS = 600_000L`, `UNREADABLE_HINT_MS = 1500L` (how long a candidate must persist before "Step closer").
- `LockGate.evaluate(count: Int, spreadM: Double, headingSpreadDeg: Double, distanceM: Double): Gate` — `enum class Gate { GATHERING, TOO_FAR, STEADY }`.
- `TrackingWatch.onHead(position: Vec3, yawDeg: Double): Boolean` — true on a jump (larger than the tuning limits since the previous tick); `reset()`.
- `VisitorFlow` — a pure state machine; `MainActivity` feeds it events and renders its state:
  - `sealed interface VisitorState { Hint; StepCloser; Loading(code: String); NotSetUp(spaceName: String); Failed(message: String); Locking(space: ArSpace); Shown(space: ArSpace, root: RootPose); }`
  - `sealed interface VisitorEvent { UnreadableSeen(sinceMs: Long); RingAgreed(ringId: Long); Lookup(ringId: Long, result: ApiResult<MarkerLookup>); Feed(snapshot: ArFeedSnapshot); FeedStatus(status: FeedStatus); Steady(ringId: Long, world: Vec3, headingDeg: Double); TrackingJump; HeadsetOff; HeadsetOn; LookAgain; OpenSpace(code: String) }`
  - `fun on(event: VisitorEvent, nowMs: Long): List<VisitorEffect>` where `sealed interface VisitorEffect { Lookup(code: String); StartFeed(spaceId: String); StopFeed; ShowScene(root: RootPose); Reanchor(root: RootPose); HideScene; FlashOutline(ringId: Long); ResetAveragers; SetRegistered(ids: Set<Long>?) }` (`null` = accept any ring, used while searching).
  - Rules:
    - While searching, any agreed ring triggers a lookup by `RingCodec.codeOf(ringId)`; a `NotFound` puts the ring on a do-not-ask list for `NOT_FOUND_RETRY_MS`.
    - After the feed arrives, only the space's ring ids are registered. A ring whose marker has no `pose` gives `NotSetUp`.
    - `Steady` for a ring with a pose → `ShowScene` + `FlashOutline` (first time) or `Reanchor` (later, any ring of the space).
    - `TrackingJump` or `HeadsetOff` → `HideScene`, `ResetAveragers`, state back to `Locking(space)` (the feed keeps running, so the next ring re-shows quickly).
    - `LookAgain` → like a jump, but also forgets the space: `StopFeed`, `SetRegistered(null)`, state `Hint`.
    - `OpenSpace(code)` → clears any current space and looks the code up (from a link or the Spaces list).
    - Feed `NOT_FOUND` → `Failed("This space isn't open right now.")`; `OFFLINE` before the first snapshot → `Failed("Can't reach VLM. Check the headset's Wi-Fi.")`; after a snapshot, offline keeps the scene shown.

- [ ] **Step 1: Write the failing tests**

`LockGateTest`: 4 frames → GATHERING; 5 frames at 1.6 m → TOO_FAR; 5 frames, spread 0.004 m, heading spread 0.5°, 1.2 m → STEADY; spread 0.02 → GATHERING.

`TrackingWatchTest`: steady walking (0.02 m per tick) → false; a 0.4 m step → true; a 30° yaw snap → true; first call after `reset()` → false.

`VisitorFlowTest`, one test per rule above, plus the Review Focus cases:
- `a ring from another space doesn't re-anchor or swap` — shown space A; `RingAgreed` for a ring not in A → no effects (it isn't registered, so the tracker wouldn't even agree it; also assert the flow ignores it).
- `a lookup that fails shows a plain message and keeps looking` — `Offline` → `Failed(...)`, and a later `RingAgreed` retries.
- `taking the headset off hides the scene until a ring is seen again` — `HeadsetOff` → `HideScene`; `HeadsetOn` → no `ShowScene`; then `Steady` → `ShowScene`.
- `an unaligned ring says not set up` — feed with the ring's `pose = null`; `Steady` → `NotSetUp(space.name)`, no `ShowScene`.
- `"Step closer" only after the candidate persists` — `UnreadableSeen(sinceMs = now - 1000)` stays `Hint`; `now - 1600` → `StepCloser`.

- [ ] **Step 2: Run them to see them fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run them to see them pass**

- [ ] **Step 5: Commit**

```bash
git add -A apps/quest
git commit -m "feat(quest): visitor flow, lock-on gate and tracking-jump watch"
```

---

### Task 6: Visitor mode on the headset

**Files:**
- Modify: `apps/quest/app/src/main/java/gg/vlm/spaces/MainActivity.kt` (wire `VisitorFlow`; remove the world-key connect, Place ahead, Turn and Align spike actions from the visitor path)
- Create: `visitor/HintCard.kt` (Compose panel), `visitor/VisitorMenu.kt` (Compose panel), `visitor/RingOutline.kt` (outline entity), `AppPrefs.kt`
- Modify: `AppState.kt`, `ControlPanel.kt` (becomes the debug-only "Developer" panel, shown only in debug builds from the menu), `SceneRenderer.kt` (`setVisible(on: Boolean)` and a 400 ms fade on images and video by animating their material alpha; models and sounds show and hide at the end of the fade)
- Modify: `res/values/ids.xml` (panel ids `hint_card`, `visitor_menu`)

**Interfaces:**
- `AppPrefs(context)`: `occlusion: Occlusion` (default `DEPTH`), `keepLoadedBetweenVisitors: Boolean` (default false; when true, `HeadsetOff` still hides the scene but the space stays loaded instead of returning to `Hint`; it's in the menu only after a builder enables it in plan 3), `recentSpaces: List<RecentSpace>` (Task 7).
- Hint card: a 0.5 × 0.3 m panel 1 m ahead, 0.15 m below eye level, re-centred when the head turns more than 35° away from it (lazy follow, eased over 300 ms). It shows a drawing of a ring (render `RingCodec.encode` of a fixed demo id as Compose `Canvas` arcs — not any real space's ring) and the state's text: `Hint` → the hint copy; `StepCloser` → "Step closer to the ring"; `Loading` → "Opening <spaceName>…"; `Locking` → "Hold still…"; `NotSetUp` → "This space isn't set up yet"; `Failed` → its message. Hidden in `Shown`.
- Outline: a thin cyan ring (torus or a ring of 48 short boxes, 4 mm thick, the marker's printed diameter) placed at the ring's world pose facing its heading, visible 1.2 s, then gone.
- Menu: opens with the left controller's menu button, and with a small "⋯" button panel that sits 0.35 m below the hint card's position when the scene is shown. (Wrist placement waits on the hand-input check in plan 3's Task 1; if that check finds wrist tracking usable, plan 3 moves the menu there.) Items: **Look at the ring again**; occlusion as three buttons **Hide behind walls** / **Live depth** / **Off** (wired to the existing `applyOcclusion()`); **Spaces** (Task 7); **Builder** (plan 3; until then it shows "Builder mode is coming soon").
- Headset off/on: `onPause` → `HeadsetOff`; `onResume` → `HeadsetOn`; plus `TrackingWatch` on every tick.
- Re-anchor: every new steady pose of any registered ring while shown sends `Steady` again; `PoseAverager`s are kept per ring id as the spike does.

- [ ] **Step 1: Build and install**

Run: `./gradlew :app:testDebugUnitTest :app:installDebug`
Expected: tests pass; app installs.

- [ ] **Step 2: Check on the headset with the owner (device check; record results in the ledger and `apps/quest/README.md`)**

Prepare a published test space with plan 1's dashboard (or a direct API call on a local/staging server — never the shared dev DB `vlm`): one floor, RING140, alignment set with a temporary admin call or by hand-entering a pose matching the room.
- Opening shows only the hint card.
- Far away (about 3 m), the hint changes to "Step closer to the ring".
- At about 1 m, "Hold still…", then the scene fades in with the outline flashing on the ring.
- Live depth hides the scene behind a hand and furniture.
- Taking the headset off and on hides the scene; looking at the ring shows it again.
- Menu → **Look at the ring again** clears it and returns to the hint.

- [ ] **Step 3: Commit**

```bash
git add -A apps/quest
git commit -m "feat(quest): visitor mode: hint card, step closer, lock-on, outline, fade, menu"
```

---

### Task 7: Links and the Spaces list

**Files:**
- Create: `apps/quest/app/src/main/java/gg/vlm/spaces/visitor/SpaceLinks.kt`, `visitor/SpacePage.kt` (Compose panel)
- Modify: `AndroidManifest.xml` (intent filter on `MainActivity`: `android:autoVerify="true"`, `VIEW`, `DEFAULT`, `BROWSABLE`, `https`, host `vlm.gg`, `pathPrefix="/s/"`), `MainActivity.kt` (`onNewIntent` and the launch intent), `AppPrefs.kt`
- Test: `apps/quest/app/src/test/java/gg/vlm/spaces/visitor/SpaceLinksTest.kt`

**Interfaces:**
- `fun spaceCodeFromUri(uri: String): String?` — accepts `https://vlm.gg/s/<code>` with or without a trailing slash or query, any case, hyphens allowed; returns the 7-character code normalised (I/L → 1, O → 0, upper case), or null. Mirrors plan 1's `parseRingCode` rules; add `RingCodec.parseCode(code): Long?` to `RingCodec.kt` for it.
- `data class RecentSpace(code: String, spaceName: String, openedAtMs: Long)`; `fun remember(list: List<RecentSpace>, item: RecentSpace, max: Int = 20): List<RecentSpace>` — newest first, de-duplicated by code.
- Space page (shown when a link opens the app, or a Spaces item is picked): the space's name, its `whereText`, "Look at the ring when you get there", and **Close**. Opening it sends `OpenSpace(code)` to the flow, so looking at that space's ring then shows the scene.
- **Spaces** in the menu lists `recentSpaces` (opened or visited), newest first.

- [ ] **Step 1: Write the failing tests**

- `spaceCodeFromUri("https://vlm.gg/s/2e3d-4c5/?ref=x")` → normalised code; `"https://example.com/s/ABCDEFG"` → null; `"https://vlm.gg/s/ABC"` → null.
- `remember` keeps newest first, drops a duplicate's older entry, caps at 20.
- `opening a link while another space is shown clears it` — in `VisitorFlowTest`: shown space A, `OpenSpace(codeB)` → `HideScene`, `StopFeed`, `Lookup(codeB)`.

- [ ] **Step 2: Run them to see them fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run tests; install; on the headset, open `https://vlm.gg/s/<code>` from the Quest browser**

Run: `./gradlew :app:testDebugUnitTest :app:installDebug`, then `adb shell am start -a android.intent.action.VIEW -d "https://vlm.gg/s/<code>"`
Expected: the app opens on the space page. (Verified links from the browser need plan 1's `assetlinks.json` with the release key's fingerprint, which comes in plan 3; until then use the `adb` intent.)

- [ ] **Step 5: Commit**

```bash
git add -A apps/quest
git commit -m "feat(quest): open spaces from vlm.gg/s links; recent spaces list"
```

---

### Task 8: Visit analytics

**Files:**
- Create: `apps/quest/app/src/main/java/gg/vlm/spaces/api/VisitAnalytics.kt`
- Modify: `MainActivity.kt` (report from the flow's state)
- Test: `apps/quest/app/src/test/java/gg/vlm/spaces/api/VisitAnalyticsTest.kt`

**Interfaces:**
- `class VisitAnalytics(post: suspend (spaceId: String, body: String) -> Boolean, clock: () -> Long)`:
  - `fun shown(spaceId: String)` → queues `enter` with a new random `playerId` per visit (UUID, never stored, never tied to the device);
  - `fun position(scenePos: Vec3)` → at most one `pos` per 5 s, in scene coordinates;
  - `fun hidden()` → `leave`;
  - `suspend fun flush()` → posts `{ v: 1, platform: "ar-quest", events: [...] }` to `POST /api/ar/spaces/:id/analytics`; failed posts keep up to 200 events and retry on the next flush. Flush every 10 s and on `leave`.

- [ ] **Step 1: Write the failing tests**

- `enter, two positions 6 s apart, leave` → one batch with `enter`, `pos`, `pos`, `leave` and `platform: "ar-quest"`.
- `positions within 5 s collapse to one`.
- `a failed post is retried, and the queue caps at 200`.
- `a new visit gets a new playerId`.

- [ ] **Step 2: Run them to see them fail**

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run them to see them pass; install and check a visit shows in the scene's analytics on the dashboard**

- [ ] **Step 5: Commit**

```bash
git add -A apps/quest
git commit -m "feat(quest): report anonymous visits as ar-quest analytics"
```

---

## Device checks owed before visitor mode ships (owner at the headset)

- **Range test** (from the ring marker plan): RING120 / RING140 / RING170 at 0.6, 1.2, 1.8 m and 0°, 30°, 45°; record found-at, distance error and heading error in `apps/quest/README.md`. Then set `VisitorTuning.MAX_LOCK_DISTANCE_M` and the spread limits from the results.
- **Measured accuracy:** position within 2 cm and heading within 1° at 1.8 m, by tape measure against a saved alignment.
