import { describe, it, expect, beforeEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { dclWorldDestinations, sceneDeployments, scenes } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { createUser, createScene } from './helpers/factories.js'

describe('dcl_world_destinations', () => {
  beforeEach(async () => { await resetDb() })

  const dest = (sceneId: string, ownerUserId: string, worldName = 'alice.dcl.eth') => ({
    sceneId, ownerUserId, ownerWallet: '0xabc', worldName, base: '0,0', parcels: ['0,0', '0,1'], mode: 'virvi' as const,
  })

  it('applies defaults', async () => {
    const u = await createUser(); const { scene } = await createScene(u)
    const [d] = await db.insert(dclWorldDestinations).values(dest(scene.id, u.id)).returning()
    expect(d.status).toBe('ok')
    expect(d.deployedFiles).toEqual([])
    expect(d.adopted).toBe(false)
    expect(d.grantedAt).toBeNull()
    expect(d.parcels).toEqual(['0,0', '0,1'])
  })

  it('worldName is unique', async () => {
    const u = await createUser(); const { scene } = await createScene(u); const { scene: s2 } = await createScene(u, 'Two')
    await db.insert(dclWorldDestinations).values(dest(scene.id, u.id))
    const err: any = await db.insert(dclWorldDestinations).values(dest(s2.id, u.id)).then(() => null, (e) => e)
    expect((err?.cause ?? err)?.code).toBe('23505')
  })

  it('deleting the scene cascades', async () => {
    const u = await createUser(); const { scene } = await createScene(u)
    await db.insert(dclWorldDestinations).values(dest(scene.id, u.id))
    await db.delete(scenes).where(eq(scenes.id, scene.id))
    expect(await db.select().from(dclWorldDestinations)).toHaveLength(0)
  })

  it('scene_deployments accepts awaiting_signature and a destination link (set null on delete)', async () => {
    const u = await createUser(); const { scene } = await createScene(u)
    const [d] = await db.insert(dclWorldDestinations).values(dest(scene.id, u.id)).returning()
    const [dep] = await db.insert(sceneDeployments).values({
      sceneId: scene.id, platform: 'decentraland', deploymentType: 'world', target: {}, status: 'awaiting_signature', destinationId: d.id,
    }).returning()
    expect(dep.status).toBe('awaiting_signature')
    await db.delete(dclWorldDestinations).where(eq(dclWorldDestinations.id, d.id))
    const after = await db.query.sceneDeployments.findFirst({ where: eq(sceneDeployments.id, dep.id) })
    expect(after!.destinationId).toBeNull()
  })
})
