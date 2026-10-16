/** A post-sign-in destination: same-origin absolute paths only (no `//host`, no `/\host`, no schemes). */
export function safeNextPath(raw: string | null | undefined): string | null {
  if (!raw || raw[0] !== '/' || raw[1] === '/' || raw[1] === '\\') return null
  if (/[\u0000-\u001f]/.test(raw)) return null
  try {
    const u = new URL(raw, 'https://vlm.invalid')
    if (u.origin !== 'https://vlm.invalid') return null
    return u.pathname + u.search + u.hash
  } catch {
    return null
  }
}
