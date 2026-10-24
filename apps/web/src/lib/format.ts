// Number and size formatting shared by the dashboard's list pages.

/** The page header's count badge: at least two digits, with thousands separators. */
export function countLabel(n: number): string {
  return n < 10 && n >= 0 ? `0${n}` : n.toLocaleString('en-US')
}

/** "1 event", "4 events", "5,482 assets". */
export function plural(n: number, noun: string): string {
  return `${n.toLocaleString('en-US')} ${noun}${n === 1 ? '' : 's'}`
}

export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1)
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
}
