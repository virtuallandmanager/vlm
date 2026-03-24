import { Client, Room } from 'colyseus.js'

export class ColyseusManager {
  private client: Client | null = null
  private room: Room | null = null
  private messageHandlers: Map<string, Set<(message: unknown) => void>> = new Map()

  connect(wssUrl: string): void {
    this.client = new Client(wssUrl)
  }

  async joinSceneRoom(sceneId: string, joinOptions: Record<string, unknown> = {}): Promise<Room> {
    if (!this.client) throw new Error('Not connected — call connect() first')

    this.room = await this.client.joinOrCreate('vlm_scene', {
      sceneId,
      ...joinOptions,
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

  onLeave(handler: (code: number) => void): void {
    if (this.room) {
      this.room.onLeave(handler)
    }
  }
}
