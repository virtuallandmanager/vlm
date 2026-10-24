# VLM Spaces for Meta Quest

The Quest app (`gg.vlm.spaces`), promoted from the spike that lived in `apps/quest-spike` (sibling of `apps/ar-spike`, iPhone and Vision Pro). It shows a VLM scene life-size in passthrough on a **Meta Quest 3 or 3S** and runs the marker detection-range test. Built with Meta's [Spatial SDK](https://developers.meta.com/horizon/documentation/spatial-sdk/spatial-sdk-explainer) (Kotlin, Android, no Unity).

What it does:

- Long-polls `GET {feedUrl}/api/hyperfy/feed` with a world key, like the Hyperfy app and the Apple spikes.
- **Images** are unlit, double-sided textured quads. **Videos** are video panels (ExoPlayer, muted, mp4 and HLS). **Models** load straight from their URL; only `.glb` works, anything else shows a pink box. **Sounds** aren't played yet.
- Puts the scene's centre, VLM (8, 0, 8), on the floor 2 m ahead of you with VLM north pointing away from you. The panel has **Place 2 m ahead**, **Turn ±15°** and **Align to the marker**.
- **Hide behind real things:** a panel switch. **Walls** draws the room scan's wall faces and ceiling (MRUK `AnchorProceduralMesh`) with the hole-punch material (`AlphaMode.HOLE_PUNCH`, `HOLE_PUNCH_SHADER`; `SceneMaterial.passthrough()` showed the room but didn't hide what was behind it), so they show the real room and hide anything virtual behind them. **Live depth** turns on Spatial SDK's environment depth occlusion (`EnvironmentDepthMode.OCCLUSION`), which also hides behind furniture and people; it's the default, and looked better on the headset. The choice is remembered. **Show scanned walls** tints the same surfaces, to check the room scan against the real walls.
- **Marker test:** VLM's ring markers (`../ring-marker`) are found in the left passthrough camera's frames (Camera2, 1280 × 960, Horizon OS v74+). The distance comes from the ring's size in the image, the position from that and the head pose, and the heading from the scanned wall the marker is on. The panel shows, per test marker, where tracking started ("found at"), where it stopped, the current distance, the position and the wall heading.

Code:

- `ScenePlan.kt` ports `packages/vlm-hyperfy-app/src/plan.ts` (via the Swift spike). `Mapping.kt` is the transform. Spatial SDK is left-handed, Y up, +Z forward, the same frame as Decentraland, so positions and scales carry over unchanged and rotations are Decentraland's Euler degrees in YXZ order. `MappingTest` checks that Spatial SDK's own `Quaternion` agrees.
- `FeedClient.kt`, `SceneRenderer.kt`, `MainActivity.kt`, `ControlPanel.kt` (Compose), `MarkerReadings.kt`.
- `ring/`: `RingCodec.kt` and `RingDetector.kt` port `../ring-marker/ringmarker/codec.py` and `detect.py`, and their tests run against that folder's vectors and synthetic test set. `RingTracker.kt` trusts an ID after 3 frames in a row. `PassthroughCamera.kt` is the camera. `RingPose.kt` turns a detection into a position and finds the wall heading.

Shortcuts and open questions:

- The world key is kept in plain `SharedPreferences`.
- **Model facing is unverified.** Decentraland shows a glTF x-mirrored; RealityKit and three.js needed a half turn about Y to match. Spatial SDK converts glTFs to its own frame, and its docs don't say how. The **Turn models half a turn** switch (on by default) flips between the two. Compare a model with an obvious front against the same scene in Decentraland and keep whichever matches.
- **Image facing is also unverified.** Images are double-sided, so they always show, but one side may read mirrored. Check text on an image from the front.
- **The lens pose** is read as Android defines it, relative to the head pose Spatial SDK reports. On a Quest 3 (2026-10-22) `LENS_POSE_REFERENCE` is `GYROSCOPE`, and the 1.0 m distance and Align checks passed with it as is.
- The camera's intrinsics are scaled from the sensor's pre-correction active array to the 1280 × 960 stream (centre crop, then scale, as in Meta's passthrough samples). On a Quest 3 the array is 1280 × 1280 and fx = fy = 866.9 px, so the stream is the middle 960 rows at unchanged scale. The synthetic test set (`ringmarker/testset.py`, `FOCAL_PX`) is rendered at fx = 867 px to match, and writes it to `manifest.json` as `focal_px`, which the Kotlin tests read.
- The room scan sometimes fails to load right after the headset wakes, while tracking recovers (`ERROR_UNKNOWN`, sometimes `ERROR_NO_ROOMS_FOUND`). The app retries it 5 times, 3 s apart, and again each time it comes back to the foreground without one.
- The marker's world position uses the head pose at the tick after the frame, not at the frame's capture time, so it lags while you move your head. Averaging over 15 frames smooths noise but not lag: stand still before pressing **Align to the marker**.
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
5. **Connect a scene.** Paste a world key into the panel (vlm.gg → **Deploy** → **Your Hyperfy worlds** → **Connect a world**) and press **Connect**. The status should read `Live · version xxxxxxxx · N items`. Typing a long key with the headset keyboard is slow, so you can also pass it once from the Mac (the app saves it):
   ```sh
   adb shell am start -n gg.vlm.spaces/.MainActivity --es worldKey 'vlmw_…'
   ```
6. Point the controller at the panel and pull the trigger to press buttons. Grab the panel to move it.

Logs: `adb logcat -s VLMSpaces`.

### Fixture feed (no world key)

`../ar-spike/tools/fake_feed.py` serves a small scene on the Mac at port 8787. Forward that port to the headset and point the app at it:

```sh
python3 ../ar-spike/tools/fake_feed.py <folder with Duck.glb and tex.png>
adb reverse tcp:8787 tcp:8787
adb shell am start -n gg.vlm.spaces/.MainActivity --es feedUrl http://127.0.0.1:8787 --es worldKey fixture
```

## Ring marker test

Print the test markers from `../ring-marker` (see its README: print at actual size, check the 100 mm bar, matte filament). There are three sizes: `RING120`, `RING140` and `RING170`. Only these IDs count, and only after 3 frames in a row agree.

What the panel shows, per marker:

- **found at / lost at:** the distance when tracking started and stopped. **Reset readings** clears them.
- **tracking at:** the current distance from the camera, from the ring's size in the image (`fx × radius / semi-major axis`).
- **at (x, y, z) m ±N cm over K:** the marker's world position, averaged over its last 15 camera frames, and the spread (the largest distance of one frame's position from that mean). It clears when the marker is lost.
- **wall faces …° / no wall:** the heading of the scanned wall within 10 cm of the marker, or "no wall".

**Align to the marker** needs the marker in view for at least 5 frames (otherwise it says "Hold still, gathering frames"). It puts the scene centre on the floor under the averaged position, with VLM north perpendicular to its wall, pointing into the wall. Without a wall it falls back to north pointing from you through the marker, and the panel says why.

Logs worth checking (`adb logcat -s VLMSpaces`): the camera's raw and scaled intrinsics, the lens pose and its reference, the room scan's wall count, and each alignment.

### Headset check

1. Tape `RING140` at 1.5 m on a wall.
2. Stand 1.0 m away, measured with a tape measure. The panel's distance should read 1.00 ± 0.02 m. If it's off by a constant factor, the lens pose or fx is wrong: check the logged values.
3. Press **Align to the marker**. The scene's north should be perpendicular to the wall within 1°. Check it against a floor tile line or a tape line on the floor.

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
