/**
 * Outbound URL guard — refuses callback targets that point inside our network.
 *
 * Every resolved address must be public; a hostname with one private record is refused.
 */

import { promises as dns } from 'node:dns'
import { isIP } from 'node:net'

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeUrlError'
  }
}

export interface PublicUrlOptions {
  allowPrivate?: boolean
  lookup?: (host: string) => Promise<string[]>
}

export const defaultLookup = async (host: string) => (await dns.lookup(host, { all: true })).map((r) => r.address)

function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number)
  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // 224/4, 240/4 and 255.255.255.255
  )
}

/** Expand an IPv6 literal to eight 16-bit groups (embedded dotted IPv4 becomes two groups). */
function expandV6(ip: string): number[] {
  let s = ip.split('%')[0].toLowerCase()
  const dotted = s.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    const [a, b, c, d] = dotted[1].split('.').map(Number)
    s = s.slice(0, -dotted[1].length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16)
  }
  const [head, tail] = s.split('::')
  const h = head ? head.split(':') : []
  const t = tail === undefined ? [] : tail ? tail.split(':') : []
  const fill = tail === undefined ? [] : new Array(8 - h.length - t.length).fill('0')
  return [...h, ...fill, ...t].map((g) => parseInt(g, 16))
}

function isPrivateV6(ip: string): boolean {
  const g = expandV6(ip)
  if (g.length !== 8 || g.some(Number.isNaN)) return true
  if (g.slice(0, 7).every((x) => x === 0) && g[7] <= 1) return true // :: and ::1
  if ((g[0] & 0xfe00) === 0xfc00) return true // fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return true // fe80::/10
  if ((g[0] & 0xff00) === 0xff00) return true // ff00::/8
  // IPv4-mapped (::ffff:a.b.c.d) and deprecated IPv4-compatible (::a.b.c.d)
  const mapped = g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff
  const compat = g.slice(0, 6).every((x) => x === 0)
  if (mapped || compat) return isPrivateV4(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`)
  return false
}

export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip)
  if (kind === 4) return isPrivateV4(ip)
  if (kind === 6) return isPrivateV6(ip)
  return true // not an address we can classify
}

export async function assertPublicHttpUrl(url: string, opts: PublicUrlOptions = {}): Promise<URL> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new UnsafeUrlError('Invalid URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnsafeUrlError('Only http and https URLs are allowed')
  }
  if (opts.allowPrivate) return parsed

  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
    throw new UnsafeUrlError('Host is not public')
  }

  let addresses: string[]
  if (isIP(host)) {
    addresses = [host]
  } else {
    try {
      addresses = await (opts.lookup ?? defaultLookup)(host)
    } catch {
      throw new UnsafeUrlError('Host did not resolve')
    }
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new UnsafeUrlError('Host resolves to a non-public address')
  }
  return parsed
}
