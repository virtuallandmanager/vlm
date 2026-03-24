/**
 * VLM Hyperfy App — Entry point.
 *
 * This is a Hyperfy app that connects a world to VLM. When added to a Hyperfy
 * world, it authenticates with the VLM server, joins the Colyseus room for
 * the configured scene, and renders all scene elements (videos, images,
 * models, sounds) as Hyperfy JSX.
 *
 * Configuration:
 *   - sceneId: The VLM scene ID (from vlm.gg dashboard)
 *   - env: 'prod' | 'staging' | 'dev'
 *   - debug: Enable debug logging
 */

import React, { useEffect, useRef } from 'react'
import { useWorld, useFields } from 'hyperfy'
import { VLM } from 'vlm-core'
import { HyperfyAdapter } from './HyperfyAdapter.js'
import { HyperfyRenderer } from './HyperfyRenderer.js'

const NULL_SCENE_ID = '00000000-0000-0000-0000-000000000000'

export default function VLMApp() {
  const world = useWorld()
  const fields = useFields()
  const vlmRef = useRef(null)
  const adapterRef = useRef(null)

  useEffect(() => {
    // Only initialize on the server side (Hyperfy runs apps on both sides)
    if (!world.isServer) return

    const sceneId = fields.sceneId
    if (!sceneId || sceneId === NULL_SCENE_ID) return

    const adapter = new HyperfyAdapter(world)
    adapterRef.current = adapter

    const vlm = new VLM(adapter)
    vlmRef.current = vlm

    vlm
      .init({
        env: fields.env || 'prod',
        sceneId,
        debug: fields.debug,
      })
      .catch((err) => {
        console.error('[VLM] Init failed:', err.message || err)
      })

    // Hook into Hyperfy frame loop to tick adapter systems
    const unsubscribe = world.onUpdate((dt) => {
      adapter.tick(dt)
    })

    return () => {
      if (vlmRef.current) {
        vlmRef.current.destroy().catch(() => {})
        vlmRef.current = null
      }
      if (adapterRef.current) {
        adapterRef.current.destroy()
        adapterRef.current = null
      }
      unsubscribe()
    }
  }, [fields.sceneId, fields.env])

  return (
    <app>
      <HyperfyRenderer />
    </app>
  )
}

/**
 * Hyperfy app store — defines configurable fields shown in the Hyperfy UI
 * when the app is selected. World owners paste their VLM scene ID here.
 */
export function getStore(state = {}) {
  return {
    state,
    actions: {},
    fields: [
      { type: 'section', label: 'Virtual Land Manager' },
      {
        type: 'text',
        key: 'sceneId',
        label: 'Scene ID',
        initial: NULL_SCENE_ID,
        placeholder: 'Paste Scene ID from vlm.gg',
        instant: false,
      },
      { type: 'section', label: 'Advanced' },
      {
        type: 'switch',
        key: 'env',
        label: 'Environment',
        options: [
          { label: 'Production', value: 'prod' },
          { label: 'Staging', value: 'staging' },
          { label: 'Dev', value: 'dev' },
        ],
        initial: 'prod',
      },
      {
        type: 'switch',
        key: 'debug',
        label: 'Debug',
        options: [
          { label: 'Off', value: false },
          { label: 'On', value: true },
        ],
        initial: false,
      },
    ],
  }
}

// Named exports for programmatic use
export { HyperfyAdapter } from './HyperfyAdapter.js'
export { HyperfyRenderer } from './HyperfyRenderer.js'
export { EntityStore } from './EntityStore.js'
