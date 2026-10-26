import { VirviSceneRoom } from './VirviSceneRoom.js'
import { VirviCommandCenterRoom } from './VirviCommandCenterRoom.js'
import { VirviStudioRoom } from './VirviStudioRoom.js'

/** Registers every Colyseus room; the server and the test game server share it. */
export function defineRooms(server: { define(name: string, room: unknown): { filterBy(keys: string[]): unknown } }) {
  server.define('virvi_scene', VirviSceneRoom).filterBy(['sceneId'])
  server.define('virvi_command_center', VirviCommandCenterRoom).filterBy(['eventId'])
  server.define('virvi_studio', VirviStudioRoom).filterBy(['designId'])
}
