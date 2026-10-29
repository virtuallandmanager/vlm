'use client'
import { Badge } from '@/components/ui'
import { AGENTS } from '@/lib/studio'

/** Claude Code and Codex, with Grok shown but not selectable. */
export function AgentPicker({ value, onChange, disabled, name }: { value: string; onChange: (id: string) => void; disabled?: boolean; name: string }) {
  return (
    <div role="radiogroup" aria-label="Agent" className="inline-flex flex-wrap rounded-md border border-gray-800 p-0.5 text-sm">
      {AGENTS.map((a) => (
        <label key={a.id}
          className={`flex items-center gap-2 rounded px-3 py-1.5 ${a.soon ? 'cursor-not-allowed text-gray-600' : value === a.id ? 'bg-white/[0.06] text-white' : 'cursor-pointer text-gray-400 hover:text-white'}`}>
          <input type="radio" name={name} className="sr-only" value={a.id} checked={value === a.id}
            disabled={a.soon || disabled} onChange={() => onChange(a.id)} />
          {a.label}
          {a.soon && <Badge>Coming soon</Badge>}
        </label>
      ))}
    </div>
  )
}
