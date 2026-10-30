'use client'
import { useEffect, useRef, useState, type Dispatch } from 'react'
import { useApi } from '@/lib/api'
import { wizardErrorMessage } from '@/lib/wizard/run'
import type { WizardAction, WizardState } from '@/lib/wizard/state'

/** Waits this long after the last option change (colour pickers fire on every move) before fetching a preview. */
const DEBOUNCE_MS = 400

export interface RoomSetPreview {
  /** A blob URL of the preview GLB for the chosen options, or null before one has loaded. */
  url: string | null
  loading: boolean
  error: string | null
}

/**
 * Loads the chosen room set's preview GLB whenever the scan or its options change. The route needs the bearer
 * header, so the GLB is fetched and shown from a blob URL. Its `X-Triangles` count goes into the wizard's budget.
 */
export function useRoomSetPreview(roomSet: WizardState['roomSet'], dispatch: Dispatch<WizardAction>): RoomSetPreview {
  const api = useApi()
  // useApi() hands out new functions every render: keep the latest without re-running the effect.
  const getPreview = useRef(api.getRoomScanPreview)
  getPreview.current = api.getRoomScanPreview
  const [preview, setPreview] = useState<RoomSetPreview>({ url: null, loading: false, error: null })
  const scanId = roomSet?.scanId ?? null
  const key = roomSet ? JSON.stringify(roomSet.options) : ''

  useEffect(() => {
    if (!roomSet || !scanId) {
      setPreview({ url: null, loading: false, error: null })
      return
    }
    const options = roomSet.options
    const ctrl = new AbortController()
    let url: string | null = null
    setPreview((p) => ({ ...p, loading: true, error: null }))
    const timer = setTimeout(() => {
      getPreview.current(scanId, options, ctrl.signal)
        .then(({ blob, triangles }) => {
          if (ctrl.signal.aborted) return
          url = URL.createObjectURL(blob)
          setPreview({ url, loading: false, error: null })
          if (triangles !== null) dispatch({ type: 'setRoomSetTriangles', scanId, triangles })
        })
        .catch((err) => {
          if (ctrl.signal.aborted) return
          setPreview({ url: null, loading: false, error: wizardErrorMessage(err) })
        })
    }, DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      ctrl.abort()
      // The next preview replaces this one; the old blob is freed once the new one is showing.
      if (url) {
        const old = url
        setTimeout(() => URL.revokeObjectURL(old), 5_000)
      }
    }
  }, [scanId, key])

  return preview
}
