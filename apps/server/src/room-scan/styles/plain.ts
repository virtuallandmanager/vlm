import type { StyleKit } from './index.js'

/** Painted walls and a flat roof. */
export const plain: StyleKit = {
  outerMaterial: { name: 'exterior-plain', color: '#D8D3CA' },
  roof: 'flat',
  roofMaterial: { name: 'roof', color: '#8E8C87' },
  outerWallHeight: ceiling => ceiling,
  extras: () => [],
}
