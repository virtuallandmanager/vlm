# VLM v2 — WebXR "Phygital" Adapter Specification

Turn any physical space into a VLM-managed "phygital" experience. Visitors scan a QR code, tap "Enter AR," and see VLM scene elements — video screens, images, 3D models, spatial audio — overlaid on the real world through their device's browser. No app install required.

The same dashboard, the same Colyseus real-time sync, the same analytics pipeline. Just a new renderer.

---

## Table of Contents

1. [Concept](#1-concept)
2. [How It Works](#2-how-it-works)
3. [Device Support](#3-device-support)
4. [Architecture](#4-architecture)
5. [Spatial Anchoring](#5-spatial-anchoring)
6. [WebXR AR App](#6-webxr-ar-app)
7. [VLM Adapter: vlm-adapter-webxr](#7-vlm-adapter-vlm-adapter-webxr)
8. [Dashboard Changes](#8-dashboard-changes)
9. [AR-Specific Element Properties](#9-ar-specific-element-properties)
10. [Analytics Extensions](#10-analytics-extensions)
11. [Use Cases](#11-use-cases)
12. [Phased Build Plan](#12-phased-build-plan)
13. [Limitations & Future Work](#13-limitations--future-work)

---

## 1. Concept

VLM currently lets a Virtual Land Manager place and control scene elements in virtual worlds (Decentraland, Hyperfy). The WebXR adapter extends this to **physical spaces** — a gallery, retail store, event venue, trade show booth, or public installation.

The venue operator manages their physical AR experience from the same VLM dashboard they use for virtual worlds. The audience experiences it through their phone or headset browser. Content updates in real-time — swap a video during a live event, toggle a 3D product display on or off, trigger a giveaway — all from the dashboard or in-world HUD, just like a virtual scene.

**The key insight:** from VLM's perspective, a physical space is just another platform. The scene data model, real-time sync, event system, analytics, and management tools are platform-agnostic. Only the rendering layer changes.

---

## 2. How It Works

### For the Venue Operator

1. Create a scene in the VLM dashboard (same as for a virtual world)
2. Add elements: video screens, images, 3D models, sounds
3. Position elements relative to anchor points in the physical space
4. Generate a QR code / short URL for the space (e.g., `vlm.gg/ar/my-venue`)
5. Print and place the QR code at the venue entrance
6. Manage content in real-time from the dashboard during events

### For the Visitor

1. Scan the QR code with their phone camera
2. Browser opens to the AR experience URL
3. Tap "Enter AR" — the browser requests camera + motion permissions
4. The phone camera activates, and VLM elements appear overlaid on the real world
5. Walk around the space — elements stay anchored to their positions
6. Interact with elements (tap a video to play, tap a 3D model for info)

### For Vision Pro / Quest Users

Same URL. Safari or Meta Browser opens the WebXR session in passthrough mode. The user sees their physical space with VLM elements blended in, using hand gestures to interact.

---

## 3. Device Support

WebXR `immersive-ar` is supported on:

| Device | Browser | Input | AR Quality |
|--------|---------|-------|------------|
| iPhone (iOS 15+) | Safari | Touch/tap | Camera-based, phone screen |
| Android | Chrome | Touch/tap | ARCore surface detection |
| Apple Vision Pro | Safari | Hand gestures, eye tracking | Full passthrough, spatial |
| Meta Quest 3/Pro | Meta Browser | Controllers, hand tracking | Full passthrough, spatial |
| Meta Quest 2 | Meta Browser | Controllers | Passthrough (grayscale) |

All devices use the same WebXR code. The browser abstracts device-specific capabilities (camera vs passthrough, touch vs hand tracking) behind the standard WebXR API.

### Fallback

Devices without WebXR AR support (older phones, desktop browsers) get a **3D viewer mode** — the scene renders in a Three.js viewport that the user can orbit/pan/zoom. Not AR, but still interactive. This ensures the URL always works even if AR isn't available.

---

## 4. Architecture

```
Visitor's Device (iPhone / Vision Pro / Quest)
  └── Browser (Safari / Chrome / Meta Browser)
      └── WebXR AR Session
          └── Three.js Scene
              └── vlm-adapter-webxr  ← new
                  └── vlm-core (scene management, element managers)
                      └── vlm-client (Colyseus WS + HTTP API)
                          └── VLM API Server (same server as virtual worlds)
```

The adapter is a standard `VLMPlatformAdapter` implementation. It receives the same scene data and Colyseus messages as the Decentraland and Hyperfy adapters. Instead of creating DCL entities or Hyperfy React components, it creates Three.js objects and places them in the WebXR scene.

### Package Map

| Package | Role |
|---------|------|
| `packages/vlm-adapter-webxr` | `VLMPlatformAdapter` implementation for Three.js + WebXR |
| `apps/ar` | Next.js app (or route in `apps/web`) serving the AR experience at `/ar/[spaceId]` |
| `packages/vlm-core` | Unchanged — scene management, element managers |
| `packages/vlm-client` | Unchanged — Colyseus + HTTP client |
| `packages/vlm-shared` | Minor additions — AR-specific element properties in shared types |

---

## 5. Spatial Anchoring

The core challenge of AR is: **where do virtual objects go in physical space?**

### Anchor Strategies (implement in order of complexity)

#### Phase 1: Origin-Relative Placement
- The AR session starts wherever the user taps "Enter AR"
- That tap point becomes the scene origin (0, 0, 0)
- VLM elements are placed relative to this origin using their existing position/rotation/scale
- **Pros:** Works immediately, no setup required
- **Cons:** Origin shifts every session, no persistence between visits

#### Phase 2: QR/Image Marker Anchors
- The venue places printed markers (QR codes or images) at known positions
- The AR app detects markers via WebXR's image tracking API
- Each marker maps to a known position in the VLM scene coordinate space
- When a marker is detected, the scene snaps to the correct alignment
- **Pros:** Consistent placement across visits, cheap to set up
- **Cons:** Requires printing markers, line-of-sight to at least one marker

#### Phase 3: Floor Plan Anchoring
- Venue uploads a floor plan to the VLM dashboard
- Operator places elements on the floor plan (2D drag-and-drop with height controls)
- AR app uses device surface detection to identify the floor plane
- User aligns the floor plan to the physical space once (point device at a known corner)
- Elements render at the correct positions relative to the floor plan
- **Pros:** No markers needed, intuitive setup
- **Cons:** Requires initial alignment per session

#### Phase 4: Persistent Anchors (Future — Native Only)
- ARKit/ARCore persistent anchors remember positions across sessions
- Visitor returns to the space and elements appear immediately without re-alignment
- Requires native app (not WebXR — the browser doesn't expose persistent anchors yet)
- **This is the reason to eventually build a native iOS/visionOS app as a follow-up**

---

## 6. WebXR AR App

### Entry Point

The AR experience is served as a web page. Two options:

**Option A: Route in existing web app**
```
apps/web/src/app/ar/[spaceId]/page.tsx
URL: https://vlm.gg/ar/my-venue
```

**Option B: Separate app** (recommended for bundle size)
```
apps/ar/
URL: https://ar.vlm.gg/my-venue
```

A separate app avoids loading the dashboard's React/Tailwind bundle. The AR app should be as lean as possible — Three.js + vlm-core + vlm-client + the adapter. Target under 500KB gzipped for fast load on mobile.

### Page Flow

```
1. Load page → show venue info (name, description, thumbnail)
2. Check WebXR support → navigator.xr.isSessionSupported('immersive-ar')
3. If supported → show "Enter AR" button
4. If not → show 3D viewer fallback (orbit camera)
5. User taps "Enter AR" → requestSession('immersive-ar', { requiredFeatures: [...] })
6. Session starts → create Three.js WebGLRenderer with xr.enabled = true
7. Connect to Colyseus room (same as dashboard/in-world SDK)
8. Receive scene data → vlm-core creates elements → adapter renders Three.js objects
9. Render loop: renderer.setAnimationLoop(() => { ... })
10. User taps "Exit" or closes browser → session ends, connection closed
```

### Required WebXR Features

```javascript
const session = await navigator.xr.requestSession('immersive-ar', {
  requiredFeatures: ['local-floor'],      // basic spatial tracking
  optionalFeatures: [
    'hit-test',                            // tap to place
    'dom-overlay',                         // 2D UI overlay on top of AR
    'image-tracking',                      // QR/marker detection (Phase 2)
    'hand-tracking',                       // Vision Pro / Quest
    'anchors',                             // persistent anchors (limited support)
  ],
})
```

### DOM Overlay

WebXR's `dom-overlay` feature lets you render HTML on top of the AR view. Use this for:
- Element info panels (tap a 3D model → see name/description)
- Mini controls (volume slider for spatial audio, play/pause for video)
- Navigation UI (back button, settings)
- VLM HUD (simplified version of the in-world management HUD)

---

## 7. VLM Adapter: vlm-adapter-webxr

### Package Structure

```
packages/vlm-adapter-webxr/
├── src/
│   ├── index.ts                  # createVLM() entry point for AR
│   ├── WebXRAdapter.ts           # VLMPlatformAdapter implementation
│   ├── elements/
│   │   ├── ARVideoElement.ts     # Three.js VideoTexture + PlaneGeometry
│   │   ├── ARImageElement.ts     # Three.js TextureLoader + PlaneGeometry
│   │   ├── ARModelElement.ts     # Three.js GLTFLoader
│   │   ├── ARSoundElement.ts     # Three.js PositionalAudio
│   │   └── ARWidgetElement.ts    # DOM overlay or CSS3DRenderer
│   ├── anchoring/
│   │   ├── OriginAnchor.ts       # Phase 1: session-relative positioning
│   │   ├── MarkerAnchor.ts       # Phase 2: image/QR marker tracking
│   │   └── FloorPlanAnchor.ts    # Phase 3: floor plan alignment
│   ├── input/
│   │   ├── TapHandler.ts         # Touch/tap interaction (iPhone/Android)
│   │   ├── GazeHandler.ts        # Eye tracking interaction (Vision Pro)
│   │   └── HandHandler.ts        # Hand gesture interaction (Vision Pro/Quest)
│   └── xr/
│       ├── XRSessionManager.ts   # Session lifecycle, render loop
│       └── XRHitTest.ts          # Surface detection for placing objects
├── package.json
└── tsconfig.json
```

### Adapter Method Mapping

Each `VLMPlatformAdapter` method maps to Three.js operations:

| Adapter Method | Three.js Implementation |
|---------------|------------------------|
| `createEntity()` | `new THREE.Group()` added to scene |
| `removeEntity()` | `scene.remove(group); group.dispose()` |
| `setTransform()` | `group.position.set(); group.quaternion.set(); group.scale.set()` |
| `setMeshShape()` | `new THREE.PlaneGeometry()` or `new THREE.BoxGeometry()` |
| `setGltfModel()` | `gltfLoader.load(url)` → add to group |
| `setVideoTexture()` | `new THREE.VideoTexture(videoElement)` → material.map |
| `setImageTexture()` | `textureLoader.load(url)` → material.map |
| `setAudioSource()` | `new THREE.PositionalAudio(listener)` → load buffer |
| `setCollider()` | `new THREE.Box3().setFromObject(group)` for raycasting |
| `getUserData()` | Anonymous (no wallet) — generate session ID |
| `getSceneInfo()` | Return space ID from URL params |

### Dependencies

```json
{
  "three": "^0.170.0",
  "@types/three": "^0.170.0",
  "vlm-core": "workspace:*",
  "vlm-client": "workspace:*",
  "vlm-shared": "workspace:*"
}
```

Three.js is the only significant dependency. It has built-in WebXR support via `WebGLRenderer.xr`.

---

## 8. Dashboard Changes

### New Concepts

#### Spaces

A **Space** is a scene with AR-specific metadata:

```typescript
// Addition to scene properties (stored in scene.metadata JSONB)
interface SpaceMetadata {
  type: 'ar'
  anchorStrategy: 'origin' | 'marker' | 'floorplan'
  floorPlanUrl?: string              // uploaded floor plan image
  floorPlanScale?: number            // meters per pixel
  markers?: Array<{
    id: string
    imageUrl: string                 // the marker image
    physicalWidthMeters: number      // real-world size for detection
    position: { x: number; y: number; z: number }
    rotation: { x: number; y: number; z: number }
  }>
  venueInfo?: {
    name: string
    address: string
    description: string
    coverImageUrl: string
  }
}
```

No new database tables needed — this all fits in the existing `scenes.metadata` or `scene_elements.properties` JSONB columns.

#### QR Code Generation

The dashboard generates a QR code for any AR space URL. Add a "QR Code" button on the scene page that:
1. Generates a QR code for `{PUBLIC_URL}/ar/{sceneId}` (or a short slug)
2. Allows download as PNG/SVG for printing
3. Optionally includes the VLM logo in the center

### Floor Plan Editor (Phase 3)

A 2D canvas in the dashboard where the operator:
1. Uploads a floor plan image (PNG/JPG/PDF)
2. Sets the scale (click two points, enter real-world distance)
3. Drags elements onto the floor plan
4. Sets height for each element (slider: 0m = floor, 3m = ceiling)
5. Preview: see a top-down view with element icons at their positions

This is a stretch goal — Phase 1 and 2 don't need it.

---

## 9. AR-Specific Element Properties

Extend the element `properties` JSONB with optional AR fields:

```typescript
interface ARElementProperties {
  // Billboard: element always faces the user
  billboard?: boolean

  // Occlusion: whether real-world objects can hide this element
  // (limited in WebXR — works better on Vision Pro / Quest 3)
  occludable?: boolean

  // Interaction distance: max distance (meters) for tap/gaze interaction
  interactionDistance?: number

  // Scale mode: 'fixed' keeps the same size regardless of distance,
  // 'world' scales normally with distance (default)
  scaleMode?: 'fixed' | 'world'

  // Visibility range: only show when user is within this distance (meters)
  visibilityRange?: number

  // Ground-locked: snap to detected floor surface
  groundLocked?: boolean
}
```

These properties are ignored by non-AR adapters (Decentraland, Hyperfy) — they just don't read them.

---

## 10. Analytics Extensions

The existing analytics pipeline (sessions + actions) works for AR with minor additions:

### AR-Specific Session Fields

```typescript
// Stored in analytics_sessions.device JSONB
interface ARDeviceInfo {
  type: 'phone' | 'headset' | 'desktop-fallback'
  model?: string          // from navigator.userAgent
  arSupported: boolean
  features: string[]      // which WebXR features were available
}

// Stored in analytics_sessions.location JSONB
interface ARLocationInfo {
  latitude?: number       // if geolocation permission granted
  longitude?: number
  venueName?: string      // from space metadata
}
```

### AR-Specific Actions

| Action | Description |
|--------|-------------|
| `ar_session_start` | User entered AR mode |
| `ar_session_end` | User exited AR mode |
| `ar_element_tap` | User tapped an AR element |
| `ar_element_gaze` | User looked at an element for >2 seconds (Vision Pro) |
| `ar_marker_detected` | A QR/image marker was detected |
| `ar_anchor_placed` | User placed the scene origin |

These flow through the same analytics pipeline — visible in the dashboard alongside virtual world analytics. A venue manager can see "50 visitors in Decentraland, 30 in Hyperfy, 120 in the physical venue" on the same analytics page.

---

## 11. Use Cases

### Brand Pop-Up / Retail

A sneaker brand launches a new shoe. They set up a VLM scene with:
- 3D model of the shoe (rotatable, life-size)
- Video screen playing a promo trailer
- Image elements showing lifestyle photography
- Giveaway: scan to enter a raffle for free shoes

They deploy the same scene to Decentraland (virtual store), Hyperfy (metaverse event space), and their physical flagship store (AR via QR code). One VLM operator manages all three from the command center.

### Art Gallery / Museum

An artist creates an exhibition in VLM:
- 3D sculptures placed throughout the gallery
- Spatial audio (different ambient tracks in different areas)
- Image elements as floating info cards next to real paintings
- Analytics track which pieces get the most attention (dwell time)

### Trade Show / Conference

A company's booth at CES:
- Video screens showing product demos (swap content per meeting)
- 3D models of their product (prospective clients can walk around them)
- Event-linked giveaway (scan QR, claim a digital collectible)
- Analytics: how many booth visitors, avg time spent, most-viewed product

### Live Music / Festival

Stage setup managed through VLM:
- AR visuals synced to the performance (operator triggers from dashboard)
- Floating artwork and effects visible through attendees' phones
- Multi-stage: different AR scenes per stage, one operator manages all
- Giveaway: limited-edition AR collectible for attendees

---

## 12. Phased Build Plan

### Phase 1: Basic AR Viewer (MVP)

**Goal:** VLM scene elements render in AR through the phone camera.

- [ ] `packages/vlm-adapter-webxr` — implement core `VLMPlatformAdapter` methods
  - [ ] `ARVideoElement` — video textures on planes
  - [ ] `ARImageElement` — image textures on planes
  - [ ] `ARModelElement` — GLTF loading
  - [ ] `ARSoundElement` — positional audio
- [ ] `apps/ar` — minimal Next.js app with Three.js + WebXR
  - [ ] `/ar/[spaceId]` — load scene, connect to Colyseus, render AR
  - [ ] "Enter AR" button with WebXR session management
  - [ ] 3D viewer fallback for non-AR devices
  - [ ] Origin-relative placement (scene starts at tap point)
- [ ] Tap-to-interact on phone (play video, trigger action)
- [ ] Colyseus real-time sync (dashboard changes appear in AR immediately)

### Phase 2: Anchoring & QR

**Goal:** AR elements appear at consistent positions in the venue.

- [ ] Image/QR marker tracking via WebXR image-tracking API
- [ ] Dashboard: configure marker images and their positions
- [ ] Dashboard: QR code generator for space URLs
- [ ] Multi-marker support (scan any marker to align the scene)
- [ ] AR-specific analytics actions (session start/end, element tap, marker detected)

### Phase 3: Floor Plan & Editing

**Goal:** Venue operators set up AR without thinking about 3D coordinates.

- [ ] Dashboard: floor plan upload and scale calibration
- [ ] Dashboard: 2D drag-and-drop element placement on floor plan
- [ ] AR app: floor plan alignment flow (point at a known corner)
- [ ] AR-specific element properties (billboard, visibility range, ground-locked)
- [ ] DOM overlay UI for element info panels and mini controls

### Phase 4: Management HUD in AR

**Goal:** Venue operators manage the AR experience from within AR.

- [ ] Simplified VLM HUD rendered as DOM overlay in AR
- [ ] Drag-to-place new elements in AR (hit-test for surface detection)
- [ ] Grab-to-move existing elements in AR
- [ ] Live preview of dashboard changes in AR
- [ ] Hand gesture support for Vision Pro / Quest

### Phase 5: Multi-Venue Command Center

**Goal:** Manage AR installations across multiple physical locations.

- [ ] Command center shows physical venues alongside virtual worlds
- [ ] Per-venue visitor counts, stream health, element status
- [ ] Push content updates to all venues simultaneously
- [ ] Cross-venue analytics (total visitors across all locations)

---

## 13. Limitations & Future Work

### WebXR Limitations

- **No persistent anchors** — the scene resets each session. Users must re-align if using markers. Fix: native iOS/visionOS app with ARKit persistent anchors.
- **No occlusion** — virtual objects render on top of real objects, not behind them. Partially addressed on Vision Pro and Quest 3 with depth sensing. Fix: native app with LiDAR (iPhone Pro).
- **No image tracking on all devices** — WebXR image tracking is behind flags in some browsers. Fallback: origin-relative placement.
- **Battery drain** — AR sessions are GPU-intensive on phones. Keep sessions under 15-20 minutes. Provide a "pause AR" option.
- **Browser permission friction** — camera + motion access requires user approval. Clear onboarding UX is critical.

### Future: Native iOS / visionOS App

A native Swift app using RealityKit would unlock:
- LiDAR occlusion (iPhone Pro, iPad Pro)
- Persistent anchors (elements stay between visits)
- Hand tracking and eye tracking (Vision Pro)
- SharePlay (multiple Vision Pro users see the same AR scene together)
- App Clip (no full app install — launches from QR scan)
- Push notifications ("The event at [venue] starts in 10 minutes")

The native app would use a Swift VLM client (HTTP + WebSocket) that speaks the same protocol as the JS client. The scene data model and server are unchanged — only the client and renderer are native.

### Future: Spatial Audio Improvements

- Audio occlusion (sound muffled by walls)
- Reverb based on room size
- HRTF for headphones (realistic spatial audio without speakers)
- These require the Web Audio API's `PannerNode` with custom HRTF profiles

### Future: Multi-User AR

- Multiple people in the same physical space see the same AR scene
- Shared anchor point (one person sets up, others connect)
- See other users' cursors/positions (collaborative placement)
- Requires cloud anchors (not available in WebXR — needs native or a backend relay)
