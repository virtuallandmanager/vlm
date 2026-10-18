import { describe, it, expect } from 'vitest'
import { assertPublicHttpUrl, UnsafeUrlError } from '../src/net/public-url.js'

const pub = async () => ['93.184.216.34']

describe('assertPublicHttpUrl', () => {
  it.each([
    'http://10.0.0.5/x',
    'http://0.0.0.0/',
    'http://100.64.0.1/',
    'http://127.0.0.1:9999/',
    'http://169.254.169.254/latest',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://224.0.0.1/',
    'http://255.255.255.255/',
    'http://[::]/',
    'http://[::1]/',
    'http://[fc00::1]/',
    'http://[fe80::1]/',
    'http://[ff02::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:a00:1]/',
    'http://localhost/',
    'http://app.localhost/',
    'http://foo.railway.internal/',
    'http://db.internal/',
    'ftp://example.com/',
    'not a url',
  ])('refuses %s', async (url) => {
    await expect(assertPublicHttpUrl(url, { lookup: pub })).rejects.toBeInstanceOf(UnsafeUrlError)
  })

  it('refuses a host if any resolved address is private', async () => {
    await expect(
      assertPublicHttpUrl('https://example.com/cb', { lookup: async () => ['93.184.216.34', '10.0.0.1'] }),
    ).rejects.toBeInstanceOf(UnsafeUrlError)
  })

  it('refuses a host that does not resolve', async () => {
    await expect(
      assertPublicHttpUrl('https://example.com/cb', { lookup: async () => { throw new Error('ENOTFOUND') } }),
    ).rejects.toBeInstanceOf(UnsafeUrlError)
  })

  it('accepts a public host and public literals', async () => {
    const u = await assertPublicHttpUrl('https://example.com/cb', { lookup: pub })
    expect(u.href).toBe('https://example.com/cb')
    await expect(assertPublicHttpUrl('http://93.184.216.34/x', { lookup: async () => { throw new Error('no lookup') } })).resolves.toBeInstanceOf(URL)
  })

  it('allowPrivate accepts a local listener but still requires http(s)', async () => {
    await expect(assertPublicHttpUrl('http://127.0.0.1:9999/', { allowPrivate: true })).resolves.toBeInstanceOf(URL)
    await expect(assertPublicHttpUrl('ftp://127.0.0.1/', { allowPrivate: true })).rejects.toBeInstanceOf(UnsafeUrlError)
  })
})
