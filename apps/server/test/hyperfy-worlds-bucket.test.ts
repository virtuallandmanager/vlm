import { describe, it, expect } from 'vitest'
import { deleteWorldFiles, type S3Like } from '../src/hyperfy/worlds-bucket.js'

function fakeS3(keys: string[]) {
  const store = new Set(keys)
  const deleteCalls: number[] = []
  const s3: S3Like = {
    async list(prefix) { return [...store].filter((k) => k.startsWith(prefix)) },
    async deleteMany(ks) {
      deleteCalls.push(ks.length)
      for (const k of ks) store.delete(k)
    },
  }
  return { s3, store, deleteCalls }
}

describe('worlds bucket', () => {
  it('deletes only keys under the slug prefix, paging through more than 1000', async () => {
    const mine = Array.from({ length: 2500 }, (_, i) => `my-world/assets/${i}.glb`)
    const others = ['my-world-2/a.glb', 'other/my-world/a.glb', 'my-worldx', 'readme.txt']
    const { s3, store, deleteCalls } = fakeS3([...mine, ...others])
    expect(await deleteWorldFiles('my-world', s3)).toBe(2500)
    expect([...store].sort()).toEqual([...others].sort())
    expect(Math.max(...deleteCalls)).toBeLessThanOrEqual(1000)
  })

  it('returns 0 when there is nothing to delete, and rejects bad slugs', async () => {
    const { s3 } = fakeS3([])
    expect(await deleteWorldFiles('empty-one', s3)).toBe(0)
    await expect(deleteWorldFiles('../x', s3)).rejects.toThrow(/invalid world slug/)
  })
})
