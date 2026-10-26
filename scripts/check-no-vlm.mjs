#!/usr/bin/env node
// Lists every remaining "vlm" or "Virtual Land Manager" in tracked files and file names, outside the names the Virvi rename keeps on purpose
// (scripts/vlm-allowlist.json, or a line marked `virvi-rename: keep`). Exits 1 when any are left.
// Usage: node scripts/check-no-vlm.mjs [pathspec...]
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const allow = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'vlm-allowlist.json'), 'utf8'))
const KEEP = 'virvi-rename: keep'
const OLD = /vlm|virtual land manager/i

const globToRegex = (glob) =>
  new RegExp(
    '^' +
      glob
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\//g, '\u0000')
        .replace(/\*\*/g, '\u0001')
        .replace(/\*/g, '[^/]*')
        .replace(/\u0000/g, '(?:.*/)?')
        .replace(/\u0001/g, '.*') +
      '$',
  )
const skipPaths = allow.paths.map(globToRegex)
const tokens = allow.tokens.map((t) => new RegExp(t, 'gi'))

const files = execFileSync('git', ['ls-files', '-z', '--', ...process.argv.slice(2)], { encoding: 'utf8', maxBuffer: 1 << 28 })
  .split('\0')
  .filter(Boolean)
  .filter((f) => !skipPaths.some((re) => re.test(f)))

let hits = 0
for (const file of files) {
  if (OLD.test(tokens.reduce((s, re) => s.replace(re, ''), file.split('/').pop()))) {
    console.log(`${file}: file name mentions vlm`)
    hits++
  }
  let buf
  try {
    buf = readFileSync(file)
  } catch {
    continue // listed but deleted in the working tree
  }
  if (buf.subarray(0, 8000).includes(0)) {
    if (OLD.test(buf.toString('latin1'))) {
      console.log(`${file}: binary file mentions vlm`)
      hits++
    }
    continue
  }
  buf.toString('utf8').split('\n').forEach((line, i) => {
    if (line.includes(KEEP)) return
    const rest = tokens.reduce((s, re) => s.replace(re, ''), line)
    if (OLD.test(rest)) {
      console.log(`${file}:${i + 1}: ${line.trim().slice(0, 200)}`)
      hits++
    }
  })
}
console.log(`${hits} hits`)
process.exit(hits > 0 ? 1 : 0)
