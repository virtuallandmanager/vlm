/**
 * Seeds a local studio for looking at the dashboard's Design Studio page without running an agent
 * (scripts/studio-local.md, "Looking at the page without an agent"): a local user with three designs.
 *
 * - A wearable set: `hat` at revision 3 with a 36-frame spin, revision 1 paid and ready to download, revision 2 paid
 *   and reportable; `feet`, failing the checker; a conversation ending in a slot proposal, after a prompt that
 *   stopped at the cost ceiling (so Continue shows).
 * - An emote with a 36-frame loop.
 * - An empty design.
 *
 * Frames and the package are written into the configured file:// studio store (python3 with Pillow draws the frames:
 * a coloured bar turning). Prints `{accessToken, session, designs: {wearable, emote, empty}}`; `session` is what the
 * dashboard keeps in localStorage. Local development only.
 *
 *   DATABASE_URL=... JWT_SECRET=... STUDIO_S3_URI=file:///tmp/studio-store pnpm exec tsx scripts/studio-seed-page.ts
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { createSigner } from 'fast-jwt'
import { db } from '../src/db/connection.js'
import {
  users, studioDesigns, studioEntitlements, studioJobs, studioMessages, studioPayments, studioPieces, studioRenders,
  studioRevisions,
} from '../src/db/schema.js'
import { config } from '../src/config.js'
import { getStudioStore, jobFileKey } from '../src/studio/store.js'
import { framePath } from '../src/studio/render-urls.js'

const EMAIL = 'studio-local@virvi.test'
const FRAMES = 36

if (config.mode === 'cloud' && !config.publicUrl.includes('localhost') && !config.publicUrl.includes('host.docker.internal')) {
  throw new Error('studio-seed-page is for a local server only')
}
if (!process.env.STUDIO_S3_URI?.startsWith('file://')) throw new Error('studio-seed-page writes to a file:// studio store only')

const DRAW = `
import sys, math
from PIL import Image, ImageDraw
out, hue = sys.argv[1], int(sys.argv[2])
for i in range(${FRAMES}):
    img = Image.new('RGBA', (512, 512), (12, 14, 20, 255))
    d = ImageDraw.Draw(img)
    a = math.radians(i * 360 / ${FRAMES})
    w = abs(math.cos(a)) * 170 + 12
    colour = (hue, 200 - hue // 3, 255 - hue, 255) if math.cos(a) >= 0 else (90, 90, 110, 255)
    d.rectangle([256 - w, 200, 256 + w, 312], fill=colour)
    d.ellipse([236, 380, 276, 420], fill=(255, 255, 255, 255) if i == 0 else (60, 60, 70, 255))
    d.text((16, 16), f'frame {i:02d}', fill=(200, 200, 200, 255))
    img.save(f'{out}/{i:03d}.webp', 'WEBP', quality=80)
`

const ZIP = `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    z.writestr('README.md', '# Seeded package\\nA stand-in for a finalized revision.\\n')
    z.writestr('neon_cap_male.glb', b'glTF')
`

const store = getStudioStore()
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000)

/** Draws 36 frames into the store as the job's render of `viewKey`, and records the render as ready. */
async function renders(designId: string, jobId: string, revisionId: string, category: string, viewKey: string, hue: number) {
  const dir = mkdtempSync(join(tmpdir(), 'studio-frames-'))
  try {
    execFileSync('python3', ['-c', DRAW, dir, String(hue)])
    for (let frame = 0; frame < FRAMES; frame++) {
      const body = readFileSync(join(dir, `${String(frame).padStart(3, '0')}.webp`))
      await store.put(jobFileKey(designId, jobId, framePath({ category, viewKey, frame })), body, 'image/webp')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  await db.insert(studioRenders).values({ revisionId, viewKey, jobId, frames: FRAMES, status: 'ready' })
}

async function job(designId: string, type: string, outcome: string, minutesAgo: number) {
  const [j] = await db.insert(studioJobs).values({
    designId, type, status: 'done', payload: { type }, result: { outcome }, createdAt: at(minutesAgo), finishedAt: at(minutesAgo - 1),
  }).returning()
  return j
}

async function revision(pieceId: string, jobId: string, number: number, checker: { pass: boolean; failures: number; warnings: number }, minutesAgo: number) {
  const [r] = await db.insert(studioRevisions).values({
    pieceId, number, jobId, changeKind: number === 1 ? 'new' : 'design', meta: {}, checker, files: [], createdAt: at(minutesAgo),
  }).returning()
  return r
}

async function paid(userId: string, designId: string, revisionId: string, category: string, kind: 'first' | 'revision', amountCents: number, minutesAgo: number) {
  const [payment] = await db.insert(studioPayments).values({
    userId, designId, kind: 'finalize', status: 'paid', amountCents, paidAt: at(minutesAgo), stripePaymentIntent: `pi_seed_${revisionId.slice(0, 8)}`,
  }).returning()
  const fin = await job(designId, 'finalize', 'ok', minutesAgo)
  const packageKey = jobFileKey(designId, fin.id, `final/${category}/package.zip`)
  const dir = mkdtempSync(join(tmpdir(), 'studio-zip-'))
  try {
    execFileSync('python3', ['-c', ZIP, join(dir, 'package.zip')])
    await store.put(packageKey, readFileSync(join(dir, 'package.zip')), 'application/zip')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  await db.insert(studioEntitlements).values({
    revisionId, paymentId: payment.id, userId, designId, category, kind, amountCents, status: 'ready', jobId: fin.id, packageKey,
  })
}

let [user] = await db.select().from(users).where(eq(users.email, EMAIL))
if (!user) [user] = await db.insert(users).values({ email: EMAIL, displayName: 'Studio Local', role: 'creator' }).returning()
const PASS = { pass: true, failures: 0, warnings: 0 }

// The wearable set
const [wearable] = await db.insert(studioDesigns).values({
  ownerId: user.id, name: 'Neon street set', kind: 'wearable', agent: 'codex', lastJobAt: at(5), finalizedAt: at(60), createdAt: at(300),
}).returning()
const first = await job(wearable.id, 'prompt', 'ok', 240)
const second = await job(wearable.id, 'prompt', 'ok', 120)
const third = await job(wearable.id, 'prompt', 'ok', 30)
const stopped = await job(wearable.id, 'prompt', 'ceiling', 5)
const [hat] = await db.insert(studioPieces).values({ designId: wearable.id, category: 'hat', name: 'Neon Cap' }).returning()
const hat1 = await revision(hat.id, first.id, 1, PASS, 240)
const hat2 = await revision(hat.id, second.id, 2, PASS, 120)
const hat3 = await revision(hat.id, third.id, 3, PASS, 30)
await db.update(studioPieces).set({ latestRevisionId: hat3.id }).where(eq(studioPieces.id, hat.id))
await renders(wearable.id, third.id, hat3.id, 'hat', 'spin-male-default', 40)
await paid(user.id, wearable.id, hat1.id, 'hat', 'first', 2900, 200)
await paid(user.id, wearable.id, hat2.id, 'hat', 'revision', 1500, 60)
const [feet] = await db.insert(studioPieces).values({ designId: wearable.id, category: 'feet', name: 'Glow Sneakers' }).returning()
const feet1 = await revision(feet.id, third.id, 1, { pass: false, failures: 2, warnings: 0 }, 30)
await db.update(studioPieces).set({ latestRevisionId: feet1.id }).where(eq(studioPieces.id, feet.id))
await renders(wearable.id, third.id, feet1.id, 'feet', 'spin-male-default', 200)
await db.insert(studioMessages).values([
  { designId: wearable.id, role: 'user', text: 'A cyberpunk street set: a cap with a glowing visor and sneakers to match.', jobId: first.id, createdAt: at(241) },
  { designId: wearable.id, role: 'agent', agent: 'codex', text: 'I built a rounded cap with a neon visor strip.', jobId: first.id, createdAt: at(239) },
  { designId: wearable.id, role: 'user', text: 'Make the visor brighter and add the sneakers.', jobId: third.id, createdAt: at(31) },
  { designId: wearable.id, role: 'agent', agent: 'codex', text: 'Brighter visor done, and glowing sneakers. The sneakers fail two checks.', jobId: third.id, createdAt: at(29) },
  { designId: wearable.id, role: 'user', text: 'What else would suit the set?', jobId: stopped.id, createdAt: at(6) },
  { designId: wearable.id, role: 'system', text: 'The agent stopped at its cost limit for one message. Continue to let it finish: it doesn’t use a prompt.', jobId: stopped.id, createdAt: at(5) },
  {
    designId: wearable.id, role: 'agent', agent: 'codex', text: 'A few pieces would round the set out. Pick the ones you want.', jobId: stopped.id, createdAt: at(4),
    proposal: { slots: [
      { category: 'eyewear', recommended: true, reason: 'visor-style shades echo the cap' },
      { category: 'upper_body', recommended: true, reason: 'a jacket with the same neon piping' },
      { category: 'hands_wear', recommended: false, reason: 'gloves, if you want the full look' },
    ] },
  },
])

// The emote
const [emote] = await db.insert(studioDesigns).values({
  ownerId: user.id, name: 'Neon wave', kind: 'emote', agent: 'claude', lastJobAt: at(15), createdAt: at(100),
}).returning()
const emoteJob = await job(emote.id, 'prompt', 'ok', 15)
const [emotePiece] = await db.insert(studioPieces).values({ designId: emote.id, category: 'emote', name: 'Neon Wave' }).returning()
const emote1 = await revision(emotePiece.id, emoteJob.id, 1, PASS, 15)
await db.update(studioPieces).set({ latestRevisionId: emote1.id }).where(eq(studioPieces.id, emotePiece.id))
await renders(emote.id, emoteJob.id, emote1.id, 'emote', 'emote-male-default', 120)
await db.insert(studioMessages).values([
  { designId: emote.id, role: 'user', text: 'A big friendly wave with a little hop.', jobId: emoteJob.id, createdAt: at(16) },
  { designId: emote.id, role: 'agent', agent: 'claude', text: 'Here is a two-second wave with a hop on the third beat.', jobId: emoteJob.id, createdAt: at(14) },
])

// The empty design
const [empty] = await db.insert(studioDesigns).values({ ownerId: user.id, name: 'Untitled design', kind: 'wearable', agent: 'claude' }).returning()

const accessToken = createSigner({ key: config.jwtSecret, expiresIn: 8 * 3600_000 })({
  id: user.id, email: user.email, role: user.role, orgId: null, wallet: null, verified: true, kind: 'account',
})
const session = { token: accessToken, user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role } }
console.log(JSON.stringify({ accessToken, session, designs: { wearable: wearable.id, emote: emote.id, empty: empty.id } }))
process.exit(0)
