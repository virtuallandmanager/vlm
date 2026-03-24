'use client'
import { useAuth } from '@/lib/auth'
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

  useEffect(() => {
    if (!loading && user) router.push('/scenes')
  }, [user, loading, router])

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
