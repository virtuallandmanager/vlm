import { describe, it, expect } from 'vitest'
import { deployErrorMessage, listedDeployments } from './deploy'

describe('deployErrorMessage', () => {
  it('explains that Hyperfy hosting is not set up yet', () => {
    expect(deployErrorMessage(new Error('hyperfy_hosting_unavailable'))).toBe("Hyperfy hosting isn't set up yet, so worlds can't be deployed or redeployed.")
  })
  it('explains a missing deployment', () => {
    expect(deployErrorMessage(new Error('Deployment not found'))).toBe('That deployment no longer exists. Refresh the page.')
  })
  it('falls back to a generic message', () => {
    expect(deployErrorMessage(new Error('API error 500'))).toBe('Something went wrong. Try again in a moment.')
    expect(deployErrorMessage('nope')).toBe('Something went wrong. Try again in a moment.')
  })
})

describe('listedDeployments', () => {
  it('leaves out Hyperfy entries, which live under Your Hyperfy worlds now', () => {
    const list = [{ id: 'a', platform: 'decentraland' }, { id: 'b', platform: 'hyperfy' }, { id: 'c', platform: 'decentraland' }]
    expect(listedDeployments(list).map((d) => d.id)).toEqual(['a', 'c'])
  })
})
