/**
 * NotificationPanel — Real-time toast notification feed.
 *
 * Displays visitor enter/leave, giveaway claims, stream status changes,
 * deployment completions, etc. Overlays on top of other panels.
 */

import type { HUDRenderer, HUDNotification } from 'vlm-shared'
import { HUDPanelType } from 'vlm-shared'

const MAX_NOTIFICATIONS = 50

export class NotificationPanel {
  private renderer: HUDRenderer
  private notifications: HUDNotification[] = []
  private visible = false
  private nextId = 1

  constructor(renderer: HUDRenderer) {
    this.renderer = renderer
  }

  /** Show the notification feed panel. */
  open(): void {
    this.visible = true
    this.renderer.showPanel(HUDPanelType.NOTIFICATIONS, {
      visible: true,
      data: { notifications: this.notifications },
    })
  }

  /** Push a new notification (always shown as toast, even if panel is closed). */
  push(notification: Omit<HUDNotification, 'id' | 'timestamp'>): void {
    const full: HUDNotification = {
      ...notification,
      id: `notif-${this.nextId++}`,
      timestamp: Date.now(),
    }

    this.notifications.unshift(full)
    if (this.notifications.length > MAX_NOTIFICATIONS) {
      this.notifications.pop()
    }

    // Always show toast regardless of panel visibility
    this.renderer.showNotification(full)

    // Update panel data if visible
    if (this.visible) {
      this.renderer.showPanel(HUDPanelType.NOTIFICATIONS, {
        visible: true,
        data: { notifications: this.notifications },
      })
    }
  }

  /** Clear all notifications. */
  clear(): void {
    this.notifications = []
  }

  /** Get recent notifications. */
  getRecent(count = 10): HUDNotification[] {
    return this.notifications.slice(0, count)
  }

  close(): void {
    this.visible = false
    this.renderer.hidePanel(HUDPanelType.NOTIFICATIONS)
  }
}
