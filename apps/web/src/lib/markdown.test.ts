import { describe, it, expect } from 'vitest'
import { parseMarkdown } from './markdown'

const t = (text: string) => ({ type: 'text', text })

describe('parseMarkdown', () => {
  it('splits paragraphs on blank lines and keeps single line breaks', () => {
    expect(parseMarkdown('one\ntwo\n\nthree')).toEqual([
      { type: 'p', inlines: [t('one'), { type: 'br' }, t('two')] },
      { type: 'p', inlines: [t('three')] },
    ])
  })

  it('reads bold, italics and inline code', () => {
    expect(parseMarkdown('a **bold** and *soft* and _also_ `out/hat/`')).toEqual([{ type: 'p', inlines: [
      t('a '), { type: 'strong', children: [t('bold')] }, t(' and '), { type: 'em', children: [t('soft')] },
      t(' and '), { type: 'em', children: [t('also')] }, t(' '), { type: 'code', text: 'out/hat/' },
    ] }])
  })

  it('leaves markers alone inside code and in words like snake_case', () => {
    expect(parseMarkdown('`**not bold**` upper_body_piece')).toEqual([{ type: 'p', inlines: [
      { type: 'code', text: '**not bold**' }, t(' upper_body_piece'),
    ] }])
  })

  it('reads headings and lists', () => {
    expect(parseMarkdown('## What changed\n- the **visor**\n- the brim\n\n1. first\n2. second')).toEqual([
      { type: 'h', level: 2, inlines: [t('What changed')] },
      { type: 'ul', items: [[t('the '), { type: 'strong', children: [t('visor')] }], [t('the brim')]] },
      { type: 'ol', items: [[t('first')], [t('second')]] },
    ])
  })

  it('keeps fenced code as it is', () => {
    expect(parseMarkdown('Run:\n```bash\nblender -b **x**\n```\ndone')).toEqual([
      { type: 'p', inlines: [t('Run:')] },
      { type: 'code', text: 'blender -b **x**' },
      { type: 'p', inlines: [t('done')] },
    ])
  })

  it('links only http and https addresses', () => {
    expect(parseMarkdown('[docs](https://docs.decentraland.org) and [bad](javascript:alert(1))')).toEqual([{ type: 'p', inlines: [
      { type: 'link', href: 'https://docs.decentraland.org', children: [t('docs')] },
      t(' and [bad](javascript:alert(1))'),
    ] }])
  })

  it('treats html as text', () => {
    expect(parseMarkdown('<img src=x onerror=alert(1)>')).toEqual([{ type: 'p', inlines: [t('<img src=x onerror=alert(1)>')] }])
  })

  it('closes an unterminated fence at the end and leaves a lone marker as text', () => {
    expect(parseMarkdown('```\ncode')).toEqual([{ type: 'code', text: 'code' }])
    expect(parseMarkdown('2 * 3 is **six')).toEqual([{ type: 'p', inlines: [t('2 * 3 is **six')] }])
  })
})
