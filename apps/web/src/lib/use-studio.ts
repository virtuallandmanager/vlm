'use client'
import { useEffect, useState } from 'react'
import { useApi } from './api'
import { useAuth } from './auth'

// One probe per page load: the studio is on (usage answers 200) or off (404 outside cloud mode).
let available: boolean | null = null
let probe: Promise<boolean> | null = null

/** Whether this dashboard has the Design Studio: null until the probe answers. */
export function useStudioAvailable(): boolean | null {
  // A scene pass may call nothing but its scene's analytics (anything else signs it out), so it never probes
  const { token, scenePass } = useAuth()
  const api = useApi()
  const [on, setOn] = useState<boolean | null>(available)
  useEffect(() => {
    if (!token || scenePass || available !== null) return
    let cancelled = false
    probe ??= api.getStudioUsage().then(() => true, () => false).then((v) => { available = v; return v })
    probe.then((v) => { if (!cancelled) setOn(v) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, scenePass])
  return on
}
