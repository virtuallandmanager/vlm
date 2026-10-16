export function visitorLabel(s: { walletAddress: string | null; displayName: string | null; userId: string }): string {
  if (s.displayName) return s.displayName
  if (s.walletAddress) return `${s.walletAddress.slice(0, 6)}…${s.walletAddress.slice(-4)}`
  return `Visitor ${s.userId.slice(0, 8)}`
}

export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}
