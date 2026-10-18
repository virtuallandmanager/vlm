// A press (onMouseDown) on any HUD surface stamps `hudPress.frame`; the edit-mode input drops a pending press
// whose frame is within one frame of the stamp. The input advances `hudPress.now` once per frame and clears stamps
// older than one frame, so a stale mark (e.g. its button's action cancelled the pending press) can't linger.
export const hudPress = { now: 0, frame: -Infinity }
export const markHudPress = (): void => {
  hudPress.frame = hudPress.now
}
export const clearHudPress = (): void => {
  hudPress.frame = -Infinity
}
