import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.js'
import { config } from '../config.js'

if (!config.databaseUrl) {
  console.error('[vlm-server] FATAL: DATABASE_URL environment variable is required')
  process.exit(1)
}

const sql = postgres(config.databaseUrl)
export const db = drizzle(sql, { schema })
