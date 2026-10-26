# Room Scan to 3D Set: Design

Date: 2026-10-26
Status: draft, awaiting owner approval

## Intent

People scan the room they actually hang out in, or several connected rooms, with the Virvi AR app. Virvi turns the scan into a 3D set in Decentraland and Hyperfy:
- partition walls that follow the real room;
- the floor, and doors and windows where the real ones are;
- an outside look they choose, such as a house, a storefront or anything else.

**Why:** the owner's longer-term goal is a live mirror. You walk around your real room wearing the headset, and your avatar walks the same path through the same room in-world. That **live position sync is a later project** and is not part of this design. But this design must keep everything it will need: exact real-world scale, and the scan saved with the scene.

## Goals

1. **Scan in the Virvi AR app,** on Quest first and iPhone/iPad second:
   - **Quest:** Meta's room setup, read through MRUK. The app already loads it today for occlusion and wall snapping (`apps/quest/.../MainActivity.kt`, `mruk.loadSceneFromDevice`).
   - **iPhone/iPad:** Apple RoomPlan on LiDAR devices.
2. **Connected rooms:** a scan can hold several rooms that become one set.
3. **The set:**
   - partition walls following the scan, with openings for doors and windows;
   - a floor;
   - an exterior style;
   - plain interior finishes that can be recoloured;
   - optional grey placeholder blocks for scanned furniture.
4. **Two ways in:**
   - the New Scene Wizard's **"Start from a room scan"**;
   - the asset library's **"Make an asset from a room scan"**, which turns the set into one model you can place in any scene, more than once.
5. **Change it later:** change the exterior style and the finishes, or nudge a room in Studio to line up a doorway, all without rescanning.
6. **Deploys like any other Virvi scene,** to Decentraland and Hyperfy, inside their size and triangle limits.

## Non-goals

- **Live avatar or headset position sync.** That's later. The owner expects it to need our own client talking to the server, or the explorer's API.
- **Photoreal capture.** This is layout only: no photos, textures from the room, Gaussian splats or photogrammetry.
- **Vision Pro capture in v1.** The owner named it in the original idea, but v1 is Quest plus iPhone/iPad. Vision Pro is a follow-up. **My call.**
- **Free-form wall editing in Studio.** The walls come from the scan. Only whole-room moves and rotations are editable (Goal 5).

## Anti-goals

- **A set that isn't the real size.** Every dimension stays 1:1 in metres, because the later sync depends on it.
- **A generated scene that silently exceeds Decentraland's parcel or triangle limits,** or one that deploys broken.
- **Treating scans as anything but private.** A scan is the layout of someone's home. It is visible only to its owner (and their org, if they choose), never public by default. It stores no photos or images of the room.

## How it works

### 1. Capture (Virvi AR app)

**A "Scan this room" action** sits in the app's builder area, for a paired device.

**Quest:**
- Uses the rooms already set up in Meta's Space Setup. If there are none, the app starts the system's room setup.
- Reads every room MRUK returns, in its shared tracking space, so rooms the person has scanned keep their relative positions:
  - the floor outline;
  - the ceiling height;
  - wall faces;
  - door and window frames (MRUK labels them);
  - furniture volumes with their labels (table, couch, bed and so on).

**iPhone/iPad:**
- Uses RoomPlan on LiDAR devices (iOS 17+ for multi-room).
- Several captured rooms are merged with RoomPlan's multi-room support into one structure, in a shared space.
- Takes walls, doors, windows, openings and furniture objects with their categories.
- The iOS app today is only the `apps/ar-spike` prototype. It needs pairing and upload added; see "Left to the builder".

**After scanning:**
- The app shows a quick preview: an outline of the rooms with a name field, which defaults to "My room" or "My home" when there are several rooms.
- It uploads the scan to the person's account through the existing paired-device auth (`ar_devices` / AR pass).

### 2. The saved scan (server)

A new **room scan** record:
- owner and optional org;
- name;
- source (`quest-mruk` or `ios-roomplan`) and capture time;
- a versioned JSON layout.

**The layout is device-neutral:**
- **Units and frame:** metres, Y up, one shared frame for all rooms.
- **Per room:**
  - a label;
  - the floor outline, as a polygon in x/z;
  - the floor height and ceiling height;
  - the wall segments, with each wall's openings: door, window or open gap, with offset along the wall, width, sill height and height;
  - the furniture boxes, with label, centre, size and yaw.
- **Anchoring for the later sync:** each room keeps what's needed to find the real room again without rescanning:
  - its device identity: the MRUK room and floor-anchor UUIDs on Quest, or the RoomPlan room identifier;
  - the floor anchor's pose in the shared frame.

  Every set also records the offset the generator applied when it centred the rooms on the plot. **My call.**

**Rules:**
- The raw device output isn't kept, only this layout. **My call:** smaller and private, and the layout keeps everything the set and the later sync need.
- Nobody but the owner can read a scan (and their org, if shared). Deleting the scan deletes nothing it has already been turned into.
- **A scan never changes after upload.** A rescan creates a new scan, and existing sets keep pointing at the scan they were made from. **My call.**
- **Only personal headsets can scan.** "Scan this room" is hidden on headsets paired as `shared`, because those upload to the approver's account, often a venue's, not the account of the person in the room. Upload goes to the account that approved the personal headset. **My call.**

### 3. Sets are separate from scans

A **room set** is one use of a scan: in a scene, or as a library asset.
- Each set has its own options (style, finishes, ceiling, furniture blocks) and its own per-room nudges (position and yaw). Changing one set never changes another.
- A library asset made from a scan is a snapshot. Placing it in a scene copies it into that scene's set, so changing the library asset later doesn't touch scenes already using it, and deployed scenes never change by surprise. **My call.**

**Privacy:**
- Generated room-set assets are private: `is_public = false` with `uploaded_by` set. They're never shown in the public catalog. The asset library already has both fields.
- The first time a room set is deployed, the deploy step says once, in plain words, that the room's layout will be visible to anyone visiting that World or Hyperfy world. **My call.**

### 4. Generating the set (server)

A generator turns a layout plus options into one GLB.

**Options:**
- **Exterior style:** House, Storefront, Plain or Dollhouse.
  - **House:** siding or brick outer walls, a pitched roof, and the front door at a real door.
  - **Storefront:** one glass outer wall, an awning, and a sign with the scene's name.
  - **Plain:** painted walls and a flat roof.
  - **Dollhouse:** no roof and low outer walls, so visitors can look in from above.

  The style list is a small library the builder makes so more styles are easy to add later.
- **Interior finishes:** a wall colour and a floor colour.
- **Ceiling:** on or off. **Off by default.** Decentraland's third-person camera fights a real 2.4 m ceiling. **My call.**
- **Furniture blocks:** on or off, off by default.

**Geometry:**
- Walls are extruded at a standard thickness (12 cm, **my call**), with door and window openings cut through.
- Walls that two connected rooms share are merged into one partition. That means walls within a few centimetres of each other, parallel and overlapping.
- The outer faces get the exterior style, and the inner faces get the interior finish.

**Output:**
- Real scale.
- The room is centred on the smallest Decentraland plot that holds it with a small margin. A typical room fits 1×1, and an apartment may need 2×2.
- The triangle count is checked against the plot's budget before saving.
- The GLB is stored like other assets, in R2.

### 5. Ways in

- **New Scene Wizard,** a "Start from a room scan" choice:
  - Shown when the person has at least one scan. When they have none, it explains that it needs the Virvi AR app on Quest or a LiDAR iPhone/iPad.
  - They pick a scan, a style and finishes. The plot is set to fit the scan.
  - The rest of the wizard works as today: add assets, arrange, deploy.
- **Asset library,** "Make an asset from a room scan":
  - Pick a scan, a style and finishes.
  - It creates a library asset, the set as one model, placeable in any scene.
  - Changing its options regenerates the library asset only, not scenes already using it.

### 6. Editing later (Virvi Studio)

- A room set in a scene keeps a link to its scan and its own options.
- Changing the style or finishes regenerates that scene's GLB only. A deployed World shows it after the next redeploy.
- **"Adjust rooms"** lets you move or rotate one room of a multi-room scan, to fix the slight misalignment separate captures can have. Doors snap together when two openings line up within a small distance. The nudge is stored on that set, never on the scan.
- Furniture blocks can be swapped for catalog models with the normal asset tools. Swapped items become ordinary scene items.

## Constraints

- **Decentraland:**
  - The scene must stay inside its parcels, including the walls' thickness.
  - The GLB must stay within the plot's triangle budget, the same budget the wizard uses.
  - Collisions on walls and floor, so avatars can't walk through.
- **Hyperfy:** the same GLB, through the existing Hyperfy path.
- **Scale:** always 1:1. No auto-scaling to fit a plot. A bigger home means a bigger plot.
- **Quest:** Meta Spatial SDK with MRUK, as the app already uses.
- **iOS:** RoomPlan needs LiDAR and iOS 16+, and iOS 17+ for multi-room. Devices without LiDAR see a clear "needs a LiDAR iPhone or iPad" message.

## Left to the builder

- The exact JSON layout schema, and how each device's output maps into it.
- The look and geometry of each exterior style: roof pitch, materials, sign placement. Keep them simple and low-poly, since Decentraland budgets are tight.
- The wall-merge and door-snap thresholds.
- Building the iOS app's pairing and upload: reuse the Quest's pairing flow and server routes. Which stays as the `ar-spike` project and which moves into a real iOS app target is the builder's call, kept inside the Virvi AR naming.
- How the wizard's existing steps (Size, Assets, Arrange) treat a scan-based start. The plot size is fixed by the scan, so the Size step becomes informational.
