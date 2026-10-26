/**
 * EventControlPanel — Manage active events and trigger cross-world actions.
 *
 * Shows event status, per-world visitor counts, and quick actions
 * that broadcast to all worlds linked to the event.
 */

import type { HUDRenderer } from 'vlm-shared'
import { HUDPanelType } from 'vlm-shared'
import type { ColyseusManager } from 'vlm-client'

interface EventInfo {
  id: string
  name: string
  startTime?: string
  endTime?: string
}

export class EventControlPanel {
  private renderer: HUDRenderer
  private colyseus: ColyseusManager
  private currentEvent: EventInfo | null = null

  constructor(renderer: HUDRenderer, colyseus: ColyseusManager) {
    this.renderer = renderer
    this.colyseus = colyseus
  }

  /** Open with current event info. */
  open(event?: EventInfo): void {
    this.currentEvent = event || null
    this.renderer.showPanel(HUDPanelType.EVENT_CONTROL, {
      visible: true,
      data: { event: this.currentEvent },
    })
  }

  /** Toggle giveaway on/off across all worlds in the event. */
  toggleGiveaway(giveawayId: string, enabled: boolean): void {
    if (!this.currentEvent) return
    this.colyseus.send('cross_world_update', {
      eventId: this.currentEvent.id,
      targetScenes: 'all',
      action: {
        type: 'giveaway_toggle',
        giveawayId,
        enabled,
      },
    })
  }

  /** Swap video stream URL across all worlds. */
  swapVideoStream(videoSk: string, newSrc: string, isLive: boolean): void {
    if (!this.currentEvent) return
    this.colyseus.send('cross_world_update', {
      eventId: this.currentEvent.id,
      targetScenes: 'all',
      action: {
        type: 'scene_video_update',
        sk: videoSk,
        isLive,
        url: newSrc,
      },
    })
  }

  /** Switch preset across all worlds. */
  switchPreset(presetId: string): void {
    if (!this.currentEvent) return
    this.colyseus.send('cross_world_update', {
      eventId: this.currentEvent.id,
      targetScenes: 'all',
      action: {
        type: 'scene_change_preset',
        presetId,
      },
    })
  }

  /** Send a moderator message to all worlds. */
  sendModeratorMessage(message: string): void {
    if (!this.currentEvent) return
    this.colyseus.send('cross_world_update', {
      eventId: this.currentEvent.id,
      targetScenes: 'all',
      action: {
        type: 'scene_moderator_message',
        message,
      },
    })
  }

  close(): void {
    this.renderer.hidePanel(HUDPanelType.EVENT_CONTROL)
  }
}
