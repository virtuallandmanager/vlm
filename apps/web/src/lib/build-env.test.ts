import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const src = fileURLToPath(new URL('..', import.meta.url))
const dockerfile = readFileSync(fileURLToPath(new URL('../../../../Dockerfile', import.meta.url)), 'utf8')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

describe('production build env', () => {
  it('the Dockerfile passes every NEXT_PUBLIC_ variable the web app reads into the build', () => {
    // Next.js inlines NEXT_PUBLIC_* at build time; a Docker build only sees build args it declares
    const used = new Set(sourceFiles(src).flatMap((f) => readFileSync(f, 'utf8').match(/process\.env\.NEXT_PUBLIC_[A-Z0-9_]+/g) ?? []).map((m) => m.slice('process.env.'.length)))
    expect(used.size).toBeGreaterThan(0)
    const missing = [...used].filter((v) => !dockerfile.includes(`ARG ${v}\n`) || !dockerfile.includes(`ENV ${v}=$${v}`))
    expect(missing).toEqual([])
  })
})
