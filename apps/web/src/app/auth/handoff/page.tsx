'use client'
import { useEffect, useRef } from 'react'
import { API_URL } from '@/lib/config'
import { runHandoff } from '@/lib/handoff'

export default function HandoffPage() {
  const started = useRef(false)

  useEffect(() => {
    // Strict mode runs effects twice in dev; a code can only be exchanged once.
    if (started.current) return
    started.current = true
    void runHandoff({
      href: window.location.href,
      replaceUrl: (u) => history.replaceState(null, '', u),
      exchange: (code) =>
        fetch(`${API_URL}/api/auth/handoff/exchange`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        }).then(async (r) => ({ status: r.status, body: r.ok ? await r.json() : undefined })),
      saveSession: (s) => localStorage.setItem('vlm_auth', JSON.stringify(s)),
      go: (u) => { window.location.href = u },
      storedSession: () => localStorage.getItem('vlm_auth'),
    })
  }, [])

  return (
    <div className="flex min-h-screen items-center justify-center">
      <meta name="referrer" content="no-referrer" />
      <p className="text-gray-400">Signing you in...</p>
    </div>
  )
}
