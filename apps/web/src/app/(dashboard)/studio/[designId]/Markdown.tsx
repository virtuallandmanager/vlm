'use client'
import { Fragment, useMemo } from 'react'
import { parseMarkdown, type Block, type Inline } from '@/lib/markdown'

/** An agent's reply, formatted. The tree from parseMarkdown becomes elements; no HTML from the reply is ever used. */
export default function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text])
  return <Blocks blocks={blocks} />
}

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <div className="space-y-2">
      {blocks.map((b, i) => {
        if (b.type === 'p') return <p key={i}><Inlines items={b.inlines} /></p>
        if (b.type === 'h') return <p key={i} className="font-semibold text-white"><Inlines items={b.inlines} /></p>
        if (b.type === 'code') {
          return <pre key={i} className="overflow-x-auto rounded bg-black/40 px-2 py-1.5 font-mono text-xs text-gray-300">{b.text}</pre>
        }
        const items = b.items.map((item, j) => (
          <li key={j}>
            <Inlines items={item.inlines} />
            {item.children.length > 0 && <div className="mt-1"><Blocks blocks={item.children} /></div>}
          </li>
        ))
        return b.type === 'ul'
          ? <ul key={i} className="list-disc space-y-0.5 pl-5">{items}</ul>
          : <ol key={i} start={b.start} className="list-decimal space-y-0.5 pl-5">{items}</ol>
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
