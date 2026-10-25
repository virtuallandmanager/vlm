import { publishOnBus } from '../realtime/bus.js'

/** What a design's page hears, through the vlm_studio room. A `job` event that is done or failed means "re-read the design". */
export type StudioEvent =
  | { type: 'progress'; jobId: string; text: string }
  | { type: 'phase'; jobId: string; phase: string }
  | { type: 'job'; jobId: string; status: 'queued' | 'taken' | 'done' | 'failed'; outcome?: string; error?: string }

export const studioTopic = (designId: string) => `studio:${designId}`

export async function publishStudio(designId: string, e: StudioEvent): Promise<void> {
  await publishOnBus(studioTopic(designId), e)
}
