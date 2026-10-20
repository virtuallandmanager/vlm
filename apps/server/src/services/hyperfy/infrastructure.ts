import { config } from '../../config.js'

export type WorldsDbMode = 'fly-job' | 'direct'

/** How worlds DB admin SQL runs; `fly-job` unless set otherwise when the provider is fly. Undefined if set to anything else. */
export function worldsDbMode(): WorldsDbMode | undefined {
  const mode = config.hyperfyWorldsDbMode || (config.hyperfyInfraProvider === 'fly' ? 'fly-job' : 'direct')
  return mode === 'fly-job' || mode === 'direct' ? mode : undefined
}

/**
 * Whether VLM-hosted Hyperfy worlds are offered: only on Fly, and only once every variable hosting needs is set.
 * Self-run worlds never consult this.
 */
export function hyperfyHosting(): { available: boolean; provider: string } {
  const provider = config.hyperfyInfraProvider || 'none'
  const required = [
    config.flyApiToken,
    config.flyWorldsOrg,
    config.hyperfyImage,
    config.hyperfyWorldsDbUrlTemplate,
    config.hyperfyAssetsS3Uri,
    config.hyperfyAssetsBaseUrl,
    config.hyperfyRouterDomain,
    config.hyperfySecretKey,
    worldsDbMode(),
    // In fly-job mode the admin URL is a Fly secret of the jobs app; only direct mode connects with it from here.
    worldsDbMode() === 'fly-job' ? config.hyperfyDbJobApp : config.hyperfyWorldsDatabaseUrl,
  ]
  return { available: provider === 'fly' && required.every(Boolean), provider }
}
