// Plain-language messages for deploy page failures (the API answers with codes such as hyperfy_hosting_unavailable).
const MESSAGES: Record<string, string> = {
  hyperfy_hosting_unavailable: "Hyperfy hosting isn't set up yet, so worlds can't be deployed or redeployed.",
  'Deployment not found': 'That deployment no longer exists. Refresh the page.',
}

export function deployErrorMessage(err: unknown): string {
  const code = err instanceof Error ? err.message : ''
  return MESSAGES[code] ?? 'Something went wrong. Try again in a moment.'
}
