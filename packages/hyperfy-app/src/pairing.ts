import { HYPERFY_FEED, HYPERFY_PAIRING, type PairClaimResponse, type PairRenewResponse, type PairStartResponse } from '@virvixr/shared'
import type { ScriptFetch, ScriptSetTimeout } from './poller.js'
import { parseIsoTime } from './iso-time.js'
import { sha256Hex } from './sha256.js'

export type PairingState =
  | { status: 'idle' }
  | { status: 'waiting'; code: string; approveUrl: string; qrUrl: string; expiresAt: string }
  | { status: 'linked'; displayName: string; sceneId: string }
  | { status: 'expired' }
  | { status: 'lost' }
  | { status: 'error'; reason: 'invalid_world_key' }

/** A scene pass, when it stops working (ISO time) and the scene it edits. pairingId/displayName come with a first link. */
export interface PassLink {
  pass: string
  passExpiresAt: string
  displayName?: string
  pairingId?: string
  sceneId?: string
}

/**
 * Asks for a fresh pass. Resolves to one; 'revoked' means the pairing is gone for good; null, undefined or a
 * rejection are temporary failures (retried with back-off). Self-run worlds use the secret-based default;
 * hosted worlds inject one that asks the world's server half to vouch again.
 */
export type PassRenewer = () => Promise<{ pass: string; passExpiresAt: string; sceneId?: string } | 'revoked' | null | undefined>

export interface PairingOptions {
  feedUrl: string
  worldKey: string
  fetch: ScriptFetch
  setTimeout: ScriptSetTimeout
  uuid: () => string
  onState: (s: PairingState) => void
  /** Milliseconds now; defaults to the sandbox clock. */
  now?: () => number
  renewer?: PassRenewer
}

/**
 * A HUD's link to VLM. Self-run: start() asks for a code, polls the claim until a VLM user approves it, then
 * keeps the pass fresh by renewing renewBeforeMs before it expires. Hosted: adopt() installs the pass the server
 * half vouched for, and the injected renewer keeps it fresh. The browser secret never leaves this object except
 * in the claim and renew bodies; only its SHA-256 goes out with the pair start.
 */
export class Pairing {
  private gen = 0
  private secret = ''
  private pairingId = ''
  private passValue: string | null = null
  private passExpiresAtMs = 0
  private name = ''
  private sceneId = ''
  private state: PairingState = { status: 'idle' }
  private renewDelay = 0
  private renewing: Promise<boolean> | null = null
  /** Only the latest renew timer acts: the sandbox has no clearTimeout, so stale timers must see they're stale. */
  private renewToken = 0
  private expiryToken = 0

  constructor(private readonly opts: PairingOptions) {}

  /** The current pass, or null when there is none or it has expired. */
  pass(): string | null {
    return this.passValue && this.now() < this.passExpiresAtMs ? this.passValue : null
  }

  start(playerName: string): void {
    this.reset()
    const gen = this.gen
    this.secret = this.opts.uuid() + this.opts.uuid() + this.opts.uuid()
    this.name = playerName
    void this.begin(gen, playerName)
  }

  /** Installs a pass from a hosted `linked` result, or a renewal of one. */
  adopt(link: PassLink): void {
    if (!Number.isFinite(parseIsoTime(link.passExpiresAt))) return
    if (link.pairingId) this.pairingId = link.pairingId
    if (link.displayName) this.name = link.displayName
    if (link.sceneId) this.sceneId = link.sceneId
    this.install(link.pass, link.passExpiresAt, this.gen)
  }

  /** Renews now (after a 401, say). Resolves true when a fresh pass was installed. */
  renewNow(): Promise<boolean> {
    if (!this.canRenew()) return Promise.resolve(false)
    return (this.renewing ??= this.renewOnce(this.gen).finally(() => {
      this.renewing = null
    }))
  }

  /**
   * VLM refused the pass (a 401): renews now, and if that can't produce a fresh pass the link is expired for good
   * ("Link expired. Pair again."), with no background renewal that could flip it back. Resolves true when renewed.
   */
  async renewOrExpire(): Promise<boolean> {
    const gen = this.gen
    if (await this.renewNow()) return true
    if (gen === this.gen && (this.state.status === 'linked' || this.state.status === 'lost')) {
      this.passValue = null
      this.renewToken++
      this.expiryToken++
      this.emit({ status: 'expired' })
    }
    return false
  }

  stop(): void {
    this.reset()
  }

  private canRenew(): boolean {
    return !!this.opts.renewer || !!(this.pairingId && this.secret)
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  private reset(): void {
    this.gen++
    this.passValue = null
    this.passExpiresAtMs = 0
    this.pairingId = ''
    this.secret = ''
    this.sceneId = ''
    this.renewDelay = 0
    this.renewing = null
    this.renewToken++
    this.expiryToken++
  }

  private emit(s: PairingState): void {
    const prev = this.state
    if (prev.status === s.status && JSON.stringify(prev) === JSON.stringify(s)) return
    this.state = s
    this.opts.onState(s)
  }

  private async post<T>(path: string, body: object): Promise<{ status: number; body: T | null } | undefined> {
    try {
      const res = await this.opts.fetch(`${this.opts.feedUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-VLM-App-Version': String(HYPERFY_FEED.version) },
        body: JSON.stringify(body),
      })
      if (!res) return undefined
      let parsed: T | null = null
      try {
        parsed = (await res.json()) as T
      } catch {
        /* no body */
      }
      return { status: res.status, body: res.ok ? parsed : null }
    } catch {
      return undefined
    }
  }

  private async begin(gen: number, playerName: string, failDelay = 0): Promise<void> {
    const r = await this.post<PairStartResponse>('/api/hyperfy/pair', {
      worldKey: this.opts.worldKey,
      secretHash: sha256Hex(this.secret),
      playerName,
    })
    if (gen !== this.gen) return
    const b = r?.body
    if (r?.status === 401) {
      this.emit({ status: 'error', reason: 'invalid_world_key' })
      return
    }
    if (!b || typeof b.code !== 'string') {
      // Could not start: show lost and try again, backing off
      this.emit({ status: 'lost' })
      const next = Math.min(Math.max(failDelay * 2, HYPERFY_FEED.retryMinMs), HYPERFY_FEED.retryMaxMs)
      this.opts.setTimeout(() => {
        if (gen === this.gen) void this.begin(gen, playerName, next)
      }, next)
      return
    }
    this.emit({ status: 'waiting', code: b.code, approveUrl: b.approveUrl, qrUrl: b.qrUrl, expiresAt: b.expiresAt })
    this.pollClaim(gen, b.code, parseIsoTime(b.expiresAt), 0)
  }

  private pollClaim(gen: number, code: string, codeExpiresAt: number, failDelay: number): void {
    this.opts.setTimeout(() => void this.claim(gen, code, codeExpiresAt, failDelay), failDelay || HYPERFY_PAIRING.claimPollMs)
  }

  private async claim(gen: number, code: string, codeExpiresAt: number, failDelay: number): Promise<void> {
    if (gen !== this.gen) return
    const r = await this.post<PairClaimResponse>(`/api/hyperfy/pair/${encodeURIComponent(code)}/claim`, { secret: this.secret })
    if (gen !== this.gen) return
    const b = r?.body
    if (b?.status === 'approved' && Number.isFinite(parseIsoTime(b.passExpiresAt))) {
      this.pairingId = b.pairingId
      this.name = b.user.displayName
      if (typeof b.sceneId === 'string') this.sceneId = b.sceneId
      this.install(b.pass, b.passExpiresAt, gen)
    } else if (b?.status === 'refused' || b?.status === 'expired' || this.now() >= codeExpiresAt) {
      this.emit({ status: 'expired' })
    } else {
      // pending polls at claimPollMs; a failed poll backs off (doubling, up to retryMaxMs)
      const next = b?.status === 'pending' ? 0 : Math.min(Math.max(failDelay * 2, HYPERFY_PAIRING.claimPollMs), HYPERFY_FEED.retryMaxMs)
      this.pollClaim(gen, code, codeExpiresAt, next)
    }
  }

  private install(pass: string, passExpiresAt: string, gen: number): void {
    this.passValue = pass
    this.passExpiresAtMs = parseIsoTime(passExpiresAt)
    this.renewDelay = 0
    this.emit({ status: 'linked', displayName: this.name, sceneId: this.sceneId })
    this.scheduleRenew(gen, Math.max(0, this.passExpiresAtMs - HYPERFY_PAIRING.renewBeforeMs - this.now()))
    const token = ++this.expiryToken
    this.opts.setTimeout(() => {
      if (gen === this.gen && token === this.expiryToken && this.passValue && this.now() >= this.passExpiresAtMs) this.emit({ status: 'expired' })
    }, Math.max(0, this.passExpiresAtMs - this.now()))
  }

  private scheduleRenew(gen: number, ms: number): void {
    if (!this.canRenew()) return
    const token = ++this.renewToken
    this.opts.setTimeout(() => {
      if (gen === this.gen && token === this.renewToken) void this.renewNow()
    }, ms)
  }

  private async renewOnce(gen: number): Promise<boolean> {
    if (gen !== this.gen || !this.passValue) return false
    let out: Awaited<ReturnType<PassRenewer>>
    try {
      out = await this.renew()
    } catch {
      out = null
    }
    if (gen !== this.gen) return false
    if (out === 'revoked') {
      this.passValue = null
      this.renewToken++
      this.emit({ status: 'expired' })
      return false
    }
    if (out && Number.isFinite(parseIsoTime(out.passExpiresAt))) {
      if (typeof out.sceneId === 'string' && out.sceneId) this.sceneId = out.sceneId
      this.install(out.pass, out.passExpiresAt, gen)
      return true
    }
    // Temporary failure: retry with back-off. Lost while the pass still works, expired once it has run out.
    this.emit(this.now() < this.passExpiresAtMs ? { status: 'lost' } : { status: 'expired' })
    this.renewDelay = Math.min(Math.max(this.renewDelay * 2, HYPERFY_FEED.retryMinMs), HYPERFY_FEED.retryMaxMs)
    this.scheduleRenew(gen, this.renewDelay)
    return false
  }

  /** The injected renewer, or the secret-based renew of this pairing. */
  private async renew(): ReturnType<PassRenewer> {
    if (this.opts.renewer) return this.opts.renewer()
    const r = await this.post<PairRenewResponse>(`/api/hyperfy/pairings/${encodeURIComponent(this.pairingId)}/renew`, { secret: this.secret })
    if (!r) return null
    if (r.status === 401) return 'revoked'
    return r.body && typeof r.body.pass === 'string' ? r.body : null
  }
}
