'use client'
import { useState } from 'react'
import { useApi } from '@/lib/api'
import { Badge, type Tone } from '@/components/ui'
import {
  categoryLabel, pieceTabStatus, refusalMessage, relativeTime, stageState, viewKey,
  type RenderView, type StudioDetail, type StudioPiece,
} from '@/lib/studio'
import SpinStage from './SpinStage'

const EMOTES = [[null, 'Spin'], ['idle', 'Idle'], ['wave', 'Wave'], ['dance', 'Dance'], ['clap', 'Clap'], ['walk', 'Walk']] as const
const SHAPES = [['male', 'Male'], ['female', 'Female']] as const
const OUTFITS = [['default', 'Default'], ['outfit-2', 'Outfit 2'], ['outfit-3', 'Outfit 3']] as const

function tabBadge(piece: StudioPiece, detail: StudioDetail): { label: string; tone: Tone } | null {
  const status = pieceTabStatus(piece, detail)
  if (status === 'building') return { label: 'Building', tone: 'info' }
  if (piece.revision?.checker?.pass === false) return { label: 'Checker found problems', tone: 'warning' }
  if (status === 'ready') return { label: 'Ready', tone: 'success' }
  return null
}

type Props = {
  designId: string
  detail: StudioDetail
  category: string | null
  onSelect: (category: string) => void
  onChanged: () => Promise<void>
  children?: React.ReactNode
}

/** The right column: the piece tabs, the stage, and the view buttons; the finalize strip and paid revisions sit under it. */
export default function Preview({ designId, detail, category, onSelect, onChanged, children }: Props) {
  const api = useApi()
  const kind = detail.design.kind
  const [view, setView] = useState<RenderView>({ bodyShape: 'male', outfit: 'default', emote: null })
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const piece = detail.pieces.find((p) => p.category === category) ?? detail.pieces[0]
  const key = viewKey(kind, view)
  const stage = stageState(piece, key, pending)

  // `pending` covers the request in flight; after it the design's own `queued` status says the view is rendering,
  // and the room's job event re-reads the design when it is done
  const pick = async (next: RenderView) => {
    setView(next)
    setError(null)
    if (!piece) return
    const k = viewKey(kind, next)
    if (piece.renders[k]?.status === 'ready' || piece.renders[k]?.status === 'queued' || pending.has(k)) return
    setPending((prev) => new Set(prev).add(k))
    try {
      await api.requestStudioRender(designId, { category: piece.category, ...next })
      await onChanged()
    } catch (err) {
      setError(refusalMessage(err as never, new Date()).text)
    } finally {
      setPending((prev) => new Set([...prev].filter((x) => x !== k)))
    }
  }

  const isPending = (v: RenderView) => !!piece && (pending.has(viewKey(kind, v)) || piece.renders[viewKey(kind, v)]?.status === 'queued')
  const button = (label: string, selected: boolean, next: RenderView) => (
    <button key={label} type="button" aria-pressed={selected} onClick={() => pick(next)} disabled={!piece}
      className={`rounded px-2.5 py-1 text-sm disabled:opacity-40 ${selected ? 'bg-white/[0.08] text-white' : 'text-gray-400 hover:text-white'}`}>
      {label}{isPending(next) ? ' · Rendering…' : ''}
    </button>
  )

  return (
    <section aria-label="Preview" className="flex min-w-0 flex-col gap-4">
      <div className="rounded-lg border border-gray-800 bg-gray-900">
        {detail.pieces.length > 0 && (
          <div role="tablist" aria-label="Pieces" className="flex flex-wrap gap-1 border-b border-gray-800 p-2">
            {detail.pieces.map((p) => {
              const b = tabBadge(p, detail)
              const selected = p.category === piece?.category
              return (
                <button key={p.id} role="tab" aria-selected={selected} type="button" onClick={() => onSelect(p.category)}
                  className={`flex items-center gap-2 rounded px-3 py-1.5 text-sm ${selected ? 'bg-white/[0.06] text-white' : 'text-gray-400 hover:text-white'}`}>
                  <span className="capitalize">{kind === 'emote' ? p.name : categoryLabel(p.category)}</span>
                  {b && <Badge tone={b.tone}>{b.label}</Badge>}
                </button>
              )
            })}
          </div>
        )}

        <div className="relative mx-auto aspect-square w-full max-w-[560px] bg-gray-950">
          {stage.kind === 'frames' ? (
            <SpinStage view={`${piece!.category}/${key}`} urls={stage.urls} loop={kind === 'emote' || !!view.emote}
              label={`${piece!.name}, ${view.bodyShape}${view.emote ? `, ${view.emote}` : ''}`} />
          ) : stage.kind === 'rendering' ? (
            <p className="absolute inset-0 flex items-center justify-center text-sm text-gray-400" aria-live="polite">Rendering this view…</p>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-8 text-center text-sm text-gray-400">
              <p>{stage.text}</p>
              {piece && <button type="button" onClick={() => pick({ ...view })} className="text-blue-300 underline">Render this view</button>}
            </div>
          )}
        </div>

        <div className="space-y-2 border-t border-gray-800 p-3">
          {piece?.revision && (
            <p className="text-xs text-gray-500">
              Revision {piece.revision.number}
              {stage.kind === 'frames' && ` · rendered ${relativeTime(stage.renderedAt, new Date())}`}
            </p>
          )}
          {kind === 'wearable' && (
            <div className="flex flex-wrap gap-1" role="group" aria-label="Emote">
              {EMOTES.map(([emote, label]) => button(label, view.emote === emote, { ...view, emote }))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Avatar">
            {SHAPES.map(([bodyShape, label]) => button(label, view.bodyShape === bodyShape, { ...view, bodyShape }))}
            <span className="mx-1 h-4 w-px bg-gray-800" aria-hidden="true" />
            {OUTFITS.map(([outfit, label]) => button(label, view.outfit === outfit, { ...view, outfit }))}
          </div>
          {error && <p className="text-sm text-amber-300" role="alert">{error}</p>}
        </div>
      </div>
      {children}
    </section>
  )
}
