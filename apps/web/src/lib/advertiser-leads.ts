import type { AdvertiserLeadInput } from '@virvixr/shared'
import { API_URL } from './config'

const CODE_MESSAGES: Record<string, string> = {
  invalid_email: 'Please enter a valid email address.',
  invalid_website: 'Please check the website address.',
  too_long: 'One of the fields is too long.',
}

/** What to tell a visitor when the early-access form fails. `status` is null when the request never reached VLM. */
export function leadErrorMessage(status: number | null, code?: string): string {
  if (status === null) return "We couldn't reach VLM. Please try again."
  if (status === 429) return 'Too many tries — please try again later.'
  if (status === 400 && code && CODE_MESSAGES[code]) return CODE_MESSAGES[code]
  return 'Something went wrong. Please try again.'
}

/** Send the early-access form. Public: no credentials. Throws an Error whose message is ready to show. */
export async function submitAdvertiserLead(input: AdvertiserLeadInput, fetchImpl: typeof fetch = fetch): Promise<void> {
  let res: Response
  try {
    res = await fetchImpl(`${API_URL}/api/advertiser-leads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
  } catch {
    throw new Error(leadErrorMessage(null))
  }
  if (res.ok) return
  const body = await res.json().catch(() => null)
  throw new Error(leadErrorMessage(res.status, body?.error))
}
