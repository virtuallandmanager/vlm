/**
 * Venue events fan out to scene rooms through Colyseus presence pub/sub,
 * so REST handlers and the lifecycle sweep reach rooms on any server.
 */
export type VenueEvent =
  | { type: 'grants_changed'; sceneId: string }
  | { type: 'preset_changed'; sceneId: string; presetId: string }
  | { type: 'booking_ended'; sceneId: string; bookingId: string; reason: 'expired' | 'canceled' }

export interface BusPresence {
  publish(topic: string, data: unknown): unknown
}

let presence: BusPresence | null = null

export function initBus(p: BusPresence) {
  presence = p
}

export function venueTopic(sceneId: string) {
  return `venue:${sceneId}`
}

export async function publishVenueEvent(e: VenueEvent) {
  if (!presence) return
  await presence.publish(venueTopic(e.sceneId), e)
}
