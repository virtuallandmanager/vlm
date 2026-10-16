import { safeNextPath } from './next-path'

export interface HandoffDeps {
  href: string                                   // window.location.href at load
  replaceUrl: (url: string) => void              // history.replaceState(null, '', url)
  exchange: (code: string) => Promise<{ status: number; body?: { accessToken: string; refreshToken: string; user: unknown } }>
  saveSession: (s: { token: string; refresh: string; user: unknown }) => void // localStorage 'vlm_auth', same shape as auth/callback
  go: (url: string) => void                      // window.location.href = url (full load so AuthProvider reads the session)
}

/** Strips the code from the URL before anything else, exchanges it once, then goes to `next` (signed in) or to sign-in with `next`. */
export async function runHandoff(d: HandoffDeps): Promise<'signed-in' | 'fallback'> {
  const u = new URL(d.href)
  const code = u.searchParams.get('code')
  const next = safeNextPath(u.searchParams.get('next')) ?? '/analytics/'
  u.searchParams.delete('code')
  d.replaceUrl(u.pathname + (u.searchParams.toString() ? `?${u.searchParams}` : ''))
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
