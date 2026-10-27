import { dclBudget, plotParcels, type Plot } from '@virvixr/shared'
import type { PlacedItem } from './placement'

export interface BudgetStatus {
  triangles: { used: number; limit: number | null }
  entities: { used: number; limit: number | null }
  bytes: { used: number; remaining: number | null }
  over: null | string
}

const n = (v: number) => Math.round(v).toLocaleString('en-US')
const mb = (v: number) => `${(v / 1_048_576).toFixed(1)} MB`

/** Running Decentraland budget for the placed items. `plot` null means no hard limits (Hyperfy/AR only). */
export function budgetStatus(
  items: PlacedItem[],
  plot: Plot | null,
  storage: { maxAllowedBytes: number; usedBytes: number } | null,
): BudgetStatus {
  const budget = plot ? dclBudget(plotParcels(plot).length) : null
  const triUsed = items.reduce((s, i) => s + (i.asset.triangleCount ?? 0), 0)
  const distinct = new Map(items.map((i) => [i.asset.id, i.asset.fileSizeBytes]))
  const bytesUsed = [...distinct.values()].reduce((s, b) => s + b, 0)
  const remaining = storage ? storage.maxAllowedBytes - storage.usedBytes : null

  let over: string | null = null
  if (budget && triUsed > budget.triangles) {
    over = `This plot fits about ${n(budget.triangles)} triangles; that would make it ${n(triUsed)}`
  } else if (budget && items.length > budget.entities) {
    over = `This plot fits about ${n(budget.entities)} items; that would make it ${n(items.length)}`
  } else if (remaining !== null && bytesUsed > remaining) {
    over = `Your World has about ${mb(Math.max(remaining, 0))} of storage left; that would make it ${mb(bytesUsed)}`
  }
  return {
    triangles: { used: triUsed, limit: budget?.triangles ?? null },
    entities: { used: items.length, limit: budget?.entities ?? null },
    bytes: { used: bytesUsed, remaining: remaining === null ? null : remaining - bytesUsed },
    over,
  }
}

/** Drops items from the end until the plot's triangle and entity limits hold. */
export function fitToBudget(items: PlacedItem[], plot: Plot): { items: PlacedItem[]; dropped: number } {
  const budget = dclBudget(plotParcels(plot).length)
  const kept: PlacedItem[] = []
  let tris = 0
  for (const it of items) {
    const t = it.asset.triangleCount ?? 0
    if (tris + t > budget.triangles || kept.length + 1 > budget.entities) break
    kept.push(it)
    tris += t
  }
  return { items: kept, dropped: items.length - kept.length }
}
