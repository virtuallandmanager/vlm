import { describe, expect, it } from 'vitest'
import { defaultTicked, namesDiffer, renameError, sceneNameError, SCENE_NAME_MAX } from './scene-rename'

describe('defaultTicked', () => {
  it('ticks an item still called the old scene name', () => {
    expect(defaultTicked('Moon', 'Moon', 'Moon base')).toBe(true)
  })
  it('does not tick an item already called the new name', () => {
    expect(defaultTicked('Moon base', 'Moon', 'Moon base')).toBe(false)
  })
  it('does not tick an item with its own name', () => {
    expect(defaultTicked('Lobby', 'Moon', 'Moon base')).toBe(false)
  })
  it('ignores spaces around names, but not case', () => {
    expect(defaultTicked(' Moon ', 'Moon', 'Moon base')).toBe(true)
    expect(defaultTicked('moon', 'Moon', 'Moon base')).toBe(false)
  })
  it('ticks nothing when the old name is unknown or unchanged', () => {
    expect(defaultTicked('Moon', null, 'Moon base')).toBe(false)
    expect(defaultTicked('Moon', 'Moon', 'Moon')).toBe(false)
    expect(defaultTicked('Moon', 'Moon', ' Moon ')).toBe(false)
  })
})

describe('namesDiffer', () => {
  it('is true when any item is called something other than the scene', () => {
    expect(namesDiffer('Moon', ['Moon', 'Lobby'])).toBe(true)
    expect(namesDiffer('Moon', ['Moon', ' Moon'])).toBe(false)
    expect(namesDiffer('Moon', [])).toBe(false)
  })
})

describe('sceneNameError', () => {
  it('refuses a blank or too-long name', () => {
    expect(sceneNameError('   ')).toMatch(/name/i)
    expect(sceneNameError('x'.repeat(SCENE_NAME_MAX + 1))).toMatch(/120/)
    expect(sceneNameError('x'.repeat(SCENE_NAME_MAX))).toBeNull()
    expect(sceneNameError(' Moon ')).toBeNull()
  })
})

describe('renameError', () => {
  it("prefers the server's message, then its error, then a fallback", () => {
    expect(renameError(Object.assign(new Error('bad_request'), { body: { error: 'bad_request', message: 'Name is too long' } }))).toBe('Name is too long')
    expect(renameError(Object.assign(new Error('World not found'), { body: { error: 'World not found' } }))).toBe('World not found')
    expect(renameError({})).toBe('Something went wrong. Try again in a moment.')
  })
})
