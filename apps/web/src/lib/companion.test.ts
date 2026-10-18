import { describe, it, expect } from 'vitest'
import { acceptFor, codeFromPath, uploadErrorMessage } from './companion'

describe('codeFromPath', () => {
  it('reads the code from the path in a static export', () => {
    expect(codeFromPath('/u/abc234/', '_')).toBe('abc234')
    expect(codeFromPath('/u/abc234', undefined)).toBe('abc234')
  })
  it('returns null when the path has no code', () => {
    expect(codeFromPath('/x', '_')).toBeNull()
    expect(codeFromPath('/u/AB!', '_')).toBeNull()
  })
  it('prefers a real route param', () => {
    expect(codeFromPath('/u/abc234', 'zzz999')).toBe('zzz999')
  })
})

describe('acceptFor', () => {
  it('limits in-world codes to images and GLB', () => {
    expect(acceptFor(['image', 'model'])).toBe('.png,.jpg,.jpeg,.webp,.gif,image/png,image/jpeg,image/webp,image/gif,.glb')
    expect(acceptFor(['image', 'model'])).not.toContain('mp4')
  })
  it('allows everything for an unrestricted code', () => {
    expect(acceptFor(null)).toContain('.mp4')
    expect(acceptFor(null)).toContain('.glb')
  })
})

describe('uploadErrorMessage', () => {
  it('maps statuses to plain messages', () => {
    expect(uploadErrorMessage(413, {})).toBe('That file is too big (images up to 10 MB, models up to 50 MB)')
    expect(uploadErrorMessage(415, {})).toBe("That file type isn't supported here (HEIC photos: choose JPEG or PNG)")
    expect(uploadErrorMessage(410, {})).toBe('This upload link has used all its uploads')
    expect(uploadErrorMessage(404, {})).toBe('This upload link has expired — make a new one in-world')
    expect(uploadErrorMessage(403, {})).toBe("You can't upload to this scene anymore")
    expect(uploadErrorMessage(402, {})).toBe("Storage is full for this scene's owner")
    expect(uploadErrorMessage(413, { error: 'storage_limit_reached' })).toBe("Storage is full for this scene's owner")
    expect(uploadErrorMessage(500, { error: 'boom' })).toBe('boom')
    expect(uploadErrorMessage(500, {})).toBe('Upload failed')
  })
})
