import { studioScopeEvents } from '../db/schema.js'
import type { Exec } from './quota.js'

/**
 * Keeping the studio to design work. The worker's scope check turns an off-topic message down before the agent runs
 * (outcome off_topic, refunded); an agent that stops on one writes out/declined.json (outcome declined, counted). Both
 * are logged here for the owner. The user only ever sees a category's fixed words, never the model's note.
 */

export const CATEGORY_WORDS: Record<string, string> = {
  coding: 'coding help', writing: 'writing', research: 'research', chat: 'general chat', other: 'other work',
}
export const SCOPE_CATEGORIES = Object.keys(CATEGORY_WORDS)

export const offTopicNote = (category: string) =>
  `The studio only builds Decentraland wearables and emotes, so this message (${CATEGORY_WORDS[category] ?? CATEGORY_WORDS.other}) wasn’t sent to the agent. It wasn’t counted.`
export const DECLINED_NOTE = 'The agent only works on Decentraland wearables and emotes, so it stopped.'

const MESSAGE_MAX = 2000
const NOTE_MAX = 120

export async function logScopeEvent(exec: Exec, e: {
  userId: string; designId: string; jobId: string; by: string; category: string; note: string; message: string
}): Promise<void> {
  await exec.insert(studioScopeEvents).values({
    ...e, category: SCOPE_CATEGORIES.includes(e.category) ? e.category : 'other',
    note: e.note.slice(0, NOTE_MAX), message: e.message.slice(0, MESSAGE_MAX),
  })
}
