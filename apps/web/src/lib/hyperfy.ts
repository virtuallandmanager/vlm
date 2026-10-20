// Copy and helpers for "Connect your own Hyperfy world" on the deploy page.

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

export function lastSeenLabel(iso: string | null, now: Date): string {
  if (!iso) return 'Never connected'
  const then = new Date(iso)
  const age = now.getTime() - then.getTime()
  if (age < 2 * MIN) return 'Connected just now'
  if (age < HOUR) return `Last seen ${Math.floor(age / MIN)} min ago`
  if (age < DAY) return `Last seen ${Math.floor(age / HOUR)} h ago`
  return `Last seen ${then.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`
}

export function setupSteps(feedUrl: string): string[] {
  return [
    'Download the VLM app and drag vlm.hyp into your Hyperfy world.',
    "Open the app's settings and paste your world key into VLM world key.",
    `Leave VLM feed URL as ${feedUrl} unless VLM support tells you otherwise.`,
    'Your scene appears within a few seconds and follows your edits.',
  ]
}

/** Removing a world only stops the feed; the world keeps showing its last scene. */
export function removeWorldPrompt(name: string): string {
  return `Remove "${name}"? The VLM app in that world stops receiving updates from VLM.`
}

export function hyperfyErrorMessage(err: unknown): string {
  const e = err instanceof Error ? (err as Error & { status?: number }) : null
  if (e?.message === 'upgrade_required') return "Your plan doesn't include deploying. Upgrade to connect your own Hyperfy world."
  if (e?.status === 400) return 'Give the world a name of 100 characters or fewer.'
  return 'Something went wrong. Try again in a moment.'
}
