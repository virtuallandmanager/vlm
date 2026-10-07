import type { IncomingMessage, ServerResponse } from 'node:http'
import { createReadStream, existsSync } from 'node:fs'
import { extname } from 'node:path'
import { resolveHlsPath } from './hls.js'

const MIME_TYPES: Record<string, string> = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  '.mp4': 'video/mp4',
}

/**
 * Public HTTP (https://live.vlm.gg): health and HLS files only. Nothing here may reveal stream
 * keys — anyone holding one can publish — so health reports a count, and HLS lives under playback ids.
 */
export function createHttpHandler(opts: { outputDir: string; activeCount: () => number }) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = req.url || '/'

    if (url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', activeStreams: opts.activeCount(), uptime: process.uptime() }))
      return
    }

    if (url.startsWith('/streams/')) {
      const filePath = resolveHlsPath(opts.outputDir, url)
      const mime = filePath ? MIME_TYPES[extname(filePath)] : undefined
      if (!filePath || !mime || !existsSync(filePath)) {
        res.writeHead(404)
        res.end('Not found')
        return
      }
      res.writeHead(200, {
        'Content-Type': mime,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': extname(filePath) === '.m3u8' ? 'no-cache' : 'max-age=10',
      })
      createReadStream(filePath).on('error', () => res.destroy()).pipe(res)
      return
    }

    res.writeHead(404)
    res.end('Not found')
  }
}
