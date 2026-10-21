# VLM Spaces for Meta Quest (spike)

A throwaway spike, the Quest sibling of `apps/ar-spike` (iPhone and Vision Pro). It shows a VLM scene life-size in passthrough on a **Meta Quest 3 or 3S** and runs the marker detection-range test. Built with Meta's [Spatial SDK](https://developers.meta.com/horizon/documentation/spatial-sdk/spatial-sdk-explainer) (Kotlin, Android, no Unity).

What it does:

- Long-polls `GET {feedUrl}/api/hyperfy/feed` with a world key, like the Hyperfy app and the Apple spikes.
- **Images** are unlit, double-sided textured quads. **Videos** are video panels (ExoPlayer, muted, mp4 and HLS). **Models** load straight from their URL; only `.glb` works, anything else shows a pink box. **Sounds** aren't played yet.
- Puts the scene's centre, VLM (8, 0, 8), on the floor 2 m ahead of you with VLM north pointing away from you. The panel has **Place 2 m ahead**, **Turn ±15°** and **Align to the marker**.
- **Marker test:** Horizon OS tracks QR codes itself (MRUK trackables, Horizon OS v78+). The panel shows, per test marker, where tracking started ("found at"), where it stopped, and the QR size the headset measured, with a warning when it's more than 3% off the print.

Code:

- `ScenePlan.kt` ports `packages/vlm-hyperfy-app/src/plan.ts` (via the Swift spike). `Mapping.kt` is the transform. Spatial SDK is left-handed, Y up, +Z forward, the same frame as Decentraland, so positions and scales carry over unchanged and rotations are Decentraland's Euler degrees in YXZ order. `MappingTest` checks that Spatial SDK's own `Quaternion` agrees.
- `FeedClient.kt`, `SceneRenderer.kt`, `MainActivity.kt`, `ControlPanel.kt` (Compose), `MarkerReadings.kt`.

Spike shortcuts and open questions:

- The world key is kept in plain `SharedPreferences`.
- **Model facing is unverified.** Decentraland shows a glTF x-mirrored; RealityKit and three.js needed a half turn about Y to match. Spatial SDK converts glTFs to its own frame, and its docs don't say how. The **Turn models half a turn** switch (on by default) flips between the two. Compare a model with an obvious front against the same scene in Decentraland and keep whichever matches.
- **Image facing is also unverified.** Images are double-sided, so they always show, but one side may read mirrored. Check text on an image from the front.
- The QR tracking pose's axes aren't documented. **Align to the marker** doesn't rely on them: it puts the centre under the marker and points north through the marker, away from you.
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
cd apps/quest-spike
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
   adb shell am start -n gg.vlm.spaces.quest/.MainActivity
   ```
   The app is also listed in the headset's library under **Unknown sources**.
4. On first launch, allow **spatial data**: QR tracking needs it.
5. **Connect a scene.** Paste a world key into the panel (vlm.gg → **Deploy** → **Your Hyperfy worlds** → **Connect a world**) and press **Connect**. The status should read `Live · version xxxxxxxx · N items`. Typing a long key with the headset keyboard is slow, so you can also pass it once from the Mac; the app saves it:
   ```sh
   adb shell am start -n gg.vlm.spaces.quest/.MainActivity --es worldKey 'vlmw_…'
   ```
6. Point the controller at the panel and pull the trigger to press buttons. Grab the panel to move it.

Logs: `adb logcat -s VLMSpaces`.

### Fixture feed (no world key)

`../ar-spike/tools/fake_feed.py` serves a small scene on the Mac at port 8787. Forward that port to the headset and point the app at it:

```sh
python3 ../ar-spike/tools/fake_feed.py <folder with Duck.glb and tex.png>
adb reverse tcp:8787 tcp:8787
adb shell am start -n gg.vlm.spaces.quest/.MainActivity --es feedUrl http://127.0.0.1:8787 --es worldKey fixture
```

## Marker detection-range test

Use the same printed markers as the Apple spikes (`../ar-spike/markers/`, see that README). Quest tracks the QR code inside the marker, which is 25 of the marker's 33 modules across: 91 mm on `TEST12` and 129 mm on `TEST17`.

- Mount the marker at about 1.5 m, in good light. Walk back until it's lost, then walk toward it until it's found again. **"Found at"** is the number that matters. **Reset readings** clears them.
- Meta's notes: QR tracking works best close up and in good light, updates slowly, and doesn't read codes with logos. Our codes are plain version 2, so they're fine.
- **Align to the marker** then drops the scene where the marker is, as a rough preview of marker alignment.
