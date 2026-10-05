'use client'
import { createContext, useContext, useState, useEffect, useCallback, ReactNode } from 'react'
import { API_URL } from './config'

interface User {
  id: string
  displayName: string
  email: string | null
  role: string
}

interface AuthState {
  user: User | null
  token: string | null
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string, displayName: string) => Promise<void>
  loginWithWallet: () => Promise<void>
  logout: () => void
  updateUser: (updates: Partial<User>) => void
}

const AuthContext = createContext<AuthState | null>(null)

interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
}

/** The browser wallet (MetaMask, Rabby, Coinbase Wallet…) if one is injected. */
export function getBrowserWallet(): Eip1193Provider | null {
  if (typeof window === 'undefined') return null
  return ((window as unknown as { ethereum?: Eip1193Provider }).ethereum) ?? null
}

function toHex(text: string): string {
  return '0x' + Array.from(new TextEncoder().encode(text), (b) => b.toString(16).padStart(2, '0')).join('')
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    return (await res.json()).error || fallback
  } catch {
    return fallback
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  // Load from localStorage on mount
  useEffect(() => {
    const stored = localStorage.getItem('vlm_auth')
    if (stored) {
      try {
        const data = JSON.parse(stored)
        // Check token expiry
        const payload = JSON.parse(atob(data.token.split('.')[1]))
        if (payload.exp * 1000 > Date.now()) {
          setToken(data.token)
          setUser(data.user)
        } else {
          localStorage.removeItem('vlm_auth')
        }
      } catch { localStorage.removeItem('vlm_auth') }
    }
    setLoading(false)
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    const res = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Login failed')
    }
    const data = await res.json()
    setToken(data.accessToken)
    setUser(data.user)
    localStorage.setItem('vlm_auth', JSON.stringify({ token: data.accessToken, refresh: data.refreshToken, user: data.user }))
  }, [])

  const register = useCallback(async (email: string, password: string, displayName: string) => {
    const res = await fetch(`${API_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, displayName }),
    })
    if (!res.ok) {
      const err = await res.json()
      throw new Error(err.error || 'Registration failed')
    }
    const data = await res.json()
    setToken(data.accessToken)
    setUser(data.user)
    localStorage.setItem('vlm_auth', JSON.stringify({ token: data.accessToken, refresh: data.refreshToken, user: data.user }))
  }, [])

  // Sign-In with Ethereum: the server issues a one-time message, the wallet signs it
  // (no transaction, no gas), and the server returns the same session as an email login.
  const loginWithWallet = useCallback(async () => {
    const wallet = getBrowserWallet()
    if (!wallet) throw new Error('No browser wallet found. Install MetaMask or another Ethereum wallet.')
    const accounts = (await wallet.request({ method: 'eth_requestAccounts' })) as string[]
    const address = accounts?.[0]
    if (!address) throw new Error('No wallet account selected')

    const challengeRes = await fetch(`${API_URL}/api/auth/wallet/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address }),
    })
    if (!challengeRes.ok) throw new Error(await errorMessage(challengeRes, 'Could not start wallet sign-in'))
    const { nonce, message } = await challengeRes.json()

    const signature = (await wallet.request({ method: 'personal_sign', params: [toHex(message), address] })) as string

    const res = await fetch(`${API_URL}/api/auth/wallet/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, nonce, signature }),
    })
    if (!res.ok) throw new Error(await errorMessage(res, 'Wallet sign-in failed'))
    const data = await res.json()
    setToken(data.accessToken)
    setUser(data.user)
    localStorage.setItem('vlm_auth', JSON.stringify({ token: data.accessToken, refresh: data.refreshToken, user: data.user }))
  }, [])

  const logout = useCallback(() => {
    setToken(null)
    setUser(null)
    localStorage.removeItem('vlm_auth')
  }, [])

  const updateUser = useCallback((updates: Partial<User>) => {
    setUser(prev => {
      if (!prev) return prev
      const updated = { ...prev, ...updates }
      // Sync to localStorage
      const stored = localStorage.getItem('vlm_auth')
      if (stored) {
        try {
          const data = JSON.parse(stored)
          data.user = updated
          localStorage.setItem('vlm_auth', JSON.stringify(data))
        } catch {}
      }
      return updated
    })
  }, [])

  return (
    <AuthContext.Provider value={{ user, token, loading, login, register, loginWithWallet, logout, updateUser }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be inside AuthProvider')
  return ctx
}
