/**
 * PanelRegistry — Manages HUD panel state (visible/hidden, panel-specific data).
 *
 * Panels are toggled by the HUDManager. The registry tracks which panels are open
 * and their current state. Only one panel can be active at a time (modal behavior)
 * except for the notification feed which overlays on top.
 */

import type { HUDPanelState } from 'vlm-shared'
import { HUDPanelType } from 'vlm-shared'

export class PanelRegistry {
  private panels: Map<HUDPanelType, HUDPanelState> = new Map()

  constructor() {
    // Initialize all panels as hidden
    for (const panel of Object.values(HUDPanelType)) {
      this.panels.set(panel as HUDPanelType, { visible: false })
    }
  }

  /** Get current state of a panel. */
  getState(panel: HUDPanelType): HUDPanelState {
    return this.panels.get(panel) || { visible: false }
  }

  /** Show a panel, hiding any other active panel (except notifications). */
  show(panel: HUDPanelType, data?: Record<string, unknown>): void {
    // Close other panels (except notifications which overlay)
    if (panel !== HUDPanelType.NOTIFICATIONS) {
      for (const [key, state] of this.panels) {
        if (key !== HUDPanelType.NOTIFICATIONS && key !== panel && state.visible) {
          this.panels.set(key, { ...state, visible: false })
        }
      }
    }

    this.panels.set(panel, { visible: true, data })
  }

  /** Hide a specific panel. */
  hide(panel: HUDPanelType): void {
    const state = this.panels.get(panel)
    if (state) {
      this.panels.set(panel, { ...state, visible: false })
    }
  }

  /** Toggle a panel's visibility. */
  toggle(panel: HUDPanelType, data?: Record<string, unknown>): boolean {
    const state = this.getState(panel)
    if (state.visible) {
      this.hide(panel)
      return false
    } else {
      this.show(panel, data)
      return true
    }
  }

  /** Check if a panel is currently visible. */
  isVisible(panel: HUDPanelType): boolean {
    return this.getState(panel).visible
  }

  /** Hide all panels. */
  hideAll(): void {
    for (const [key, state] of this.panels) {
      if (state.visible) {
        this.panels.set(key, { ...state, visible: false })
      }
    }
  }

  /** Get all currently visible panels. */
  getVisiblePanels(): HUDPanelType[] {
    return Array.from(this.panels.entries())
      .filter(([_, state]) => state.visible)
      .map(([panel]) => panel)
  }
}
