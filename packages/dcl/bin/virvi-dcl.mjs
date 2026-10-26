#!/usr/bin/env node
import { sync, install, DEFAULT_SERVER } from './sync.mjs'

const USAGE = `Usage: virvi-dcl sync [--server <url>] [--location <key>] [--dry-run]
       virvi-dcl install [--dry-run] [--force]`

const [cmd, ...args] = process.argv.slice(2)
if (cmd !== 'sync' && cmd !== 'install') {
  console.log(USAGE)
  process.exit(cmd === '--help' || cmd === '-h' || !cmd ? 0 : 1)
}

const opts = { server: DEFAULT_SERVER, location: undefined, dryRun: false, force: false }
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--dry-run') opts.dryRun = true
  else if (cmd === 'install' && a === '--force') opts.force = true
  else if (cmd === 'sync' && a === '--server' && args[i + 1]) opts.server = args[++i]
  else if (cmd === 'sync' && a === '--location' && args[i + 1]) opts.location = args[++i]
  else {
    console.error(`Unknown argument: ${a}\n${USAGE}`)
    process.exit(1)
  }
}

try {
  if (cmd === 'install') {
    install({ cwd: process.cwd(), dryRun: opts.dryRun, force: opts.force })
    process.exit(0)
  }
  const r = await sync({ cwd: process.cwd(), server: opts.server, location: opts.location, dryRun: opts.dryRun })
  console.log(`\nNow deploy your scene (Creator Hub: Publish, or \`npx sdk-commands deploy\`).`)
  process.exit(r.over ? 2 : 0)
} catch (e) {
  console.error(`virvi-dcl: ${e.message}`)
  process.exit(1)
}
