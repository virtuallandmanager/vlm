'use client'
import { useEffect, useRef, useState } from 'react'
import { agentLabel, otherAgents } from '@/lib/studio'

/** The selected agent, with the others behind "Change agent": most people stay on the preselected, cheapest one. */
export function AgentPicker({ value, onChange, disabled, name }: { value: string; onChange: (id: string) => void; disabled?: boolean; name: string }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close) }
  }, [open])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  const menuId = `${name}-menu`
  return (
    <div ref={ref} className="relative inline-flex items-center gap-3 text-sm">
      <span className="rounded-md border border-gray-800 px-3 py-1.5 text-white" aria-label="Agent">{agentLabel(value)}</span>
      <button type="button" onClick={() => setOpen(!open)} disabled={disabled} aria-haspopup="menu" aria-expanded={open} aria-controls={menuId}
        className="text-gray-400 hover:text-white disabled:cursor-not-allowed disabled:text-gray-600">
        Change agent
      </button>
      {open && (
        <div id={menuId} role="menu" className="absolute left-0 top-full z-20 mt-1 min-w-44 rounded-md border border-gray-800 bg-gray-900 py-1 shadow-lg shadow-black/40">
          {otherAgents(value).map((a) => (
            <button key={a.id} type="button" role="menuitem" onClick={() => { setOpen(false); onChange(a.id) }}
              className="block w-full px-3 py-2 text-left text-sm text-gray-200 hover:bg-white/[0.05]">
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
