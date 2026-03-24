'use client'
import { useAuth } from '@/lib/auth'
import { API_URL } from '@/lib/config'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

export default function Home() {
  const { user, loading, login, register } = useAuth()
  const router = useRouter()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [providers, setProviders] = useState<{ google: boolean; discord: boolean }>({ google: false, discord: false })

  useEffect(() => {
    if (!loading && user) router.push('/scenes')
  }, [user, loading, router])

  useEffect(() => {
    fetch(`${API_URL}/api/auth/providers`).then(r => r.json()).then(setProviders).catch(() => {})
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      if (mode === 'login') {
        await login(email, password)
      } else {
        await register(email, password, displayName)
      }
      router.push('/scenes')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <div className="flex h-screen items-center justify-center"><p>Loading...</p></div>
  if (user) return null

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="w-full max-w-md rounded-xl bg-gray-900 p-8">
        <h1 className="mb-2 text-2xl font-bold">Virtual Land Manager</h1>
        <p className="mb-6 text-sm text-gray-400">{mode === 'login' ? 'Sign in to manage your scenes' : 'Create your account'}</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          {mode === 'register' && (
            <div>
              <label className="mb-1 block text-sm text-gray-400">Display Name</label>
              <input type="text" value={displayName} onChange={e => setDisplayName(e.target.value)}
                className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
                required />
            </div>
          )}
          <div>
            <label className="mb-1 block text-sm text-gray-400">Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
              className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
              required />
          </div>
          <div>
            <label className="mb-1 block text-sm text-gray-400">Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)}
              className="w-full rounded-lg bg-gray-800 px-4 py-2 text-white outline-none focus:ring-2 focus:ring-blue-500"
              required />
          </div>
          {error && <p className="text-sm text-red-400">{error}</p>}
          <button type="submit" disabled={submitting}
            className="w-full rounded-lg bg-blue-600 py-2 font-medium hover:bg-blue-700 disabled:opacity-50">
            {submitting ? '...' : mode === 'login' ? 'Sign In' : 'Create Account'}
          </button>
        </form>

        {(providers.google || providers.discord) && (
          <>
            <div className="flex items-center gap-3 my-4"><div className="flex-1 border-t border-gray-700" /><span className="text-xs text-gray-500">or</span><div className="flex-1 border-t border-gray-700" /></div>
            <div className="space-y-3">
              {providers.google && (
                <a href={`${API_URL}/api/auth/google`}
                  className="block w-full rounded-lg bg-white py-2 text-center font-medium text-gray-900 hover:bg-gray-100">
                  Continue with Google
                </a>
              )}
              {providers.discord && (
                <a href={`${API_URL}/api/auth/discord`}
                  className="block w-full rounded-lg bg-[#5865F2] py-2 text-center font-medium text-white hover:bg-[#4752C4]">
                  Continue with Discord
                </a>
              )}
            </div>
          </>
        )}

        <p className="mt-4 text-center text-sm text-gray-500">
          {mode === 'login' ? (
            <>No account? <button onClick={() => setMode('register')} className="text-blue-400 hover:underline">Register</button></>
          ) : (
            <>Have an account? <button onClick={() => setMode('login')} className="text-blue-400 hover:underline">Sign in</button></>
          )}
        </p>
      </div>
    </div>
  )
}
