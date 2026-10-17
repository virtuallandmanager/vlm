import { createHash } from 'node:crypto'
import { Authenticator } from '@dcl/crypto'
import { createUnsafeIdentity } from '@dcl/crypto/dist/crypto.js'
import { createPayload } from '@dcl/crypto-middleware'
import { createLegacyPayload } from '@dcl/crypto-middleware/dist/verify.js'

const wallets = { a: createUnsafeIdentity(), b: createUnsafeIdentity() }

export const SCENE_META = {
  sceneId: 'bafkreiscenea',
  parcel: '10,20',
  tld: 'org',
  network: 'mainnet',
  isGuest: false,
  signer: 'decentraland-kernel-scene',
  realm: { hostname: 'peer.decentraland.org', protocol: 'v3', serverName: 'main' },
}

/**
 * Signs a request exactly as the explorer does: a real wallet -> ephemeral auth chain, with the
 * ephemeral key signing the 6.x payload (metadata bytes verbatim). `legacy: true` signs the
 * pre-6.0.0 payload (whole string lowercased) instead, for old-explorer traffic.
 */
export async function signedSceneHeaders(opts: {
  method: string
  path: string
  body?: string
  metadata?: Record<string, unknown>
  rawMetadata?: string
  wallet?: 'a' | 'b'
  legacy?: boolean
}): Promise<{ headers: Record<string, string>; wallet: string }> {
  const w = wallets[opts.wallet ?? 'a']
  const ephemeral = createUnsafeIdentity()
  const ownerSigner = async (msg: string) => Authenticator.createSignature(w, msg)
  const identity = await Authenticator.initializeAuthChain(w.address, ephemeral, 10, ownerSigner)
  const meta: Record<string, unknown> = { ...SCENE_META, ...(opts.metadata ?? {}) }
  if (opts.body !== undefined && !('hashPayload' in (opts.metadata ?? {}))) {
    meta.hashPayload = createHash('sha256').update(opts.body, 'utf8').digest('hex')
  }
  const rawMetadata = opts.rawMetadata ?? JSON.stringify(meta)
  const ts = Date.now()
  const build = opts.legacy ? createLegacyPayload : createPayload
  const chain = Authenticator.signPayload(identity, build(opts.method, opts.path, String(ts), rawMetadata))
  const headers: Record<string, string> = {}
  chain.forEach((link, i) => { headers[`x-identity-auth-chain-${i}`] = JSON.stringify(link) })
  headers['x-identity-timestamp'] = String(ts)
  headers['x-identity-metadata'] = rawMetadata
  return { headers, wallet: w.address.toLowerCase() }
}
