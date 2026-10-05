import { describe, it, expect, beforeEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { sceneElements, sceneElementInstances } from '../src/db/schema.js'
import { serializePreset, serializeSingleElement, serializeSingleInstance } from '../src/services/scene-serializer.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene, createElement, createInstance } from './helpers/factories.js'

const run = promisify(execFile)
const SCRIPT = fileURLToPath(new URL('../scripts/unwrap-nested-properties.mjs', import.meta.url))

const baseElement = {
  id: 'e1', presetId: 'p1', type: 'image', name: 'Poster', enabled: true, customId: null,
  customRendering: false, clickEvent: null,
}
const baseInstance = {
  id: 'i1', elementId: 'e1', enabled: true, customId: null, customRendering: false,
  position: { x: 1, y: 2, z: 3 }, rotation: null, scale: null, clickEvent: null,
  parentInstanceId: null, withCollisions: false,
}

describe('serializer unwraps legacy nested properties', () => {
  it('element: nested keys are flattened, outer keys win, no `properties` key remains', () => {
    const out = serializeSingleElement({
      ...baseElement,
      properties: { properties: { textureSrc: 'https://old/a.png', emission: 1 }, emission: 2 },
      instances: [],
    })
    expect(out.textureSrc).toBe('https://old/a.png')
    expect(out.emission).toBe(2)
    expect(out).not.toHaveProperty('properties')
  })
  it('instance: nested keys are flattened', () => {
    const out = serializeSingleInstance({ ...baseInstance, properties: { properties: { volume: 0.5 } } })
    expect(out.volume).toBe(0.5)
    expect(out).not.toHaveProperty('properties')
  })
  it('a non-object `properties` value is left alone; normal rows unchanged', () => {
    const preset = serializePreset({
      id: 'p1', sceneId: 's1', name: 'Default', locale: null,
      elements: [
        { ...baseElement, id: 'a', properties: { properties: 'text', textureSrc: 'x' } },
        { ...baseElement, id: 'b', properties: { textureSrc: 'y' } },
      ],
    })
    expect(preset.images[0].properties).toBe('text')
    expect(preset.images[1].textureSrc).toBe('y')
  })
})

describe('scripts/unwrap-nested-properties.mjs (vlm_test DB)', () => {
  beforeEach(() => resetDb())

  async function seed() {
    const owner = await createUser()
    const { preset } = await createScene(owner)
    const nested = await createElement(preset.id, { type: 'image', properties: { properties: { textureSrc: 'https://a/x.png', a: 1 }, a: 2 } })
    const flat = await createElement(preset.id, { type: 'image', properties: { textureSrc: 'https://a/y.png' } })
    const inst = await createInstance(nested.id)
    await db.update(sceneElementInstances).set({ properties: { properties: { volume: 0.3 } } }).where(eq(sceneElementInstances.id, inst.id))
    return { nested, flat, inst }
  }
  const script = (...args: string[]) => run(process.execPath, [SCRIPT, ...args], { env: { ...process.env } })

  it('--count reports rows without changing them', async () => {
    const { nested } = await seed()
    const { stdout } = await script('--count')
    expect(stdout).toContain('scene_elements: 1')
    expect(stdout).toContain('scene_element_instances: 1')
    const row = await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, nested.id) })
    expect(row!.properties).toHaveProperty('properties')
  })

  it('--apply unwraps both tables (outer keys win) and a second run finds nothing', async () => {
    const { nested, flat, inst } = await seed()
    const { stdout } = await script('--apply')
    expect(stdout).toContain('scene_elements: 1')
    expect(stdout).toContain('scene_element_instances: 1')
    const el = await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, nested.id) })
    expect(el!.properties).toEqual({ textureSrc: 'https://a/x.png', a: 2 })
    const fl = await db.query.sceneElements.findFirst({ where: eq(sceneElements.id, flat.id) })
    expect(fl!.properties).toEqual({ textureSrc: 'https://a/y.png' })
    const ins = await db.query.sceneElementInstances.findFirst({ where: eq(sceneElementInstances.id, inst.id) })
    expect(ins!.properties).toEqual({ volume: 0.3 })
    const again = await script('--count')
    expect(again.stdout).toContain('scene_elements: 0')
    expect(again.stdout).toContain('scene_element_instances: 0')
  })

  it('refuses to run without a mode', async () => {
    await expect(script()).rejects.toMatchObject({ code: 2 })
  })
})
