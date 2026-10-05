import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { Wallet } from 'ethers'
import { db } from '../src/db/connection.js'
import { userAuthMethods } from '../src/db/schema.js'
import { resetDb } from './helpers/db.js'
import { testApp, createUser, tokenFor } from './helpers/factories.js'

describe('GET /api/auth/wallets', () => {
  let app: Awaited<ReturnType<typeof testApp>>
  beforeEach(async () => {
    await resetDb()
    app = await testApp()
  })
  afterEach(() => app.close())

  async function link(wallet: Wallet, bearer: string) {
    const ch = await app.inject({ method: 'POST', url: '/api/auth/wallet/challenge', payload: { address: wallet.address } })
    const { nonce, message } = ch.json()
    return app.inject({
      method: 'POST',
      url: '/api/auth/wallet/verify',
      payload: { address: wallet.address, nonce, signature: await wallet.signMessage(message) },
      headers: { authorization: `Bearer ${bearer}` },
    })
  }

  it('lists the verified wallets linked to the signed-in user, and only theirs', async () => {
    const me = await createUser()
    const other = await createUser()
    const w = Wallet.createRandom()
    expect((await link(w, tokenFor(me))).json()).toMatchObject({ linked: true })
    await link(Wallet.createRandom(), tokenFor(other))
    // a legacy unverified record is not a linked wallet
    await db.insert(userAuthMethods).values({ userId: me.id, type: 'wallet', identifier: '0x' + '1'.repeat(40), metadata: { verified: false } })

    const res = await app.inject({ method: 'GET', url: '/api/auth/wallets', headers: { authorization: `Bearer ${tokenFor(me)}` } })
    expect(res.statusCode).toBe(200)
    expect(res.json().wallets).toEqual([{ address: w.address.toLowerCase(), linkedAt: expect.any(String) }])
  })

  it('requires a signed-in user', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/wallets' })
    expect(res.statusCode).toBe(401)
  })
})
