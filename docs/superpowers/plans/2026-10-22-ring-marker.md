# VLM Ring Marker: Generator, Reference Decoder and Quest Detector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Print VLM ring markers.
- Decode them in a Python reference implementation.
- Detect them live on Quest 3/3S, with a range test that measures "found at", position and heading.

**Architecture:**
- **Python package `apps/ring-marker/`.** It owns everything other code is checked against:
  - the code (Reed–Solomon over GF(64), a mask, the cell mapping);
  - the geometry;
  - the print files;
  - a synthetic test set;
  - a reference detector.
- **The Quest spike ports two parts to Kotlin:** the codec, checked against committed JSON vectors, and the detector, checked against the generated test set in JVM unit tests.
- **On the headset**, frames come from the passthrough camera through Camera2, and the wall direction comes from MRUK's scene data.

**Tech Stack:**
- **Python 3.11** with numpy, Pillow and pytest. OpenCV (`cv2`) is used only for connected-component labelling and perspective warps.
- **Kotlin** with Meta Spatial SDK 0.14.0 (the existing `apps/quest-spike`), Android Camera2 and JUnit 4.

**Spec:** `docs/superpowers/specs/2026-10-22-ring-marker-design.md` on branch `feature/ar-spaces-design` (worktree `/Users/unknower/-VLM/vlm-v2/.worktrees/ar-spaces-design`). It amends `docs/superpowers/specs/2026-10-21-ar-spaces-design.md` on the same branch.

**Where the code goes:** branch `spike/ar-spaces`, worktree `/Users/unknower/-VLM/vlm-v2/.worktrees/ar-spike`. All paths below are relative to that worktree. Don't touch `apps/ar-spike/tools/make_markers.py` or the QR test markers: the Apple spike still uses them.

## Global Constraints

- **Layout, at a 140 mm diameter.** Every length scales by `diameter_mm / 140`.
  - finder ring from r = 62 to 70 mm, with one 16° gap centred at the top;
  - code rings from r = 51–59 (ring 0), 40–48 (ring 1) and 29–37 (ring 2);
  - 24 cells per ring, cell k spanning 15k° to 15(k+1)° clockwise from the top;
  - each run of "on" cells drawn inset by 1.2° at both ends;
  - centre dot r = 12;
  - a square plaque 150 mm across with corner marks;
  - no text on the face.
- **Code.**
  - 72 cells read as 12 six-bit symbols;
  - RS(12,6) over GF(64), minimum distance 7;
  - 6 data symbols = 36 bits = 4-bit format version (high bits) + 32-bit ID;
  - symbol boundaries staggered by 2 cells, then 4, from ring to ring.
- **Decoding rules.**
  - Correct at most 2 bad symbols.
  - Cells that can't be judged are erasures.
  - On Quest, an ID counts only if it is a registered marker (here: a test marker) and 3 frames in a row agree.
- **Printing.**
  - light base 4.0 mm thick;
  - dark parts raised 0.6 mm;
  - matte filament;
  - two STLs sharing an origin (change filament at 4.0 mm) or one two-colour 3MF;
  - a paper PDF on US Letter with a 100 mm check bar.
- **Size limit:** never more than 256 mm. The test sizes are 120, 140 and 170 mm.
- **Range targets:**
  - found from 0.6–1.8 m;
  - up to 45° off the marker's face;
  - heading within 1° and position within 2 cm at 1.8 m.
- **Heading** comes from the wall (MRUK scene data), not from the circle's squash. The scene is levelled by gravity.
- **Quest permissions:** `android.permission.CAMERA` and `horizonos.permission.HEADSET_CAMERA`, on Horizon OS v74+, Quest 3/3S only.
- **Codes in URLs:** `vlm.gg/s/<code>`, where the code is the 32-bit ID in 7 characters of Crockford base32.
- **Repo rules:**
  - Never print or log world keys or tokens.
  - Never use bare `git stash`.
  - Each commit ends with:
    ```
    Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
    Claude-Session: https://claude.ai/code/session_018ds2NZXw5KLxDpVm9B3ABD
    ```

## Review Focus

1. **Two markers in one frame.** Both should decode, each with its own ID, and neither should be lost. The test is the `two_markers` case in Task 3, checked by Task 4's `test_testset_cases` and Task 6's `testsetCases`.
2. **Damage past the correction limit** (a wedge of glare or a sticker over a third of the rings). This must give no detection, never a different ID. The test is the `heavy_damage` case in Task 3, expected `none`, checked by `test_testset_cases` and `test_never_wrong_id` in Task 4.
3. **Round things that aren't markers** (a plate, a clock face, a plain black disc inside a ring). These should give zero detections. The test is the `decoys` cases in Task 3, expected `none`, checked by Task 4 and Task 6.
4. **A marker mounted rotated or upside down.** It should decode to the same ID, with the rotation reported. The test is the `rotated_180` and `rotated_73` cases in Task 3, checked by `test_rotation_reported` in Task 4.
5. **Camera permission refused, or no camera found on the headset.** The panel should say why detection is off, and the app shouldn't crash. The test is `cameraStatusText` in Task 7.

---

### Task 1: Ring codec (Python)

**Files:**
- Create: `apps/ring-marker/ringmarker/__init__.py` (empty), `apps/ring-marker/ringmarker/codec.py`
- Create: `apps/ring-marker/tests/test_codec.py`, `apps/ring-marker/pytest.ini` (`[pytest]\ntestpaths = tests`)
- Create: `apps/ring-marker/vectors/codec.json` (written by `python3 -m ringmarker.codec --vectors vectors/codec.json`)

**Interfaces:**
- Produces:
  - `CELLS = 72`
  - `encode(marker_id: int, version: int = 0) -> list[bool]` gives 72 cells, index = ring × 24 + cell, True means "on" (dark, raised). The mask is already applied.
  - `decode(cells: list[bool | None]) -> Decoded | None`, where None in a cell means an erasure.
  - `@dataclass(frozen=True) Decoded(marker_id: int, version: int, corrected: int)`
  - `code_of(marker_id: int) -> str` gives 7 Crockford base32 characters.
  - `TEST_MARKERS: dict[str, tuple[int, float]] = {"RING120": (0x1D2C3B4A, 120.0), "RING140": (0x2E3D4C5B, 140.0), "RING170": (0x3F4E5D6C, 170.0)}`

**Codec rules** (the signature doesn't decide these):
- **Field:** GF(64), primitive polynomial x⁶ + x + 1 (0x43), α = 2.
- **Systematic RS(12,6).** The generator's roots are α⁰…α⁵. The 6 data symbols come first, then 6 parity symbols.
- **Data symbols:** the 36-bit value `(version << 32) | marker_id`, split into 6 symbols, most significant first.
- **Placing symbols on cells:**
  - Symbol j goes on ring `j // 4`, starting at cell `((j % 4) * 6 + OFFSET[ring]) % 24`, with `OFFSET = (0, 2, 4)`.
  - Its 6 bits are written most significant first, clockwise, wrapping mod 24.
- **Mask:** XOR the 72 cells with the first 72 bits of `SHA-256(b"VLM ring marker v0")`, most significant bit first. Without it, ID 0 would print as empty rings.
- **Decoding:**
  - Undo the mask. An erasure stays an erasure.
  - Any symbol with an erased cell is an erased symbol.
  - Use Berlekamp–Massey with erasures plus Forney.
  - Accept only when `2·errors + erasures ≤ 6` and `errors ≤ 2`, and re-encoding the result reproduces every cell that isn't erased. Otherwise return None.

- [ ] **Step 1: Write the failing tests** in `tests/test_codec.py`:

```python
def test_round_trip(): # for ids 0, 1, 0xFFFFFFFF, 0x2E3D4C5B and version 0 and 15
    assert decode(encode(i, v)) == Decoded(i, v, 0)
def test_id_zero_is_not_blank(): assert 20 <= sum(encode(0)) <= 52
def test_corrects_two_symbol_errors(): ...  # flip one cell in symbols 0 and 7 → corrected == 2, same id
def test_rejects_three_symbol_errors(): ... # flip one cell in symbols 0, 5, 9 → decode(...) is None
def test_erasures(): ...                    # erase all cells of symbols 1..6 (6 erased symbols) → same id
def test_erasures_plus_error_over_limit(): ... # 5 erased symbols + 1 error → None
def test_radial_scratch_hits_few_symbols(): ... # flip cell 3 on all three rings → still decodes (stagger)
def test_random_cells_rarely_decode(): ...   # 20000 random 72-cell patterns (seed 1) → at most 2 decode (expected ≈ 0.08)
def test_code_of(): assert code_of(0) == "0000000" and code_of(0xFFFFFFFF) == "3ZZZZZZ"
def test_vectors_file_matches():  ...        # vectors/codec.json entries equal encode()/decode() output
```

- [ ] **Step 2: Run them to confirm they fail.** Run `cd apps/ring-marker && python3 -m pytest -q tests/test_codec.py`. Expected: they fail with `ModuleNotFoundError: ringmarker.codec`.
- [ ] **Step 3: Implement `codec.py`** to the rules above. Also add the `--vectors <path>` entry point, which writes:
  - 12 encode cases (`{"id", "version", "cells": "0101…"}`);
  - 12 decode cases using `?` for erasures (`{"cells", "expect": {"id", "version", "corrected"} | null}`), covering each rule above.
- [ ] **Step 4: Write the vectors and rerun the tests.** Run `python3 -m ringmarker.codec --vectors vectors/codec.json && python3 -m pytest -q tests/test_codec.py`. Expected: all pass.
- [ ] **Step 5: Commit** `apps/ring-marker/{ringmarker,tests,vectors,pytest.ini}` with the message `feat(ring-marker): RS(12,6)/GF(64) codec with stagger and mask`.

### Task 2: Geometry, rendering and print files (Python)

**Files:**
- Create: `apps/ring-marker/ringmarker/layout.py`, `apps/ring-marker/ringmarker/render.py`, `apps/ring-marker/ringmarker/printfiles.py`, `apps/ring-marker/make_ring_markers.py`
- Create: `apps/ring-marker/tests/test_layout.py`, `apps/ring-marker/tests/test_printfiles.py`
- Create: `apps/ring-marker/.gitignore` (`out/`, `testset/`, `__pycache__/`)

**Interfaces:**
- Consumes: `encode` from Task 1.
- Produces:
  - `Sector(r0: float, r1: float, a0: float, a1: float)` is an annular sector in mm. Angles are in degrees, clockwise from the top.
  - `Disc(r: float)`
  - `Rect(x0, y0, x1, y1)` in mm, with the marker's centre at the origin and +y up.
  - `marker_shapes(marker_id: int, diameter_mm: float, version: int = 0) -> list[Sector | Disc | Rect]` gives every dark part.
  - `plaque_side(diameter_mm) -> float`, which equals `diameter_mm * 150 / 140`.
  - `RING_RADII(diameter_mm) -> list[tuple[float, float]]` gives the three code rings, outermost first.
  - `render(marker_id, diameter_mm, px_per_mm: float, version=0) -> PIL.Image` gives an 8-bit grey image of the whole plaque, dark (30) on light (225).
  - `write_print_files(marker_id, diameter_mm, out_dir: Path, name: str) -> list[Path]` writes `<name>-reference.png`, `<name>-paper.pdf`, `<name>-base.stl`, `<name>-raised.stl` and `<name>.3mf`.

**Shapes:**
- Code runs follow Global Constraints.
- The finder ring is one Sector from 8° to 352°.
- **Corner marks:**
  - Each corner gets a 3 × 3 grid of 4 mm squares (scaled). The grid's outer corner is 3 mm in from the plaque corner.
  - The outermost square is always on, and the other 8 follow bits of `SHA-256(marker_id.to_bytes(4,'big'))`: 8 bits per corner, corners in the order top-left, top-right, bottom-right, bottom-left.
- **Meshes:**
  - Extrude each Sector as a strip between its inner and outer arcs, with at least one segment per 2°, and the Disc as a fan.
  - The base is one box from z = 0 to 4.0, and the raised parts go from z = 4.0 to 4.6.
  - Write STL and 3MF the same way as `apps/ar-spike/tools/make_markers.py` (copy its `Mesh`, `write_stl` and `write_3mf`; that tool stays as it is).
- **The paper PDF** puts the plaque at exact size on a Letter page at 600 dpi, with a 100 mm check bar and the marker's name and `code_of(id)` beneath it.

- [ ] **Step 1: Write the failing tests:**

```python
def test_shapes_inside_plaque(): # every shape of RING140 lies within ±plaque_side/2, sectors within r ≤ 70
def test_runs_match_cells():     # for RING140, the on/off pattern sampled at each ring's mid-radius and each
                                 # cell's centre angle equals encode(id)
def test_finder_gap():           # no finder Sector covers angles in (-8°, 8°)
def test_corner_marks_differ():  # corner Rects of RING120 != those of RING140; none closer than 72 mm to centre
def test_scales_with_diameter(): # RING_RADII(70) == [tuple(r/2 for r in ring) for ring in RING_RADII(140)]
def test_render_samples():       # render(RING140, 140, 4): pixel at the dot centre < 80; 66 mm above the centre (the gap) > 180
def test_stl_is_watertight():    # every edge of base and raised meshes is shared by exactly two triangles
def test_files_written(tmp_path): # write_print_files writes the 5 files, each non-empty; 3MF opens as a zip
```

- [ ] **Step 2: Run them to confirm they fail.** Run `python3 -m pytest -q tests/test_layout.py tests/test_printfiles.py`. Expected: they fail on import.
- [ ] **Step 3: Implement the modules and the CLI.** `make_ring_markers.py [out_dir=out]` writes print files for every `TEST_MARKERS` entry.
- [ ] **Step 4: Run the tests and the CLI.** Run `python3 -m pytest -q && python3 make_ring_markers.py`. Expected: all tests pass and `out/` holds 15 files.
- [ ] **Step 5: Check the result visually.** Open `out/RING140-reference.png` and compare it with sketch A from the brainstorm: three rings of merged arcs, a finder ring with a top gap, a centre dot and four corner marks. Then open `out/RING140-paper.pdf` and confirm the 100 mm bar is 100 mm at actual size.
- [ ] **Step 6: Commit** with the message `feat(ring-marker): layout, corner marks, paper PDF, STL and 3MF`.

### Task 3: Synthetic test set (Python)

**Files:**
- Create: `apps/ring-marker/ringmarker/testset.py`, `apps/ring-marker/tests/test_testset.py`

**Interfaces:**
- Consumes: `render`, `TEST_MARKERS`.
- Produces: `python3 -m ringmarker.testset <out_dir>` writes 1280 × 960 grey PNGs plus `<out_dir>/manifest.json`, a list of:

  ```
  {"file", "name", "case",
   "markers": [{"id", "center_px": [x, y], "rotation_deg", "distance_m", "angle_deg"}],
   "expect": "ids" | "none"}
  ```

  `markers` lists what was drawn. `expect: "none"` means a correct detector reports nothing.
- `FOCAL_PX = 760.0`, `IMAGE = (1280, 960)`. This approximates Quest 3's passthrough camera; Task 8 logs the real intrinsics, and the value is updated if they differ.

**Rendering:**
- Use a pinhole camera at FOCAL_PX, with the principal point at the image centre.
- Place the plaque at distance d on the optical axis, turned about the vertical axis by `angle_deg` and in its own plane by `rotation_deg`.
- Warp the `render(...)` image with `cv2.warpPerspective` onto a background of smoothed noise (mean 140, σ 25).
- Then apply a Gaussian blur of σ 1.0 px and pixel noise of σ 4. Use a fixed seed per file.

**Cases:**
- `range`: every test marker × d ∈ {0.6, 1.2, 1.8} × angle ∈ {0, 30, 45}. Expect `ids`.
- `rotated_73`, `rotated_180`: RING140 at 1.2 m. Expect `ids`.
- `glare`: one cell-sized white blob over the code rings. Expect `ids`.
- `shadow_wedge`: a 40° sector darkened by 35%. Expect `ids`.
- `two_markers`: RING120 and RING170 side by side at 1.2 m. Expect `ids`.
- `heavy_damage`: a light patch over 120° of all three code rings. Expect `none`.
- `decoys`, all expecting `none`:
  - a 140 mm light plate with a dark rim;
  - a clock face with 12 dark ticks;
  - a black disc inside a closed ring;
  - plain background.
- `too_far`: RING120 at 4.0 m. Expect `none`.

- [ ] **Step 1: Write the failing test.** `test_generates(tmp_path)` runs the generator and asserts:
  - there are at least 38 entries;
  - every file exists at 1280 × 960;
  - every `range` entry's `center_px` is within the image.
- [ ] **Step 2: Run it to confirm it fails.** Run `python3 -m pytest -q tests/test_testset.py`. Expected: it fails.
- [ ] **Step 3: Implement `testset.py`.**
- [ ] **Step 4: Run it to confirm it passes, and look at the output.** Run `python3 -m pytest -q tests/test_testset.py && python3 -m ringmarker.testset testset`. Then open `testset/range-RING120-1.8-45.png` and check that the marker is visible but small, about 90 px across.
- [ ] **Step 5: Commit** with the message `feat(ring-marker): synthetic test set with decoys and damage`.

### Task 4: Reference detector (Python)

**Files:**
- Create: `apps/ring-marker/ringmarker/detect.py`, `apps/ring-marker/tests/test_detect.py`

**Interfaces:**
- Consumes: `decode`, the layout radii (as fractions of the outer radius), and the manifest from Task 3.
- Produces:
  - `detect(gray: numpy.ndarray[uint8, (H, W)]) -> list[Detection]`
  - `@dataclass Detection(marker_id: int, version: int, corrected: int, center_px: tuple[float, float], ellipse: tuple[float, float, float, float, float], rotation_deg: float)`. The ellipse is the finder ring's outer edge: centre x, centre y, semi-major, semi-minor and the major axis angle in degrees.

**Algorithm.** Task 6 ports this step for step, so keep it to these operations:
1. **Threshold.** Use an adaptive mean threshold with an integral image. The window is `max(15, W // 40) | 1` and the offset is 7. Dark pixels become 1.
2. **Label blobs.** Use 8-connected components (`cv2.connectedComponentsWithStats`; the Kotlin port uses union-find).
3. **Find dot candidates.** Keep blobs with area ≥ 30 px, then compute each blob's ellipse from its second moments. Keep it only if:
   - its fill is between 0.85 and 1.15 of the ellipse area;
   - its axis ratio is ≥ 0.5.
4. **Find the finder ring.** For each dot, use the dot's ellipse as the affine frame and predict where the ring should be, at 62/12 to 70/12 of the dot's radius.
   - Cast 90 rays and take the outermost dark-to-light transition within ±20% of the prediction on each.
   - Fit a conic to those edge points by least squares: `Ax² + Bxy + Cy² + Dx + Ey = 1`, centred on the dot.
   - Reject the candidate if fewer than 60 rays found an edge, or if the fit is not an ellipse.
5. **Find the gap.** Map the unit circle onto the fitted ellipse. Sample intensity at normalised radius 66/70 every 0.5°.
   - The gap is the longest light run. It must be 10°–22°, and it must be the only light run longer than 4°.
   - `rotation_deg` is the gap centre's angle, clockwise from image up.
6. **Read the cells.**
   - Set `dark` to the mean of the finder-ring samples and `light` to the mean of the gap samples.
   - For each ring and cell, average 5 samples around the cell centre (mid radius, ±3° and ±1 mm). Read the angle from the gap centre.
   - The value is `t = (v - dark) / (light - dark)`. A cell is on when t < 0.4, off when t > 0.6, and an erasure in between.
7. **Decode** with `decode`. Keep the candidate only if it decodes.
8. **Remove duplicates.** If two candidates' centres are within half the dot's radius, keep the one with fewer corrections.

- [ ] **Step 1: Write the failing tests:**

```python
def test_clean_render(): # detect(np.array(render(RING140, 140, 2.0))) → one Detection with RING140's id
def test_testset_cases(): # for every manifest entry (testset generated in a session fixture into tmp):
                          # expect "ids" → set of detected ids == set of drawn ids, centres within 3 px;
                          # expect "none" → detect(...) == []
def test_rotation_reported(): # rotated_73 → rotation_deg within 2° of 73; rotated_180 → within 2° of 180
def test_never_wrong_id(): # over every manifest image, no detection ever carries an id that wasn't drawn
```

- [ ] **Step 2: Run them to confirm they fail.** Run `python3 -m pytest -q tests/test_detect.py`. Expected: they fail.
- [ ] **Step 3: Implement `detect.py`** following the algorithm. If a `range` case at 1.8 m and 45° fails, try these, in this order:
  - the threshold window;
  - the edge search ±20%;
  - the t thresholds.

  Record any change in the docstring. Don't loosen the decode rules.
- [ ] **Step 4: Run all the tests to confirm they pass.** Run `python3 -m pytest -q`. Expected: all pass.
- [ ] **Step 5: Commit** with the message `feat(ring-marker): reference detector`.

### Task 5: Kotlin codec (Quest)

**Files:**
- Create: `apps/quest-spike/app/src/main/java/gg/vlm/spaces/quest/ring/RingCodec.kt`
- Create: `apps/quest-spike/app/src/test/java/gg/vlm/spaces/quest/ring/RingCodecTest.kt`

**Interfaces:**
- Consumes: `apps/ring-marker/vectors/codec.json`. The test reads it from `../../ring-marker/vectors/codec.json`, relative to the `app` module directory, which is the JVM test's working directory.
- Produces:
  - `object RingCodec { const val CELLS = 72; fun encode(id: Long, version: Int = 0): BooleanArray; fun decode(cells: Array<Boolean?>): RingDecoded?; fun codeOf(id: Long): String }`
  - `data class RingDecoded(val id: Long, val version: Int, val corrected: Int)`
  - `val RING_TEST_MARKERS = listOf(RingTestMarker("RING120", 0x1D2C3B4AL, 0.120), RingTestMarker("RING140", 0x2E3D4C5BL, 0.140), RingTestMarker("RING170", 0x3F4E5D6CL, 0.170))`
  - `data class RingTestMarker(val name: String, val id: Long, val diameter: Double)`

The rules are identical to Task 1. IDs are `Long` holding an unsigned 32-bit value.

- [ ] **Step 1: Write the failing test** `vectorsMatch()`. For every encode vector, `encode` equals its cells. For every decode vector, `decode` equals `expect`, or null where it says null.
- [ ] **Step 2: Run it to confirm it fails.** Run `cd apps/quest-spike && JAVA_HOME=/opt/homebrew/opt/openjdk@17 ./gradlew -q testDebugUnitTest --tests '*RingCodecTest*'`. Expected: it fails to compile.
- [ ] **Step 3: Implement `RingCodec.kt`.**
- [ ] **Step 4: Run it to confirm it passes.** Use the same command. Expected: it passes.
- [ ] **Step 5: Commit** with the message `feat(quest): ring codec port, checked against the Python vectors`.

### Task 6: Kotlin detector (Quest)

**Files:**
- Create: `apps/quest-spike/app/src/main/java/gg/vlm/spaces/quest/ring/RingDetector.kt`
- Create: `apps/quest-spike/app/src/test/java/gg/vlm/spaces/quest/ring/RingDetectorTest.kt`
- Modify: `apps/quest-spike/app/build.gradle.kts`. Add an `Exec` task `ringTestset`, which runs `python3 -m ringmarker.testset ../../ring-marker/testset` in `../../ring-marker`, and make `testDebugUnitTest` depend on it.

**Interfaces:**
- Consumes: `RingCodec`, and the manifest from Task 3.
- Produces:
  - `class RingDetector { fun detect(gray: ByteArray, width: Int, height: Int, rowStride: Int = width): List<RingDetection> }`
  - `data class RingDetection(val id: Long, val version: Int, val corrected: Int, val cx: Double, val cy: Double, val semiMajor: Double, val semiMinor: Double, val angleDeg: Double, val rotationDeg: Double)`

Port Task 4's algorithm step for step, using union-find for the labelling. Reuse buffers between calls: `detect` runs on every camera frame.

- [ ] **Step 1: Write the failing tests.** These mirror Task 4's tests:
  - **`testsetCases`:** the same assertions as `test_testset_cases`.
  - **`neverWrongId`:** no image yields an ID that wasn't drawn.
  - **`fastEnough`:** the median `detect` time over the 27 `range` images is under 40 ms on the dev Mac (JVM, after 5 warm-up runs).

  Load the images with `javax.imageio.ImageIO`.
- [ ] **Step 2: Run them to confirm they fail.** Run `./gradlew -q testDebugUnitTest --tests '*RingDetectorTest*'`. Expected: compile failure.
- [ ] **Step 3: Implement `RingDetector.kt`.**
- [ ] **Step 4: Run all the unit tests to confirm they pass.** Run `./gradlew -q testDebugUnitTest`. Expected: all pass, including the old tests.
- [ ] **Step 5: Commit** with the message `feat(quest): ring detector port, checked against the synthetic test set`.

### Task 7: Passthrough camera and live detection (Quest)

**Files:**
- Create: `apps/quest-spike/app/src/main/java/gg/vlm/spaces/quest/ring/PassthroughCamera.kt`, `apps/quest-spike/app/src/main/java/gg/vlm/spaces/quest/ring/RingTracker.kt`
- Create: `apps/quest-spike/app/src/test/java/gg/vlm/spaces/quest/ring/RingTrackerTest.kt`
- Modify:
  - `AndroidManifest.xml`: add `android.permission.CAMERA` and `horizonos.permission.HEADSET_CAMERA`.
  - `MainActivity.kt`: remove the MRUK QR tracker (`configureTrackers`, `trackMarkers`, `TrackedQrCode`) and the temporary `qr entities` logging. Keep `MRUKFeature`, since Task 8 uses it.
  - `MarkerReadings.kt`: replace `TestMarker` with `RingTestMarker`, and drop `qrSide`, `codeFromQr` and `measuredSide`.
  - `AppState.kt`, `ControlPanel.kt`: rename the QR lines (`lastQr` becomes `lastRing`), and add `cameraStatus`.
  - Their tests.

**Interfaces:**
- Consumes: `RingDetector`, `RING_TEST_MARKERS`, `MarkerReading`.
- Produces:
  - `class PassthroughCamera(context: Context, onFrame: (gray: ByteArray, width: Int, height: Int, stride: Int, timestampNs: Long) -> Unit, onStatus: (CameraStatus) -> Unit)` with `start()` and `stop()`.
    - It opens the **left** passthrough camera at 1280 × 960 in YUV_420_888 and passes on the Y plane only.
    - It processes at most one frame at a time on a background thread. Frames that arrive while it's busy are dropped.
  - `val intrinsics: CameraIntrinsics?`, where `data class CameraIntrinsics(fx, fy, cx, cy: Double, lensTranslation: FloatArray, lensRotation: FloatArray)`, read from `LENS_INTRINSIC_CALIBRATION`, `LENS_POSE_TRANSLATION` and `LENS_POSE_ROTATION`.
  - `enum class CameraStatus { NO_PERMISSION, NO_CAMERA, STARTING, RUNNING, ERROR }` and `fun cameraStatusText(s: CameraStatus): String`.
  - `class RingTracker(registered: Set<Long>, framesToAgree: Int = 3) { fun update(detections: List<RingDetection>): List<RingDetection> }` returns only registered IDs seen in `framesToAgree` frames in a row. A miss resets that ID's count.

**Finding the camera:**
- Look through `CameraManager.cameraIdList`.
- Pick the camera whose vendor key `com.meta.extra_metadata.camera_source` equals 0 (passthrough) and whose `com.meta.extra_metadata.position` equals 0 (left).
- Read both keys with `CameraCharacteristics.Key("…", Int::class.javaObjectType)`.
- Log the chosen camera ID and its intrinsics once, at info level, with the tag `VLMSpaces`. If no camera matches, report `NO_CAMERA` and log every camera ID with both key values.
- Ask for both permissions together with the existing scene permission, in one `requestPermissions` call.

- [ ] **Step 1: Write the failing tests** in `RingTrackerTest`:
  - **`needsThreeFrames`:** an ID seen in 2 frames isn't returned; seen in a 3rd, it is.
  - **`missResets`:** after a miss, it needs 3 frames again.
  - **`unregisteredIgnored`:** an ID not in `registered` is never returned.

  And in a new `CameraStatusTest`, **`cameraStatusText`**:
  - `NO_PERMISSION` gives "Camera permission denied: marker detection is off";
  - `NO_CAMERA` gives "No passthrough camera found (needs Quest 3/3S, Horizon OS v74+)";
  - every value gives non-empty text.
- [ ] **Step 2: Run them to confirm they fail.** Run `./gradlew -q testDebugUnitTest`. Expected: compile failure.
- [ ] **Step 3: Implement the code and wire it up.**
  - `MainActivity` starts the camera once the permissions are granted and stops it in `onPause`, restarting in `onResume`.
  - Each frame goes through `RingDetector`, then `RingTracker`.
  - Results go to the UI thread, where `trackRings(head)` updates `MarkerReading` for each test marker, using the distance computed in Task 8 (until then, use `0.0`).
- [ ] **Step 4: Run the unit tests, build, and install.** Run `./gradlew -q testDebugUnitTest assembleDebug && adb -d install -r app/build/outputs/apk/debug/app-debug.apk`. Expected: the tests pass and the install reports `Success`.
- [ ] **Step 5: Check it on the headset.**
  - Start the app and grant both camera permissions.
  - Run `adb -d logcat -s VLMSpaces`. Expected: one line with the camera ID and intrinsics. Update `FOCAL_PX` in Task 3's `testset.py` if fx differs by more than 10%.
  - Hold the printed `RING140-paper.pdf` at about 1 m. Expected: the panel shows `RING140` as tracked.
- [ ] **Step 6: Commit** with the message `feat(quest): passthrough camera ring detection replaces QR tracking`.

### Task 8: Marker pose, wall heading and the range test (Quest)

**Files:**
- Create: `apps/quest-spike/app/src/main/java/gg/vlm/spaces/quest/ring/RingPose.kt`, `apps/quest-spike/app/src/test/java/gg/vlm/spaces/quest/ring/RingPoseTest.kt`
- Modify: `MainActivity.kt` (pose, wall lookup, Align to marker), `ControlPanel.kt` (pose lines), `apps/quest-spike/README.md`, `apps/ring-marker/README.md` (new)

**Interfaces:**
- Consumes: `RingDetection`, `CameraIntrinsics`, MRUK.
- Produces:
  - `fun markerInCamera(d: RingDetection, k: CameraIntrinsics, diameterM: Double): Vec3`
    - Distance = `fx * (diameterM / 2) / d.semiMajor`. The semi-major axis is barely affected by tilt.
    - The direction is the ray through the ellipse centre, `((cx - k.cx)/fx, (cy - k.cy)/fy, 1)`, normalised.
    - The result is in camera space: +x right, +y down, +z forward.
  - `fun cameraToWorld(p: Vec3, head: Pose, k: CameraIntrinsics): Vector3` applies the lens pose relative to the head, then the head pose. The lens pose's frame is unconfirmed: log it and check it in Step 5.
  - `fun wallHeading(marker: Vector3, walls: List<WallPlane>): Double?` returns the yaw in degrees of the normal of the nearest wall within 0.10 m of the marker, pointing into the room. It returns null if there's none.
  - `data class WallPlane(val centre: Vector3, val normal: Vector3, val halfWidth: Float, val halfHeight: Float)`

**Walls:**
- Load the room with `MRUKFeature.loadSceneFromDevice()`.
- Read the wall entities, labelled as wall faces, with their `Transform` and `MRUKPlane`.
- Confirm the exact class and label names with `javap` on `meta-spatial-sdk-mruk-0.14.0.aar` before writing the code.
- If the headset has no room scan, show "No room scan: set up your space in Quest settings to get wall heading" and leave heading empty.

**Align to marker:** put the scene's saved pose at the marker's position, with heading from `wallHeading`. Without a wall, fall back to facing the viewer, as now, and say so on the panel.

- [ ] **Step 1: Write the failing tests:**

```kotlin
@Test fun distanceFromSize()   // detection with semiMajor 59.1 px, fx 760, RING140 → 0.90 m ± 1 cm
@Test fun rayThroughCentre()   // ellipse centre at principal point → (0, 0, d)
@Test fun wallHeadingNearest() // two walls, marker 5 cm from one → that wall's yaw; marker 30 cm from both → null
@Test fun wallNormalIntoRoom() // a wall whose normal points away from the viewer gets flipped
```

- [ ] **Step 2: Run them to confirm they fail.** Run `./gradlew -q testDebugUnitTest --tests '*RingPoseTest*'`. Expected: compile failure.
- [ ] **Step 3: Implement `RingPose.kt`, then wire it into `MainActivity`.**
  - The panel shows, per marker: found at, lost at, the current distance, the position, and the wall heading or "no wall".
  - Every detection feeds `MarkerReading.observe` with its real distance.
- [ ] **Step 4: Run the tests and install.** Run `./gradlew -q testDebugUnitTest assembleDebug && adb -d install -r app/build/outputs/apk/debug/app-debug.apk`. Expected: the tests pass and the install reports `Success`.
- [ ] **Step 5: Check on the headset, with the owner.**
  1. Tape `RING140` at 1.5 m on a wall.
  2. Stand 1.0 m away, measured with a tape measure. Expected: the panel's distance reads 1.00 ± 0.02 m. If it's off by a constant factor, the lens pose or fx is wrong, so check the logged values.
  3. Press **Align to marker**. Expected: the scene's north is perpendicular to the wall within 1°. Check it against a floor tile line or a tape line on the floor.
  4. **Range test:** for each size, walk back from the marker head-on, at 30° and at 45°. Record "found at" and "lost at".
- [ ] **Step 6: Write it up.**
  - **`apps/ring-marker/README.md`:** how to regenerate the files, how to print them (the actual-size check, matte filament, change filament at 4.0 mm), what the test markers are, and how to run the tests.
  - **`apps/quest-spike/README.md`:** replace the QR marker section with the ring marker test, and add a results table (size × angle → found at, lost at) filled in from Step 5.
- [ ] **Step 7: Commit** with the message `feat(quest): ring marker pose, wall heading, range test write-up`.

## Later (not in this plan)

- **Vision Pro image tracking test.** Spec, step 3.
- **The iPhone Swift port.** Port the detector against the same test set.
- **Folding the results into the AR spaces build plan,** with Quest as a full target.
