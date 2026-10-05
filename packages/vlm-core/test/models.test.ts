import { describe, it, expect } from 'vitest'
import { localModelFile } from 'vlm-shared'

describe('localModelFile', () => {
  it('maps https glb urls to models/vlm/<basename>', () => {
    expect(localModelFile('https://cdn.vlm.gg/u1/ab12.glb')).toBe('models/vlm/ab12.glb')
    expect(localModelFile('http://cdn.vlm.gg/u1/ab12.glb')).toBe('models/vlm/ab12.glb')
  })
  it('strips the query string and fragment', () => {
    expect(localModelFile('https://cdn.vlm.gg/u1/ab12.glb?v=2')).toBe('models/vlm/ab12.glb')
  })
  it('accepts uppercase .GLB', () => {
    expect(localModelFile('https://cdn.vlm.gg/u1/AB.GLB')).toBe('models/vlm/AB.GLB')
  })
  it('returns null for non-glb and relative paths', () => {
    expect(localModelFile('https://cdn.vlm.gg/u1/ab12.gltf')).toBeNull()
    expect(localModelFile('models/local.glb')).toBeNull()
    expect(localModelFile('')).toBeNull()
  })
})
