// Scene list helpers for the Scenes page.

/** First 8 characters of an id, for card footers (the full id is one click away via copy). */
export function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}

export function filterScenes<T extends { name: string; description?: string | null }>(scenes: T[], query: string): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return scenes
  return scenes.filter((s) => s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q))
}

/** Two hues for a scene without a preview image, stable per scene so its placeholder never changes. */
export function placeholderHues(id: string): [number, number] {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0
  const a = h % 360
  return [a, (a + 40 + ((h >>> 9) % 60)) % 360]
}
