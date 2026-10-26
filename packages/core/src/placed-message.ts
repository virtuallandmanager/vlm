/** What the scene's World destination reports to the in-world editor (GET /api/scenes/:id/dcl/publish-status). */
export interface PublishDestination {
  mode: 'virvi' | 'sign'
  status: string
  /** True once the owner has given Virvi deploy permission on the World. */
  granted: boolean
}

/**
 * The editor's line after a model is placed: what happens next, in plain words. It never names a domain
 * (the Publish button opens the server's own link), and it promises Virvi will add the model only when
 * Virvi holds the permission and nothing is holding deploys back.
 */
export function placedMessage(name: string, d: PublishDestination | null): { text: string; publish: boolean } {
  const placed = `Placed ${name} —`
  if (!d) return { text: `${placed} to get it into your World, open this scene's Deploy page in Virvi Studio, or run npx virvi-dcl sync and redeploy`, publish: false }
  if (d.status === 'over_budget') return { text: `${placed} the scene is past Decentraland's limits for this plot, so it can't go live until something is removed`, publish: false }
  if (d.status === 'needs_review') return { text: `${placed} deploys to your World are paused; check this scene's Deploy page in Virvi Studio`, publish: false }
  if (d.mode === 'sign') return { text: `${placed} publish it to see it in your World`, publish: true }
  if (!d.granted) return { text: `${placed} Virvi needs your permission to deploy it; give it on this scene's Deploy page in Virvi Studio`, publish: false }
  return { text: `${placed} Virvi is adding it to your World; it appears in a minute or two`, publish: false }
}
