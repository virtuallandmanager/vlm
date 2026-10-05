import { createHmac } from 'node:crypto'

/** Per-scene pseudonymous visitor id: HMAC-SHA256(salt, lowercase(visitorId)), hex. */
export function visitorHash(saltHex: string, visitorId: string): string {
  return createHmac('sha256', Buffer.from(saltHex, 'hex')).update(visitorId.toLowerCase()).digest('hex')
}
