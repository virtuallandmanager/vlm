// LOCAL DEV ONLY: seeds a demo analytics location so the dashboard has data to show.
//
//   DATABASE_URL=postgresql://…@localhost/… node scripts/seed-analytics-demo.mjs --scene <vlmSceneId> [--reset]
//
// Refuses to run unless DATABASE_URL points at localhost / 127.0.0.1.
// Creates (or reuses) the location gc:-150,-150 (2x2 parcels), an active setup pointing at --scene
// (the scene's owner becomes the host), ~600 sessions over 30 days with matching hourly rollups,
// daily heatmap cells around two hot spots, and 3 live sessions with one position each.
// --reset deletes the location's rows first and recreates them.
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import postgres from 'postgres'

const args = process.argv.slice(2)
const sceneArg = args.indexOf('--scene')
const sceneId = sceneArg >= 0 ? args[sceneArg + 1] : null
const reset = args.includes('--reset')
if (!sceneId) {
  console.error('usage: node scripts/seed-analytics-demo.mjs --scene <vlmSceneId> [--reset]')
  process.exit(2)
}
const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set')
  process.exit(2)
}
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
if (!UUID_RE.test(sceneId)) {
  console.error('--scene must be a scene id (uuid)')
  process.exit(2)
}

const LOCATION_KEY = 'gc:-150,-150'
const PARCELS = ['-150,-150', '-149,-150', '-150,-149', '-149,-149']
const HOUR = 3_600_000
const DAY = 24 * HOUR

const DEMO_TITLE = 'Demo location (-150,-150)'

// Guard on the host(s) the postgres client will really connect to (its URL parser differs from
// WHATWG URL: a comma after the first "@" makes a multihost list). Creating the client does not connect.
const authority = url.slice(url.indexOf('://') + 3).split(/[?/]/)[0]
const sql = postgres(url, { max: 1, onnotice: () => {} })
const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
const hosts = [].concat(sql.options.host ?? [])
if (authority.includes(',') || authority.split('@').length > 2 || !hosts.length || sql.options.path || !hosts.every((h) => LOCAL.has(String(h).toLowerCase()))) {
  console.error('Refusing: seed is for a local database')
  process.exit(1)
}

// Deterministic-ish pseudo random so repeated seeds look alike.
let seed = 20261016
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
const pick = (weighted) => {
  let t = rnd() * weighted.reduce((a, [, w]) => a + w, 0)
  for (const [v, w] of weighted) if ((t -= w) < 0) return v
  return weighted[0][0]
}
const gauss = () => Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd())
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))
const inc = (m, k) => {
  m[k] = (m[k] || 0) + 1
}

try {
  const [scene] = await sql`select id, owner_id from scenes where id = ${sceneId}`
  if (!scene) {
    console.error(`No scene ${sceneId} in this database`)
    process.exit(1)
  }

  const now = new Date()
  const result = await sql.begin(async (tx) => {
    const [existing] = await tx`select id, title from analytics_scenes where location_key = ${LOCATION_KEY}`
    if (existing && existing.title !== DEMO_TITLE) {
      throw new Error(`${LOCATION_KEY} already exists and is not demo data (title ${JSON.stringify(existing.title)}); not touching it`)
    }
    if (existing && !reset) throw new Error(`${LOCATION_KEY} is already seeded (location ${existing.id}); re-run with --reset to delete and recreate it`)
    if (existing) await tx`delete from analytics_scenes where id = ${existing.id}` // cascades to every analytics_* row and the setups
    let loc
    {
      ;[loc] = await tx`
        insert into analytics_scenes (kind, location_key, realm, base_parcel, parcels, title, salt, wallet_visibility, last_activity_at)
        values ('parcels', ${LOCATION_KEY}, 'main', '-150,-150', ${PARCELS}, ${DEMO_TITLE}, ${randomBytes(32).toString('hex')}, true, ${now})
        returning id, salt`
    }
    await tx`insert into location_setups (analytics_scene_id, vlm_scene_id, host_user_id, started_at) values (${loc.id}, ${sceneId}, ${scene.owner_id}, ${new Date(now.getTime() - 31 * DAY)})`
    await tx`update analytics_scenes set vlm_scene_id = ${sceneId} where id = ${loc.id}`

    const hashOf = (id) => createHash('sha256').update(loc.salt + id).digest('hex')
    const pool = Array.from({ length: 480 }, (_, i) => hashOf(`demo-visitor-${i}`))
    const seen = new Set()
    const sessions = []
    const platforms = [['desktop', 60], ['web', 25], ['mobile', 15]]
    const countries = [['US', 30], ['DE', 12], ['BR', 10], ['GB', 9], ['JP', 8], ['FR', 7], ['AR', 6], ['CA', 6], ['ES', 6], ['AU', 6]]
    const names = ['Nova', 'Orbit', 'Pixel', 'Quasar', 'Zeno', 'Lumen']

    // Chronological so "returning" is only set for visitors already seen.
    const starts = Array.from({ length: 600 }, () => {
      const daysAgo = Math.pow(rnd(), 1.4) * 30 // more recent traffic
      const hourBias = clamp(Math.round(18 + gauss() * 4), 0, 23)
      const t = new Date(now.getTime() - daysAgo * DAY)
      t.setUTCHours(hourBias, Math.floor(rnd() * 60), Math.floor(rnd() * 60), 0)
      return t > new Date(now.getTime() - 20 * 60_000) ? new Date(now.getTime() - 20 * 60_000 - rnd() * HOUR) : t
    }).sort((a, b) => a - b)

    let fresh = 0
    for (const startedAt of starts) {
      const repeat = fresh > 20 && rnd() < 0.2
      const visitorHash = repeat ? sessions[Math.floor(rnd() * sessions.length)].visitorHash : pool[fresh++ % pool.length]
      const isReturning = seen.has(visitorHash)
      seen.add(visitorHash)
      const durationSec = Math.round(clamp(Math.exp(5.2 + gauss() * 0.9), 15, 3600))
      const withId = rnd() < 0.08
      const verified = withId || rnd() < 0.35
      sessions.push({
        id: randomUUID(),
        visitorHash,
        wallet: withId ? '0x' + createHash('sha1').update(visitorHash).digest('hex') : null,
        displayName: withId ? names[Math.floor(rnd() * names.length)] + Math.floor(rnd() * 90 + 10) : null,
        verified,
        platform: pick(platforms),
        country: pick(countries),
        cameraMode: rnd() < 0.7 ? 'first' : 'third',
        isReturning,
        startedAt,
        lastSeenAt: new Date(startedAt.getTime() + durationSec * 1000),
        durationSec,
        eventCount: Math.round(durationSec / 20 + rnd() * 8),
      })
    }

    for (let i = 0; i < sessions.length; i += 100) {
      const rows = sessions.slice(i, i + 100).map((s) => ({
        id: s.id, scene_id: loc.id, visitor_hash: s.visitorHash, wallet: s.wallet, display_name: s.displayName,
        is_guest: !s.verified, verified: s.verified, platform: s.platform, device: s.platform === 'mobile' ? 'phone' : 'pc',
        realm: 'main', country: s.country, camera_mode: s.cameraMode, is_returning: s.isReturning,
        started_at: s.startedAt, last_seen_at: s.lastSeenAt, ended_at: s.lastSeenAt, duration_sec: s.durationSec, event_count: s.eventCount,
      }))
      await tx`insert into analytics_sessions ${tx(rows)}`
    }

    // Hourly rollups, grouped by start hour (mirrors rollupHour: sessions starting in the hour).
    const byHour = new Map()
    for (const s of sessions) {
      const h = Math.floor(s.startedAt.getTime() / HOUR) * HOUR
      ;(byHour.get(h) ?? byHour.set(h, []).get(h)).push(s)
    }
    const targets = [['Pull the lever', 5], ['Open the hatch', 3], ['Press the button', 4], ['Sit down', 2]]
    const emotes = [['clap', 4], ['dance', 5], ['wave', 6], ['hammer', 1]]
    const hourRows = []
    for (const [h, list] of byHour) {
      const interactions = {}, emoteMap = {}, ctry = {}, plat = {}, cam = {}
      for (const s of list) {
        inc(ctry, s.country); inc(plat, s.platform); inc(cam, s.cameraMode)
        const n = Math.round(rnd() * 3)
        for (let k = 0; k < n; k++) inc(interactions, pick(targets))
        if (rnd() < 0.4) inc(emoteMap, pick(emotes))
      }
      const durs = list.map((s) => s.durationSec).sort((a, b) => a - b)
      let peak = 0
      for (let m = 0; m < 60; m++) {
        const t = h + m * 60_000
        peak = Math.max(peak, sessions.filter((s) => s.startedAt.getTime() < t + 60_000 && s.lastSeenAt.getTime() >= t).length)
      }
      hourRows.push({
        scene_id: loc.id, hour: new Date(h), sessions: list.length,
        unique_visitors: new Set(list.map((s) => s.visitorHash)).size,
        new_visitors: list.filter((s) => !s.isReturning).length,
        returning_visitors: list.filter((s) => s.isReturning).length,
        verified_sessions: list.filter((s) => s.verified).length,
        peak_concurrency: peak,
        dwell_avg_sec: Math.round(durs.reduce((a, b) => a + b, 0) / durs.length),
        dwell_p50_sec: durs[Math.floor(durs.length * 0.5)],
        dwell_p90_sec: durs[Math.min(durs.length - 1, Math.floor(durs.length * 0.9))],
        interactions, video: {}, emotes: emoteMap, countries: ctry, platforms: plat, camera_modes: cam,
      })
    }
    for (let i = 0; i < hourRows.length; i += 200) await tx`insert into analytics_rollup_hourly ${tx(hourRows.slice(i, i + 200).map((r) => ({
      ...r, interactions: tx.json(r.interactions), video: tx.json(r.video), emotes: tx.json(r.emotes),
      countries: tx.json(r.countries), platforms: tx.json(r.platforms), camera_modes: tx.json(r.camera_modes),
    })))}`
    const verifiedShare = sessions.filter((s) => s.verified).length / sessions.length
    await tx`update analytics_scenes set verified_session_share = ${verifiedShare} where id = ${loc.id}`

    // Daily heatmap: two hot spots in the 32x32 m area (1 m cells).
    const spots = [{ x: 8, z: 9, sd: 2.2, w: 0.6 }, { x: 24, z: 22, sd: 3, w: 0.4 }]
    const heat = []
    for (let d = 0; d < 30; d++) {
      const day = new Date(now.getTime() - d * DAY).toISOString().slice(0, 10)
      const cells = new Map()
      const samples = 150 + Math.floor(rnd() * 100)
      for (let i = 0; i < samples; i++) {
        const sp = rnd() < spots[0].w ? spots[0] : spots[1]
        const x = clamp(Math.floor(sp.x + gauss() * sp.sd), 0, 31)
        const z = clamp(Math.floor(sp.z + gauss() * sp.sd), 0, 31)
        const c = cells.get(`${x},${z}`) ?? { x, z, dwell: 0, visits: 0 }
        c.dwell += 3 + Math.floor(rnd() * 12); c.visits += 1
        cells.set(`${x},${z}`, c)
      }
      for (const c of cells.values()) heat.push({ scene_id: loc.id, day, cell_x: c.x, cell_z: c.z, dwell_sec: c.dwell, visits: c.visits })
    }
    for (let i = 0; i < heat.length; i += 500) await tx`insert into analytics_heatmap_daily ${tx(heat.slice(i, i + 500))}`

    // Three live sessions, one position each.
    const livePos = [[8.5, 9.5], [10.5, 7.5], [24.5, 22.5]]
    for (let i = 0; i < 3; i++) {
      const sid = randomUUID()
      await tx`insert into analytics_sessions (id, scene_id, visitor_hash, is_guest, verified, platform, device, realm, country, camera_mode, is_returning, started_at, last_seen_at, duration_sec, event_count)
        values (${sid}, ${loc.id}, ${hashOf(`demo-live-${i}`)}, false, true, 'desktop', 'pc', 'main', ${['US', 'DE', 'BR'][i]}, 'third', false, ${new Date(now.getTime() - (3 + i) * 60_000)}, ${now}, ${(3 + i) * 60}, 5)`
      await tx`insert into analytics_positions (scene_id, session_id, seq, occurred_at, x, y, z, heading, moving)
        values (${loc.id}, ${sid}, 1, ${now}, ${livePos[i][0]}, 1, ${livePos[i][1]}, ${i * 90}, ${i === 0})`
    }
    return { locationId: loc.id, sessions: sessions.length + 3, hours: hourRows.length, heatCells: heat.length }
  })
  console.log(`Seeded ${LOCATION_KEY}${reset ? ' (reset)' : ''}: location ${result.locationId}`)
  console.log(`  host scene ${sceneId} (owner ${scene.owner_id}), sessions ${result.sessions} (3 live), hourly rollups ${result.hours}, heatmap cells ${result.heatCells}`)
  console.log(`  open: /analytics/?location=${result.locationId}`)
  console.log('  note: live sessions count as "here now" for 60 s after seeding; re-run (with --reset) to refresh them')
} catch (err) {
  if (String(err?.message).includes(LOCATION_KEY)) {
    console.error(err.message)
    process.exitCode = 1
  } else throw err
} finally {
  await sql.end()
}
