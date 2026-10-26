// Tests for check-no-vlm.mjs: each case builds a throwaway git repo and runs the guard in it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-no-vlm.mjs')

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'no-vlm-'))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['add', '-A'], { cwd: dir })
  return dir
}

function run(dir, ...pathspecs) {
  const r = spawnSync('node', [SCRIPT, ...pathspecs], { cwd: dir, encoding: 'utf8' })
  return { code: r.status, out: r.stdout + r.stderr }
}

test('flags a plain vlm line', () => {
  const r = run(repo({ 'a.txt': "const a = 'vlm'\n" }))
  assert.equal(r.code, 1)
  assert.match(r.out, /a\.txt:1:/)
  assert.match(r.out, /1 hits/)
})

test('skips allowlisted paths', () => {
  const r = run(repo({ 'docs/superpowers/x.md': 'vlm\n' }))
  assert.equal(r.code, 0)
  assert.match(r.out, /0 hits/)
})

test('strips allowlisted tokens', () => {
  assert.equal(run(repo({ 'fly.toml': 'app = "vlm-worlds-router"\n' })).code, 0)
  assert.equal(run(repo({ 'fly.toml': 'app = "vlm-worlds-router" // vlm\n' })).code, 1)
})

test('honours the keep marker', () => {
  assert.equal(run(repo({ 'a.ts': "old = 'vlm_scene_id' // virvi-rename: keep\n" })).code, 0)
})

test('scopes to pathspecs', () => {
  const dir = repo({ 'a/ok.txt': 'fine\n', 'b/bad.txt': 'vlm\n' })
  assert.equal(run(dir, 'a/').code, 0)
  assert.equal(run(dir).code, 1)
})

test('counts a binary file once', () => {
  const dir = repo({ 'bin.dat': '\u0000vlm\u0000vlm\nvlm' })
  const r = run(dir)
  assert.equal(r.code, 1)
  assert.match(r.out, /1 hits/)
})
