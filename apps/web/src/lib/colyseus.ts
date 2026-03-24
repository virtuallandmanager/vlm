'use client'
import { useEffect, useRef, useState, useCallback } from 'react'
import { Client, Room } from 'colyseus.js'
import { WSS_URL } from './config'

export function useSceneRoom(sceneId: string | null, token: string | null) {
  const [room, setRoom] = useState<Room | null>(null)
  const [connected, setConnected] = useState(false)
  const clientRef = useRef<Client | null>(null)
  const roomRef = useRef<Room | null>(null)

  useEffect(() => {
    if (!sceneId || sceneId === '_' || !token) return

    const connect = async () => {
      try {
        const client = new Client(WSS_URL)
        clientRef.current = client

        const newRoom = await client.joinOrCreate('vlm_scene', {
          sceneId,
          sessionToken: token,
          clientType: 'host',
          user: { id: 'dashboard' },
        })

        roomRef.current = newRoom
        setRoom(newRoom)
        setConnected(true)

        newRoom.onLeave(() => {
          setConnected(false)
          setRoom(null)
        })
      } catch (err) {
        console.error('Colyseus connection failed:', err)
        setConnected(false)
      }
    }

    connect()

    return () => {
      roomRef.current?.leave()
      roomRef.current = null
      setRoom(null)
      setConnected(false)
    }
  }, [sceneId, token])

  // Send a scene update (element/instance change)
  const sendUpdate = useCallback((message: any) => {
    if (roomRef.current) {
      roomRef.current.send('scene_preset_update', message)
    }
  }, [])

  // Send a preset change
  const changePreset = useCallback((presetId: string) => {
    if (roomRef.current) {
      roomRef.current.send('scene_change_preset', { presetId })
    }
  }, [])

  // Send an arbitrary message type
  const sendMessage = useCallback((type: string, payload: any) => {
    if (roomRef.current) {
      roomRef.current.send(type, payload)
    }
  }, [])

  return { room, connected, sendUpdate, changePreset, sendMessage }
}
