/** Where "Advertise with VLM" goes. Null opens the early-access form; set to '/advertise' when ad step 3 ships. */
export const ADVERTISE_PAGE: string | null = null

/** Public links on the landing page. A link with no configured URL is null and left out. */
export function siteLinks(
  env: { docs?: string; discord?: string } = { docs: process.env.NEXT_PUBLIC_DOCS_URL, discord: process.env.NEXT_PUBLIC_DISCORD_URL },
): { docs: string | null; privacy: string | null; discord: string | null } {
  const docs = env.docs || null
  return {
    docs,
    privacy: docs ? `${docs.replace(/\/+$/, '')}/privacy/` : null,
    discord: env.discord || null,
  }
}
