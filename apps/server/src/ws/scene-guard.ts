import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { sceneElementInstances, sceneElements, scenePresets, scenes, venues } from '../db/schema.js'
import { canWriteElement, diffKeys, hasScope, type SceneAccess, type SceneScope } from '../auth/permissions.js'

/** The element/instance ids the guard authorized; the room must act on these, not re-derive them. */
export interface GuardTarget {
  elementId?: string
  instanceId?: string
}

export type GuardResult =
  | { ok: true; broadcast: boolean; target?: GuardTarget }
  | { ok: false; code: 'forbidden' | 'not_found' }

const OK_BROADCAST: GuardResult = { ok: true, broadcast: true }
const FORBIDDEN: GuardResult = { ok: false, code: 'forbidden' }
const NOT_FOUND: GuardResult = { ok: false, code: 'not_found' }

/** Field keys of an element update message, matching VLMSceneRoom.persistPresetUpdate. */
const ELEMENT_FIELDS = ['name', 'enabled', 'customId', 'clickEvent'] as const

/** Must stay in sync with VLMSceneRoom.extractProperties' structural keys. */
const STRUCTURAL = new Set([
  'sk', 'id', 'pk', 'name', 'enabled', 'customId', 'customRendering', 'clickEvent', 'instances', 'instanceIds',
  'position', 'rotation', 'scale', 'parent', 'withCollisions', 'elementId', 'configId', 'entity', 'services',
  'defaultClickEvent',
])

export function propertiesOf(data: Record<string, unknown>) {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(data)) if (!STRUCTURAL.has(k) && v !== undefined) out[k] = v
  return out
}

/** Grant holders may only use live-scene controls during the live window. */
function liveScope(access: SceneAccess, scope: SceneScope): GuardResult {
  if (!hasScope(access, scope)) return FORBIDDEN
  if (access.level === 'grant' && access.booking?.window !== 'live') return FORBIDDEN
  return OK_BROADCAST
}

const OPEN = new Set([
  'scene_sound_locator', 'session_start', 'session_action', 'session_end', 'user_message', 'get_user_state',
  'set_user_state', 'giveaway_claim', 'request_player_position', 'send_player_position', 'path_segments_add',
])

export async function authorizeSceneMessage(access: SceneAccess, sceneId: string, type: string, message: any): Promise<GuardResult> {
  if (OPEN.has(type)) return OK_BROADCAST
  switch (type) {
    case 'scene_setting_update':
      return hasScope(access, 'scene.edit') ? OK_BROADCAST : FORBIDDEN
    case 'scene_video_update': {
      const live = liveScope(access, 'screens')
      if (!live.ok || access.level !== 'grant') return live
      // Crew may only drive rentable screens in their own booking preset.
      const elementId = message?.sk || message?.id || message?.elementId
      const el = elementId && (await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, elementId), with: { preset: true } }))
      if (!el || el.preset.sceneId !== sceneId) return NOT_FOUND
      const rentable = access.booking!.rentableElementIds
      if (el.presetId !== access.booking!.bookingPresetId) return FORBIDDEN
      if (!rentable.has(el.id) && !(el.clonedFromId && rentable.has(el.clonedFromId))) return FORBIDDEN
      return OK_BROADCAST
    }
    case 'scene_moderator_message':
    case 'scene_moderator_crash':
      return hasScope(access, 'moderation') ? OK_BROADCAST : FORBIDDEN
    case 'scene_change_preset': {
      const presetId = message?.presetId || message?.id
      const preset = presetId && (await db.query.scenePresets.findFirst({ where: eq(scenePresets.id, presetId) }))
      if (!preset || preset.sceneId !== sceneId) return NOT_FOUND
      const live = liveScope(access, 'presets')
      if (!live.ok || access.level !== 'grant') return live
      // Crew may only switch between their booking preset and the venue default.
      if (preset.id === access.booking!.bookingPresetId) return live
      const venue = await db.query.venues.findFirst({ where: eq(venues.sceneId, sceneId), columns: { defaultPresetId: true } })
      return venue?.defaultPresetId === preset.id ? live : FORBIDDEN
    }
    case 'scene_preset_update':
      return authorizePresetUpdate(access, sceneId, message ?? {})
    default:
      return FORBIDDEN // unknown mutating types are closed by default
  }
}

/** Delete actions: the room's own 'delete' plus the names apps/web sends after its REST delete. */
const DELETE_ACTIONS = new Set(['delete', 'delete_instance', 'delete_element'])

async function authorizePresetUpdate(access: SceneAccess, sceneId: string, message: any): Promise<GuardResult> {
  const { action, instance, elementData, instanceData, id } = message
  if (action !== 'update' || instance) {
    // create/delete of anything, or any instance change: scene editors only
    if (!hasScope(access, 'scene.edit')) return FORBIDDEN
    if (action === 'create' && !instance) return OK_BROADCAST
    // The dashboard deletes over REST first, then relays the delete here; with the row
    // already gone there is nothing to persist, so just relay it (editors only, checked above).
    const isDelete = DELETE_ACTIONS.has(action)
    const isInstance = instance || action === 'delete_instance'
    const instanceId = isInstance ? instanceData?.sk || instanceData?.id || id : null
    const elementId = isInstance ? instanceData?.elementId || elementData?.sk || elementData?.id : elementData?.sk || elementData?.id || id
    if (instanceId && action !== 'create') {
      const inst = await db.query.sceneElementInstances.findFirst({
        where: eq(sceneElementInstances.id, instanceId),
        with: { element: { with: { preset: true } } },
      })
      if (!inst && isDelete) return OK_BROADCAST
      if (!inst || inst.element.preset.sceneId !== sceneId) return NOT_FOUND
      return { ok: true, broadcast: await isActive(sceneId, inst.element.presetId), target: { instanceId: inst.id } }
    }
    if (!elementId) return NOT_FOUND
    const el = await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, elementId), with: { preset: true } })
    if (!el && isDelete) return OK_BROADCAST
    if (!el || el.preset.sceneId !== sceneId) return NOT_FOUND
    return { ok: true, broadcast: await isActive(sceneId, el.presetId), target: { elementId: el.id } }
  }

  const elementId = elementData?.sk || elementData?.id || id
  if (!elementId) return NOT_FOUND
  const el = await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, elementId), with: { preset: true } })
  if (!el || el.preset.sceneId !== sceneId) return NOT_FOUND
  const data = (elementData ?? {}) as Record<string, unknown>
  const propertyKeys = elementData ? diffKeys(el.properties as Record<string, unknown> | null, propertiesOf(data)) : []
  const fieldKeys = ELEMENT_FIELDS.filter(
    (k) => data[k] !== undefined && JSON.stringify(data[k]) !== JSON.stringify((el as any)[k]),
  )
  if (!canWriteElement(access, el, { propertyKeys, fieldKeys })) return FORBIDDEN
  return { ok: true, broadcast: await isActive(sceneId, el.presetId), target: { elementId: el.id } }
}

async function isActive(sceneId: string, presetId: string) {
  const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId), columns: { activePresetId: true } })
  return scene?.activePresetId === presetId
}
