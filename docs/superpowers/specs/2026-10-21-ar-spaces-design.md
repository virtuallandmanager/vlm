# AR Spaces: design

Status: draft for the owner's review, 2026-10-21.

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
- **Seeing other platforms' visitors as avatars.** Later.
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

- **Shape:** a square plaque, by default 150 × 150 mm and 4 mm thick. The code area is 120 mm, with a 2 mm raised rim and a text strip below. Printed height stays under 200 mm, so it fits common printer beds.
- **The code:** a QR code (version 2 or 3, error correction M) in the centre, encoding `https://vlm.gg/s/<code>`. At 120 mm, modules are about 4 mm, which is easy for FDM printers and readable from 1 to 3 m.
- **The tracking pattern:** a border ring of black-and-white blocks around the QR code, derived from the marker's code by a hash. A QR code on its own is repetitive, which makes tracking jittery; the unique border gives Apple's image tracking distinct features. The QR code plus the border together form the reference image both apps track.
- **Contrast:**
  - The base prints in a light colour and the code and border are raised 0.6 mm in a dark colour.
  - **Single-colour printers:** the base and the code pieces are separate STLs, with a "pause at layer N" note so the filament can be swapped.
  - **Multicolour printers:** a 3MF with both parts assigned to two filaments.
  - Optionally, a flat "inlay" version for people who paint the raised parts instead.
- **Mounting options in the generator:**
  - countersunk screw holes, with a choice of positions;
  - a keyhole slot for hanging on a single screw;
  - a 1 mm recess for double-sided tape;
  - magnet pockets (sized for 10 × 2 mm discs).
- **Text strip:** optional text, by default "Look here to see this space with VLM", plus the VLM mark, raised in the dark colour.
- **The printed size is recorded with the marker.** Accurate lining up depends on it. The app tells Apple's image tracking the physical width.
  - Scaling a print by hand breaks alignment. The generator's printing notes say this, and the setup flow checks it, because a measured size that doesn't match puts the scene out of line.
- **Where it's built:** a server endpoint generates the files, `GET /api/ar/markers/:id/files?format=stl|3mf` with parameters for size, mounting and text. It uses a Node mesh library (Claude's call: write the plain extrusion geometry directly rather than depending on CAD software). The dashboard shows a live preview before download.

### Spaces and markers (data)

- **AR space:** a scene, a name, an address or place description, published or draft, and floors. Each floor has a name and a height in metres relative to the ground floor.
- **Marker:**
  - its space and floor;
  - a short unique `code`, so the URL is `vlm.gg/s/<code>`;
  - the printed size in millimetres;
  - its **pose in scene coordinates**: where the marker sits in the scene and which way it faces. This is set during the owner's setup.
- Both are new tables. The dashboard edits them, and the apps read them.

### The owner's setup

1. **In the dashboard:** create the AR space for a scene, add floors, make a marker for each floor, download and print it, and mount it.
2. **On site, in the app:**
   - Sign in. The AR apps sign in with the same pairing code flow the Hyperfy HUD design defines, approved on the website.
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
- **Analytics:** visits are reported like Hyperfy's (enter, leave, position), as unverified visitors with no names.
- **Permissions:** camera on iPhone; world sensing on Vision Pro; location only for the nearby shortlist, and only if the user allows it.

## Constraints

- **Off limits:** billing code.
- **Deploying the VLM server:** only with `railway up <worktree> --path-as-root -s vlm-server --ci`.
- **Secrets:** sign-in tokens live in the Keychain. Never log tokens or keys.
- **App Store:** publishing the apps needs an Apple Developer team, plus App Store review for location and camera use.

## Left to the builder

- The QR library.
- The border pattern's exact design and the hash.
- The STL/3MF writer.
- The preview renderer in the dashboard.
- The alignment UI details beyond the spike's controls.
- How the nearby shortlist is sized and cached.
- The web fallback page for `vlm.gg/s/<code>`.
