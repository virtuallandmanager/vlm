import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { db } from '../src/db/connection.js'
import { organizations, orgMembers } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor } from './helpers/factories.js'

const as = (u: any) => ({ authorization: `Bearer ${tokenFor(u)}` })

describe('org roles', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => { await resetDb(); app = await testApp() })
  afterEach(async () => { await app.close() })

  async function setup() {
    const owner = await createUser()
    const admin = await createUser()
    const admin2 = await createUser()
    const member = await createUser()
    const [org] = await db.insert(organizations).values({ name: 'Org', slug: 'org', billingOwnerId: owner.id }).returning()
    await db.insert(orgMembers).values([
      { orgId: org.id, userId: owner.id, role: 'owner' },
      { orgId: org.id, userId: admin.id, role: 'admin' },
      { orgId: org.id, userId: admin2.id, role: 'admin' },
      { orgId: org.id, userId: member.id, role: 'member' },
    ])
    return { owner, admin, admin2, member, org }
  }
  const invite = (app: any, orgId: string, user: any, role?: string) =>
    app.inject({ method: 'POST', url: `/api/orgs/${orgId}/invites`, headers: as(user), payload: { email: 'new@x.io', role } })

  it('invites: only member/admin roles, only the owner invites admins', async () => {
    const s = await setup()
    const owner = await invite(app, s.org.id, s.admin, 'owner')
    expect(owner.statusCode).toBe(400)
    expect(owner.json()).toEqual({ error: 'invalid_role' })
    expect((await invite(app, s.org.id, s.admin, 'admin')).statusCode).toBe(403)
    expect((await invite(app, s.org.id, s.admin, 'member')).statusCode).toBe(201)
    expect((await invite(app, s.org.id, s.owner, 'admin')).statusCode).toBe(201)
  })

  it('removal: nobody removes the owner, only the owner removes an admin, members may leave', async () => {
    const s = await setup()
    const del = (user: any, target: any) =>
      app.inject({ method: 'DELETE', url: `/api/orgs/${s.org.id}/members/${target.id}`, headers: as(user) })
    const o = await del(s.admin, s.owner)
    expect(o.statusCode).toBe(400)
    expect(o.json()).toEqual({ error: 'Transfer ownership first' })
    expect((await del(s.owner, s.owner)).statusCode).toBe(400)
    expect((await del(s.admin, s.admin2)).statusCode).toBe(403)
    expect((await del(s.member, s.member)).statusCode).toBe(204)
    expect((await del(s.admin, s.admin)).statusCode).toBe(204)
    expect((await del(s.owner, s.admin2)).statusCode).toBe(204)
  })
})
