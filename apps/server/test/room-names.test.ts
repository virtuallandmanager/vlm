import { describe, it, expect } from 'vitest'
import { defineRooms } from '../src/ws/registry.js'

describe('room names', () => {
  it('registers the Virvi rooms and nothing named after VLM', () => { // virvi-rename: keep
    const names: string[] = []
    const server = { define: (name: string) => (names.push(name), { filterBy: () => undefined }) }
    defineRooms(server as never)
    expect(names).toEqual(['virvi_scene', 'virvi_command_center', 'virvi_studio'])
    expect(names.some((n) => /vlm/i.test(n))).toBe(false) // virvi-rename: keep
  })
})
