import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { sceneElements } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, createElement, tokenFor } from './helpers/factories.js'
import { startGameServer, joinScene } from './helpers/game-server.js'

describe('persistPresetUpdate merges properties', () => {
  let gs: Awaited<ReturnType<typeof startGameServer>>
  beforeEach(async () => {
    await resetDb()
    gs = await startGameServer()
  })
  afterEach(() => gs.stop())

  const row = async (id: string) => (await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, id) }))!
  const settle = () => new Promise((r) => setTimeout(r, 300))

  async function setup(properties: Record<string, unknown>) {
    const owner = await createUser()
    const { scene, preset } = await createScene(owner)
    const el = await createElement(preset.id, { type: 'image', name: 'Pic', properties })
    const c = await joinScene(gs.url, scene.id, tokenFor(owner))
    await c.waitFor('scene_preset_update')
    return { c, el }
  }

  it('toggle keeps properties', async () => {
    const { c, el } = await setup({ textureSrc: 'https://x/a.png' })
    c.room.send('scene_preset_update', { action: 'update', element: 'image', elementData: { sk: el.id, enabled: false } })
    await settle()
    const r = await row(el.id)
    expect(r.enabled).toBe(false)
    expect((r.properties as any).textureSrc).toBe('https://x/a.png')
  })

  it('property edit merges and keeps other keys', async () => {
    const { c, el } = await setup({ textureSrc: 'https://x/a.png', keep: 1 })
    c.room.send('scene_preset_update', { action: 'update', element: 'image', elementData: { sk: el.id, textureSrc: 'https://x/b.png' } })
    await settle()
    expect((await row(el.id)).properties).toEqual({ textureSrc: 'https://x/b.png', keep: 1 })
  })

  it('unwraps nested properties from dashboard relays', async () => {
    const { c, el } = await setup({ textureSrc: 'https://x/a.png' })
    c.room.send('scene_preset_update', { action: 'update', element: 'image', elementData: { id: el.id, properties: { textureSrc: 'https://x/c.png' } } })
    await settle()
    expect((await row(el.id)).properties).toEqual({ textureSrc: 'https://x/c.png' })
  })
})
