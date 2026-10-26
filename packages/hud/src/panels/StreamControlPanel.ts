/**
 * StreamControlPanel — Monitor and control video streams from in-world.
 *
 * Shows current stream status (live/offline, bitrate, viewer count)
 * and allows quick-switching between video sources.
 */

import type { HUDRenderer } from 'vlm-shared'
import { HUDPanelType } from 'vlm-shared'
import type { ColyseusManager } from 'vlm-client'

interface StreamInfo {
  videoSk: string
  name: string
  isLive: boolean
  liveSrc?: string
  offImageSrc?: string
  playlist?: string[]
}

export class StreamControlPanel {
  private renderer: HUDRenderer
  private colyseus: ColyseusManager
  private streams: StreamInfo[] = []

  constructor(renderer: HUDRenderer, colyseus: ColyseusManager) {
    this.renderer = renderer
    this.colyseus = colyseus
  }

  /** Open with current stream state. */
  open(streams: StreamInfo[]): void {
    this.streams = streams
    this.renderer.showPanel(HUDPanelType.STREAM_CONTROL, {
      visible: true,
      data: { streams },
    })
  }

  /** Set a video to live mode. */
  goLive(videoSk: string, liveSrc: string): void {
    this.colyseus.send('scene_video_update', {
      sk: videoSk,
      isLive: true,
      url: liveSrc,
    })
  }

  /** Set a video to offline/fallback mode. */
  goOffline(videoSk: string): void {
    this.colyseus.send('scene_video_update', {
      sk: videoSk,
      isLive: false,
    })
  }

  /** Switch video source URL. */
  switchSource(videoSk: string, src: string): void {
    this.colyseus.send('scene_preset_update', {
      action: 'update',
      elementData: { sk: videoSk, liveSrc: src },
    })
  }

  /** Update stream info (called when video status messages arrive). */
  updateStreamInfo(videoSk: string, updates: Partial<StreamInfo>): void {
    const stream = this.streams.find((s) => s.videoSk === videoSk)
    if (stream) {
      Object.assign(stream, updates)
      this.renderer.showPanel(HUDPanelType.STREAM_CONTROL, {
        visible: true,
        data: { streams: this.streams },
      })
    }
  }

  close(): void {
    this.renderer.hidePanel(HUDPanelType.STREAM_CONTROL)
  }
}
