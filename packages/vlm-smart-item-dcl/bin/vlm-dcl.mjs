#!/usr/bin/env node
import { sync, DEFAULT_SERVER } from './sync.mjs'

const USAGE = `Usage: vlm-dcl sync [--server <url>] [--location <key>] [--dry-run]`

const [cmd, ...args] = process.argv.slice(2)
if (cmd !== 'sync') {
  console.log(USAGE)
  process.exit(cmd === '--help' || cmd === '-h' || !cmd ? 0 : 1)
}

const opts = { server: DEFAULT_SERVER, location: undefined, dryRun: false }
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--dry-run') opts.dryRun = true
  else if (a === '--server' && args[i + 1]) opts.server = args[++i]
  else if (a === '--location' && args[i + 1]) opts.location = args[++i]
  else {
    console.error(`Unknown argument: ${a}\n${USAGE}`)
    process.exit(1)
  }
}

try {
  const r = await sync({ cwd: process.cwd(), ...opts })
  console.log(`\nNow deploy your scene (Creator Hub: Publish, or \`npx sdk-commands deploy\`).`)
  process.exit(r.over ? 2 : 0)
} catch (e) {
  console.error(`vlm-dcl: ${e.message}`)
  process.exit(1)
}
