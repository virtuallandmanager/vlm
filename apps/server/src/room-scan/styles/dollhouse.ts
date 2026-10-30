import type { StyleKit } from './index.js'

/** No roof and 1.2 m outer walls, so visitors can look in from above. */
export const dollhouse: StyleKit = {
  outerMaterial: { name: 'exterior-dollhouse', color: '#E7CFC4' },
  roof: 'none',
  ceiling: false, // a lid over 1.2 m walls would hide the look-in
  outerWallHeight: ceiling => Math.min(ceiling, 1.2),
  extras: () => [],
}
