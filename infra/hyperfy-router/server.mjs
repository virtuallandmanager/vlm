// Hands each request for <slug>.<domain> to the world's own Fly app with fly-replay.
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'

const SLUG = /^[a-z0-9-]{3,30}$/

export function replayTarget(host, domain) {
  if (typeof host !== 'string') return null
  const h = host.toLowerCase().replace(/:\d+$/, '')
  const suffix = '.' + domain.toLowerCase()
  if (!h.endsWith(suffix)) return null
  const slug = h.slice(0, -suffix.length)
  return SLUG.test(slug) ? `vlm-w-${slug}` : null
}

const NOT_FOUND_BODY = '<!doctype html><title>No world here</title><h1>No world here</h1><p>There is no VLM world at this address.</p>'
const NOT_FOUND_HEAD = `HTTP/1.1 404 Not Found\r\ncontent-type: text/html; charset=utf-8\r\ncontent-length: ${Buffer.byteLength(NOT_FOUND_BODY)}\r\nconnection: close\r\n\r\n`

export function createRouter(domain) {
  const server = createServer((req, res) => {
    const target = replayTarget(req.headers.host, domain)
    if (target) {
      res.writeHead(307, { 'fly-replay': `app=${target}` })
      res.end()
    } else if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': 2 })
      res.end('ok')
    } else {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
      res.end(NOT_FOUND_BODY)
    }
  })
  server.on('upgrade', (req, socket) => {
    const target = replayTarget(req.headers.host, domain)
    socket.on('error', () => {})
    if (target) socket.end(`HTTP/1.1 307 Temporary Redirect\r\nfly-replay: app=${target}\r\ncontent-length: 0\r\n\r\n`)
    else { socket.write(NOT_FOUND_HEAD + NOT_FOUND_BODY); socket.destroy() }
  })
  return server
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createRouter(process.env.ROUTER_DOMAIN || 'worlds.vlm.gg').listen(Number(process.env.PORT) || 3000, '0.0.0.0')
}
