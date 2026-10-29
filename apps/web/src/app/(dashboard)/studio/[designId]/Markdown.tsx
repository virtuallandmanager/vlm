'use client'
import { Fragment } from 'react'
import { parseMarkdown, type Inline } from '@/lib/markdown'

/** An agent's reply, formatted. The tree from parseMarkdown becomes elements; no HTML from the reply is ever used. */
export default function Markdown({ text }: { text: string }) {
  return (
    <div className="space-y-2">
      {parseMarkdown(text).map((b, i) => {
        if (b.type === 'p') return <p key={i}><Inlines items={b.inlines} /></p>
        if (b.type === 'h') return <p key={i} className="font-semibold text-white"><Inlines items={b.inlines} /></p>
        if (b.type === 'code') {
          return <pre key={i} className="overflow-x-auto rounded bg-black/40 px-2 py-1.5 font-mono text-xs text-gray-300">{b.text}</pre>
        }
        const List = b.type === 'ul' ? 'ul' : 'ol'
        return (
          <List key={i} className={`space-y-0.5 pl-5 ${b.type === 'ul' ? 'list-disc' : 'list-decimal'}`}>
            {b.items.map((item, j) => <li key={j}><Inlines items={item} /></li>)}
          </List>
        )
      })}
    </div>
  )
}

function Inlines({ items }: { items: Inline[] }) {
  return (
    <>
      {items.map((n, i) => {
        switch (n.type) {
          case 'text': return <Fragment key={i}>{n.text}</Fragment>
          case 'br': return <br key={i} />
          case 'strong': return <strong key={i} className="font-semibold text-white"><Inlines items={n.children} /></strong>
          case 'em': return <em key={i}><Inlines items={n.children} /></em>
          case 'code': return <code key={i} className="rounded bg-black/40 px-1 py-0.5 font-mono text-[0.85em]">{n.text}</code>
          case 'link':
            return <a key={i} href={n.href} target="_blank" rel="noopener noreferrer" className="text-blue-300 underline"><Inlines items={n.children} /></a>
        }
      })}
    </>
  )
}
