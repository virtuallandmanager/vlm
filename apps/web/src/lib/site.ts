/** Where "Advertise with VLM" goes. Null opens the early-access form; set to '/advertise' when ad step 3 ships. */
export const ADVERTISE_PAGE: string | null = null

/** Public links on the landing page. Docs and Discord are null (and left out) until their URL is configured; privacy is the app's own page. */
export function siteLinks(
  env: { docs?: string; discord?: string } = { docs: process.env.NEXT_PUBLIC_DOCS_URL, discord: process.env.NEXT_PUBLIC_DISCORD_URL },
): { docs: string | null; privacy: string; discord: string | null } {
  return {
    docs: env.docs || null,
    privacy: '/privacy/',
    discord: env.discord || null,
  }
}
