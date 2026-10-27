import { config } from '../../config.js'

export type WorldsDbMode = 'fly-job' | 'direct'

/** How worlds DB admin SQL runs; `fly-job` unless set otherwise when the provider is fly. Undefined if set to anything else. */
export function worldsDbMode(): WorldsDbMode | undefined {
  const mode = config.hyperfyWorldsDbMode || (config.hyperfyInfraProvider === 'fly' ? 'fly-job' : 'direct')
  return mode === 'fly-job' || mode === 'direct' ? mode : undefined
}

/**
 * A URL worlds can connect with: Postgres, with both placeholders. Hyperfy silently falls back to SQLite on the machine's
 * throwaway disk when DB_URI isn't a postgres URL.
 */
const validDbUrlTemplate = (t: string | undefined) =>
  !!t && /^postgres(ql)?:\/\//.test(t) && t.includes('{user}') && t.includes('{password}')

/** 32 bytes of hex, as the admin-code cipher needs. */
const validSecretKey = (k: string | undefined) => !!k && /^[0-9a-f]{64}$/i.test(k)

/**
 * Whether Virvi-hosted Hyperfy worlds are offered: only on Fly, and only once every variable hosting needs is set (and the
 * DB URL template and secret key are well formed). Self-run worlds never consult this.
 */
export function hyperfyHosting(): { available: boolean; provider: string } {
  const provider = config.hyperfyInfraProvider || 'none'
  const required = [
    config.flyApiToken,
    config.flyWorldsOrg,
    config.hyperfyImage,
    validDbUrlTemplate(config.hyperfyWorldsDbUrlTemplate),
    config.hyperfyAssetsS3Uri,
    config.hyperfyAssetsBaseUrl,
    config.hyperfyRouterDomain,
    validSecretKey(config.hyperfySecretKey),
    worldsDbMode(),
    // In fly-job mode the admin URL is a Fly secret of the jobs app; only direct mode connects with it from here.
    worldsDbMode() === 'fly-job' ? config.hyperfyDbJobApp : config.hyperfyWorldsDatabaseUrl,
  ]
  return { available: provider === 'fly' && required.every(Boolean), provider }
}
