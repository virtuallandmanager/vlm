/**
 * Decentraland Signed Fetch Verification
 *
 * Verifies that platform auth requests from Decentraland are cryptographically
 * signed by the player's wallet. Uses the AuthChain pattern:
 *
 * 1. SIGNER — identifies the Ethereum wallet address
 * 2. ECDSA_EPHEMERAL — wallet delegates to an ephemeral key (login proof)
 * 3. ECDSA_SIGNED_ENTITY — ephemeral key signs the specific request
 *
 * Headers sent by DCL's signedFetch:
 *   X-Identity-Auth-Chain-0, X-Identity-Auth-Chain-1, X-Identity-Auth-Chain-2
 *   X-Identity-Timestamp
 *   X-Identity-Metadata
 */

import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

// decentraland-crypto-middleware is CJS, use require
const { default: verify, extractAuthChain } = require('decentraland-crypto-middleware/lib/verify') as {
  default: (
    method: string,
    path: string,
    headers: Record<string, string | string[] | undefined>,
    options?: { catalyst?: string; expiration?: number }
  ) => Promise<{ auth: string; authMetadata: Record<string, any> }>,
  extractAuthChain: (headers: Record<string, string | string[] | undefined>) => any[],
}

export interface DclAuthResult {
  /** Lowercase Ethereum address of the verified wallet */
  walletAddress: string
  /** Metadata sent with the signed request */
  metadata: Record<string, any>
}

/**
 * Verify a Decentraland signed fetch request.
 *
 * @param method HTTP method (GET, POST, etc.)
 * @param path Request path (e.g., /api/auth/platform)
 * @param headers Request headers object
 * @returns Verified wallet address and metadata
 * @throws Error if verification fails
 */
export async function verifyDclSignedFetch(
  method: string,
  path: string,
  headers: Record<string, string | string[] | undefined>,
): Promise<DclAuthResult> {
  const result = await verify(method, path, headers, {
    expiration: 120_000, // 2 minutes — generous for slow connections
  })

  return {
    walletAddress: result.auth, // lowercase eth address
    metadata: result.authMetadata || {},
  }
}

/**
 * Check if a request has DCL auth chain headers.
 * Useful for determining which auth method to use.
 */
export function hasDclAuthHeaders(headers: Record<string, string | string[] | undefined>): boolean {
  return !!headers['x-identity-auth-chain-0']
}
