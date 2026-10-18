# In-world transform tools: owner test checklist

Tick each item as you go. Each says what to do and what should happen.

## 1. Setup

- [ ] 1. Use a test scene on `@dcl/sdk` >= 7.23. For example, bump the devDependencies of `test-scenes/dcl-smart-item-test` (`npm install @dcl/sdk@latest` in that folder) and make sure its own code never imports `PrimaryPointerInfo`. Do not change the repo's copy; use a throwaway copy if you prefer.
- [ ] 2. Build vlm-dcl (`cd packages/vlm-smart-item-dcl && npm run bundle`) and install it into the test scene from the local bundle. The scene starts and connects.
- [ ] 3. Sign in as an editor (account A). Open the Layout panel: an **Edit layout** button shows.
- [ ] 4. Have a second account (B) signed in as an editor, and a third (C) as a visitor with no role.
- [ ] 5. Sign in as a renter or venue renter (if you have one): the **Edit layout** button never shows.
- [ ] 6. The scene has a model, an image (once with and once without collisions), a screen and a sound placed, all visible (synced).

## 2. Move

- [ ] 7. Press **Edit layout**. The edit bar appears with Move, Rotate, Resize, Save, Revert and Done.
- [ ] 8. Click a model (no movement). It selects, does not move, and Save and Revert stay dimmed.
- [ ] 9. Click and drag the model across the floor. It follows the pointer and lands where the pointer hits the floor, exactly under it. Check with the cursor locked (crosshair) and unlocked (free cursor); the item follows the mouse, not screen centre.
- [ ] 10. Drag the model onto a wall. It lands on the wall surface where the pointer is.
- [ ] 11. Hang a screen on a wall the same way. It sits on the wall and stays put on release.
- [ ] 12. Move a sound. A marker shows only in edit mode, is clickable, and follows the sound as it moves.
- [ ] 13. Tap Shift once: the lock goes Free to X and a red guide line shows. Tap again for Y (green), again for Z (blue), again back to Free (no guide). Each tap cycles exactly once.
- [ ] 14. With X locked, drag. The item only moves along the scene X axis. Repeat for Y and Z.
- [ ] 15. In third-person camera, drag with the pointer ray passing through your own avatar. The item does not snap onto your avatar. Also check other players' avatars as surfaces.
- [ ] 16. Hold the pointer down while walking (WASD) without turning the camera. No drag starts (the 2 degree threshold is on ray direction). Turn the camera a little and the drag starts.
- [ ] 17. Images: both the collision and non-collision image are selectable. After Done, the collision image still blocks you and the other is click-through again.
- [ ] 18. A model with collisions keeps its physics during and after edit mode.

## 3. Rotate

- [ ] 19. Select an item and press **Rotate**. Three rings show (red, green, blue). The rings are grabbable from about 3 to 6 m.
- [ ] 20. Drag a ring. The item turns freely around that scene axis.
- [ ] 21. Hold Shift while dragging. It turns in 15 degree steps. Tilt a screen past 90 degrees in 15 degree steps and it lands on exact multiples.
- [ ] 22. Releasing Shift mid-drag goes back to free turning.

## 4. Resize

- [ ] 23. Select an item and press **Resize**. A white corner handle and three axis handles show.
- [ ] 24. Drag the corner handle. The item scales evenly.
- [ ] 25. Drag an axis handle. The item stretches along that one axis only.
- [ ] 26. Hold Shift while resizing. Scale snaps in 10% steps, and 0.25 m steps where it applies.
- [ ] 27. On an item rotated 45 degrees on Y, or tilted 30 degrees on X, check the handles. They sit on the scene axes, not on the item's corners. Note anything that feels wrong (a rotated screen's width handle may not line up with its visible edge).

## 5. Save and Revert

- [ ] 28. Move an item, then press **Save**. Save and Revert dim, and the change is stored in the live preset only.
- [ ] 29. Leave and rejoin the scene. The item is where you saved it.
- [ ] 30. Move an item, then press **Revert**. It snaps back to the saved position.
- [ ] 31. Save, then straight away click the same item again. The very next click selects it (also after Move, Rotate, Resize and Revert).
- [ ] 32. Move an item and press **Done**. A prompt asks what to do. Choose Save: it saves and leaves edit mode. Repeat and choose Revert: it reverts and leaves edit mode.
- [ ] 33. Move an item, then click a different item. A prompt shows; after answering, the other item selects and you stay in edit mode.
- [ ] 34. Make Save fail on purpose (for example, server rejects it). The bar shows `Save failed — <code>` and the draft stays.
- [ ] 35. Disconnect from the server, then press Save. The bar shows `Not connected — your change is still a draft` and the draft survives. After reconnecting, Save works.

## 6. Multi-editor

- [ ] 36. A starts moving an item. B sees "being moved by" A's name on it, readable at a sensible size and turned toward B.
- [ ] 37. B tries to grab it. B gets `Being moved by <A>` and nothing moves.
- [ ] 38. A saves. The label goes, B sees the item at the new spot, and B can grab it.
- [ ] 39. Repeat, but A reverts, or A leaves the scene. The label goes and B can grab it.
- [ ] 40. B has the item selected. A saves a move. B drags it straight away. The drag starts from A's saved position, not the old one.

## 7. Visitors

- [ ] 41. While A has an unsaved draft, C sees the item at its old, saved position.
- [ ] 42. After A saves, C sees the item at the new position.
- [ ] 43. C never sees an edit bar, markers, rings or labels.

## 8. HUD clicks

- [ ] 44. With an item behind the bar, click each bar button (Move, Rotate, Resize, Save, Revert, Done, and the prompt buttons, including dimmed ones). The item behind never selects or moves. Do this with the cursor locked and unlocked.
- [ ] 45. Click the VLM toggle, the Nav tabs, Layout panel rows and buttons, and a toast while editing, over an item. Nothing behind selects.
- [ ] 46. Click the Roles wallet text field while editing, over an item. No item selects.
- [ ] 47. Click just above and below the bar, and at the top of the screen. Items there still select.
- [ ] 48. Hide the HUD while editing. The bar stays and Done works.
- [ ] 49. Lock label colors match the guide colors, and Save and Revert are dimmed when clean.

## 9. Edge cases

- [ ] 50. A sound with no Transform: its marker does not show at the origin before it starts following.
- [ ] 51. A scene that never imports `PrimaryPointerInfo`, built with sdk-commands on SDK >= 7.23, with a free cursor: the dragged item follows the mouse (proves it survived tree-shaking).
- [ ] 52. Shift: tap cycles once per tap (no double cycle) in Move, and holding snaps in Rotate and Resize, including when Shift is already down as you switch modes.
- [ ] 53. Press and hold the pointer, then press **Edit layout**. The held press is ignored.
