import { HYPERFY_FEED, HYPERFY_PAIRING } from '@virvixr/shared'
import {
  LINK,
  type HApp,
  type HWorld,
  type LinkReply,
  type ScriptSetTimeout,
  type VirviVouch,
  type VirviVouchResult,
} from './sandbox.js'

export interface LinkRelayOptions {
  app: Pick<HApp, 'on' | 'sendTo'>
  world: Pick<HWorld, 'getPlayer' | 'on'>
  setTimeout: ScriptSetTimeout
  /** `app.virviVouch`: a hosted image's server-side vouch. Undefined means a self-run world. */
  vouch: VirviVouch | undefined
}

/** A LINK request's attempt number, echoed in every answer so the browser can drop answers to older attempts. */
function attemptOf(data: unknown): number {
  const a = data && typeof data === 'object' ? (data as { attempt?: unknown }).attempt : undefined
  return typeof a === 'number' && Number.isFinite(a) ? a : 0
}

/**
 * The server half's answer to LINK.
 * - The player is the event's sender (Hyperfy passes the sender's socket id, which is the player id), never anything
 *   in the message, and only an admin or builder is answered at all.
 * - Hosted worlds vouch for that player through `app.virviVouch`: the image calls Virvi from Node with the world secret
 *   and key from its machine env, so the secret never enters a script (any builder's script shares the sandbox).
 * - The result goes to that player only. While unlinked the pending pairing is polled every claimPollMs until it is
 *   approved, refused or expired.
 * - Without `app.virviVouch` (a self-run world) nothing is vouched: the player pairs from the browser.
 */
export function runLinkRelay({ app, world, setTimeout, vouch: virviVouch }: LinkRelayOptions): void {
  const hosted = typeof virviVouch === 'function'
  /** Each player's link in progress: the poll that may act, the attempt to answer, its pending pairing and code card. */
  const pending = new Map<
    string,
    { token: number; attempt: number; pairingId?: string; card?: LinkReply }
  >()
  let tokens = 0
  const reply = (playerId: string, r: LinkReply, attempt: number) =>
    app.sendTo(playerId, LINK, { ...r, attempt })

  const vouch = async (playerId: string, pendingPairingId?: string): Promise<VirviVouchResult | undefined> => {
    try {
      return await virviVouch!({
        hyperfyPlayerId: playerId,
        playerName: world.getPlayer(playerId)?.name ?? null,
        ...(pendingPairingId ? { pendingPairingId } : {}),
      })
    } catch {
      return undefined
    }
  }

  const step = async (playerId: string, token: number, failDelay: number): Promise<void> => {
    const mine = () => pending.get(playerId)?.token === token
    if (!mine()) return
    const entry = pending.get(playerId)!
    const r = await vouch(playerId, entry.pairingId)
    if (!mine()) return
    const answer = (x: LinkReply) => reply(playerId, x, entry.attempt)
    const again = (delay: number) =>
      setTimeout(() => void step(playerId, token, delay), delay || HYPERFY_PAIRING.claimPollMs)
    const status = r?.status ?? null
    if (r?.status === 'linked') {
      pending.delete(playerId)
      answer({
        status: 'linked',
        pass: r.pass,
        passExpiresAt: r.passExpiresAt,
        pairingId: r.pairingId,
        sceneId: r.sceneId,
        displayName: r.user?.displayName ?? '',
      })
    } else if (r?.status === 'unlinked') {
      entry.pairingId = r.pairingId
      entry.card = {
        status: 'unlinked',
        code: r.code,
        approveUrl: r.approveUrl,
        qrUrl: r.qrUrl,
        expiresAt: r.expiresAt,
      }
      answer(entry.card)
      again(0)
    } else if (status === 'pending') {
      again(0)
    } else if (status === 'refused' || status === 'expired') {
      pending.delete(playerId)
      answer({ status: 'expired' })
    } else if (status === 'unauthorized') {
      // Virvi doesn't know this world's secret (bad or cleared): the browser can still pair with a code.
      pending.delete(playerId)
      answer({ status: 'self' })
    } else if (entry.pairingId) {
      // Lost while a code is out: keep polling, backing off.
      again(Math.min(Math.max(failDelay * 2, HYPERFY_FEED.retryMinMs), HYPERFY_FEED.retryMaxMs))
    } else {
      pending.delete(playerId)
      answer({ status: 'lost' })
    }
  }

  app.on(LINK, (data, playerId) => {
    if (!playerId) return
    // Only players who may build here get the HUD; anyone else (a visitor sending LINK by hand) is ignored, so they
    // can't mint codes or spend the world's vouch budget.
    const player = world.getPlayer(playerId)
    if (!player || !(player.admin || player.builder)) return
    const attempt = attemptOf(data)
    if (!hosted) return reply(playerId, { status: 'self' }, attempt)
    const current = pending.get(playerId)
    if (current) {
      current.attempt = attempt
      // A code is already out for this player: show it again rather than minting another.
      if (current.card) reply(playerId, current.card, attempt)
      return
    }
    const token = ++tokens
    pending.set(playerId, { token, attempt })
    void step(playerId, token, 0)
  })
  world.on('leave', (e) => pending.delete(e.playerId))
}
