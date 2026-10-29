/**
 * The small Markdown the studio's agents write (paragraphs, headings, lists, fenced code, bold, italics, inline code
 * and links), parsed into a tree the page renders as React elements. Nothing is ever turned into HTML: tags in a
 * reply stay text, and only http(s) links become links.
 */

export type Inline =
  | { type: 'text'; text: string }
  | { type: 'br' }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: Inline[] }

export type Block =
  | { type: 'p'; inlines: Inline[] }
  | { type: 'h'; level: 1 | 2 | 3; inlines: Inline[] }
  | { type: 'ul' | 'ol'; items: Inline[][] }
  | { type: 'code'; text: string }

const FENCE = /^\s*```/
const HEADING = /^(#{1,6})\s+(.*)$/
const BULLET = /^\s*[-*+]\s+(.*)$/
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n')
  const blocks: Block[] = []
  let para: string[] = []
  const flush = () => {
    if (para.length) blocks.push({ type: 'p', inlines: inlinesOfLines(para) })
    para = []
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (FENCE.test(line)) {
      flush()
      const code: string[] = []
      for (i++; i < lines.length && !FENCE.test(lines[i]); i++) code.push(lines[i])
      blocks.push({ type: 'code', text: code.join('\n') })
      continue
    }
    const h = HEADING.exec(line)
    if (h) {
      flush()
      blocks.push({ type: 'h', level: Math.min(h[1].length, 3) as 1 | 2 | 3, inlines: parseInline(h[2].trim()) })
      continue
    }
    const listKind = BULLET.test(line) ? 'ul' : NUMBERED.test(line) ? 'ol' : null
    if (listKind) {
      flush()
      const re = listKind === 'ul' ? BULLET : NUMBERED
      const items: Inline[][] = []
      for (; i < lines.length && re.test(lines[i]); i++) items.push(parseInline(re.exec(lines[i])![1].trim()))
      i--
      blocks.push({ type: listKind, items })
      continue
    }
    if (!line.trim()) flush()
    else para.push(line.trim())
  }
  flush()
  return blocks
}

function inlinesOfLines(lines: string[]): Inline[] {
  return lines.flatMap((l, i) => (i ? [{ type: 'br' } as Inline, ...parseInline(l)] : parseInline(l)))
}

const SAFE_HREF = /^https?:\/\/[^\s]+$/i

/** Inline spans. A marker only counts with a closing partner; anything unmatched stays as written. */
export function parseInline(s: string): Inline[] {
  const out: Inline[] = []
  let text = ''
  const pushText = (t: string) => { text += t }
  const flush = () => {
    if (text) out.push({ type: 'text', text })
    text = ''
  }

  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '`') {
      const end = s.indexOf('`', i + 1)
      if (end > i + 1) {
        flush()
        out.push({ type: 'code', text: s.slice(i + 1, end) })
        i = end + 1
        continue
      }
    }
    if (c === '*' && s[i + 1] === '*') {
      const end = s.indexOf('**', i + 2)
      if (end > i + 2) {
        flush()
        out.push({ type: 'strong', children: parseInline(s.slice(i + 2, end)) })
        i = end + 2
        continue
      }
    }
    if ((c === '*' || c === '_') && s[i + 1] !== c && s[i + 1] !== ' ' && s[i + 1] !== undefined) {
      // `_` only opens at a word's start, so snake_case stays text
      const opensWord = c === '*' || i === 0 || /[\s(]/.test(s[i - 1])
      const end = findClose(s, c, i + 1)
      if (opensWord && end > i + 1) {
        flush()
        out.push({ type: 'em', children: parseInline(s.slice(i + 1, end)) })
        i = end + 1
        continue
      }
    }
    if (c === '[') {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(s.slice(i))
      if (m && SAFE_HREF.test(m[2])) {
        flush()
        out.push({ type: 'link', href: m[2], children: parseInline(m[1]) })
        i += m[0].length
        continue
      }
    }
    pushText(c)
    i++
  }
  flush()
  return out
}

/** The closing single `*` or `_`: not doubled, not after a space, and (for `_`) at a word's end. */
function findClose(s: string, c: string, from: number): number {
  for (let j = from; j < s.length; j++) {
    if (s[j] !== c || s[j - 1] === ' ' || s[j + 1] === c) continue
    if (c === '_' && s[j + 1] !== undefined && /\w/.test(s[j + 1])) continue
    return j
  }
  return -1
}
