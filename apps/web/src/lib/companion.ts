/** Helpers for the companion upload page (/u/<code>), opened from the in-world HUD on a computer or phone. */

const CODE_RE = /^[a-z0-9]{6}$/

/**
 * The upload code for this page. The static export has a single page for every code (built as `_`),
 * so outside `next dev` the route param is `_` and the real code is in the address bar.
 */
export function codeFromPath(pathname: string, paramCode: string | undefined): string | null {
  if (paramCode && paramCode !== '_') return paramCode
  const m = /^\/u\/([^/]+)\/?$/.exec(pathname)
  return m && CODE_RE.test(m[1]) ? m[1] : null
}

const IMAGE_ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,image/png,image/jpeg,image/webp,image/gif'

/** The file picker's accept list for a code's allowed kinds (null = any). */
export function acceptFor(kinds: string[] | null): string {
  if (!kinds) return `${IMAGE_ACCEPT},.glb,.mp4,.webm`
  const parts: string[] = []
  if (kinds.includes('image')) parts.push(IMAGE_ACCEPT)
  if (kinds.includes('model')) parts.push('.glb')
  if (kinds.includes('video')) parts.push('.mp4,.webm')
  return parts.join(',')
}

/** A plain message for a refused upload. */
export function uploadErrorMessage(status: number, body: { error?: string }): string {
  if (status === 402 || /quota|storage_limit/.test(body.error ?? '')) return "Storage is full for this scene's owner"
  if (status === 413) return 'That file is too big (images up to 10 MB, models up to 50 MB)'
  if (status === 415) return "That file type isn't supported here (HEIC photos: choose JPEG or PNG)"
  if (status === 410) return 'This upload link has used all its uploads'
  if (status === 404) return 'This upload link has expired — make a new one in-world'
  if (status === 403) return "You can't upload to this scene anymore"
  return body.error ?? 'Upload failed'
}
