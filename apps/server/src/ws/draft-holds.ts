/**
 * Who is dragging which instance right now, for every scene on this process: the scene rooms (Decentraland editors,
 * key `room:<sessionId>`) and the AR draft routes (headsets, key `ar:<deviceId>`) share it, so one can't take an item
 * the other holds. Synchronous and in memory, so it only spans one process (`VLM_MODE=single`). Never persisted.
 */

export type DraftHolder = { key: string; name: string; expiresAt?: number }

/** sceneId -> instance sk -> holder */
const holds = new Map<string, Map<string, DraftHolder>>()

const lapsed = (h: DraftHolder, now: number) => h.expiresAt !== undefined && h.expiresAt <= now

/** The live holder of sk in this scene; a lapsed hold not yet swept counts as free. */
export function holderOf(sceneId: string, sk: string): DraftHolder | undefined {
  const h = holds.get(sceneId)?.get(sk)
  return h && !lapsed(h, Date.now()) ? h : undefined
}

/**
 * Takes or refreshes the hold. `ok` is false when someone else holds sk. `lapsed` is another holder's lapsed hold this
 * one replaced before the sweep reached it: the caller tells editors it ended.
 */
export function hold(sceneId: string, sk: string, holder: DraftHolder): { ok: boolean; lapsed?: DraftHolder } {
  const previous = holds.get(sceneId)?.get(sk)
  if (previous && previous.key !== holder.key && !lapsed(previous, Date.now())) return { ok: false }
  let scene = holds.get(sceneId)
  if (!scene) holds.set(sceneId, (scene = new Map()))
  scene.set(sk, holder)
  return previous && previous.key !== holder.key ? { ok: true, lapsed: previous } : { ok: true }
}

/** Drops the hold if `holderKey` has it. True when it did. */
export function release(sceneId: string, sk: string, holderKey: string): boolean {
  const scene = holds.get(sceneId)
  if (scene?.get(sk)?.key !== holderKey) return false
  scene.delete(sk)
  if (!scene.size) holds.delete(sceneId)
  return true
}

/** Drops every hold `holderKey` has, in any scene. */
export function releaseAll(holderKey: string): Array<{ sceneId: string; sk: string }> {
  return takeWhere((h) => h.key === holderKey)
}

/** Drops every hold whose expiry has passed. */
export function sweepExpired(now: number): Array<{ sceneId: string; sk: string }> {
  return takeWhere((h) => lapsed(h, now))
}

function takeWhere(match: (h: DraftHolder) => boolean): Array<{ sceneId: string; sk: string }> {
  const taken: Array<{ sceneId: string; sk: string }> = []
  for (const [sceneId, scene] of holds) {
    for (const [sk, h] of scene) {
      if (!match(h)) continue
      scene.delete(sk)
      taken.push({ sceneId, sk })
    }
    if (!scene.size) holds.delete(sceneId)
  }
  return taken
}
