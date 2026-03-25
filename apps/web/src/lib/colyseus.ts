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

export interface CommandCenterStatus {
  eventId: string | null
  worlds: Array<{
    sceneId: string
    sceneName: string
    platform: string | null
    deploymentStatus: string | null
    visitorCount: number
    activePreset: string | null
  }>
  aggregate: {
    totalVisitors: number
    worldCount: number
    deployedCount: number
  }
  timestamp: number
}

export function useCommandCenterRoom(eventId: string | null, token: string | null) {
  const [room, setRoom] = useState<Room | null>(null)
  const [connected, setConnected] = useState(false)
  const [status, setStatus] = useState<CommandCenterStatus | null>(null)
  const [activityLog, setActivityLog] = useState<Array<{ time: number; message: string }>>([])
  const clientRef = useRef<Client | null>(null)
  const roomRef = useRef<Room | null>(null)

  useEffect(() => {
    if (!eventId || !token) return

    const connect = async () => {
      try {
        const client = new Client(WSS_URL)
        clientRef.current = client

        const newRoom = await client.joinOrCreate('vlm_command_center', {
          eventId,
          sessionToken: token,
          clientType: 'host',
        })

        roomRef.current = newRoom
        setRoom(newRoom)
        setConnected(true)

        newRoom.onMessage('command_center_status', (data: CommandCenterStatus) => {
          setStatus(data)
        })

        newRoom.onMessage('cross_world_dispatched', (data: any) => {
          setActivityLog((prev) => [
            { time: Date.now(), message: `Broadcast sent to ${data.targetScenes?.length || 0} world(s)` },
            ...prev.slice(0, 99),
          ])
        })

        newRoom.onMessage('error', (data: any) => {
          setActivityLog((prev) => [
            { time: Date.now(), message: `Error: ${data.message}` },
            ...prev.slice(0, 99),
          ])
        })

        newRoom.onLeave(() => {
          setConnected(false)
          setRoom(null)
        })

        setActivityLog((prev) => [
          { time: Date.now(), message: 'Connected to command center' },
          ...prev.slice(0, 99),
        ])
      } catch (err) {
        console.error('Command center Colyseus connection failed:', err)
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
  }, [eventId, token])

  const sendBroadcast = useCallback((action: Record<string, unknown>) => {
    if (roomRef.current) {
      roomRef.current.send('cross_world_update', { action })
    }
  }, [])

  return { room, connected, status, activityLog, setActivityLog, sendBroadcast }
}
