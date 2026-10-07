import { existsSync } from 'node:fs'
import path from 'node:path'

const HLS_EXT = new Set(['.m3u8', '.ts', '.mp4'])

/** `/streams/<key>/<file>` → absolute path inside outputDir, or null (traversal, bad encoding, other files). */
export function resolveHlsPath(outputDir: string, urlPath: string): string | null {
  const raw = urlPath.split('?')[0]
  if (!raw.startsWith('/streams/')) return null
  let rel: string
  try {
    rel = decodeURIComponent(raw.slice('/streams/'.length))
  } catch {
    return null
  }
  const root = path.resolve(outputDir)
  const abs = path.resolve(root, rel)
  if (!abs.startsWith(root + path.sep)) return null
  if (!HLS_EXT.has(path.extname(abs))) return null
  return abs
}

/** Resolves true once `file` exists, false after `timeoutMs` (polls every `intervalMs`). */
export async function waitForFile(file: string, opts: { timeoutMs?: number; intervalMs?: number } = {}): Promise<boolean> {
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000)
  for (;;) {
    if (existsSync(file)) return true
    if (Date.now() >= deadline) return false
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 500))
  }
}
