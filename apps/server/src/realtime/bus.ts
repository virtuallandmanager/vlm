/**
 * Venue events fan out to scene rooms through Colyseus presence pub/sub,
 * so REST handlers and the lifecycle sweep reach rooms on any server.
 */
export type VenueEvent =
  | { type: 'grants_changed'; sceneId: string }
  | { type: 'preset_changed'; sceneId: string; presetId: string }
  | { type: 'booking_ended'; sceneId: string; bookingId: string; reason: 'expired' | 'canceled' }
  | {
      type: 'element_changed'
      sceneId: string
      presetId: string
      elementId: string
      elementType: string
      deleted: boolean
    }

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

/**
 * Tell scene rooms an element (or one of its instances) changed through REST.
 * Never throws: the DB write already succeeded, so a failed broadcast must not fail the request.
 */
export async function publishElementChanged(e: Omit<Extract<VenueEvent, { type: 'element_changed' }>, 'type'>) {
  try {
    await publishVenueEvent({ type: 'element_changed', ...e })
  } catch (err) {
    console.error('[bus] element_changed publish failed:', err)
  }
}
