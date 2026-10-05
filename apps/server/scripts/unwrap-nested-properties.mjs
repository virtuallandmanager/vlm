// One-off data fix: unwrap legacy nested `properties` on scene elements and instances.
//
// A dashboard relay bug (fixed on feature/media-hosting) stored rows as `{ properties: { … } }`.
// The serializer already unwraps them at read time; this rewrites the stored rows the same way
// (nested keys, then the outer keys on top).
//
//   DATABASE_URL=… node scripts/unwrap-nested-properties.mjs --count   # how many rows are affected
//   DATABASE_URL=… node scripts/unwrap-nested-properties.mjs --apply   # fix them (one transaction)
import postgres from 'postgres'

const mode = process.argv.includes('--apply') ? 'apply' : process.argv.includes('--count') ? 'count' : null
if (!mode) {
  console.error('usage: node scripts/unwrap-nested-properties.mjs --count | --apply')
  process.exit(2)
}
const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set')
  process.exit(2)
}

const sql = postgres(url, { max: 1, onnotice: () => {} })
try {
  if (mode === 'count') {
    const [{ n: elements }] = await sql`SELECT count(*)::int AS n FROM scene_elements WHERE jsonb_typeof(properties->'properties') = 'object'`
    const [{ n: instances }] = await sql`SELECT count(*)::int AS n FROM scene_element_instances WHERE jsonb_typeof(properties->'properties') = 'object'`
    console.log(`rows with nested properties — scene_elements: ${elements}, scene_element_instances: ${instances}`)
  } else {
    const [elements, instances] = await sql.begin(async (tx) => {
      const e = await tx`UPDATE scene_elements SET properties = (properties->'properties') || (properties - 'properties') WHERE jsonb_typeof(properties->'properties') = 'object'`
      const i = await tx`UPDATE scene_element_instances SET properties = (properties->'properties') || (properties - 'properties') WHERE jsonb_typeof(properties->'properties') = 'object'`
      return [e.count, i.count]
    })
    console.log(`unwrapped — scene_elements: ${elements}, scene_element_instances: ${instances}`)
  }
} finally {
  await sql.end()
}
