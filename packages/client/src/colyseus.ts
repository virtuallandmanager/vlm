import { Client, Room } from 'colyseus.js'
import { ensureNetworkPolyfills } from './polyfills.js'

export class ColyseusManager {
  private client: Client | null = null
  private room: Room | null = null
  private messageHandlers: Map<string, Set<(message: unknown) => void>> = new Map()
  private leaveHandlers: Set<(code: number) => void> = new Set()

  connect(wssUrl: string): void {
    // colyseus.js needs URL and XMLHttpRequest, which some sandboxed runtimes (Decentraland) lack
    ensureNetworkPolyfills()
    this.client = new Client(wssUrl)
  }

  async joinSceneRoom(sceneId: string, joinOptions: Record<string, unknown> = {}): Promise<Room> {
    if (!this.client) throw new Error('Not connected — call connect() first')

    const room = await this.client.joinOrCreate('vlm_scene', {
      sceneId,
      ...joinOptions,
    })
    this.room = room

    // A dropped connection forgets the room, so getRoom()/isConnected() see it as gone. An intentional
    // leaveRoom() has already cleared it, so it doesn't count as a drop.
    room.onLeave((code: number) => {
      if (this.room !== room) return
      this.room = null
      for (const handler of this.leaveHandlers) {
        try { handler(code) } catch { /* swallow */ }
      }
    })

    // Re-register any handlers that were set before joining
    for (const [type, handlers] of this.messageHandlers) {
      for (const handler of handlers) {
        this.room.onMessage(type, handler)
      }
    }

    return this.room
  }

  leaveRoom(): void {
    if (this.room) {
      this.room.leave()
      this.room = null
    }
  }

  getRoom(): Room | null {
    return this.room
  }

  /** In a room whose connection is open (colyseus.js 0.15 `room.connection.isOpen`). */
  isConnected(): boolean {
    return !!this.room && !!this.room.connection?.isOpen
  }

  send(type: string, data: unknown): void {
    if (!this.room) throw new Error('Not in a room')
    this.room.send(type, data)
  }

  onMessage(type: string, handler: (message: unknown) => void): void {
    // Store handler so it can be re-registered on reconnect
    if (!this.messageHandlers.has(type)) {
      this.messageHandlers.set(type, new Set())
    }
    this.messageHandlers.get(type)!.add(handler)

    // If already in a room, register immediately
    if (this.room) {
      this.room.onMessage(type, handler)
    }
  }

  /** Called when the room's connection drops (not after leaveRoom()); kept across rejoins. */
  onLeave(handler: (code: number) => void): void {
    this.leaveHandlers.add(handler)
  }
}
