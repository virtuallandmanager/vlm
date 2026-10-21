# VLM Spaces (AR spike)

A throwaway spike for checking how VLM scenes load and look in AR, life-size. It has two apps that share one Swift source folder:

- **VLMSpaces-iOS** (iOS 18+): an ARKit/RealityKit `ARView` with horizontal plane detection. Tap the floor and the scene's centre, VLM (8, 0, 8), lands on that spot, with VLM north pointing away from you. The **Tabletop 1:20** toggle shrinks the scene.
- **VLMSpaces-visionOS** (visionOS 2+): a settings window and an **Enter space** button. The button opens a mixed `ImmersiveSpace` that puts the scene life-size on the floor, with its centre 2 m in front of you.

Both apps long-poll `GET {feedUrl}/api/hyperfy/feed` with a world key, the same way the Hyperfy app does. Then they build RealityKit entities:

- Images become unlit, double-sided textured planes.
- Videos become `VideoMaterial` planes, looped and muted unless **Sound** is on.
- Models (.glb/.gltf) are loaded with GLTFKit2. A model that fails to load shows a pink placeholder box labelled with its file name.
- Sounds play as spatial audio, only when **Sound** is on.

The code is organised like this:

- `Shared/ScenePlan.swift` is a port of `packages/vlm-hyperfy-app/src/plan.ts`.
- `Shared/Mapping.swift` is a port of `src/transform.ts`. It handles the left-handed to right-handed axes, YXZ Euler order and `MODEL_TURN`.
- `Tests/` holds the transform test cases ported from `test/transform.test.ts`, plus two plan tests.

Spike shortcuts:

- The world key is stored in `UserDefaults`. Production would keep it in the Keychain.
- Clicks and analytics aren't implemented.
- A `.gltf` that points to external buffers or textures won't load, because only the main file is downloaded.

## Build (simulators)

```sh
brew install xcodegen          # once
cd apps/ar-spike
xcodegen generate              # creates VLMSpaces.xcodeproj (git-ignored)
xcodebuild -project VLMSpaces.xcodeproj -scheme VLMSpaces-iOS -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
xcodebuild -project VLMSpaces.xcodeproj -scheme VLMSpaces-visionOS -destination 'generic/platform=visionOS Simulator' CODE_SIGNING_ALLOWED=NO build
# unit tests (any iOS 18+ simulator)
xcodebuild -project VLMSpaces.xcodeproj -scheme VLMSpaces-iOS -destination 'platform=iOS Simulator,name=<an iOS 18+ iPhone>' CODE_SIGNING_ALLOWED=NO test
```

The iOS simulator has no ARKit, so the iOS app only shows its UI there. AR needs a real iPhone.

### Fixture feed (no world key needed)

`tools/fake_feed.py` serves a small scene with two images, the Khronos Duck GLB and one model that is deliberately missing, on `http://127.0.0.1:8787`. To use it, put `Duck.glb` and a `tex.png` in a folder, then run `python3 tools/fake_feed.py <that folder>`. Then launch the visionOS app with launch arguments. They override the settings for that run only:

```sh
xcrun simctl launch <vision-sim-id> gg.vlm.spaces.visionos -feedUrl http://127.0.0.1:8787 -worldKey fixture -autoEnterSpace YES
```

See `docs/visionos-immersive-fixture.png` for the result.

## Placing the scene (Vision Pro)

The window's top row has a mode picker (**View**, **Place scene**, **Edit objects**) and **Enter/Leave space**. In **View** mode, gestures are off.

In the space, a translucent 0.6 m disc marks the scene's centre, VLM (8, 0, 8), on the floor. Its arrow and **N** point to the scene's north, VLM +Z. A thin outline shows the 16 m × 16 m parcel; the parcel's south-west corner is VLM's origin.

- **Place scene:** pinch and drag the marker or the outline to slide the whole scene along the floor. Pinch the marker with both hands and twist to turn the scene about its centre.
- **Pin to this room:** adds an ARKit `WorldAnchor` at the scene's current spot and saves its id in `UserDefaults`. On the next launch, the scene moves back to that spot once visionOS finds the anchor. If you move a pinned scene, the pin moves with it.
- **Re-place:** clears the pin and puts the scene 2 m ahead of you again, with north pointing away from you.
- Pinning needs a device. In the simulator the buttons do nothing and the status reads "Pinning needs a device".

## Editing objects (Vision Pro)

In **Edit objects** mode, pinch an image, video or model to select it. The selected object gets a cyan box around it, and the window shows its name and a **Reset object** button.

- Drag to move it in 3D.
- Pinch with both hands and twist to turn it about the vertical axis.
- Pinch with both hands and spread or close them to resize it, from 0.1× to 10× its VLM size.

Edits stay on the headset and aren't saved to VLM. When the feed changes an object, the feed's version replaces the local edit, so live edits from VLM still show. Changing **Sound** and tapping **Connect** rebuilds every object, which drops all local edits.

See `docs/visionos-controls.png` for the window in the simulator.

## Run on your Apple Vision Pro (or iPhone)

1. Run `cd apps/ar-spike && xcodegen generate`, then open `VLMSpaces.xcodeproj` in Xcode 26.
2. For **both** targets (`VLMSpaces-iOS` and `VLMSpaces-visionOS`), go to the **Signing & Capabilities** tab. Keep **Automatically manage signing** on and pick your **Team**. The bundle ids are `gg.vlm.spaces.ios` and `gg.vlm.spaces.visionos`. If Xcode says an id is taken, change the prefix (for example `com.yourname.spaces.visionos`).
   - Picking the team in Xcode is lost the next time you run `xcodegen generate`. To keep it, set `DEVELOPMENT_TEAM` in `project.yml`.
3. Pair the Vision Pro:
   1. On the headset, open **Settings → General → Remote Devices**.
   2. On the Mac, open Xcode → **Window → Devices and Simulators**, select the Vision Pro and click **Pair**, then enter the code shown in the headset.
   3. The Mac and the headset must be on the same Wi-Fi network.
   4. If Xcode asks, turn on **Developer Mode** on the headset (**Settings → Privacy & Security → Developer Mode**) and restart it.
4. In Xcode's toolbar, choose the **VLMSpaces-visionOS** scheme and pick your Vision Pro as the run destination. Press **Run** (⌘R). The first install can take a few minutes while Xcode prepares the device.
   - For an iPhone, plug it in, choose **VLMSpaces-iOS**, pick the phone and run. On first launch, allow camera access.
5. In the app's settings, paste a world key. To get one, open vlm.gg → **Deploy** → **Your Hyperfy worlds** → **Connect a world** and copy the `vlmw_…` key. Tap **Connect**. The status line should read `Live · version xxxxxxxx · N items`.
6. **Vision Pro:** tap **Enter space**. The scene appears life-size with its centre 2 m ahead of you on the floor, north pointing away from you. Use **Place scene** to move it and **Pin to this room** to keep it there. **iPhone:** move the phone around until the floor is detected, then tap it.
