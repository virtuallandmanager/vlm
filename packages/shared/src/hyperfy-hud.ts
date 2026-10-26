/** Shared vocabulary for the Hyperfy HUD: pairing-code sign-in for editing a VLM scene from inside a Hyperfy world. */

export const HYPERFY_PAIRING = {
  /** How long a pairing code stays claimable, in ms. */
  codeTtlMs: 600_000,
  /** Lifetime of a self-owned pairing, in ms (12 h). */
  selfPairingTtlMs: 43_200_000,
  /** Idle lifetime of a hosted pairing, in ms (90 days). */
  hostedIdleTtlMs: 7_776_000_000,
  /** Renew a pass this long before it expires, in ms. */
  renewBeforeMs: 120_000,
  /** How often the HUD polls a pending claim, in ms. */
  claimPollMs: 2_000,
  /** Crockford-style alphabet: no 0, O, 1 or I. */
  codeAlphabet: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789',
  codeLength: 6,
} as const

/** Shows a code as XXX-XXX. */
export function formatPairingCode(raw: string): string {
  return `${raw.slice(0, 3)}-${raw.slice(3)}`
}

/**
 * Normalizes a typed pairing code: uppercases, drops dashes and whitespace.
 * Returns null unless the result is exactly `codeLength` characters, all from `codeAlphabet`.
 */
export function normalizePairingCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[-\s]/g, '')
  if (code.length !== HYPERFY_PAIRING.codeLength) return null
  for (const ch of code) {
    if (!HYPERFY_PAIRING.codeAlphabet.includes(ch)) return null
  }
  return code
}

export interface PairStartResponse {
  code: string
  approveUrl: string
  qrUrl: string
  expiresAt: string
}

export type PairClaimResponse =
  | { status: 'pending' }
  | {
      status: 'approved'
      pass: string
      passExpiresAt: string
      pairingId: string
      /** The scene the pass edits (the world's scene). */
      sceneId: string
      user: { id: string; displayName: string }
    }
  | { status: 'refused' | 'expired' }

export interface PairRenewResponse {
  pass: string
  passExpiresAt: string
  sceneId: string
}

/** A hosted world's vouch for a linked player (POST /api/hyperfy/pairings/vouch). */
export interface HyperfyVouchLinked {
  status: 'linked'
  pass: string
  passExpiresAt: string
  pairingId: string
  sceneId: string
  user: { id: string; displayName: string }
}

/** Every answer of POST /api/hyperfy/pairings/vouch. */
export type HyperfyVouchResponse =
  | HyperfyVouchLinked
  | { status: 'unlinked'; code: string; approveUrl: string; qrUrl: string; expiresAt: string; pairingId: string }
  | { status: 'pending' | 'refused' | 'expired' }

export interface HyperfyPairingSummary {
  id: string
  worldId: string
  worldName: string
  sceneId: string
  sceneName: string
  kind: 'self' | 'hosted'
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string | null
}
