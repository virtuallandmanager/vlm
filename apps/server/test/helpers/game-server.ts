import { createRequire } from 'node:module'
import { Client } from 'colyseus.js'
import { initBus } from '../../src/realtime/bus.js'
import { VLMSceneRoom } from '../../src/ws/VLMSceneRoom.js'

const _require = createRequire(import.meta.url)
const { Server, LocalPresence, matchMaker } = _require('colyseus') as any
const { WebSocketTransport } = _require('@colyseus/ws-transport') as any

export async function startGameServer() {
  const presence = new LocalPresence()
  initBus(presence)
  const server = new Server({ transport: new WebSocketTransport(), presence })
  server.define('vlm_scene', VLMSceneRoom).filterBy(['sceneId'])
  const port = 20000 + Math.floor(Math.random() * 20000)
  await server.listen(port)
  return { url: `ws://localhost:${port}`, stop: () => server.gracefullyShutdown(false) as Promise<void> }
}

export async function joinScene(url: string, sceneId: string, token?: string) {
  const client = new Client(url)
  const inbox: { type: string; message: any }[] = []
  const room = await client.joinOrCreate('vlm_scene', { sceneId, sessionToken: token, clientType: 'analytics' })
  room.onMessage('*', (type: string | number, message: any) => inbox.push({ type: String(type), message }))

  async function waitFor(type: string, ms = 3000) {
    const start = Date.now()
    while (Date.now() - start < ms) {
      const i = inbox.findIndex((m) => m.type === type)
      if (i >= 0) return inbox.splice(i, 1)[0].message
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error(`timed out waiting for ${type}; got ${inbox.map((m) => m.type).join(', ')}`)
  }

  async function expectNone(type: string, ms = 400) {
    await new Promise((r) => setTimeout(r, ms))
    if (inbox.some((m) => m.type === type)) throw new Error(`unexpected ${type}`)
  }

  return { room, inbox, waitFor, expectNone }
}

/** The server-side room instance (same process, local driver). */
export function serverRoom(roomId: string): any {
  return matchMaker.getRoomById(roomId)
}
