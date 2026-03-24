import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'
import { config } from '../config'

const sql = postgres(config.databaseUrl)
export const db = drizzle(sql, { schema })
