# VLM v2 — Decentraland Inspector Integration & Smart Item Spec

Embed the Decentraland 3D scene editor directly in the VLM dashboard for visual scene layout, and publish a VLM Smart Item that creators drag into their scenes to connect to VLM and get the management HUD.

---

## Table of Contents

1. [Overview](#1-overview)
2. [Inspector Embedding](#2-inspector-embedding)
3. [VLM ↔ Inspector Data Bridge](#3-vlm--inspector-data-bridge)
4. [Dashboard UX Flow](#4-dashboard-ux-flow)
5. [VLM Smart Item](#5-vlm-smart-item)
6. [Smart Item: Technical Design](#6-smart-item-technical-design)
7. [Smart Item: Creator Hub Integration](#7-smart-item-creator-hub-integration)
8. [Phased Build Plan](#8-phased-build-plan)

---

## 1. Overview

Two integration points with the Decentraland Creator Hub ecosystem:

### A. Embed `@dcl/inspector` in the VLM Dashboard

Replace the current number-input-based positioning (X/Y/Z fields) with a visual 3D scene editor. Users drag VLM elements around in a BabylonJS-rendered preview of their Decentraland scene. Changes sync back to VLM's scene data via the inspector's RPC interface.

**Value:** Scene layout goes from "type coordinates and hope for the best" to "drag it where you want it."

### B. VLM Smart Item for the Creator Hub

A drag-and-drop Smart Item that appears in the Creator Hub's asset catalog. When a creator drops it into their scene, it:
- Connects the scene to VLM's servers
- Activates the in-world management HUD
- Loads all VLM-managed elements (video screens, images, models, sounds)
- No code required — just drag, configure the scene ID, and deploy

**Value:** Zero-code VLM integration for Decentraland creators who use the Creator Hub.

---

## 2. Inspector Embedding

### How It Works

The `@dcl/inspector` is a standalone React + BabylonJS web app designed to be embedded via iframe. Communication between the parent app (VLM dashboard) and the inspector happens through `postMessage` RPC using `@dcl/mini-rpc`.

### Architecture

```
VLM Dashboard (Next.js)
  └── Scene Editor Page
      ├── VLM Element Panel (left sidebar)
      │   └── List of VLM elements, properties, add/remove
      ├── Inspector IFrame (center)
      │   └── @dcl/inspector (BabylonJS 3D viewport)
      │       └── Communicates via postMessage RPC
      └── Properties Panel (right sidebar)
          └── Selected element properties, transform, VLM-specific settings
```

### Embedding the Inspector

```tsx
// apps/web/src/components/InspectorEmbed.tsx

const INSPECTOR_URL = 'https://inspector.decentraland.org' // or self-hosted

function InspectorEmbed({ sceneId }: { sceneId: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    if (!iframeRef.current) return
    const rpc = initInspectorRpc(iframeRef.current)
    return () => rpc.dispose()
  }, [])

  const params = new URLSearchParams({
    dataLayerRpcParentUrl: window.location.origin,
    disableSmartItems: 'false',
  })

  return (
    <iframe
      ref={iframeRef}
      src={`${INSPECTOR_URL}?${params}`}
      className="w-full h-full border-0"
      allow="cross-origin-isolated"
    />
  )
}
```

### RPC Bridge Setup

The parent (VLM dashboard) must implement the Storage RPC to handle file operations from the inspector. Instead of a real filesystem, VLM maps these to its own scene data:

```typescript
import { MessageTransport } from '@dcl/mini-rpc'

function initInspectorRpc(iframe: HTMLIFrameElement) {
  const transport = new MessageTransport(window, iframe.contentWindow!)
  const storage = new StorageRPC(transport)

  // Map file operations to VLM's scene data API
  storage.handle('read_file', async ({ path }) => {
    if (path === 'scene.json') return buildSceneJsonFromVLM(sceneId)
    if (path.endsWith('.composite')) return buildCompositeFromVLMElements(sceneId)
    return fetchAssetFile(path)
  })

  storage.handle('write_file', async ({ path, content }) => {
    if (path.endsWith('.composite')) {
      // Parse inspector changes and sync back to VLM
      await syncInspectorChangesToVLM(sceneId, content)
    }
  })

  storage.handle('exists', async ({ path }) => {
    // Check if the file exists in VLM's virtual filesystem
    return knownFiles.has(path)
  })

  storage.handle('list', async ({ path }) => {
    // Return directory listing for the inspector
    return getVirtualDirectoryListing(path)
  })

  storage.handle('delete', async ({ path }) => {
    // Handle file deletion
  })

  return { storage, dispose: () => storage.dispose() }
}
```

### Data Layer RPC Methods

The inspector's Data Layer provides these operations that VLM can hook into:

| Method | Purpose | VLM Mapping |
|--------|---------|-------------|
| `CrdtStream` | Scene state sync (bidirectional) | Sync transforms, materials to VLM elements |
| `GetAssetCatalog` | Load asset packs | Include VLM assets alongside DCL defaults |
| `CreateCustomAsset` | User-created items | Save as VLM media asset |
| `GetFiles` / `SaveFile` | File operations | Map to VLM scene data |
| `Undo` / `Redo` | State reversal | Maintain local undo stack |
| `Save` | Persist changes | Push to VLM API |

---

## 3. VLM ↔ Inspector Data Bridge

The core challenge: the inspector speaks Decentraland's ECS component format, VLM has its own element model. A translation layer converts between them.

### VLM → Inspector (Loading)

When the inspector loads, VLM generates a Decentraland `.composite` file from its scene data:

```typescript
function vlmElementToInspectorEntity(element: VLMElement, instance: VLMInstance) {
  // VLM element → DCL entity with components
  return {
    id: instance.id,
    components: {
      'core::Transform': {
        position: instance.position,    // { x, y, z }
        rotation: eulerToQuaternion(instance.rotation),
        scale: instance.scale,
      },
      // Map element type to DCL components
      ...(element.type === 'video' ? {
        'core::VideoPlayer': { src: element.properties.liveSrc },
        'core::MeshRenderer': { mesh: { $case: 'plane', plane: {} } },
        'core::Material': { material: { $case: 'pbr', pbr: { texture: { videoTexture: {} } } } },
      } : {}),
      ...(element.type === 'image' ? {
        'core::MeshRenderer': { mesh: { $case: 'plane', plane: {} } },
        'core::Material': { material: { $case: 'pbr', pbr: { texture: { src: element.properties.textureSrc } } } },
      } : {}),
      ...(element.type === 'model' ? {
        'core::GltfContainer': { src: element.properties.modelSrc },
      } : {}),
      ...(element.type === 'sound' ? {
        'core::AudioSource': { audioClipUrl: element.properties.audioSrc, playing: false, volume: element.properties.volume },
      } : {}),
    },
    // Tag with VLM metadata so we can map changes back
    vlmMetadata: {
      elementId: element.id,
      instanceId: instance.id,
      elementType: element.type,
    },
  }
}
```

### Inspector → VLM (Saving)

When the user moves/edits entities in the inspector, VLM intercepts the `write_file` calls and maps changes back:

```typescript
function syncInspectorChangesToVLM(sceneId: string, compositeData: Buffer) {
  const entities = parseComposite(compositeData)

  for (const entity of entities) {
    const meta = entity.vlmMetadata
    if (!meta) continue // Not a VLM-managed entity

    // Extract transform changes
    const transform = entity.components['core::Transform']
    if (transform) {
      await api.updateInstance(meta.instanceId, {
        position: transform.position,
        rotation: quaternionToEuler(transform.rotation),
        scale: transform.scale,
      })
    }

    // Extract material/property changes per element type
    // ... (video src, image texture, model url, audio url)
  }
}
```

### Conflict Resolution

Both VLM (via Colyseus real-time sync) and the inspector can modify the same data:

1. **Inspector is source of truth for transforms** during visual editing
2. **VLM is source of truth for element properties** (video URL, playlist, etc.)
3. When the user saves in the inspector, changes push to VLM via API
4. When VLM receives Colyseus updates from another client (e.g., the in-world HUD), the inspector iframe receives updated data via the RPC bridge

---

## 4. Dashboard UX Flow

### Scene Editor with Inspector

```
┌─────────────────────────────────────────────────────────────────┐
│  Scene: "My Gallery"                               [Save] [Deploy] │
├───────────┬─────────────────────────────────────┬───────────────┤
│ Elements  │                                     │  Properties   │
│           │                                     │               │
│ ▸ Videos  │    ┌─────────────────────────┐      │  Transform    │
│   Stream1 │    │                         │      │  X: 8.0       │
│ ▸ Images  │    │  @dcl/inspector         │      │  Y: 2.5       │
│   Logo    │    │  (3D viewport)          │      │  Z: 12.0      │
│   Banner  │    │                         │      │               │
│ ▸ Models  │    │  [drag elements here]   │      │  Rotation     │
│   Stage   │    │                         │      │  X: 0  Y: 90  │
│ ▸ Sounds  │    │                         │      │               │
│   BGM     │    └─────────────────────────┘      │  VLM Props    │
│           │                                     │  Texture: ... │
│ [+ Add]   │    [2D] [3D] [Top] [Free]           │  Enabled: ✓   │
├───────────┴─────────────────────────────────────┴───────────────┤
│  Tabs: [Visual Editor] [Element List] [Presets] [Collaborators] │
└─────────────────────────────────────────────────────────────────┘
```

### Workflow

1. User opens a scene → VLM loads the inspector with the scene's elements rendered as DCL entities
2. User drags an element in the 3D viewport → inspector updates transform → RPC bridge syncs to VLM
3. User clicks an element → Properties panel shows VLM-specific settings (video URL, playlist, etc.)
4. User clicks [Save] → all pending changes push to VLM API → Colyseus broadcasts to live scenes
5. User clicks [Deploy] → VLM builds the DCL scene with all elements and deploys to catalyst

### Toggle: Visual Editor vs Element List

The current number-input UI stays as a tab alongside the inspector. Users can switch between:
- **Visual Editor** — the inspector iframe for drag-and-drop positioning
- **Element List** — the current tab-based view (Videos/Images/Models/Sounds) for property editing

---

## 5. VLM Smart Item

### What It Does

A single drag-and-drop item that creators place in their Decentraland scene via the Creator Hub. When the scene runs, the smart item:

1. Connects to VLM's API using the configured scene ID
2. Joins the Colyseus room for real-time updates
3. Loads all VLM-managed elements and renders them in the scene
4. Activates the VLM in-world HUD for the scene operator
5. Starts analytics tracking (sessions, actions, movement)

### For the Creator

1. Open Creator Hub
2. Find "VLM Manager" in the asset catalog (or import the asset pack)
3. Drag it into the scene
4. Set the `sceneId` parameter to their VLM scene ID
5. Optionally set the `serverUrl` if self-hosting
6. Deploy — VLM is now connected

No code, no npm install, no imports. The smart item handles everything.

---

## 6. Smart Item: Technical Design

### File Structure

```
vlm-smart-item/
├── asset.json              # Smart item manifest
├── models/
│   └── vlm_beacon.glb      # Small visual indicator model (VLM logo cube)
├── src/
│   └── item.ts             # Smart item entry point
└── thumbnail.png           # Catalog thumbnail
```

### asset.json (Manifest)

```json
{
  "id": "vlm-manager-v2",
  "name": "VLM Manager",
  "tags": ["vlm", "virtual land manager", "management", "hud", "video", "streaming"],
  "category": "utils",
  "model": "models/vlm_beacon.glb",
  "parameters": [
    {
      "id": "sceneId",
      "label": "VLM Scene ID",
      "type": "text",
      "default": ""
    },
    {
      "id": "serverUrl",
      "label": "VLM Server URL",
      "type": "text",
      "default": "https://vlm.gg"
    },
    {
      "id": "showBeacon",
      "label": "Show VLM Beacon in Scene",
      "type": "boolean",
      "default": false
    },
    {
      "id": "enableHud",
      "label": "Enable Management HUD",
      "type": "boolean",
      "default": true
    },
    {
      "id": "enableAnalytics",
      "label": "Enable Analytics Tracking",
      "type": "boolean",
      "default": true
    },
    {
      "id": "autoConnect",
      "label": "Auto-Connect on Scene Load",
      "type": "boolean",
      "default": true
    }
  ],
  "actions": [
    {
      "id": "connect",
      "label": "Connect to VLM",
      "parameters": []
    },
    {
      "id": "disconnect",
      "label": "Disconnect from VLM",
      "parameters": []
    },
    {
      "id": "toggleHud",
      "label": "Toggle Management HUD",
      "parameters": []
    },
    {
      "id": "switchPreset",
      "label": "Switch Scene Preset",
      "parameters": [
        {
          "id": "presetId",
          "label": "Preset ID",
          "type": "text"
        }
      ]
    },
    {
      "id": "triggerGiveaway",
      "label": "Trigger Giveaway",
      "parameters": [
        {
          "id": "giveawayId",
          "label": "Giveaway ID",
          "type": "text"
        }
      ]
    }
  ]
}
```

### item.ts (Entry Point)

```typescript
import { createVLM } from 'vlm-adapter-dcl'

export default class VLMManagerItem {
  private vlm: ReturnType<typeof createVLM> | null = null

  init() {
    // Called once when the scene starts
  }

  spawn(host: any, props: any, channel: any) {
    // Called for each instance of the smart item
    const {
      sceneId,
      serverUrl,
      showBeacon,
      enableHud,
      enableAnalytics,
      autoConnect,
    } = props

    if (!sceneId) {
      console.warn('[VLM] No scene ID configured — skipping initialization')
      return
    }

    // Hide the beacon model unless explicitly shown
    if (!showBeacon) {
      // Set the model entity to invisible
      host.setVisible(false)
    }

    if (autoConnect) {
      this.connect(sceneId, serverUrl, enableHud, enableAnalytics)
    }

    // Listen for actions from other smart items
    channel.handleAction('connect', () => this.connect(sceneId, serverUrl, enableHud, enableAnalytics))
    channel.handleAction('disconnect', () => this.disconnect())
    channel.handleAction('toggleHud', () => this.vlm?.toggleHud())
    channel.handleAction('switchPreset', ({ presetId }: any) => this.vlm?.switchPreset(presetId))
    channel.handleAction('triggerGiveaway', ({ giveawayId }: any) => this.vlm?.triggerGiveaway(giveawayId))
  }

  private async connect(
    sceneId: string,
    serverUrl: string,
    enableHud: boolean,
    enableAnalytics: boolean,
  ) {
    this.vlm = createVLM({
      sceneId,
      serverUrl,
      features: {
        hud: enableHud,
        analytics: enableAnalytics,
      },
    })

    await this.vlm.init()
    console.log('[VLM] Connected to', serverUrl, 'scene:', sceneId)
  }

  private disconnect() {
    this.vlm?.dispose()
    this.vlm = null
    console.log('[VLM] Disconnected')
  }
}
```

### What Happens at Runtime

```
Scene loads in Decentraland
  → Smart item spawn() fires
  → createVLM() initializes:
      → vlm-client connects to VLM API (auth via platform signed fetch)
      → vlm-client joins Colyseus room for the scene
      → vlm-core receives scene data (elements, instances, presets)
      → vlm-adapter-dcl creates DCL entities for each VLM element
      → vlm-hud activates the management overlay (if enableHud=true)
      → Analytics session starts (if enableAnalytics=true)
  → Scene is now VLM-managed
  → Dashboard changes appear in real-time
  → HUD lets the operator manage from inside the world
```

---

## 7. Smart Item: Creator Hub Integration

### Distribution Options

#### Option A: Official Asset Pack (Best UX)

Submit the VLM Smart Item as an asset pack to Decentraland's catalog:
- Appears in the Creator Hub's built-in asset browser
- Users search "VLM" and drag it in
- Requires approval from the Decentraland Foundation

#### Option B: Custom Asset Pack (Immediate)

Publish as a standalone asset pack that users import:
1. VLM dashboard has a "Get the Decentraland Smart Item" button
2. Downloads a `.zip` asset pack
3. User imports it into Creator Hub via "Import Custom Assets"
4. Smart item appears in their local catalog

#### Option C: NPM Package (For Developers)

Publish `vlm-smart-item-dcl` on npm:
```bash
npm install vlm-smart-item-dcl
```
Developers import it in their scene code — this is what `vlm-adapter-dcl` already does, but wrapped as a Smart Item for the visual editor.

### Integration with Other Smart Items

The VLM Smart Item exposes actions that other Smart Items can trigger:

- A "Start Event" button → triggers `connect` action on VLM Manager
- A door opening → triggers `switchPreset` to change the scene layout
- A timer countdown → triggers `triggerGiveaway` when it hits zero

This lets creators build interactive flows that incorporate VLM's features without writing code.

---

## 8. Phased Build Plan

### Phase 1: VLM Smart Item (2-3 days)

The smart item is simpler and delivers immediate value.

- [ ] Create `vlm-smart-item/` directory with asset.json manifest
- [ ] Build the beacon GLB model (small VLM logo cube, ~10KB)
- [ ] Implement item.ts that calls `createVLM()` from vlm-adapter-dcl
- [ ] Wire up all action handlers (connect, disconnect, toggleHud, switchPreset, triggerGiveaway)
- [ ] Package as importable asset pack (.zip)
- [ ] Test in Creator Hub: drag in, set scene ID, deploy, verify VLM connects
- [ ] Add "Get Smart Item" download button to VLM dashboard

### Phase 2: Inspector Embedding — Basic (1 week)

Get the inspector rendering in the dashboard with read-only scene visualization.

- [ ] Install `@dcl/mini-rpc` in apps/web
- [ ] Create `InspectorEmbed` component with iframe + RPC bridge
- [ ] Implement Storage RPC handlers that serve VLM scene data as DCL files
- [ ] Build VLM-to-DCL element translator (position, rotation, scale, materials)
- [ ] Add "Visual Editor" tab to the scene editor page
- [ ] Render VLM elements in the inspector viewport (read-only initially)

### Phase 3: Inspector Embedding — Bi-directional Editing (1 week)

Make the inspector editable with changes syncing back to VLM.

- [ ] Implement `write_file` handler to parse inspector changes
- [ ] Build DCL-to-VLM reverse translator (transform, material changes → API updates)
- [ ] Handle conflict resolution (inspector vs Colyseus updates)
- [ ] Wire up Colyseus broadcasts when inspector edits are saved
- [ ] Add the Properties panel alongside the inspector
- [ ] Implement undo/redo via the inspector's Data Layer RPC

### Phase 4: Asset Catalog Integration (3-5 days)

Let users browse VLM's asset library and media from within the inspector.

- [ ] Implement `GetAssetCatalog` to include VLM media assets
- [ ] Implement `CreateCustomAsset` to save inspector items to VLM
- [ ] Bridge VLM's media upload to the inspector's asset import flow
- [ ] Show VLM media library thumbnails in the inspector's asset panel

### Phase 5: Deploy from Inspector (2-3 days)

Deploy the scene directly from the visual editor.

- [ ] "Deploy" button in the visual editor toolbar
- [ ] Build the full DCL scene package from the inspector state + VLM smart item
- [ ] Use VLM's existing DCL deployer service
- [ ] Show deployment progress/status in the dashboard

---

## Dependencies

### For Inspector Embedding

```json
{
  "@dcl/mini-rpc": "latest",
  "@dcl/inspector": "latest"
}
```

Or use the hosted inspector at `https://inspector.decentraland.org` (no local dependency needed for iframe approach).

### For Smart Item

The smart item bundles `vlm-adapter-dcl`, `vlm-core`, and `vlm-client` into a single file that the Creator Hub's runtime loads. The bundle should be tree-shaken and minified — target under 200KB.

---

## Estimated Total Effort

| Phase | Effort | Value |
|-------|--------|-------|
| Smart Item | 2-3 days | Zero-code VLM for Creator Hub users |
| Inspector read-only | 1 week | Visual scene preview in dashboard |
| Inspector bi-directional | 1 week | Drag-and-drop scene layout |
| Asset catalog bridge | 3-5 days | Unified asset browsing |
| Deploy from inspector | 2-3 days | End-to-end visual workflow |

**Total: ~4-5 weeks for everything, ~3 days for the smart item alone.**
