/**
 * Where a VLM-hosted model lives inside a scene folder: `models/vlm/<basename>`.
 * Only http(s) URLs ending in `.glb` (query/fragment ignored) qualify; anything else is null.
 */
export function localModelFile(url: string): string | null {
  const m = /^https?:\/\/[^/?#]+([^?#]*)/i.exec(url)
  if (!m) return null
  const base = m[1].split('/').pop() ?? ''
  if (!/\.glb$/i.test(base)) return null
  return `models/vlm/${base}`
}
