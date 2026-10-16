/** A post-sign-in destination: same-origin absolute paths only (no `//host`, no `/\host`, no schemes). */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw || raw[0] !== '/' || raw[1] === '/' || raw[1] === '\\') return null
  if (/[\u0000-\u001f]/.test(raw)) return null
  try {
    const u = new URL(raw, 'https://vlm.invalid')
    if (u.origin !== 'https://vlm.invalid') return null
    const out = u.pathname + u.search + u.hash
    // URL parsing collapses dot segments (`/.//evil.com` -> `//evil.com`), so re-check the result.
    if (out[0] !== '/' || out[1] === '/' || out[1] === '\\') return null
    return out
  } catch {
    return null
  }
}
