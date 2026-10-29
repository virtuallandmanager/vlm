import { describe, it, expect } from 'vitest'
import type { AdContent, AdReviewStatus, AdAudience } from '@virvixr/shared'
import { adAllowed } from '../src/ads/content.js'

type Decision = 'approved' | 'declined' | null

describe('adAllowed', () => {
  const contents: AdContent[] = ['family', 'all', 'approve']
  const decisions: Decision[] = [null, 'approved', 'declined']
  const ads: Array<{ reviewStatus: AdReviewStatus; audience: AdAudience | null }> = [
    { reviewStatus: 'pending', audience: null },
    { reviewStatus: 'rejected', audience: null },
    { reviewStatus: 'approved', audience: 'family' },
    { reviewStatus: 'approved', audience: 'mature' },
  ]

  for (const content of contents) {
    for (const ad of ads) {
      for (const decision of decisions) {
        const expected =
          ad.reviewStatus !== 'approved' ? false
          : content === 'approve' ? decision === 'approved'
          : content === 'family' ? ad.audience === 'family'
          : true
        it(`${content} / ${ad.reviewStatus}${ad.audience ? ' ' + ad.audience : ''} / owner ${decision} -> ${expected}`, () => {
          expect(adAllowed(content, ad, decision)).toBe(expected)
        })
      }
    }
  }

  it('approve with an approved mature ad the owner approved is true', () => {
    expect(adAllowed('approve', { reviewStatus: 'approved', audience: 'mature' }, 'approved')).toBe(true)
  })
})
