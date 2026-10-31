import { AUTH_KEY, readStoredAuth } from './auth-storage'

/**
 * Access tokens last minutes (JWT_ACCESS_EXPIRY, 15m by default); the refresh token stored beside one lasts days. This
 * swaps it for a new access token so a session outlives its first token. A refused refresh token ends the session; a
 * server that can't be reached leaves it as it is, to try again later.
 */

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>
type Post = (refreshToken: string) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>
export type Refreshed = { token: string } | { refused: true } | { unreachable: true }

// Requests that expire together share one refresh
let inflight: Promise<Refreshed> | null = null

export function refreshStoredSession(storage: Storage, post: Post): Promise<Refreshed> {
  inflight ??= run(storage, post).finally(() => { inflight = null })
  return inflight
}

async function run(storage: Storage, post: Post): Promise<Refreshed> {
  const stored = readStoredAuth(storage)
  if (!stored?.refresh) return { refused: true }
  let res: Awaited<ReturnType<Post>>
  try {
    res = await post(stored.refresh)
  } catch {
    return { unreachable: true }
  }
  if (res.status === 401 || res.status === 403) {
    storage.removeItem(AUTH_KEY)
    return { refused: true }
  }
  const body = res.ok ? await res.json().catch(() => null) : null
  if (typeof body?.accessToken !== 'string') return { unreachable: true }
  storage.setItem(AUTH_KEY, JSON.stringify({ ...stored, token: body.accessToken }))
  return { token: body.accessToken }
}

/** Tests: forget a refresh left in flight. */
export function _resetRefresh(): void {
  inflight = null
}
