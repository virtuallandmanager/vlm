import { config } from '../../config.js'

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
    config.hyperfyWorldsDatabaseUrl,
    config.hyperfyWorldsDbUrlTemplate,
    config.hyperfyAssetsS3Uri,
    config.hyperfyAssetsBaseUrl,
    config.hyperfyRouterDomain,
    config.hyperfySecretKey,
  ]
  return { available: provider === 'fly' && required.every(Boolean), provider }
}
