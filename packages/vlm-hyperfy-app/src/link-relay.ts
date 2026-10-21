import { HYPERFY_FEED, HYPERFY_PAIRING, type HyperfyVouchResponse } from 'vlm-shared'
import {
  LINK,
  type HApp,
  type HWorld,
  type LinkReply,
  type ScriptFetch,
  type ScriptSetTimeout,
  type VlmWorld,
} from './sandbox.js'

export interface LinkRelayOptions {
  app: Pick<HApp, 'on' | 'sendTo'>
  world: Pick<HWorld, 'getPlayer' | 'on'>
  fetch: ScriptFetch
  setTimeout: ScriptSetTimeout
  /** `app.vlmWorld`: server-only, from the machine env. Undefined or incomplete means a self-run world. */
  vlmWorld: VlmWorld | undefined
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
 * - Hosted worlds vouch for that player with the server-only world (`app.vlmWorld`: secret, VLM API URL, world key,
 *   from the machine env). Never props: builders can edit those, and the secret must only ever go to VLM.
 * - The result goes to that player only. While unlinked the pending pairing is polled every claimPollMs until it is
 *   approved, refused or expired.
 * - Without a complete server-only world (a self-run world) nothing is vouched: the player pairs from the browser.
 */
export function runLinkRelay({ app, world, fetch, setTimeout, vlmWorld }: LinkRelayOptions): void {
  const secret = vlmWorld?.secret
  const apiUrl = (vlmWorld?.apiUrl ?? '').trim().replace(/\/+$/, '')
  const worldKey = (vlmWorld?.worldKey ?? '').trim()
  const hosted =
    typeof secret === 'string' && !!secret && /^https?:\/\//i.test(apiUrl) && !!worldKey
  /** Each player's link in progress: the poll that may act, the attempt to answer, its pending pairing and code card. */
  const pending = new Map<
    string,
    { token: number; attempt: number; pairingId?: string; card?: LinkReply }
  >()
  let tokens = 0
  const reply = (playerId: string, r: LinkReply, attempt: number) =>
    app.sendTo(playerId, LINK, { ...r, attempt })

  const vouch = async (
    playerId: string,
    pendingPairingId?: string,
  ): Promise<HyperfyVouchResponse | { httpStatus: number } | undefined> => {
    const body = {
      worldKey,
      worldSecret: secret,
      hyperfyPlayerId: playerId,
      playerName: world.getPlayer(playerId)?.name ?? null,
      ...(pendingPairingId ? { pendingPairingId } : {}),
    }
    try {
      const res = await fetch(`${apiUrl}/api/hyperfy/pairings/vouch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-VLM-App-Version': String(HYPERFY_FEED.version),
        },
        body: JSON.stringify(body),
      })
      if (!res) return undefined
      if (!res.ok) return { httpStatus: res.status }
      return (await res.json()) as HyperfyVouchResponse
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
    const status = r && 'status' in r ? r.status : null
    if (r && 'status' in r && r.status === 'linked') {
      pending.delete(playerId)
      answer({
        status: 'linked',
        pass: r.pass,
        passExpiresAt: r.passExpiresAt,
        pairingId: r.pairingId,
        sceneId: r.sceneId,
        displayName: r.user?.displayName ?? '',
      })
    } else if (r && 'status' in r && r.status === 'unlinked') {
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
    } else if (r && 'httpStatus' in r && r.httpStatus === 401) {
      // VLM doesn't know this world's secret (yet): the browser can still pair with a code.
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
