// Set by a press (onMouseDown) on the edit bar; the edit-mode input drops its pending press when it sees this.
export const hudPress = { flag: false }
export const markHudPress = (): void => {
  hudPress.flag = true
}
