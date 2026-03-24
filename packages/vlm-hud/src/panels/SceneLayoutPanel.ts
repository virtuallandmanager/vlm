/**
 * SceneLayoutPanel — List/select/transform scene elements from in-world.
 *
 * Shows all elements and instances in the current scene. Selecting one
 * activates the platform's transform gizmo for move/rotate/scale.
 * Changes sync via Colyseus — same as editing from the dashboard.
 */

import type { HUDRenderer, VLMStorage, EntityHandle } from 'vlm-shared'
import { HUDPanelType } from 'vlm-shared'
import type { ColyseusManager } from 'vlm-client'

interface ElementEntry {
  sk: string
  name: string
  type: string
  enabled: boolean
  instanceCount: number
}

export class SceneLayoutPanel {
  private renderer: HUDRenderer
  private storage: VLMStorage
  private colyseus: ColyseusManager
  private selectedEntity: EntityHandle | null = null
  private gizmoMode: 'move' | 'rotate' | 'scale' = 'move'

  constructor(renderer: HUDRenderer, storage: VLMStorage, colyseus: ColyseusManager) {
    this.renderer = renderer
    this.storage = storage
    this.colyseus = colyseus
  }

  /** Open the panel and list all scene elements. */
  open(): void {
    const elements = this.getElementList()
    this.renderer.showPanel(HUDPanelType.SCENE_LAYOUT, {
      visible: true,
      data: { elements },
    })
  }

  /** Select an entity and show the transform gizmo. */
  selectEntity(entity: EntityHandle): void {
    if (this.selectedEntity) {
      this.renderer.hideTransformGizmo()
    }
    this.selectedEntity = entity
    this.renderer.showTransformGizmo(entity, this.gizmoMode)
  }

  /** Deselect the current entity. */
  deselectEntity(): void {
    if (this.selectedEntity) {
      this.renderer.hideTransformGizmo()
      this.selectedEntity = null
    }
  }

  /** Switch gizmo mode. */
  setGizmoMode(mode: 'move' | 'rotate' | 'scale'): void {
    this.gizmoMode = mode
    if (this.selectedEntity) {
      this.renderer.showTransformGizmo(this.selectedEntity, mode)
    }
  }

  /** Toggle element visibility. */
  toggleVisibility(elementSk: string, enabled: boolean): void {
    this.colyseus.send('scene_preset_update', {
      action: 'update',
      elementData: { sk: elementSk, enabled },
    })
  }

  /** Delete an element. */
  deleteElement(elementSk: string): void {
    this.colyseus.send('scene_preset_update', {
      action: 'delete',
      elementData: { sk: elementSk },
    })
  }

  close(): void {
    this.deselectEntity()
    this.renderer.hidePanel(HUDPanelType.SCENE_LAYOUT)
  }

  private getElementList(): ElementEntry[] {
    const entries: ElementEntry[] = []

    const addFromStore = (type: string, store: { configs: Record<string, any> }) => {
      for (const [key, config] of Object.entries(store.configs)) {
        entries.push({
          sk: config.sk || key,
          name: config.name || key,
          type,
          enabled: config.enabled ?? true,
          instanceCount: Object.keys(store.configs).length,
        })
      }
    }

    addFromStore('video', this.storage.videos)
    addFromStore('image', this.storage.images)
    addFromStore('model', this.storage.models)
    addFromStore('sound', this.storage.sounds)

    return entries
  }
}
