export interface CountryLookup {
  lookup(ip: string, headers: Record<string, string | string[] | undefined>): string | null
}

const VALID = /^[A-Z]{2}$/
const UNKNOWN = new Set(['XX', 'T1', 'ZZ'])

function normalize(code: unknown): string | null {
  if (typeof code !== 'string') return null
  const c = code.toUpperCase()
  return VALID.test(c) && !UNKNOWN.has(c) ? c : null
}

/**
 * Country from a CDN header (Cloudflare `cf-ipcountry`) or, when GEOIP_COUNTRY_DB_PATH points at an
 * mmdb country database (e.g. DB-IP Lite, CC-BY 4.0), from the IP. The IP itself is never kept.
 */
export async function createCountryLookup(dbPath: string | undefined = process.env.GEOIP_COUNTRY_DB_PATH): Promise<CountryLookup> {
  type Reader = { get(ip: string): { country?: { iso_code?: string } } | null }
  let reader = null as Reader | null
  if (dbPath) {
    try {
      const maxmind = await import('maxmind')
      reader = (await maxmind.open(dbPath)) as unknown as Reader
    } catch (err) {
      console.warn('[vlm-server] Country database could not be opened; countries will be header-only:', (err as Error).message)
    }
  }
  return {
    lookup(ip, headers) {
      const header = headers['cf-ipcountry']
      const fromHeader = normalize(Array.isArray(header) ? header[0] : header)
      if (fromHeader) return fromHeader
      if (!reader) return null
      try {
        return normalize(reader.get(ip)?.country?.iso_code)
      } catch {
        return null
      }
    },
  }
}
