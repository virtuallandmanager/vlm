# VLM Spaces for Meta Quest

The Quest app (`gg.vlm.spaces`), promoted from the spike that lived in `apps/quest-spike` (sibling of `apps/ar-spike`, iPhone and Vision Pro). It shows a VLM space life-size in passthrough on a **Meta Quest 3 or 3S**, placed from the ring marker the visitor looks at. Debug builds also run the marker detection-range test. Built with Meta's [Spatial SDK](https://developers.meta.com/horizon/documentation/spatial-sdk/spatial-sdk-explainer) (Kotlin, Android, no Unity).

What it does:

- **Visitor mode.** A hint card (1 m ahead, a little below the eyes, following the head lazily) shows a drawing of a ring and says "Look for a ring like this, at eye level near the entrance." A ring seen but not readable turns it into "Step closer to the ring". A readable ring is looked up (`GET /api/ar/markers/by-code/:code`), the space's feed is long-polled (`GET /api/ar/spaces/:id/feed`), and once the ring is within 1.5 m and its averaged position and wall heading hold still, the scene fades in (400 ms) placed from the ring's saved pose, with a cyan outline flashing on the ring. Any other ring of the same space re-anchors it; a tracking jump hides it until a ring is seen again. Taking the headset off ends the visit (back to the hint card, nothing loaded). The code is in `visitor/`: `VisitorFlow` (the state machine), `VisitorController` (the glue to the headset), `HintCard`, `VisitorMenu`, `RingOutline`.
- **Menu:** the left controller's menu button at any time, or, while the scene is shown, the small "⋯" button below where the hint card was. **Look at the ring again**, occlusion (**Hide behind walls** / **Live depth** / **Off**), **Spaces** (not yet) and **Builder** ("Builder mode is coming soon"). Debug builds add **Developer**: the old control panel, with the feed status, occlusion and the marker readings.
- **Server:** always `https://vlm.gg` in release builds. Debug builds take a `baseUrl` intent extra and remember it.
- **Images** are unlit, double-sided textured quads. **Videos** are video panels (ExoPlayer, muted, mp4 and HLS). **Models** load straight from their URL; only `.glb` works, anything else shows a pink box. **Sounds** aren't played yet.
- **Hide behind real things:** a menu choice. **Walls** draws the room scan's wall faces and ceiling (MRUK `AnchorProceduralMesh`) with the hole-punch material (`AlphaMode.HOLE_PUNCH`, `HOLE_PUNCH_SHADER`; `SceneMaterial.passthrough()` showed the room but didn't hide what was behind it), so they show the real room and hide anything virtual behind them. **Live depth** turns on Spatial SDK's environment depth occlusion (`EnvironmentDepthMode.OCCLUSION`), which also hides behind furniture and people; it's the default, and looked better on the headset. The choice is remembered. **Show scanned walls** tints the same surfaces, to check the room scan against the real walls.
- **Marker test:** VLM's ring markers (`../ring-marker`) are found in the left passthrough camera's frames (Camera2, 1280 × 960, Horizon OS v74+). The distance comes from the ring's size in the image, the position from that and the head pose, and the heading from the scanned wall the marker is on. The panel shows, per test marker, where tracking started ("found at"), where it stopped, the current distance, the position and the wall heading.

Code:

- `ScenePlan.kt` ports `packages/vlm-hyperfy-app/src/plan.ts` (via the Swift spike). `Mapping.kt` is the transform. Spatial SDK is left-handed, Y up, +Z forward, the same frame as Decentraland, so positions and scales carry over unchanged and rotations are Decentraland's Euler degrees in YXZ order. `MappingTest` checks that Spatial SDK's own `Quaternion` agrees.
- `api/` (`ArApi`, `ArFeed`), `space/SpaceAlignment.kt` (scene root from a ring's saved pose), `SceneRenderer.kt`, `MainActivity.kt` (lifecycle, camera, room scan, panels), `AppPrefs.kt`, `ControlPanel.kt` (the Developer panel), `MarkerReadings.kt`.
- `ring/`: `RingCodec.kt` and `RingDetector.kt` port `../ring-marker/ringmarker/codec.py` and `detect.py`, and their tests run against that folder's vectors and synthetic test set. `RingTracker.kt` trusts an ID after 3 frames in a row. `PassthroughCamera.kt` is the camera. `RingPose.kt` turns a detection into a position and finds the wall heading.

Shortcuts and open questions:

- **Model facing is unverified.** Decentraland shows a glTF x-mirrored; RealityKit and three.js needed a half turn about Y to match. Spatial SDK converts glTFs to its own frame, and its docs don't say how. The **Turn models half a turn** switch (on by default) flips between the two. Compare a model with an obvious front against the same scene in Decentraland and keep whichever matches.
- **Image facing is also unverified.** Images are double-sided, so they always show, but one side may read mirrored. Check text on an image from the front.
- **The lens pose** is read as Android defines it, relative to the head pose Spatial SDK reports. On a Quest 3 (2026-10-22) `LENS_POSE_REFERENCE` is `GYROSCOPE`, and the 1.0 m distance and Align checks passed with it as is.
- The camera's intrinsics are scaled from the sensor's pre-correction active array to the 1280 × 960 stream (centre crop, then scale, as in Meta's passthrough samples). On a Quest 3 the array is 1280 × 1280 and fx = fy = 866.9 px, so the stream is the middle 960 rows at unchanged scale. The synthetic test set (`ringmarker/testset.py`, `FOCAL_PX`) is rendered at fx = 867 px to match, and writes it to `manifest.json` as `focal_px`, which the Kotlin tests read.
- The room scan sometimes fails to load right after the headset wakes, while tracking recovers (`ERROR_UNKNOWN`, sometimes `ERROR_NO_ROOMS_FOUND`). The app retries it 5 times, 3 s apart, and again each time it comes back to the foreground without one.
- The marker's world position uses the head pose at the tick after the frame, not at the frame's capture time, so it lags while you move your head. Averaging over 15 frames smooths noise but not lag, which is why the scene waits for the ring to hold still.
- Clicks, sounds and analytics aren't implemented.

## Build

Needs JDK 17 and the Android SDK (API 34). On this Mac they're installed with Homebrew:

```sh
brew install openjdk@17
brew install --cask android-commandlinetools android-platform-tools
sdkmanager --sdk_root=$HOME/Library/Android/sdk "platforms;android-34" "build-tools;34.0.0"
```

Then:

```sh
cd apps/quest
export JAVA_HOME=/opt/homebrew/opt/openjdk@17 ANDROID_HOME=$HOME/Library/Android/sdk
echo "sdk.dir=$ANDROID_HOME" > local.properties   # once
./gradlew :app:testDebugUnitTest    # unit tests (no headset needed)
./gradlew :app:assembleDebug        # app/build/outputs/apk/debug/app-debug.apk
```

## Run it on your Quest

1. **Developer mode (once).** Developer mode needs a Meta developer account, which is free:
   1. Sign up at [developers.meta.com/horizon](https://developers.meta.com/horizon/) and create an organisation. Any name works.
   2. On your phone, open the **Meta Horizon** app, then **Devices** → your headset → **Headset settings** → **Developer mode**, and turn it on.
   3. Restart the headset.
2. **Connect.** Plug the headset into the Mac with a USB-C cable that carries data. In the headset, accept **Allow USB debugging** and tick "Always allow". Then run `adb devices`: the headset should be listed as `device`.
3. **Install and start:**
   ```sh
   adb install -r app/build/outputs/apk/debug/app-debug.apk
   adb shell am start -n gg.vlm.spaces/.MainActivity
   ```
   The app is also listed in the headset's library under **Unknown sources**, as "VLM Spaces". If the old spike (`gg.vlm.spaces.quest`) is still installed, remove it with `adb uninstall gg.vlm.spaces.quest`.
4. On first launch, allow the **camera** (marker detection) and **spatial data** (the room's walls, for heading). Heading also needs a room scan: if the panel says "No room scan", set up your space in the Quest settings (**Physical space** → **Space setup**) and restart the app.
5. **Look at a ring** of a published, aligned space. A debug build can point at another server (saved for next launches; pass `https://vlm.gg` to go back):
   ```sh
   adb shell am start -n gg.vlm.spaces/.MainActivity --es baseUrl http://192.168.1.20:3000
   ```
6. Point the controller at a panel and pull the trigger to press buttons. The Developer panel can be grabbed and moved.

Logs: `adb logcat -s VLMSpaces`.

## Ring marker test

Print the test markers from `../ring-marker` (see its README: print at actual size, check the 100 mm bar, matte filament). There are three sizes: `RING120`, `RING140` and `RING170`. Only these IDs count, and only after 3 frames in a row agree.

In a debug build, the Developer panel (menu → **Developer**) shows, per marker:

- **found at / lost at:** the distance when tracking started and stopped. **Reset readings** clears them.
- **tracking at:** the current distance from the camera, from the ring's size in the image (`fx × radius / semi-major axis`).
- **at (x, y, z) m ±N cm over K:** the marker's world position, averaged over its last 15 camera frames, and the spread (the largest distance of one frame's position from that mean). It clears when the marker is lost.
- **wall faces …° / no wall:** the heading of the scanned wall within 10 cm of the marker, or "no wall".

Logs worth checking (`adb logcat -s VLMSpaces`): the camera's raw and scaled intrinsics, the lens pose and its reference, the room scan's wall count, tracking jumps.

### Headset check

1. Tape `RING140` at 1.5 m on a wall.
2. Stand 1.0 m away, measured with a tape measure. The panel's distance should read 1.00 ± 0.02 m. If it's off by a constant factor, the lens pose or fx is wrong: check the logged values.
3. The panel's wall heading should be perpendicular to the wall within 1°. Check it against a floor tile line or a tape line on the floor.

### Range test

For each size, walk back from the marker head-on, at 30° and at 45° off its face. Record "found at" (walking in) and "lost at" (walking out). The targets are found from 0.6–1.8 m, up to 45° off the face, with heading within 1° and position within 2 cm at 1.8 m.

The table is filled in from the range test on the headset; it hasn't been run yet.

| Marker | Angle | Found at | Lost at |
|---|---|---|---|
| `RING120` (120 mm) | 0° | — | — |
| `RING120` (120 mm) | 30° | — | — |
| `RING120` (120 mm) | 45° | — | — |
| `RING140` (140 mm) | 0° | — | — |
| `RING140` (140 mm) | 30° | — | — |
| `RING140` (140 mm) | 45° | — | — |
| `RING170` (170 mm) | 0° | — | — |
| `RING170` (170 mm) | 30° | — | — |
| `RING170` (170 mm) | 45° | — | — |

Headset check on a Quest 3, 2026-10-22: `RING140` (paper) was tracked within seconds; the distance at 1.0 m and the heading after **Align to the marker** looked right by eye (not yet measured to ±2 cm and 1°). **Walls** and **Live depth** both hid scene content behind real surfaces.

## Owner checks (visitor mode)

Not yet run (no headset was connected when visitor mode was built). Record the results here and in the plan's ledger.

Prepare a published test space with plan 1's dashboard, or with a direct API call on a local or staging server (never the shared dev database `vlm`): one floor, `RING140`, and an alignment set with a temporary admin call or by hand-entering a pose that matches the room. Tape `RING140` at eye level on a scanned wall. For a local server, start the app with `--es baseUrl http://<mac's address>:<port>` (debug build).

- [ ] Opening the app shows only the hint card.
- [ ] Far away (about 3 m), the hint changes to "Step closer to the ring". (The unreadable band is narrow, so it may read the ring instead: then "Opening …" and "Step closer to the ring" while it's beyond 1.5 m.)
- [ ] At about 1 m, "Hold still…", then the scene fades in with the outline flashing on the ring.
- [ ] Live depth hides the scene behind a hand and furniture.
- [ ] Taking the headset off and on hides the scene; looking at the ring shows it again.
- [ ] Menu → **Look at the ring again** clears it and returns to the hint.
- [ ] Open a space from a link. A verified link from the browser needs plan 3's `assetlinks.json` with the release key's fingerprint, so until then use the intent: `adb shell am start -a android.intent.action.VIEW -d "https://vlm.gg/s/<code>"`. The app opens on the space page: the space's name, where to find it, "Look at the ring when you get there" and **Close**. Looking at that space's ring then shows the scene. Sent while the app is already open, it replaces the current space.
- [ ] Menu → **Spaces** lists the spaces opened or visited, newest first; picking one opens its page.

Also worth noting while there:

- Whether the left controller's menu button opens the menu (Horizon OS may keep it for itself; the "⋯" button works while the scene is shown).
- Whether images and videos visibly fade, or snap (the fade sets material alpha at runtime; if the unlit shader ignores it they snap at the end of the fade).
- Whether opening the Quest's system menu pauses the app (it would end the visit, as taking the headset off does). If it does, the headset-off trigger moves from `onPause` to an XR session state or the proximity sensor.
- A ring on a wall the room scan missed never locks ("Hold still…" stays): heading comes from the wall.
