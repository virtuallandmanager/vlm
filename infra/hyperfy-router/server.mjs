// Hands each request for <slug>.<domain> to the world's own Fly app with fly-replay.
import { createServer, request as httpRequest } from 'node:http'
import { pipeline } from 'node:stream'
import { fileURLToPath } from 'node:url'

const SLUG = /^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/

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

// fly-replay can't carry request bodies over 1 MB, so bigger (or chunked) ones are proxied over Flycast.
const REPLAY_BODY_LIMIT = 1048576

const HOP_BY_HOP = ['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade']

function stripHopByHop(headers) {
  const drop = new Set(HOP_BY_HOP)
  for (const name of String(headers.connection || '').split(',')) if (name.trim()) drop.add(name.trim().toLowerCase())
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !drop.has(k.toLowerCase())))
}

function needsProxy(req) {
  if (/chunked/i.test(req.headers['transfer-encoding'] || '')) return true
  return Number(req.headers['content-length'] || 0) > REPLAY_BODY_LIMIT
}

export function createRouter(domain, opts = {}) {
  const suffix = opts.upstreamSuffix ?? '.flycast'
  const upstreamHost = opts.upstreamHost ?? ((app) => app + suffix)
  const upstreamPort = opts.upstreamPort ?? 80

  function proxy(req, res, target) {
    const up = httpRequest({ host: upstreamHost(target), port: upstreamPort, method: req.method, path: req.url, headers: stripHopByHop(req.headers) }, (ures) => {
      res.writeHead(ures.statusCode, stripHopByHop(ures.headers))
      pipeline(ures, res, () => {})
    })
    up.on('error', () => {
      if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('Bad gateway') }
      else res.destroy()
    })
    res.on('close', () => up.destroy())
    pipeline(req, up, () => {})
  }

  const server = createServer((req, res) => {
    const target = replayTarget(req.headers.host, domain)
    if (target && needsProxy(req)) {
      proxy(req, res, target)
    } else if (target) {
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
  createRouter(process.env.ROUTER_DOMAIN || 'worlds.vlm.gg', {
    upstreamSuffix: process.env.ROUTER_UPSTREAM_SUFFIX || '.flycast',
    upstreamPort: Number(process.env.ROUTER_UPSTREAM_PORT) || 80,
  }).listen(Number(process.env.PORT) || 3000, '0.0.0.0')
}
