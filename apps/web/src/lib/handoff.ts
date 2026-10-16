import { safeNextPath } from './next-path'

export interface HandoffDeps {
  href: string                                   // window.location.href at load
  replaceUrl: (url: string) => void              // history.replaceState(null, '', url)
  exchange: (code: string) => Promise<{ status: number; body?: { accessToken: string; refreshToken: string; user: unknown } }>
  saveSession: (s: { token: string; refresh: string; user: unknown }) => void // localStorage 'vlm_auth', same shape as auth/callback
  go: (url: string) => void                      // window.location.href = url (full load so AuthProvider reads the session)
}

/**
 * Reads the code and `next` from the URL fragment only (fragments never reach a server, a log or a Referer),
 * strips the fragment and query from the address bar (keeping the path) before anything else, exchanges the code once,
 * then goes to `next` (signed in) or to sign-in with `next`. A `?code=` in the query string is never exchanged.
 */
export async function runHandoff(d: HandoffDeps): Promise<'signed-in' | 'fallback'> {
  const u = new URL(d.href)
  const frag = new URLSearchParams(u.hash.replace(/^#/, ''))
  const code = frag.get('code')
  const next = safeNextPath(frag.get('next')) ?? '/analytics/'
  d.replaceUrl(u.pathname)
  if (code) {
    try {
      const r = await d.exchange(code)
      if (r.status === 200 && r.body) {
        d.saveSession({ token: r.body.accessToken, refresh: r.body.refreshToken, user: r.body.user })
        d.go(next)
        return 'signed-in'
      }
    } catch {
      /* network error → normal sign-in */
    }
  }
  d.go(`/?next=${encodeURIComponent(next)}`)
  return 'fallback'
}
