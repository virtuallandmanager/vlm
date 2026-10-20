import { describe, it, expect } from 'vitest'
import { API_URL } from './config'
import { leadErrorMessage, submitAdvertiserLead } from './advertiser-leads'

describe('leadErrorMessage', () => {
  it('words each failure for a person', () => {
    expect(leadErrorMessage(429)).toBe('Too many tries — please try again later.')
    expect(leadErrorMessage(400, 'invalid_email')).toBe('Please enter a valid email address.')
    expect(leadErrorMessage(400, 'invalid_website')).toBe('Please check the website address.')
    expect(leadErrorMessage(400, 'too_long')).toBe('One of the fields is too long.')
    expect(leadErrorMessage(null)).toBe("We couldn't reach VLM. Please try again.")
    expect(leadErrorMessage(500)).toBe('Something went wrong. Please try again.')
  })
})

describe('submitAdvertiserLead', () => {
  const input = { email: 'ana@brand.example', consent: true as const }
  const respond = (status: number, body: unknown = {}) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch

  it('posts JSON to the public endpoint without credentials', async () => {
    let seen: { url: string; init: RequestInit } | null = null
    const fake = (async (url: string, init: RequestInit) => {
      seen = { url, init }
      return new Response('{"ok":true}', { status: 201 })
    }) as unknown as typeof fetch
    await submitAdvertiserLead(input, fake)
    expect(seen!.url).toBe(`${API_URL}/api/advertiser-leads`)
    expect(seen!.init.method).toBe('POST')
    expect(JSON.parse(String(seen!.init.body))).toEqual(input)
    expect(new Headers(seen!.init.headers).get('authorization')).toBeNull()
  })

  it('rejects with the rate limit message on 429', async () => {
    await expect(submitAdvertiserLead(input, respond(429))).rejects.toThrow('Too many tries — please try again later.')
  })

  it('rejects with the server error code message on 400', async () => {
    await expect(submitAdvertiserLead(input, respond(400, { error: 'invalid_email' }))).rejects.toThrow('Please enter a valid email address.')
  })

  it('rejects with the network message when fetch throws', async () => {
    const down = (async () => { throw new TypeError('Failed to fetch') }) as unknown as typeof fetch
    await expect(submitAdvertiserLead(input, down)).rejects.toThrow("We couldn't reach VLM. Please try again.")
  })
})
