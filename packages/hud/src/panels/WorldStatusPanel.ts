/**
 * WorldStatusPanel — Mini command center for in-world use.
 *
 * Compact view of all connected worlds in the current event.
 * Per-world: platform, visitor count, stream status, deployment status.
 * Tap a world to send a quick action to just that world.
 */

import type { HUDRenderer, WorldStatus } from 'vlm-shared'
import { HUDPanelType } from 'vlm-shared'
import type { ColyseusManager } from 'vlm-client'

export class WorldStatusPanel {
  private renderer: HUDRenderer
  private colyseus: ColyseusManager
  private worlds: WorldStatus[] = []

  constructor(renderer: HUDRenderer, colyseus: ColyseusManager) {
    this.renderer = renderer
    this.colyseus = colyseus
  }

  /** Open and display all connected worlds. */
  open(worlds: WorldStatus[]): void {
    this.worlds = worlds
    this.renderer.showPanel(HUDPanelType.WORLD_STATUS, {
      visible: true,
      data: { worlds },
    })
    this.renderer.renderWorldStatusGrid(worlds)
  }

  /** Update worlds data (called periodically from command center status). */
  update(worlds: WorldStatus[]): void {
    this.worlds = worlds
    this.renderer.renderWorldStatusGrid(worlds)
  }

  /** Send an action to a specific world. */
  sendToWorld(sceneId: string, action: Record<string, unknown>): void {
    this.colyseus.send('cross_world_update', {
      targetScenes: [sceneId],
      action,
    })
  }

  /** Get aggregate stats. */
  getAggregate(): { totalVisitors: number; liveStreams: number; deployedCount: number } {
    return {
      totalVisitors: this.worlds.reduce((sum, w) => sum + w.visitorCount, 0),
      liveStreams: this.worlds.filter((w) => w.streamStatus === 'live').length,
      deployedCount: this.worlds.filter((w) => w.deploymentStatus === 'deployed').length,
    }
  }

  close(): void {
    this.renderer.hidePanel(HUDPanelType.WORLD_STATUS)
  }
}
