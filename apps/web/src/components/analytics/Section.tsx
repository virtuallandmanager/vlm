import type { ReactNode } from 'react'

export type SectionState = 'loading' | 'error' | 'empty' | 'ready'

export function Section({ title, action, state, onRetry, children }: {
  title: string
  action?: ReactNode
  state: SectionState
  onRetry: () => void
  children?: ReactNode
}) {
  return (
    <section className="bg-gray-900 rounded-xl p-5" aria-busy={state === 'loading'}>
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-white">{title}</h2>
        {action}
      </div>
      {state === 'loading' && <p className="text-sm text-gray-400">Loading…</p>}
      {state === 'error' && (
        <p className="text-sm text-gray-400" role="alert">
          Couldn&apos;t load —{' '}
          <button type="button" onClick={onRetry} className="text-blue-500 hover:text-blue-400 underline-offset-2 hover:underline">
            Retry
          </button>
        </p>
      )}
      {state === 'empty' && <p className="text-sm text-gray-400">No visits recorded yet</p>}
      {state === 'ready' && children}
    </section>
  )
}
