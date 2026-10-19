# Model Catalog: Open-Source Packs — Design

Project 1 of 4 toward the scene builder:

1. **Model catalog** (this doc)
2. Default layouts
3. Website scene builder
4. Design-studio scene in Decentraland

## Intent

VLM users should be able to build a venue from free, ready-made 3D models instead of sourcing their own. The end
goal is a flow like "I need a café, do I want the cyberpunk, cozy or minimalist one?" That flow is built from
buildings and furniture laid out by default layouts (project 2). This project lays the foundation for it. It loads
the open-source model collections into VLM's catalog, gives every model the information later projects need to pick
it, and lets an admin switch any pack off in one click.

The collections:

| Source | What | License situation |
|---|---|---|
| **Mr Dhingia**: github.com/MrDhingia/DhingiaBuilds | 103 GLBs: ~37 whole parcel buildings (with `Render.png` each), ~35 interior props, a DJ kit | MIT. Keep his copyright notice. |
| **Last Slice** In World Builder: `last-slice/iwb-3d-wip`, `last-slice/dcl-iwb`, metadata in `last-slice/iwb-servers` (`iwb-server/src/tests/catalog.json`) | ~3,000 artist models (Kirzoz, DOCTORdripp, Cyclopa, Koshi, Blacknode, AwedJob, KJWalker, FGR3D, NikkiFuego), with a PNG thumbnail each, polycount, size, bounding box and a style (`sty`) | No license file. Open-sourcing was a grant requirement, and the user knows the team. |
| **Decentraland**: `decentraland/asset-packs` (Creator Hub packs: cyberpunk, fantasy, gallery, genesis_city, halloween, pirates, sci-fi, steampunk, voxels_pack, western, year_of_the_pig) and `decentraland/builder-assets` | ~2,500 models. Also mirrored in Last Slice's `current-builder-assets/`. | Builder packs are CC BY-NC 3.0. Creator Hub packs have no license. **The user's ruling: bring them in now and deal with the legal side later. Every pack must be easy to switch off.** |

Low Poly Models is out for now: no public release was found. Adding it later is just another pack.

## Goals

- Every model from the three sources sits in the catalog once. Each one carries:
  - name, thumbnail, file size, triangle count, real-world size (bounding box in meters)
  - **style**
  - **category**
  - **venue tags**
  - artist, **pack**, license and source link
- **Packs** are the unit of switching. Turning a pack off hides its models from catalog browsing and blocks new links
  into scene libraries, effective immediately, no deploy. Turning it back on restores them.
- **Already-placed models stay.** Turning a pack off never removes or breaks a model already in someone's scene or
  scene library (the user's ruling).
- Catalog models link into a scene's library without counting against the user's storage. This already works:
  `linkToScene` links public catalog models with no copy.
- People can browse and filter the catalog on the website (style, category, venue, pack) and add a model to a
  scene's library from there.
- Credit is visible:
  - each model shows its artist and license
  - a credits page lists every pack with its license text, including Mr Dhingia's MIT notice

## Non-goals

- Layouts, the website scene builder, the in-world design studio (projects 2–4).
- Legal clearance with Decentraland or Last Slice (the user handles it later).
- Browsing the catalog from the in-world HUD (project 4).
- Re-importing automatically when the source repos change. A manual re-run is fine.

## Anti-goals (a failure even if it "works")

- A catalog model counting against anyone's storage.
- Switching a pack off making models vanish or break in existing scenes.
- Running the import twice and getting duplicates.
- The same model showing up twice because two sources carry it, e.g. Decentraland's Builder models inside Last Slice's
  `current-builder-assets/`.

## Decisions

### Packs

- A new `catalog_packs` table with these columns:
  - `id` (slug)
  - `name`
  - `source` (`dhingia` | `last-slice` | `decentraland`)
  - `license` (`mit` | `cc-by-nc-3.0` | `unstated`)
  - `attribution` (text to show; the full MIT notice for Dhingia)
  - `source_url`
  - `enabled` (default true)
- `asset_library_items` gains:
  - `pack_id`
  - `style`
  - `venue_tags text[]`
  - `source_ref`: the item's id or path in its source. Unique per pack, which makes re-imports idempotent.
- Pack granularity (my call): one pack per source × artist or collection.
  - Last Slice gives one pack per artist (`last-slice-kirzoz`, …), so an artist who objects can be switched off alone.
  - Decentraland gives one pack per Creator Hub pack, plus one per old Builder pack.
  - Mr Dhingia gives `dhingia-buildings`, `dhingia-interiors` and `dhingia-dj`.
- Switching is admin-only:
  - API: `PATCH /api/admin/catalog/packs/:id {enabled}`
  - a small admin page in the dashboard listing packs with model counts and a toggle
  - admins are users with `role === 'admin'`, as in `feature-gate.ts`
- Imported rows: `is_public = true`, `uploaded_by = null`, and `pack_id` set. A non-null `pack_id` is what marks a
  catalog model. Catalog models are never counted toward anyone's storage. (My call.)
- A disabled pack's items are left out of browsing (`GET /api/assets` list and categories). They're refused when
  linking a model into a scene library, with a clear error. Already-linked items still show in scene libraries, still
  resolve by id (`GET /api/assets/:id`) and still render. The switch only stops new picks. (My call, from "leave
  them".)
- Today, the scene library's add route (`POST /api/scenes/:sceneId/library`) only accepts an asset you uploaded.
  It's widened to also accept a public catalog model in an enabled pack, which is what "Add to scene" uses. (My
  call.)

### Styles, categories, venue tags

- **Style** is one value from a fixed list, mapped from Last Slice's `sty` and from Decentraland pack names. Draft
  list: Cyberpunk, Sci-Fi, Fantasy, Western, Steampunk, Pirates, Asian, Modern, Cozy, Minimalist, Industrial, Nature,
  Voxel, Halloween, Classic. "Cozy" and "Minimalist" come from the user's own examples.
- **Category** is what the object is. Fixed list: Building, Structure (walls, floors, stairs), Furniture, Lighting,
  Decor, Plants & Nature, Food & Drink, Tech & Music, Signage, Vehicles, Characters & Animals, Effects, Other.
- **Venue tags** say where the object fits: café, club, gallery, shop, office, home, outdoor, stage, beach, gym, and
  so on. A chair can fit many. These are what "I need a café" filters on. Kept separate from category because the
  user's "kind" (café) is a place, not an object.
- Tagging (my call): I propose the style, category and venue tags from names, Last Slice's `cat` / `sty` /
  description, and folder paths. The output is a reviewable CSV or JSON checked into the repo. The user reviews it
  before import. The import reads that file, so tags are data and can be fixed by editing it and re-running.

### Import

- A one-off server script, `pnpm --filter vlm-server catalog:import <source> <path-to-downloaded-repo>`:
  - reads the tag file
  - uploads GLBs and thumbnails to the configured storage (R2 in production)
  - computes triangle count and bounding box from the GLB where the source doesn't give them
  - upserts by `(pack_id, source_ref)`
- Duplicates across sources:
  - Decentraland's models are imported only as Decentraland packs, never as Last Slice.
  - Last Slice's `current-builder-assets/` is skipped.
  - Identical files are recognised by content hash. When two packs carry the same file, Decentraland keeps it over
    Last Slice, and otherwise the first import keeps it. (My call.)
- Tests run against small fixture repos, never the real 1–2 GB downloads. The production import is run from a
  local machine against production storage and database, and only with the user's OK each time.
- Missing thumbnails (Mr Dhingia's props) are rendered once, offline, before import, e.g. in Blender. Until then the
  catalog shows a placeholder.
- Rough size: about 6,000 models, 1–2 GB. Small for R2.
- Mr Dhingia's whole buildings can be 8 MB and heavy. File size and triangle count are recorded so later projects can
  warn about parcel limits. This project doesn't enforce them.

### Browsing

- `GET /api/assets` gains `style`, `venue`, `pack` and `category` filters, and returns each item's pack name, artist
  and license.
- The dashboard's existing 3D Asset Library page gets those filters, an artist/license credit line per model, and
  "Add to scene", which picks one of your scenes and links the model into its library. It uses the existing scene
  library link, so it needs no storage.
- A public `/credits` page lists every pack that has models, enabled or not, with its artist, license and source
  link, and the full MIT notice. Disabled packs stay listed because their models may still be in scenes. (My call.)
- The admin pack page is a dashboard page shown only to admins. (My call.)

## Left to the builder

- Exact table and column names, migration shape (follow `entrypoint.sh`'s fallback-ALTER habit), route file layout.
- How to compute the bounding box and triangle count (e.g. `@gltf-transform`).
- The admin page's look.
- Whether to keep the old `dimensions` jsonb or replace it with the bounding box.
- Final style and category lists. The drafts above are a starting point; the tag review settles them.
