import { eq } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { sceneElementInstances, sceneElements, scenePresets, scenes } from '../db/schema.js'
import { canWriteElement, diffKeys, hasScope, type SceneAccess, type SceneScope } from '../auth/permissions.js'

export type GuardResult = { ok: true; broadcast: boolean } | { ok: false; code: 'forbidden' | 'not_found' }

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
    case 'scene_video_update':
      return liveScope(access, 'screens')
    case 'scene_moderator_message':
    case 'scene_moderator_crash':
      return hasScope(access, 'moderation') ? OK_BROADCAST : FORBIDDEN
    case 'scene_change_preset': {
      const presetId = message?.presetId || message?.id
      const preset = presetId && (await db.query.scenePresets.findFirst({ where: eq(scenePresets.id, presetId) }))
      if (!preset || preset.sceneId !== sceneId) return NOT_FOUND
      return liveScope(access, 'presets')
    }
    case 'scene_preset_update':
      return authorizePresetUpdate(access, sceneId, message ?? {})
    default:
      return FORBIDDEN // unknown mutating types are closed by default
  }
}

async function authorizePresetUpdate(access: SceneAccess, sceneId: string, message: any): Promise<GuardResult> {
  const { action, instance, elementData, instanceData, id } = message
  if (action !== 'update' || instance) {
    // create/delete of anything, or any instance change: scene editors only
    if (!hasScope(access, 'scene.edit')) return FORBIDDEN
    if (action === 'create' && !instance) return OK_BROADCAST
    const instanceId = instance ? instanceData?.sk || instanceData?.id || id : null
    const elementId = instance ? instanceData?.elementId || elementData?.sk || elementData?.id : elementData?.sk || elementData?.id || id
    if (instanceId && action !== 'create') {
      const inst = await db.query.sceneElementInstances.findFirst({
        where: eq(sceneElementInstances.id, instanceId),
        with: { element: { with: { preset: true } } },
      })
      if (!inst || inst.element.preset.sceneId !== sceneId) return NOT_FOUND
      return { ok: true, broadcast: await isActive(sceneId, inst.element.presetId) }
    }
    if (!elementId) return NOT_FOUND
    const el = await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, elementId), with: { preset: true } })
    if (!el || el.preset.sceneId !== sceneId) return NOT_FOUND
    return { ok: true, broadcast: await isActive(sceneId, el.presetId) }
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
  return { ok: true, broadcast: await isActive(sceneId, el.presetId) }
}

async function isActive(sceneId: string, presetId: string) {
  const scene = await db.query.scenes.findFirst({ where: eq(scenes.id, sceneId), columns: { activePresetId: true } })
  return scene?.activePresetId === presetId
}
