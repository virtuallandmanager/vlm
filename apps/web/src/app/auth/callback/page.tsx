'use client'
import { useSearchParams } from 'next/navigation'
import { useEffect, useState, Suspense } from 'react'

function CallbackHandler() {
  const searchParams = useSearchParams()
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const token = searchParams.get('token')
    const refresh = searchParams.get('refresh')

    if (!token || !refresh) {
      setError('Missing authentication parameters. Please try signing in again.')
      return
    }

    try {
      const payload = JSON.parse(atob(token.split('.')[1]))
      const user = {
        id: payload.sub ?? payload.id,
        displayName: payload.displayName ?? payload.name ?? '',
        email: payload.email ?? null,
        role: payload.role ?? 'user',
      }

      localStorage.setItem(
        'vlm_auth',
        JSON.stringify({ token, refresh, user }),
      )

      window.location.href = '/scenes'
    } catch {
      setError('Invalid authentication token. Please try signing in again.')
    }
  }, [searchParams])

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="w-full max-w-md rounded-xl bg-gray-900 p-8 text-center">
          <p className="mb-4 text-red-400">{error}</p>
          <a href="/" className="text-blue-400 hover:underline">
            Back to login
          </a>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-gray-400">Signing you in...</p>
    </div>
  )
}

export default function AuthCallbackPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <p className="text-gray-400">Signing you in...</p>
        </div>
      }
    >
      <CallbackHandler />
    </Suspense>
  )
}
