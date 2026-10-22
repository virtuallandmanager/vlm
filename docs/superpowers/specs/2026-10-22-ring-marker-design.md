# VLM ring marker: design

Status: draft for the owner's review, 2026-10-22. This changes the marker in `2026-10-21-ar-spaces-design.md`; everything else in that design stands unless listed under "What this changes".

## Intent

AR spaces need a registration marker: a small 3D-printed plaque on a wall that a device looks at to place a VLM scene in the real room. The first design used a QR code inside a hashed border. On the Quest, the headset could see that marker but never decoded it, and Meta's own QR sample couldn't either.

The owner wants VLM's own marker instead: **circular, with arcs on rings that form the code**, so it reads as a VLM thing rather than a stock QR code. It doesn't have to explain itself: the people who use it already know what it is, from having seen them before or because a VLM app told them there's an AR experience there.

## Goals

- **Look at it from arm's length to wingspan away (about 0.6–1.8 m) and the space appears**, lined up with the room.
- **Effectively unlimited markers**, several per scene: one per floor, and more on large floors.
- **Small.** About 140 mm across by default; never more than 256 mm (a Bambu Lab bed).
- **Works on Quest 3/3S, iPhone and Apple Vision Pro.**
- **Prints well** on an ordinary home printer, in two colours.

## Non-goals

- **Opening from a plain phone camera.** The marker is no longer a QR code, so the system camera won't recognise it. Discovery comes from the VLM apps (nearby spaces, notifications) and from shared `vlm.gg/s/<code>` links.
- **Being decodable by anything but VLM's apps.**

## Anti-goals

- **Misreading one marker as another.** A scuff, glare or shadow must either still decode correctly or be rejected; it must never open the wrong space.
- **A marker that only works on one platform.**
- **Fine detail that a home printer smears.**

## What this changes in the AR spaces design

- **Marker shape, code and tracking pattern:** replaced by the ring marker below.
- **Goal "No app needed to discover a space":** dropped, by the owner's choice of a custom marker.
- **Non-goal "Android and Quest":** Quest 3/3S becomes a **shipping platform** (the owner's decision), and an early one, since the owner has a headset now. Other Android stays out. Quest gets the same pieces as the Apple apps:
  - the device pairing sign-in;
  - the owner's setup and Save alignment;
  - the published-space feed;
  - analytics as platform `ar-quest`;
  - Meta Horizon Store review.

  The spike's Spatial SDK app is the starting point.
- **Plaque limit of 180 mm:** raised to 256 mm. The 140 mm default still fits 180 mm beds.
- **Unchanged:** placement (eye level on a wall or door frame inside the entrance), one marker per floor and more allowed, the marker's pose stored in scene coordinates as a position plus a heading, levelling by gravity, the owner's setup flow, the data model, and the feed.

## Decided with the owner

- **Look:** rings of arcs (sketch A in the brainstorm): three rings of 24 cells, where neighbouring "on" cells merge into one arc.
- **Corner marks are fine:** marks in the plaque's corners around the ring are acceptable if Vision Pro needs them.
- **Capacity:** effectively unlimited, one marker per floor of each scene at least.
- **Range:** about arm's length to wingspan, 0.6–1.8 m.
- **Size:** smaller is better; up to 256 × 256 mm is acceptable.
- **Placement:** about eye level on a wall (already decided in the AR spaces design).
- **Users:** people who already know what the marker is, or who were told by a VLM app.
- **Quest ships:** Quest 3/3S is a platform VLM ships on, likely sooner than the Apple apps.

## Design calls by Claude (for review)

### Layout

From the outside in, at the 140 mm default (every size scales from these proportions):

- **Finder ring:** a solid ring 8 mm wide at the outer edge, with one **gap** 16° wide at the top. The detector finds the marker by this ring's ellipse, which also gives its tilt; the gap gives which way is up, so the code can't be read rotated.
- **Three code rings** of 24 cells each, 72 cells in total. Each cell is 8 mm deep radially, with 3 mm between rings and a 2.4° gap where two "off/on" cells meet, so arcs never touch. An "on" cell is raised dark; neighbouring "on" cells are joined into one arc.
- **Centre dot:** solid, 24 mm across, with nothing inside it. It gives the detector a second check on the centre.
- **Corner marks (decided with the owner):** the circle sits on a square plaque, and each of the four corners outside the ring carries a small dark mark in the raised colour.
  - The marks are generated from the marker's ID, so every marker's corners differ. They give Vision Pro's image tracking the corners it needs and tell otherwise similar markers apart.
  - Quest and iPhone ignore them; they read the rings.
  - At 140 mm across, the plaque is about 150 mm square.
- **No text on the face.** An optional text strip, as in the AR spaces design, goes below the circle on the plaque.

At 1.8 m, the smallest feature (the inner ring's cells, about 9 mm along the arc) spans roughly 4 pixels in Quest 3's passthrough camera. That's an estimate; the range test checks it.

### The code

- **A 32-bit marker ID** plus error correction, using all 72 cells:
  - The cells are read as 12 six-bit symbols, each a run of 6 neighbouring cells on one ring, so a scuff tends to damage few symbols.
  - **Symbol boundaries are staggered** from ring to ring (by 2 cells, then 4), so a radial scratch or a wedge of glare crosses few symbols.
  - A Reed–Solomon code over GF(64) gives 6 data symbols and 6 check symbols (minimum distance 7).
  - The 6 data symbols hold 36 bits: the 32-bit ID plus 4 bits for a format version, so the layout can change later without confusing old apps.
  - **Not misreading (Claude's call, from the builder check):**
    - The decoder corrects at most 2 bad symbols, keeping the rest of the code's strength for spotting damage.
    - Cells it can't judge (glare, shadow) count as erasures rather than guesses.
    - An ID counts only when it is a registered marker and 3 frames in a row agree.
    - Error correction alone isn't enough: decoding to the full limit lets random clutter pass as a valid ID about once in 1,200 tries. The sparse ID space, the version bits, the registry lookup and frame agreement are what keep a wrong space from opening.
- **IDs are random**, not sequential, so neighbouring markers don't differ by one cell.
- **The marker's `code`** in the URL `vlm.gg/s/<code>` becomes that 32-bit ID written as 7 characters of Crockford base32, for sharing links.
- **Room to shorten it later:** if range matters more than expected, a 16-bit code resolved with the device's location could make each cell about twice as big. Not built now.

### Printing

As in the AR spaces design: a light base 4 mm thick with the finder ring, arcs and centre dot raised 0.6 mm in a dark colour; matte filament; two STLs sharing an origin (change filament at 4.0 mm) or one two-colour 3MF; the same mounting options. The circle sits on a square plaque with the corner marks, and the printed diameter is recorded with the marker.

### Detection on each device

- **Quest 3/3S:** Meta's built-in tracking only reads QR codes, so the app reads the passthrough camera through Meta's Passthrough Camera API and runs VLM's own detector. That API needs Horizon OS v74+, Android Camera2, and both `android.permission.CAMERA` and `horizonos.permission.HEADSET_CAMERA`.
- **iPhone:** the same detector on ARKit's camera frames. ARKit world tracking keeps the scene placed between markers.
- **Apple Vision Pro:** apps can't read the main camera (Apple keeps that for enterprise apps), so it can't run VLM's detector.
  - It uses visionOS image tracking with the shortlist from the AR spaces design. Each marker's reference image is rendered from its ID.
  - Ring art with few corners may track poorly. That is this design's biggest risk; see Risks.
- **One detector, two ports.** Kotlin on Quest and Swift on iPhone, both checked against one shared set of test images with known IDs and poses. The generator also renders those test images (tilted, blurred, shadowed) and a small Python reference decoder defines the expected results, so both ports have a target before either exists. The Swift port comes after the Quest spike proves the range.
- **Viewing angle (Claude's call):** the marker must be found up to 45° off its face, which covers walking past an entrance wall. The range test checks 0°, 30° and 45°.
- **What the detector does:**
  1. Find ellipses.
  2. Keep pairs that look like the finder ring and centre dot.
  3. Use the gap to fix rotation.
  4. Undo the tilt.
  5. Sample the 72 cells and decode.
  6. Get the pose from the ellipse and the known printed diameter.

### Pose

As in the AR spaces design, the scene is placed by the marker's position and heading, with gravity keeping it level.

**Heading comes from the wall, not the circle's squash (Claude's call, from the builder check).** Near head-on, a circle's tilt barely changes its outline: at 1.8 m a one-pixel error is about 9°, roughly 1.5 m off at 10 m into the scene. So:

- **Position** comes from the marker: the centre of the finder ring, using the projected centre of its concentric edges and the dot, not the naive ellipse centre.
- **Heading** comes from the wall's direction where the marker sits: MRUK's wall data or depth on Quest, plane detection on iPhone, and the image anchor on Vision Pro. The marker faces straight out of its wall.
- The circle's own tilt only picks between the two possible tilts and checks that the marker is on the wall that was found.
- Several frames are averaged before the scene snaps.
- **Target:** heading within 1°, position within 2 cm, at the 1.8 m range. The range test measures both.

## First steps

1. **Generator:** extend `tools/make_markers.py` (or write its successor) to make ring markers: paper PDF with a check bar, STLs and 3MF, plus test markers at 120, 140 and 170 mm.
2. **Quest detector spike:** add the camera-based detector to `apps/quest-spike` and measure "found at" for each size, against the 0.6–1.8 m target.
3. **Vision Pro image tracking test:** once the headset is back, check that visionOS can track a ring marker (with its corner marks) from its rendered reference image at the target range, and that it doesn't confuse two markers on the same shortlist. If it still struggles, make the corner marks larger or busier before changing the rings. Markers shouldn't be handed out for real spaces before this test, since printed markers are permanent.
4. Then fold the result into the AR spaces build plan, with Quest as a full target alongside iPhone and Vision Pro.

## Risks

- **Vision Pro image tracking of ring art** is untested. Ring markers all share a finder ring and centre dot, so they may also look too alike to tell apart from a shortlist (see step 3).
- **Quest camera access** adds latency and needs a permission prompt; its resolution sets the real range.
- **Raised arcs cast shadows** at steep side angles; error correction should absorb some of it, and the range test includes angled views.
- **Heading accuracy** from a 140 mm circle at 1.8 m is unmeasured; if it's poor, re-anchoring from a closer view or a second marker helps.

## Left to the builder

- The exact proportions within the layout's rules, and the corner marks' exact pattern.
- The ellipse detector's internals and any image library.
- How test images for the shared test set are produced.
- Where the generator lives long-term (the AR spaces design puts it on the server).
