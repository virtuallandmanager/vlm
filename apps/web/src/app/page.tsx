'use client'
import { useAuth } from '@/lib/auth'
import { landingRoute } from '@/lib/landing-route'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useEffect } from 'react'

function Landing() {
  const { user, loading, scenePass } = useAuth()
  const router = useRouter()
  const search = useSearchParams().toString()
  const route = landingRoute({ search: search ? `?${search}` : '', loading, signedIn: !!user, scenePass: !!scenePass })
  const go = typeof route === 'object' ? route.go : null

  useEffect(() => {
    if (go) router.replace(go)
  }, [go, router])

  if (route !== 'show') return null
  return <main />
}

export default function LandingPage() {
  return (
    <Suspense fallback={null}>
      <Landing />
    </Suspense>
  )
}
