// Renaming a scene, and offering to carry the new name to what's connected to it (Decentraland Worlds,
// Hyperfy worlds, AR spaces).

/** Same limit as the wizard's scene name and the server's PUT /api/scenes/:sceneId. */
export const SCENE_NAME_MAX = 120

/**
 * Whether "Rename to <new name>" starts ticked for a Hyperfy world or AR space.
 *
 * Ticked only when the item is still called the old scene name (it was named after the scene) and isn't
 * already the new one. Names are compared after trimming spaces at either end, and otherwise exactly
 * (case matters: "moon" is a name the user chose, not "Moon"). With no known old name (the panel reopened
 * later) or no real change, nothing starts ticked.
 */
export function defaultTicked(itemName: string, oldName: string | null, newName: string): boolean {
  if (oldName === null) return false
  const item = itemName.trim()
  const from = oldName.trim()
  const to = newName.trim()
  return from !== to && item === from && item !== to
}

/** Whether any connected item is called something other than the scene (same comparison as defaultTicked). */
export function namesDiffer(sceneName: string, itemNames: string[]): boolean {
  const name = sceneName.trim()
  return itemNames.some((n) => n.trim() !== name)
}

/** Why a scene name can't be saved, or null when it can. */
export function sceneNameError(name: string): string | null {
  const t = name.trim()
  if (!t) return 'Give the scene a name.'
  if (t.length > SCENE_NAME_MAX) return `Keep the name to ${SCENE_NAME_MAX} characters or fewer.`
  return null
}

/** The server's own words for a failed rename or redeploy. */
export function renameError(err: unknown): string {
  const e = err as { message?: string; body?: { message?: unknown; error?: unknown } }
  const body = e?.body
  if (body && typeof body.message === 'string' && body.message) return body.message
  if (body && typeof body.error === 'string' && body.error) return body.error
  return e?.message || 'Something went wrong. Try again in a moment.'
}
