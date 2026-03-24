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
  logout: () => void
}

const AuthContext = createContext<AuthState | null>(null)

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

  const logout = useCallback(() => {
    setToken(null)
    setUser(null)
    localStorage.removeItem('vlm_auth')
  }, [])

  return (
    <AuthContext.Provider value={{ user, token, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be inside AuthProvider')
  return ctx
}
