import { asc, eq, inArray } from 'drizzle-orm'
import { db } from '../db/connection.js'
import { studioEntitlements, studioPieces, studioRevisions, type PaymentLine } from '../db/schema.js'
import { config } from '../config.js'
import type { Design } from './designs.js'

/**
 * What finalizing a design's pieces costs. A piece's first finalize is the first paid revision of that piece; every
 * later one is a half-price revision. Within a design the first finalized wearable piece is full price and the rest
 * are extra pieces; within one checkout the first wearable revision is full price and the rest are extra pieces. A
 * piece whose checker found a FAIL can't be finalized. Amounts are settings (config.studioPrices).
 */

export const RECURATION_NOTE =
  'Decentraland’s curators review a change to a published item again before it goes live. Decentraland doesn’t charge for that review.'

export type QuotePiece = {
  category: string
  name: string
  revisionNumber: number
  revisionId: string
  state: 'payable' | 'entitled' | 'blocked' | 'none'
  kind: 'first' | 'revision'
  checker: unknown
}

export type Quote = { pieces: QuotePiece[]; lines: PaymentLine[]; totalCents: number; blocked: string[]; notes: string[] }

export class QuoteError extends Error {
  constructor(public code: 'checks_failed' | 'nothing_to_pay' | 'unknown_piece' | 'not_waivable', public categories: string[] = []) {
    super(code)
  }
}

/**
 * The price of each piece in one checkout, in order: `kind` is whether the piece has been paid for before, and
 * `designHasFirst` whether any piece of the design has. Used to quote, and again when a payment is granted, against
 * what has been paid for by then.
 */
export function priceLines(
  designKind: string,
  pieces: { kind: 'first' | 'revision' }[],
  designHasFirst: boolean,
): { priceKind: PaymentLine['priceKind']; amountCents: number }[] {
  const prices = config.studioPrices
  const emote = designKind === 'emote'
  let hasFirst = designHasFirst
  let hasRevision = false
  return pieces.map((p) => {
    if (p.kind === 'first') {
      const line = {
        priceKind: emote || !hasFirst ? 'first' as const : 'first_extra' as const,
        amountCents: emote ? prices.emote : hasFirst ? prices.extraPiece : prices.wearable,
      }
      hasFirst = true
      return line
    }
    const line = {
      priceKind: emote || !hasRevision ? 'revision' as const : 'revision_extra' as const,
      amountCents: emote ? prices.revisionEmote : hasRevision ? prices.revisionExtraPiece : prices.revisionWearable,
    }
    hasRevision = true
    return line
  })
}

export async function quoteFinalize(design: Design, categories: string[] | null, waived: string[]): Promise<Quote> {
  const pieceRows = await db.select().from(studioPieces).where(eq(studioPieces.designId, design.id)).orderBy(asc(studioPieces.category))
  const revIds = pieceRows.map((p) => p.latestRevisionId).filter((x): x is string => !!x)
  const revs = revIds.length ? await db.select().from(studioRevisions).where(inArray(studioRevisions.id, revIds)) : []
  const ents = await db.select().from(studioEntitlements).where(eq(studioEntitlements.designId, design.id))
  const pieces: QuotePiece[] = pieceRows.map((p) => {
    const rev = revs.find((r) => r.id === p.latestRevisionId)
    const kind = ents.some((e) => e.category === p.category) ? 'revision' as const : 'first' as const
    const state = !rev ? 'none' as const
      : ents.some((e) => e.revisionId === rev.id) ? 'entitled' as const
        : (rev.checker as { pass?: boolean } | null)?.pass === false ? 'blocked' as const
          : 'payable' as const
    return { category: p.category, name: p.name, revisionNumber: rev?.number ?? 0, revisionId: rev?.id ?? '', state, kind, checker: rev?.checker ?? null }
  })
  const blocked = pieces.filter((p) => p.state === 'blocked').map((p) => p.category)

  let chosen: QuotePiece[]
  if (categories) {
    const unknown = categories.filter((c) => !pieces.some((p) => p.category === c && p.state !== 'none'))
    if (unknown.length) throw new QuoteError('unknown_piece', unknown)
    const failing = categories.filter((c) => blocked.includes(c))
    if (failing.length) throw new QuoteError('checks_failed', failing)
    chosen = pieces.filter((p) => categories.includes(p.category) && p.state === 'payable')
    if (!chosen.length) throw new QuoteError('nothing_to_pay', categories)
  } else {
    chosen = pieces.filter((p) => p.state === 'payable')
  }
  const notWaivable = waived.filter((c) => !chosen.some((p) => p.category === c && p.kind === 'revision'))
  if (notWaivable.length) throw new QuoteError('not_waivable', notWaivable)

  const prices = priceLines(design.kind, chosen, ents.length > 0)
  const lines: PaymentLine[] = chosen.map((p, i) => ({
    category: p.category, revisionId: p.revisionId, revisionNumber: p.revisionNumber, pieceName: p.name,
    ...prices[i], waived: waived.includes(p.category),
  }))
  return {
    pieces,
    lines,
    totalCents: lines.reduce((sum, l) => sum + (l.waived ? 0 : l.amountCents), 0),
    blocked,
    notes: lines.some((l) => l.priceKind.startsWith('revision')) ? [RECURATION_NOTE] : [],
  }
}
