import { describe, it, expect } from 'vitest'
import { siteLinks } from './site'

describe('siteLinks', () => {
  it('derives the privacy page from the docs site', () => {
    expect(siteLinks({ docs: 'https://docs.example/' })).toEqual({ docs: 'https://docs.example/', privacy: 'https://docs.example/privacy/', discord: null })
  })

  it('leaves out links that are not configured', () => {
    expect(siteLinks({})).toEqual({ docs: null, privacy: null, discord: null })
  })
})
