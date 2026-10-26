/** Browser storage key for the signed-in session. The pre-rename key (vlm_auth) is never read: those visitors sign in again. */
export const AUTH_KEY = 'virvi_auth'

export interface StoredAuth { token: string; refresh?: string | null; user: unknown }

/** The stored session, or null. An unreadable entry is removed. */
export function readStoredAuth(storage: Pick<Storage, 'getItem' | 'removeItem'>): StoredAuth | null {
  const raw = storage.getItem(AUTH_KEY)
  if (!raw) return null
  try {
    const data = JSON.parse(raw)
    if (data && typeof data.token === 'string') return data
  } catch {}
  storage.removeItem(AUTH_KEY)
  return null
}
