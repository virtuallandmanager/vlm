/**
 * ClickHandler — Utility for extracting pointer event props from an entity.
 *
 * Used by the HyperfyRenderer to read the entity's pointerDown data and pass
 * consistent onPointerDown / hint props to element components.
 */

/**
 * Extract pointer event props from an entity.
 * @param {object} entity — Entity from EntityStore
 * @returns {{ onPointerDown?: () => void, hint?: string }}
 */
export function getPointerProps(entity) {
  if (!entity.pointerDown) {
    return {}
  }

  return {
    onPointerDown: () => {
      entity.pointerDown.callback({
        entityHandle: entity.id,
        button: entity.pointerDown.options?.button || 'primary',
        origin: { x: 0, y: 0, z: 0 },
        direction: { x: 0, y: 0, z: 1 },
      })
    },
    hint: entity.pointerDown.options?.hoverText,
  }
}
