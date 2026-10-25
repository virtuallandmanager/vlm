import { db } from '../../src/db/connection.js'
import { studioDesigns } from '../../src/db/schema.js'
import type { WorkerMachineSpec } from '../../src/hyperfy/fly.js'
import type { TestUser } from './factories.js'

/** A Fly that keeps machines in memory and records what it was asked to do. */
export function fakeFly() {
  const machines = new Map<string, { state: string; spec: WorkerMachineSpec }>()
  const calls = { create: [] as WorkerMachineSpec[], start: [] as string[], del: [] as string[] }
  let n = 0
  const fly = {
    calls,
    machines,
    failCreate: null as null | ((spec: WorkerMachineSpec) => Error),
    async createWorkerMachine(_app: string, spec: WorkerMachineSpec) {
      calls.create.push(spec)
      if (fly.failCreate) throw fly.failCreate(spec)
      await new Promise((r) => setTimeout(r, 5))
      const id = `m${++n}`
      machines.set(id, { state: 'started', spec })
      return { id }
    },
    async getMachineState(_app: string, id: string) {
      return machines.get(id)?.state ?? null
    },
    async startMachine(_app: string, id: string) {
      calls.start.push(id)
      const m = machines.get(id)
      if (m) m.state = 'started'
    },
    async deleteMachine(_app: string, id: string) {
      calls.del.push(id)
      machines.delete(id)
    },
  }
  return fly
}

export async function createDesign(
  user: TestUser,
  opts: Partial<typeof studioDesigns.$inferInsert> = {},
) {
  const [d] = await db.insert(studioDesigns)
    .values({ ownerId: user.id, name: 'Neon cap', kind: 'wearable', agent: 'claude', ...opts })
    .returning()
  return d
}
