import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Wallet } from 'ethers'
import { eq } from 'drizzle-orm'
import { db } from '../src/db/connection.js'
import { users, userAuthMethods } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor } from './helpers/factories.js'

vi.mock('../src/middleware/dcl-auth.js', () => ({
  hasDclAuthHeaders: (h: Record<string, unknown>) => !!h['x-identity-auth-chain-0'],
  verifyDclSignedFetch: async () => { throw new Error('unused') },
  verifyDclSceneRequest: async (_m: string, _p: string, h: Record<string, string>) => {
    const v = h['x-identity-auth-chain-0']
    if (typeof v === 'string' && v.startsWith('valid:'))
      return { wallet: v.slice(6), scene: { sceneId: 'bafyX', parcel: '0,0', realm: { hostname: 'peer.decentraland.org', serverName: 'main' }, isGuest: false } }
    throw new Error('bad signature')
  },
}))

// In-world visitors are tracked under a viewer account; it becomes a creator account once they sign in to the dashboard.
describe('visitor accounts', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    await createUser({ role: 'admin' })
    app = await testApp()
  })
  afterEach(() => app.close())

  const visit = (wallet: string) => app.inject({
    method: 'POST', url: '/api/auth/platform',
    headers: { 'x-identity-auth-chain-0': `valid:${wallet}` }, payload: { user: { displayName: 'Visitor' } },
  })
  async function signIn(wallet: Wallet, bearer?: string) {
    const { nonce, message } = (await app.inject({ method: 'POST', url: '/api/auth/wallet/challenge', payload: { address: wallet.address } })).json()
    return app.inject({
      method: 'POST', url: '/api/auth/wallet/verify',
      payload: { address: wallet.address, nonce, signature: await wallet.signMessage(message) },
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    })
  }
  const userOf = async (wallet: string) =>
    (await db.query.userAuthMethods.findFirst({ where: eq(userAuthMethods.identifier, wallet.toLowerCase()), with: { user: true } }))?.user

  it('a player seen in-world gets a viewer account', async () => {
    const w = Wallet.createRandom()
    const res = await visit(w.address.toLowerCase())
    expect(res.json().user.role).toBe('viewer')
    expect((await userOf(w.address))!.role).toBe('viewer')
  })

  it('signing in to the dashboard turns that viewer into a creator, keeping the same account', async () => {
    const w = Wallet.createRandom()
    await visit(w.address.toLowerCase())
    const before = await userOf(w.address)
    const res = await signIn(w)
    expect(res.statusCode).toBe(200)
    const after = await userOf(w.address)
    expect(after).toMatchObject({ id: before!.id, role: 'creator' })
    expect(res.json().user.role).toBe('creator')
  })

  it('a dashboard sign-in with a fresh wallet still creates a creator', async () => {
    const w = Wallet.createRandom()
    await signIn(w)
    expect((await userOf(w.address))!.role).toBe('creator')
  })

  it('visiting in-world never demotes an existing creator', async () => {
    const w = Wallet.createRandom()
    await signIn(w)
    await visit(w.address.toLowerCase())
    expect((await userOf(w.address))!.role).toBe('creator')
  })

  it("linking a wallet to an email account takes it over from that wallet's visitor account", async () => {
    const w = Wallet.createRandom()
    await visit(w.address.toLowerCase())
    const shell = await userOf(w.address)
    const me = await createUser({ role: 'creator' })
    const res = await signIn(w, tokenFor(me))
    expect(res.json()).toMatchObject({ linked: true })
    expect((await userOf(w.address))!.id).toBe(me.id)
    expect(await db.query.users.findFirst({ where: eq(users.id, shell!.id) })).toBeUndefined()
  })

  it("linking still refuses a wallet that belongs to another creator's account", async () => {
    const w = Wallet.createRandom()
    await signIn(w)
    const me = await createUser({ role: 'creator' })
    expect((await signIn(w, tokenFor(me))).statusCode).toBe(409)
  })
})
