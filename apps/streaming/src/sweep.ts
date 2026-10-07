/** At startup: streams the API thinks are live but aren't publishing here get an offline webhook. */
export async function sweepStaleLive(opts: {
  liveKeys(): Promise<string[]>
  notify(streamKey: string, status: 'offline'): Promise<void>
  isLive(streamKey: string): boolean
  attempts?: number
  delayMs?: number
  sleep?: (ms: number) => Promise<void>
}): Promise<number> {
  const attempts = opts.attempts ?? 5
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  for (let i = 0; i < attempts; i++) {
    try {
      const keys = (await opts.liveKeys()).filter((k) => !opts.isLive(k))
      for (const k of keys) await opts.notify(k, 'offline')
      return keys.length
    } catch (err) {
      console.error(`[sweep] attempt ${i + 1}/${attempts} failed:`, err)
      if (i < attempts - 1) await sleep(opts.delayMs ?? 30_000)
    }
  }
  return 0
}
