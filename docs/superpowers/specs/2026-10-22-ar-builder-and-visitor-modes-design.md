# AR spaces: builder mode and visitor mode

Status: draft for the owner's review, 2026-10-22. Builds on `2026-10-21-ar-spaces-design.md` and `2026-10-22-ring-marker-design.md`; changes to them are listed under "What this changes".

## Intent

An AR space has two kinds of people in it. **Visitors** come to a real place and should see its VLM scene with as little in the way as possible: look at the ring, and the scene is there, lined up with the room. **Builders** (the owner and their editors) stand in that place with a headset and lay the scene out against the real room: move things, add things from their asset library, and save. The owner wants the builder side to feel like the HUD they already use in Decentraland, and the visitor side to be optimised for people walking into a place.

The Quest app comes first (the owner has a headset and Quest ships soonest). iPhone and Vision Pro get the same two modes later, with their own input.

## Goals

- **Visitors:** open the app (or find it already open on a headset the place hands out), look at a ring, and the scene appears in the right place. No sign-in, no world key, no settings.
- **Builders:** sign in once on a headset, pick **Layout**, and move things around; pick **Assets** and place things from their library, standing in the real room.
- **One scene everywhere (the owner's decision):** edits made in AR change the shared VLM scene, so they show in Decentraland and Hyperfy too, exactly like an edit from the Decentraland HUD.
- **One scene, several real places (the owner's decision):** a scene can be shown as an AR space in more than one real place, for example the same show in two venues. Each place has its own alignment (as in the AR spaces design), so the scene as a whole fits each room. See "Edits in a scene shown in several places" for how single items are fitted.
- **Works for both kinds of headset (the owner's decision):** visitors' own Quests and headsets a place hands out.

## Anti-goals (the owner's words: these would make them wince)

- **A visitor who doesn't know to look at the ring.** If someone stands in the space wondering what to do, the app has failed, however well everything else works.
- **A scene that lands in the wrong place.** A visitor who looks at the ring and gets a scene that's visibly off from where the owner put it has a poor experience. Wrong placement is worse than a short delay.
- **Visitors seeing builder tools or half-finished edits.**

## Non-goals (for now)

- Editing events, streams, roles or stats in AR. Those stay on the website and in the Decentraland HUD.
- Multi-select, grouping, copy and paste (the same limits as the Decentraland transform tools).
- Seeing other visitors as avatars (already a later project in the AR spaces design).

## What this changes in the earlier designs

- **AR spaces design, non-goal "Editing from the AR apps":** dropped. Builders edit in AR, through the same instance-update path the Decentraland HUD uses.
- **AR spaces design, device pairing scope:** the device's token reached only listing spaces, reading draft feeds and saving alignment. It now also reaches scene editing (instance updates, placing from the media library and the editor draft relay), still only for people with `scene.edit` on that scene.
- **AR spaces design, data model and published feed:** one new table, per-space item adjustments ("Just this place" edits), which the feed applies before sending the scene.
- **Unchanged:** the ring marker, placement at eye level by the entrance, one or more rings per floor, the marker pose stored as position plus heading, levelling by gravity, the data model, the published-space feed, and analytics.

## Visitor mode

This is what the app does when nobody has signed in, and what it always returns to.

1. **Opening.** The app opens straight into looking for rings. The only thing on screen is a small hint card with a picture of a ring and "Look for a ring like this, at eye level near the entrance." There's no panel, no world key and no sign-in.
2. **Getting closer (Claude's call).** The detector can tell when it sees something ring-shaped it can't read yet, because it's too far, too steep or too blurry. Then the hint changes to "Step closer to the ring". This turns "nothing happened" into an instruction.
3. **Locking on.**
   - When a ring is read, the app looks up its space and floor.
   - It loads the published feed and waits for a steady pose: several frames averaged, and the ring within about 1.5 m. Then it fades the scene in.
   - **Claude's call:** a brief outline is drawn over the real ring, so the visitor sees what the app locked onto. If the outline doesn't sit on the ring, they know at once something is off.
4. **Hiding.** The scene hides behind real things using live depth, which looked best on the headset. Walls from the room scan are available as well.
5. **Staying lined up.** Seeing any other ring in the space quietly re-anchors the scene. If the headset's own tracking jumps (it relocalises, or the headset was taken off and put back on), the scene fades out and the hint asks the visitor to look at a ring again. Showing nothing is better than showing it in the wrong place.
6. **The menu.** One small menu, on the wrist or behind the controller's menu button. It has:
   - **Look at the ring again:** re-aligns from the next ring seen.
   - **Hide behind walls / live depth:** the occlusion switch.
   - **Builder:** for owners.
7. **Headsets a place hands out.** Taking the headset off ends the visit. When the next person puts it on, the app is back at the hint card with nothing loaded. The place can also leave the scene loaded between visitors as a setting (Claude's call; the default is to reset).

### Finding the place before arriving

The ring marker design already drops "any phone camera opens it". Discovery comes from VLM apps and shared `vlm.gg/s/<code>` links. On Quest:
- **A link** opens the app on that space's page. It has the place's name, a picture of where the ring is, and "Look at the ring when you get there".
- **A "Spaces" list** in the menu shows spaces you've opened or visited.
- **Notifications:** the owner would like a notification through Meta's Horizon app. A Quest has no GPS, and whether Meta lets an app notify by place is unchecked. That's a step-1 check (see First steps), not a promise.

## Builder mode

1. **Getting in.** Menu, then **Builder**.
   - The first time on a headset, the app shows a pairing code. The owner approves it on vlm.gg, as with the Hyperfy HUD's pairing. The pairing belongs to the device.
   - Who can build: the scene's owner, admins and editors (people with `scene.edit`). Booking hosts and renters can't.
   - **Personal and shared headsets (Claude's call).** When pairing, the owner picks **This is my headset** or **Shared headset**.
     - **My headset:** the pairing stays, and **Builder** opens in one tap.
     - **Shared headset:** the token lasts for one builder session. Each time someone taps **Builder**, a new code has to be approved on vlm.gg (from a phone is fine). Taking the headset off for more than a couple of minutes ends the session and signs out, so the next visitor can never reach the builder tools.
     - The website lists paired headsets and can revoke any of them.
   - **Taking the headset off (Claude's call).** Drafts aren't lost to a short break. Unsaved drafts are kept on the headset for 10 minutes.
     - On a personal headset, putting it back on resumes builder mode with them.
     - The scene room only reverts the drafts for other editors when the session really ends: signing out, Done, or the 10 minutes running out. That replaces the relay's "revert when the client leaves" rule for AR clients.
2. **Which space.** If a ring is in view, the app already knows the space and floor. Otherwise the builder picks from their spaces.
3. **First visit to a floor: alignment.** This is unchanged from the AR spaces design:
   - look at the ring;
   - the scene appears with the ring at a default spot;
   - drag and turn the scene until it fits the room;
   - **Save alignment**.

   This is also the main defence against the "wrong place" anti-goal; see Getting placement right.
4. **The HUD.** A panel like the Decentraland HUD, with **Layout** and **Assets** tabs.
   - **Claude's call:** it floats beside the builder and can be grabbed and moved, like the spike's panel. A wrist panel is the alternative if this gets in the way.
   - A banner says "Builder: visitors don't see your changes until you save".
5. **Layout** follows the Decentraland transform tools (`2026-10-18-hud-transform-tools-design.md`) wherever they translate:
   - **Picking an item:** point the controller or hand ray at it and press the trigger, or pinch, to pick it. It gets an outline.
   - **Changing it:** a small bar with **Move / Rotate / Resize**, the same handles and snapping as in Decentraland, and **Exact** for typed numbers.
   - **Claude's call: direct grab.** In AR it's natural to grab an item with a hand or controller and carry it. Grab moves and turns it together; the handles are there for precision.
   - **Claude's call: snap to real surfaces.** This is what AR can do that Decentraland can't. While moving an item, its position is tested against the room scan and live depth. Near a real wall, it lands flush and turns to face out. Near the floor or a table, it sits on it. A modifier (the grip button, or Shift's equivalent) turns snapping off.
   - **Save / Revert / Done**, with the same rules as Decentraland: drafts are visible only to editors, and one editor holds an item while drafting.
   - **Which preset (Claude's call).** AR shows and edits whatever preset is live, as Decentraland does, so the AR space always matches what other worlds show. While a booking preset is live, the HUD warns: "A booking's layout is live: changes save to that booking only".
   - Saved changes go through the same scene-room path as the Decentraland HUD, so Decentraland and Hyperfy update too.
   - When the scene is shown in more than one real place, see below.

### Edits in a scene shown in several places (Claude's call)

A picture moved to fit one venue's wall would, if it moved everywhere, sit in thin air in another venue or in Decentraland. So in AR there are two kinds of change:

- **Everywhere (the default):** the change goes to the shared scene, as the owner decided. Decentraland, Hyperfy and every other place get it.
- **Just this place:** a switch on the Move / Rotate / Resize bar. The change is stored as an adjustment for this AR space only: an offset to the item's position, rotation and scale on top of the shared scene. Decentraland, Hyperfy and other places don't see it.
  - Items with an adjustment here show a small marker in the HUD and in the Layout list, with **Reset to shared** to drop it.
  - If the item is later moved in the shared scene (from anywhere), the adjustment stays on top of the new position. Deleting the item in the shared scene removes it here too.
  - Adjustments belong to the AR space, so they're saved with Save and reverted with Revert like any other draft, and visitors see them only once saved.
- **The warning:** when the scene has more than one AR space, the builder banner adds "This scene is also shown at <other places>: changes set to Everywhere move things there too."
- When the scene has only one AR space, the switch is still there, but defaults to Everywhere and the warning is hidden.
- **Data:** a new table of per-space item adjustments (space, item instance, position, rotation and scale offsets). The published-space feed applies them before sending the scene to visitors' devices.
6. **Assets.**
   - The builder's media library (images, videos, models), with **Place**. The item appears about 1 m in front of the builder, facing them, and is picked for moving straight away.
   - Uploading from the headset isn't needed. The library already takes uploads from the website and the in-world upload code (`2026-10-18-in-world-upload-design.md`).

## Getting placement right

This is the owner's second anti-goal, so it gets its own section. These are all Claude's calls.

- **When the owner saves alignment:**
  - The app shows the ring's live outline and how steady the reading is, and refuses to save from further than about 1.5 m.
  - It checks the saved floor against the floor's stated height; that check already exists in the AR spaces design.
- **A floor's other rings (Claude's call).**
  - After the floor is aligned, the builder walks to each other ring and taps **Record this ring**.
  - The ring's pose in scene coordinates comes from the headset's tracking since the alignment. The app asks for it within a few metres of the aligned ring, so drift stays small.
  - Each ring has its own stored pose, as in the data model.
- **A check after saving:**
  - The owner walks to any other ring on the floor. The app reports how far that ring's reading is from where the alignment expects it, for example "This ring is 3 cm and 0.5° from where it should be".
  - More than about 5 cm or 1° shows a warning with **Re-record this ring**. That fixes only this ring's stored pose; the floor's alignment and other rings stay.
  - A floor with one ring gets a suggestion to add a second.
- **For visitors:**
  - The scene snaps only once the averaged pose is steady and the ring is close enough to be accurate.
  - It re-anchors at every ring.
  - It fades out rather than drift when tracking jumps.
- **Printed size:**
  - The paper print's check bar stays.
  - When the owner first aligns a floor, the app compares the ring's measured size with the room scan's distance to the wall. If the print came out scaled, it warns "This ring looks about 8% smaller than its recorded size: was it printed at 100%?"

## Input (Claude's call)

Controllers and hands both work:
- **Trigger or pinch:** picks.
- **Grip, or a closed-hand grab:** carries.
- **Thumbstick:** turns the picked item while it's carried.

Exact bindings are left to the builder, with one rule: the Decentraland anti-goal of taking over keys a scene uses doesn't apply here, because the AR app owns all its input.

## Constraints

- **Secrets:** the device token is kept in Android's encrypted storage on Quest and the Keychain on Apple. Never log tokens or keys.
- **Off limits:** billing code.
- **Deploying the server:** only with `railway up <worktree> --path-as-root -s vlm-server --ci`.
- **Store:** Meta Horizon Store review, with wording for the camera and spatial data permissions.

## First steps

1. **Checks before building:**
   - whether a Quest app can be notified, or notify, by place (Horizon app notifications, and Wi-Fi or Bluetooth hints);
   - whether Spatial SDK exposes hand-pinch and grab events that are usable for picking and carrying;
   - the range test from the ring marker plan, so the visitor's "close enough" distance comes from measurements.
2. Then fold this design, the AR spaces design and the ring marker design into one AR spaces build plan, with Quest first.
   - **In that plan (Claude's call):**
     - the server's spaces, floors and markers data;
     - the published-space feed and device pairing;
     - the dashboard's space, floor and marker setup, with the marker generator and print files;
     - the `vlm.gg/s/<code>` page and Android app links;
     - the Quest app's visitor and builder modes;
     - Horizon Store submission.
   - **Not in that plan:** the iPhone and Vision Pro apps get their own plan afterwards, reusing the server and dashboard work.

## Left to the builder

- Hint card wording and art, the menu's exact placement, and the HUD's look (follow the Decentraland HUD's look where it fits).
- The steadiness threshold and the exact "close enough" distance, from the range test.
- How snapping weighs the room scan against live depth.
- Message names for the AR client joining the scene room as an editor; reuse the Decentraland draft relay as it is.
