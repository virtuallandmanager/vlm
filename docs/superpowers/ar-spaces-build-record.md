# AR spaces build: rulings, owed checks and deferred items

Built 2026-10-23 to 2026-10-24 on `feature/ar-spaces` from plans 1–3 (`docs/superpowers/plans/2026-10-23-ar-spaces-*.md`). Every decision made on the owner's behalf during the build is listed here with what it costs if wrong. Nothing has run on a headset yet.

## Rulings

### Plan 1-server-and-dashboard

- T2 puts sha256 in its own `ring-marker/sha256.ts` and T1's mask stays a constant — avoids T1 depending on T2.
- T3/T4 don't set `ar`; T5 adds the flag and sets it on those routes (T5's file list already names them).
- T3/T4 leave `ar: true` to T5 — the flag doesn't exist until T5 — costs nothing if wrong.
- sync SHA-256 lives in T2's file; T1 uses a precomputed mask constant — keeps vlm-shared sync for the browser — if the constant were wrong, the vector test fails loudly.
- web package is `vlm-web` (plan says `web`) — use the real name — none.
- subagent commits carry their own model in Co-Authored-By (e.g. Sonnet) with the same Claude-Session line — honest attribution — trivial to amend if the owner wants one line.
- Decentraland scene passes bound to the same scene may use the setup routes (mayBuild still gates them); only Hyperfy (and later AR) passes are refused — the pass is already scoped to that scene and its user is a builder — if wrong, a builder could change AR setup from inside Decentraland, which is harmless.
- /api/ar/drafts/end uses boundScene, not the instance-checking resolver — a headset must be able to end its own draft after the item is deleted, and it only releases its own hold — if wrong, a headset could send end for an sk in its scene that it doesn't hold, which is a no-op.
- screw holes move to the top-left and bottom-right corners at the point of most clearance (head ≥1.5 mm from raised shapes, ≥2 mm from edges; 400 no_room_for_screws otherwise) — the plan's 10 mm-from-edge positions fall inside the finder ring — if wrong, the owner may prefer holes elsewhere (e.g. a taller plaque with tabs).
- STL downloads are named -base.stl / -raised.stl — the plan's single name made the browser rename the second — none.
- accepted the implementer's keyhole channel (9 mm wide, 2 mm deep, behind the 4 mm slot, base min z = -2) — a single-depth slot can't hold a screw head — if wrong, the keyhole needs a redesign.
- accepted PDF 400 too_large_for_paper for plaques over 196 mm — Letter can't fit them at 100% — owner may want A3/tiled later.
- plan 3 Task 4 DraftStore updated (controller doc edit) — base from feed arShared, Everywhere save subtracts the adjustment, Just-here saves full offset; server ends the headset draft on adjustment save — matches the feed fix — if wrong, adjusted items get double offsets.
- no fallback "ensure" SQL in entrypoint.sh for the new tables — reviewer pushed head schema onto base in a scratch DB non-interactively and it succeeded — check the first deploy log.
- leave; owner decides whether a resize should clear the alignment — cosmetic.
- same pattern as /drafts/end, low risk — a save could look failed.

### Plan 2-quest-visitor

- T2 and T3 keep the app compiling — they adapt the spike callers in MainActivity minimally (T2: connect() keeps the spike's world-key feed path out by switching it to ArFeed on a typed space id, or the connect action is removed; T3: placeAhead/alignToMarker build a RootPose) — T6 later replaces them — cost: small throwaway glue.
- T1 also moves the untracked local.properties into apps/quest.
- device steps (installs, headset checks) are deferred to the owner; implementers build with assembleDebug instead of installDebug when no device — the code still compiles and unit tests run.
- hand-written JSON parsing in ArModels (no kotlinx-serialization compiler plugin in the build) — accepted — wire drift caught only by fixture tests.
- extra visitor copy (not in spec): unparseable feed "Something's wrong with this space's data."; lookup failure "Couldn't open this space. Try again in a moment."; rate limited "VLM is busy. Trying again…"; Loading carries spaceName (null → "Opening…") — the plan lacked these cases — owner may reword.
- Task 6 puts visitor wiring in visitor/VisitorController.kt (MainActivity keeps lifecycle/camera/MRUK/panels) — avoids a monolith — none.
- heading spread for LockGate = circular spread of per-frame wall headings; no wall heading → stays GATHERING — heading comes from the wall (ring marker design) — a ring on a wall MRUK missed never locks (owner check).
- debug-only baseUrl intent extra; release always https://vlm.gg — none.
- accepted onPause ending the visit (README check; fall back to XR session state/proximity if system menu pauses), re-anchor on steady edge, LazyFollow drift re-centre — reasonable readings — visible hops or false visit-ends on device.
- the space page shows the live hint line under its text and closes itself on Shown; Close works anytime — the brief didn't say when it dismisses — if wrong, the owner may prefer the page to close as soon as the ring is seen.
- one visit spans tracking-jump re-shows; hidden() pauses, end() sends leave on forget/HeadsetOff — the brief's leave-on-every-hide would split one visit into many — if wrong, visit counts are lower than the owner expects.
- new visitor copy — no room scan: "Set up your space on this headset first: Settings → Physical space → Space setup."; camera denied: "VLM Spaces needs camera access to find rings. Allow it in Settings → Apps → VLM Spaces."; no wall: "Can't see the wall behind this ring. Look around the room so the headset can map it." — the spec has no copy for these — owner may reword.
- wall tilt check accepts a wall only within 30° of an ellipse-derived normal (or of the ray when the ellipse is nearly circular) — the ring marker spec requires the check but gives no threshold — too strict a threshold delays locking; too loose lets corner rings pick the wrong wall.
- jump detection by speed (2.5 m/s, 300°/s, dt cap 0.5 s) — stalls looked like jumps — a real small relocalisation during fast motion could be missed (spatial anchors are the plan-3 follow-up).
- residual tilt finding is load-bearing (plan 3 alignment uses wallHeading) — carried into plan 3 as a pre-task fix: ambiguous when the two best wall scores are within 15° → null heading; TILT_TOLERANCE_DEG 20; corner test at 45°; plus a detector→circleNormals test on a real oblique testset image — cost if wrong: corner rings may take longer to lock.
- spatial data permission denied gets its own device problem: "VLM Spaces needs spatial data access to line spaces up with the room. Allow it in Settings → Apps → VLM Spaces." — carried into plan 3 pre-task — owner may reword.

### Plan 3-quest-builder

- T1 does docs/sample research only, records findings as "unverified on device", picks controller Grabbable + ray as the baseline that works without hands, and adds the hand check to owner device checks
- before T2, run a Task 0 pre-fix carrying plan 2's residuals plus the session extraction (shared SpaceSession used by visitor and builder) — builder work needs both — cost: one extra dispatch.
- a wall heading counts only within MAX_VIEW_ANGLE_DEG = 35 of head-on; steeper views report TOO_STEEP with hint "Stand in front of the ring" — a single circle is ambiguous near 45°, and head-on views make the perpendicular wall impossible — cost: visitors must face the ring (the spec's 45° is detection range, not lock range); owner may reword the hint.
- accepted Task 0 choices — parallel wall segments don't conflict; unitTests.isReturnDefaultValues = true; re-anchor only from a ring steady on the newest frame, else hide and re-lock.
- also require measured tilt acos(minor/major) ≤ MAX_VIEW_ANGLE_DEG, and lower MAX_VIEW_ANGLE_DEG to 30 — independent evidence plus margin — cost: visitors stand more squarely in front of rings.
- Tasks 7–8 use controller ray + toolkit Grabbable; hands use system pointer pinch (SemanticType.Select) via IsdkSystem observer PointerEvent.hitInfo.point; no ISDK hand grab; wrist menu stays as plan 2's ⋯ — 0.14.0 docs don't show hand grab release or wrist pose reads — cost: hands can pick and press but not carry until a device check confirms ISDK grab.
- alignment coarse step 5 cm / 2.5° (fine 1 cm / 0.5° with grip), stick dead zone 0.5 — brief gave only the fine step — owner tunes on device. Task 10 carry: call AlignFlow.checkSize with markerInCamera distance and depthRange from readWalls().
- walls are chosen by camera-ray intersection (scale-independent) in both depthRange and wallFix — keeps misprinted rings alignable so the size check can warn — cost if wrong: a wall behind/beside the ring along the ray could be chosen; tilt/view checks still gate it.
- wall hit must lie within ±25% of the ring's size-based range (PRINT_SCALE_TOLERANCE) — stops a wall in the next room being taken — cost: misprints beyond ±25% won't align (they'd also be visibly wrong).
- extra copy 'Ring saved', 'Saving…', "Couldn't save the ring: try again" — owner may reword.
- a JUST_HERE draft relays the unchanged shared transform — it takes the hold but DCL editors see nothing move — Just-this-place edits shouldn't show in other worlds — none.
- extra copy "Save your changes before leaving?" (Save / Don't save / Cancel), "Saving…", "Couldn't save N change(s): try again" — owner may reword.
- TransformSession takes rays (faithful session.ts port) instead of the brief's drag deltas — fidelity to the proven DCL tool — none.
- Surface gains widthAxis; 15 cm measured to the item's nearest face; wall landing zeroes pitch/roll; grip starts a carry only within half-diagonal + 25 cm of the ray; typed Exact scale still clamps positive — sensible readings — cost: minor feel differences, owner tunes on device.
- show them disabled with 'Not shown on the headset' (new copy, owner may reword). Round 1 also: clear pending on unpick/leave, thumbnail size cap.
- revoked headset is asked to pair again at once; Done on a shared headset signs out (the shared token lasts one builder session); while building, other rings don't re-anchor the scene (alignment is being set); after headset-off the scene re-places from a ring; Done hands over to the visitor's published-only feed — consistent with the spec — cost: an unpublished space shows "isn't open" after Done.
- revocation noticed on the next refused builder call (idle builder may stay in up to ~15 min with a cached pass); server refuses every write at once — acceptable.
- extra copy for the pick list, placing and notices (listed in README) — owner may reword.
- on a shared headset, every exit from builder mode to OFF ends the session; a restored Paired(SHARED) with no live build is ended at startup (a shared session never outlives the app process) — closes the leak — cost: a shared builder whose app crashes must pair again.
- Done handoff clears the view and waits for the first published snapshot (no pass-authenticated snapshot shown to the next person); NoAccess mid-build leaves with "This account can't edit this scene"; links while building show "Finish building first (Done) to open another space" — owner may reword.
- Done hands over only a published space (server sends the same snapshot body to builders and visitors; the pass only adds unpublished access) — simpler of the two options — cost: after Done on an unpublished space the visitor starts fresh.
- Re-record also requires RECORD_RADIUS_M from the last anchor (plan Task 6 text corrected) — drift would otherwise be saved as truth — cost: builder must walk back to re-record a far ring.
- privacy/Store text says media loads from wherever each owner hosts it — accurate — owner may reword.

## Owed: owner checks and steps

- Task 10: OWED: browser check of the AR tab (no browser tools in subagents) — controller does it after Task 12
- Plan 1: DONE (1c2ad2f..f1682ca). OWED to owner: browser check of the AR tab, headset pairing page, /s page; slicer check of the 3MF.
- Task 6: OWED owner device checks: left menu button reaches app?; unlit shader honours alpha?; system menu pauses app?
- Plan 2: DONE (1a92f4e..a73ed93) pending the carried pre-task. OWED owner device checks: README "Owner checks (visitor mode)" incl. range test, menu button, alpha fade, system-menu pause, hint card not blocking an eye-level ring.
- Task 0: OWED device check: tilt check includes pitch — ring well above/below eye level from close may read TOO_STEEP when squarely in front (0.5 m away, 0.3 m height diff ≈ 31°)
- The full on-headset runs listed in `apps/quest/README.md` ("Owner checks" sections), including the range test and measured accuracy.
- Release key (`apps/quest/STORE.md`), signed build, `ANDROID_CERT_SHA256` on the server, Store upload.

## Deferred minor findings

- Task 1: minor (deferred): ringCodeOf tested only by round-trip; add a literal code from Python's code_of (cross-port check) — test-strength
- Task 1: minor (deferred): no tests for encodeRing range guards; ringCodeOf doesn't validate input
- Task 2: minor (deferred): test imports sha256 across package boundary by relative path; no multi-block sha vector; SVG full-ring branch untested
- Task 3: minor (deferred): deleteFloor count-then-delete not atomic (concurrent deletes can leave zero floors)
- Task 3: minor (deferred): heightM/sortOrder unbounded → 500 on overflow; addFloor sortOrder = count can duplicate; MIN_DIAMETER 60 local; schema hardcodes 140; publishSceneTouched unguarded after commit; missing 404/cohost/floor-cascade tests
- Task 4: minor (deferred): builder decision fixed for a 25 s hold; marker lookup has only the global rate limit; three queries per held read; no test for a builder's held draft feed
- Task 5: minor (deferred): listDeviceSpaces misses admin-wide scenes, N queries; expired pending ar_devices rows never swept; code-existence oracle (bad_secret vs 404); extra rate limits 60/min chosen by implementer; full-suite noise (hook timeout under load, MaxListeners warnings — pre-existing)
- Task 5: minor (deferred): revoke pushes no fresh venue-access message to a joined session (UI may still show editor until re-send; edits are refused)
- Task 6: minor (deferred): applyAdjustments returns same ref for empty map; vec() defaults hide corrupt transforms; pose/delta values unbounded; clearAdjustment publishes even when nothing deleted; stale adjustments after preset switch (ignored, reappear) not pinned
- Task 7: minor (deferred): per-draft DB cost (holder name lookup); out-of-order REST relays jitter; no test that later drafts extend expiry; fake-request cast in resolver; MaxListeners test noise (pre-existing)
- Task 7: minor (deferred): lapsed-takeover end relayed to the new holder makes its own dragged DCL item snap back to saved until next drag move (VLM.ts:336 restoreTransform) — rare (needs a 10-min-lapsed headset hold); fix in VLM.ts or use except:client. deviceEndedAt map never cleared.
- Task 8: minor (deferred): no test for ar batch re-sent/interleaved with hyperfy; body cast before checker
- Task 9: minor (deferred): screw search window fixed 30 mm — 24% of ids at 256 mm get no_room_for_screws (scale window with diameter); test clearance check partly circular; 3MF filament assignment unverified in a slicer (owner check); extra getMarker query; earClip fallback latent
- Task 10: minor (deferred): stale error banner after a later successful load; overlapping unlocked saves can briefly show stale data; whitespace-only edits don't normalise in the field
- Task 11: minor (deferred): last-used shows date only (locale); approval error has no retry (same as Hyperfy); null kind shows Personal (unreachable)
- Task 12: minor (deferred): fingerprints not normalised/validated (Google wants uppercase colon hex); network/429/5xx shows "isn't open yet"
- Task 4: flaky (deferred): ar-feed "the feed wakes on a space edit" failed once under load, passes on rerun — timing-sensitive
- Final: parked — resize note says "align again" beside green "Aligned" (server keeps pose on resize), note never resets — Ruling: leave; owner decides whether a resize should clear the alignment — cosmetic.
- Final: parked — endHeadsetDraft after committed adjustment can 500 if relay throws — Ruling: same pattern as /drafts/end, low risk — a save could look failed.
- Task 1: minor (deferred): leftover 59.1 constant in RingPoseTest
- Task 2: minor (deferred): published parsed loosely; no min gap on unchanged-version answers (hot loop if server stops holding); disconnect doesn't interrupt blocking read; feed test doesn't assert bearer header; backoff/OFFLINE/RATE_LIMITED feed paths untested
- Task 3: minor (deferred): rootFromMarker yaw unnormalised (e.g. -340); no known-value test of markerInScene heading sign; import order
- Task 4: minor (deferred): decoy loop could pass vacuously (assert count); UnreadableRing.semiMajor unreliable — don't depend on it; seenConic hidden coupling; long line
- Task 5: minor (deferred): newer snapshot re-aligning the shown ring doesn't move the scene until next Steady; FeedStatus events carry no space id
- Task 5: minor (deferred): two rings in view can alternate failure messages; lookup Ok + feed NOT_FOUND loop has no backoff (needs server inconsistency)
- Task 6: minor (deferred): positions use tick head pose not capture time (spike carry-over; range test); menuPressed reacts to either controller's menu bit; onSceneTick main-thread assumption unverified (owner/device)
- Task 7: minor (deferred): Recents re-launch can replay a stale VIEW intent; dispatch finally fix untested (controller not unit-testable); whitespace edge (U+FEFF) between JS and Kotlin parse
- Task 7: minor (deferred): page shows "Opening Cafe…" under title "Cafe" while loading
- Task 2: minor (deferred): device()/get() HTTP boilerplate duplicated
- Task 2: minor (deferred): two race tests don't prove per-device keying/new lock; tiny re-pair-wipe windows (non-Ok branch, spaces()) outside cacheLock; Approved writes three puts non-atomically
- Task 3: minor (deferred): done()/signOut() identical bodies; tick() is a query only — Task 10 must call signOut + DeviceAuth.endSession; boundary tests at exact 10/2 min via headsetOn missing
- Task 4: minor (deferred): zero base scale breaks just-here round trip (plan-mandated, rare); tiny factor overflow; place() orphan on unparseable element reply; asFailure casts; BuilderApi test gaps
- Task 5: minor (deferred): free-standing sign turned 25–60° within ~37 cm of a wall can lock that wall's heading (wider than before); owner may want ±15% for visitors
- Task 6: minor (deferred): TOO_FAR shown twice if requestSave called anyway; shadowed `lines` in AlignPanel (warning); display vs threshold rounding mismatch; ringCheckLines untested
- Task 7: minor (deferred): edit during Done→Save left as draft with hold; tick() relay after EndDraft can re-hold
- Task 8: minor (deferred): model extents from scale not mesh bounds; sloped walls/tilted flat items
