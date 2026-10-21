# AR Spaces: design

Status: approved by the owner, 2026-10-21. The builder check's answers are folded in below (marked "Claude's call" where they are mine).

## Intent

A VLM scene can be pinned to a real place: a club, a gallery, a shop. People there walk through it life-size, with an iPhone or an Apple Vision Pro. It stays in sync with Decentraland, Hyperfy and the dashboard.

The owner sets the space up on site. They mount a 3D-printed **registration marker** by the entrance, at eye level, line the scene up with the real room once, and publish it. A visitor opens the VLM app, looks at the marker, and the scene loads and snaps into place.

**Why:** AR spaces could be VLM's front door. Someone sees a virtual installation at a real venue on their phone, then visits the same scene in Decentraland or Hyperfy from home. Phones put it in front of far more people than headsets.

## Goals

- **Look at a marker and the space appears**, lined up with the real room, within a few seconds of the marker coming into view.
- **Works on iPhone and Apple Vision Pro.**
- **One marker per floor.** Seeing any of a space's markers re-anchors the scene. That covers elevators, which break headset tracking, and long walks where tracking drifts.
- **Live content.** Edits from the dashboard, the Decentraland HUD or the Hyperfy HUD appear in the AR space within about a second, through the same scene feed Hyperfy uses.
- **Printable markers.** A parametric generator in the dashboard produces print files for any home 3D printer.
- **No app needed to discover a space.** A marker's code is a normal QR code linking to `vlm.gg/s/<code>`. Any phone camera opens it: in the app if installed, otherwise on a web page that explains the space and links to the App Store.

## Non-goals (for now)

- **Outdoor, GPS-only spaces** such as street corners using Google's geospatial positioning. Indoor, marker-based spaces come first. Outdoor is a later addition.
- **Editing from the AR apps.** The spike's local moving and resizing stays a preview. Saving AR edits to VLM comes after the Hyperfy HUD's pairing-based sign-in exists, and reuses it.
- **Seeing other platforms' visitors as avatars, and being seen by them.** Later, as its own project (the owner wants it eventually). The AR visitor would join the scene's Decentraland comms room and the Hyperfy world as a client, publishing their position from the AR alignment, and the apps would draw the other visitors where they stand. Nothing in this design should block it: the alignment already gives the device's pose in scene coordinates.
- **VLM printing and shipping markers.** The dashboard has a placeholder "Order a printed marker" for later; the first version is download-only.
- **Android and Quest.** Later. The marker and data model are platform-neutral, so they won't need redesigning.

## Anti-goals

- **A space that lines up differently for each visitor.** The marker is the shared reference point, and alignment is the owner's single source of truth.
- **Markers that don't print well on an ordinary printer.**
- **Asking for camera or location access the app doesn't need.**

## Decided with the owner

- **Placement:** markers go at about eye level (1.5 m) on a wall or door frame just inside the entrance. There is one per floor; more may follow after testing.
- **Platforms:** iPhone and Apple Vision Pro first.
- **Where markers are made:** in the dashboard, next to setting up an AR space. Shipping printed markers comes later.
- **The code:** a normal QR code to `vlm.gg/s/<code>`, so plain phone cameras work too.
- **Vision Pro limits:**
  - The apps can't read raw camera images; Apple keeps main camera access for enterprise apps only.
  - The headset finds markers through image tracking, against a shortlist of marker patterns the app gives it.

## Design calls by Claude (for review)

### The marker

- **Shape (Claude's call on the layout):** a plaque 150 mm wide and 4 mm thick. From the centre out:
  - the QR code;
  - a quiet zone of 2 modules;
  - the border ring;
  - a 2 mm raised rim.

  The **tracked image** is the border ring's outer square, 120 mm by default. That width is the "printed size" stored with the marker, drawn by the app renderer and passed to image tracking; all three must use the same number. The optional text strip goes below and makes the plaque taller (about 175 mm). Every dimension stays within 180 mm, so it fits 180 × 180 mm beds (Bambu A1 mini, Prusa MINI).
- **Sizes:** 120 mm by default, with a larger 170 mm option, because how far away a Vision Pro can spot a marker is the design's biggest unknown (see Risks).
- **The code:** a QR code (version 2 or 3, error correction M) in the centre, encoding `HTTPS://VLM.GG/S/<CODE>` in uppercase so it fits QR's compact alphanumeric mode with bigger modules. Codes are uppercase, and the `/s/` route ignores case. Modules come out around 3.5 mm. Expect an iPhone to read it from about 1 to 1.5 m; image tracking then keeps hold from further away.
- **The tracking pattern:** a border ring of black-and-white blocks around the QR code, derived from the marker's code by a hash. A QR code on its own is repetitive, which makes tracking jittery; the unique border gives Apple's image tracking distinct features. The QR code plus the border together form the reference image both apps track.
- **Contrast:**
  - The base prints in a light colour and the code and border are raised 0.6 mm in a dark colour.
  - **Single-colour printers:** the base and the code pieces are separate STLs sharing one origin, so they load as one object. The note says to pause or change colour at a height in millimetres (4.0 mm), not a layer number. It also recommends matte filament, since glare from glossy PLA hurts tracking.
  - **Multicolour printers:** a 3MF with both parts assigned to two filaments.
  - Optionally, a flat "inlay" version for people who paint the raised parts instead.
- **Mounting options in the generator:**
  - countersunk screw holes, with a choice of positions;
  - a keyhole slot for hanging on a single screw, with the plaque thickened behind it;
  - a 1 mm recess for double-sided tape;
  - magnet pockets (sized for 10 × 2 mm discs).
- **Text strip:** optional text, by default "Look here to see this space with VLM", plus the VLM mark, raised in the dark colour.
- **The printed size is recorded with the marker.** Accurate lining up depends on it. The app tells Apple's image tracking the physical width.
  - Scaling a print by hand breaks alignment. The generator's printing notes say this, and the setup flow checks it, because a measured size that doesn't match puts the scene out of line.
  - **The check (Claude's call):** on iPhone, ARKit estimates the marker's real size, and setup warns when it's more than 3% off. visionOS can't estimate it, so on the headset setup asks the owner to confirm the width they measured.
- **Where it's built:** a server endpoint generates the files, `GET /api/ar/markers/:id/files?format=stl|3mf` with parameters for size, mounting and text. It uses a Node mesh library (Claude's call: write the plain extrusion geometry directly rather than depending on CAD software). The dashboard shows a live preview before download.

### Spaces and markers (data)

- **AR space:** a scene, a name, an address or place description, published or draft, and floors. Each floor has a name and a height in metres relative to the ground floor.
  - **Location (Claude's call):** latitude and longitude, captured by the owner's phone during setup, with the address geocoded as a fallback. It is only used for the Vision Pro nearby shortlist.
  - **Floor height** sets where a new marker starts during setup. It also keeps a floor's markers consistent with each other: a saved alignment that puts a floor more than 0.5 m from its stated height gets a warning.
- **Marker:**
  - its space and floor;
  - a short unique `code`, so the URL is `vlm.gg/s/<code>`;
  - the printed size in millimetres;
  - its **pose in scene coordinates**: where the marker sits in the scene and which way it faces. This is set during the owner's setup.
  - **What the pose holds (Claude's call):** a position plus a heading around the vertical axis. The scene is kept level using the device's gravity, never the marker's tilt, so a marker mounted 1° crooked doesn't tilt the whole scene (about 17 cm off at 10 m).
- Both are new tables. The dashboard edits them, and the apps read them.

### The owner's setup

1. **In the dashboard:** create the AR space for a scene, add floors, make a marker for each floor, download and print it, and mount it.
2. **On site, in the app:**
   - Sign in. The AR apps use the Hyperfy HUD's pairing code flow, approved on the website, but the pairing belongs to the **device**, not a world (Claude's call).
     - The device's token reaches only the AR routes: listing the user's spaces, reading draft feeds and saving alignment.
     - It is built in this project, on top of the HUD's pairing code once the HUD ships.
     - Who can save an alignment: the scene's owner, admins and editors. Booking hosts can't, because alignment is a permanent fact about the venue.
   - Pick the space and floor, then look at the marker.
   - The app first shows the scene with that marker at a default spot. The owner drags and turns the scene with the place-scene controls from the spike until it lines up with the real room, then taps **Save alignment**.
   - VLM stores the marker's pose in scene coordinates.
3. **Publish.** The space then opens for anyone who looks at its markers.

### The visitor's experience

- **iPhone:**
  - The app reads the QR code from the camera through Apple's Vision framework, loads that marker's space, and tracks the marker's pattern with ARKit image tracking.
  - It places the scene so the marker's tracked pose matches its saved pose.
  - Opening `vlm.gg/s/<code>` from the system camera deep-links into the app.
- **Vision Pro:**
  - The app keeps a **shortlist** of candidate markers and gives their reference images to visionOS image tracking. It renders each image from the marker's code, exactly as the generator does.
  - The shortlist is built from:
    - spaces the user owns or has visited;
    - published spaces near the user's approximate location, if they allow it;
    - any space opened from a `vlm.gg/s/<code>` link, including one opened by scanning with an iPhone or tapping a shared link.
  - When the headset recognises a marker, the scene loads and snaps into place.
  - visionOS only tracks images while the app's immersive space is open, so the visitor taps **Look for spaces** first. Updating the shortlist restarts the image tracking provider.
  - **Visited** is stored on the device for visitors who aren't signed in.
- **Staying lined up:** between markers, the scene relies on the device's own tracking. Seeing any of the space's markers again re-anchors it. A Vision Pro world anchor can keep the scene steady on that floor.
- **Content** comes from the scene feed (the long-poll from Hyperfy project 1). It renders with the spike's Swift ports of `planScene` and the coordinate mapping, which are tested against the same cases as the Hyperfy app.

### Feed access for the apps

- The spike borrows a Hyperfy world key. The real apps use a read-only feed scoped to a published AR space: `GET /api/ar/spaces/:id/feed?since=`.
- It is public for published spaces, since the content is already visible to anyone standing there, just as Decentraland scene content is public.
- It is rate-limited like the Hyperfy feed.
- Drafts need the owner's sign-in.

### The apps

- **One Xcode project** with an iOS target and a visionOS target sharing a Swift core: feed client, plan, mapping, renderer, marker image renderer, and space and alignment math.
- **Models** load from GLB through GLTFKit2, which works in the spike. If performance or fidelity falls short on device, the fallback is server-side GLB→USDZ conversion; that's left to testing.
- **iPhone tracking:** world tracking with detection images, not image-only tracking, so the scene stays placed between markers.
- **Opening links:** universal links need `vlm.gg/.well-known/apple-app-site-association` listing both apps' bundle ids.
- **Analytics (Claude's call):** visits are reported like Hyperfy's (enter, leave, position), as unverified visitors with no names. They go to a new public, rate-limited endpoint keyed by space, `POST /api/ar/spaces/:id/analytics`, and appear in the scene's existing analytics with platform `ar-ios` or `ar-visionos`.
- **Permissions:** camera on iPhone; world sensing on Vision Pro; location only for the nearby shortlist, and only if the user allows it.

## Constraints

- **Off limits:** billing code.
- **Deploying the VLM server:** only with `railway up <worktree> --path-as-root -s vlm-server --ci`.
- **Secrets:** sign-in tokens live in the Keychain. Never log tokens or keys.
- **App Store:** publishing the apps needs an Apple Developer team, plus App Store review for location and camera use.

## Risks

- **How far away a Vision Pro can spot a marker** is unverified. Apple's forums report small images failing on Vision Pro at distances an iPhone handles, and intermittent "Adding reference image failed" errors. The first build step is a device test with the spike, using printed 120 mm and 170 mm markers, before building the generator.
- **visionOS image anchors update slowly.** That's fine for occasional re-anchoring, but not for continuous tracking; world anchors carry the scene in between.

## Left to the builder

- The QR library.
- The border pattern's exact design and the hash.
- The STL/3MF writer.
- The preview renderer in the dashboard.
- The alignment UI details beyond the spike's controls.
- How the nearby shortlist is sized and cached.
- The web fallback page for `vlm.gg/s/<code>`.
