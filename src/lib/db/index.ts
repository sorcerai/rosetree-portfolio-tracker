import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

// Database connection
const connectionString = process.env.DATABASE_URL!

// For migrations and admin operations
export const migrationClient = postgres(connectionString, { max: 1 })

// For queries (with connection pooling)
const queryClient = postgres(connectionString)
export const db = drizzle(queryClient, { schema })

// Export all schema
export * from './schema'