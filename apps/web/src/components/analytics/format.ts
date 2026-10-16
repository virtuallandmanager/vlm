const compactFmt = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const fullFmt = new Intl.NumberFormat()

/** Axis ticks and bar values: 950, 1.2K, 3.4M. */
export const compact = (n: number) => (Math.abs(n) < 1000 ? fullFmt.format(n) : compactFmt.format(n))
/** Tooltips: the exact value. */
export const full = (n: number) => fullFmt.format(n)
