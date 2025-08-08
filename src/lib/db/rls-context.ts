import { Pool } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import postgres from 'postgres'
import * as schema from './schema'
import { sql } from 'drizzle-orm'

// Test environment override - allows injection of test pool
let testDatabasePool: Pool | null = null

/**
 * Set test database pool for integration tests
 * This allows tests to inject their Testcontainers pool
 */
export function setTestDatabasePool(pool: Pool | null) {
  testDatabasePool = pool
}

// Create database connections for both test and production
let productionDb: ReturnType<typeof drizzle> | null = null
let testDb: ReturnType<typeof drizzle> | null = null

/**
 * Get the appropriate database instance for current environment
 */
function getDatabase(): ReturnType<typeof drizzle> {
  if (testDatabasePool) {
    // Create test database instance if not cached
    if (!testDb) {
      testDb = drizzle(testDatabasePool, { schema })
    }
    return testDb
  }
  
  // Create production database instance if not cached
  if (!productionDb) {
    const connectionString = process.env.DATABASE_URL!
    const client = postgres(connectionString, {
      max: 10, // Connection pool size
      idle_timeout: 20,
      connect_timeout: 10
    })
    productionDb = drizzle(client, { schema })
  }
  
  return productionDb
}

/**
 * User context for Row Level Security
 * Sets the authenticated user and their roles for database queries
 */
export interface RLSContext {
  userId: string
  roles: ('TRADER' | 'COACH' | 'ADMIN' | 'SYSTEM')[]
}

/**
 * Execute database operations with Row Level Security context
 * 
 * CRITICAL SECURITY FIX: Now uses Drizzle's native transaction API to ensure
 * app.set_auth() and all queries execute on the exact same database connection.
 * This fixes the RLS policy bypass issue where users could see each other's data.
 * 
 * This function is the foundation of our security architecture:
 * 1. Opens a Drizzle transaction (guarantees same connection)
 * 2. Sets the user context via app.set_auth() on that connection
 * 3. Executes all queries within that security context
 * 4. RLS policies automatically enforce data isolation
 * 
 * Based on Codex production patterns for financial applications
 * 
 * @param context User ID and roles for RLS enforcement
 * @param operation Database operations to execute with user context
 * @returns Result of the database operation
 * 
 * @example
 * ```typescript
 * const portfolios = await withRLS(
 *   { userId: 'user-123', roles: ['TRADER'] },
 *   async (db) => {
 *     // This query automatically filters by user due to RLS
 *     return await db.select().from(portfoliosTable)
 *   }
 * )
 * ```
 */
export async function withRLS<T>(
  context: RLSContext,
  operation: (db: ReturnType<typeof drizzle>) => Promise<T>
): Promise<T> {
  const db = getDatabase()
  
  // Use Drizzle's native transaction API to ensure same connection for RLS context and queries
  return await db.transaction(async (tx) => {
    // CRITICAL SECURITY FIX: Use SET LOCAL for transaction-scoped RLS context
    // This prevents context leakage across connections in the pool
    // SET LOCAL automatically clears at transaction end (COMMIT or ROLLBACK)
    await tx.execute(sql`SET LOCAL app.user_id = ${sql.raw(`'${context.userId}'`)}`)
    await tx.execute(sql`SET LOCAL app.roles = ${sql.raw(`'${context.roles.join(',')}'`)}`)
    
    // Verify SET LOCAL worked correctly
    const debugCheck = await tx.execute(sql`SELECT app.current_user_id() as user_id`)
    const expectedUser = debugCheck.rows[0]?.user_id
    console.log(`🔍 RLS Context Set: Expected=${context.userId}, Actual=${expectedUser}`)
    
    if (expectedUser !== context.userId) {
      throw new Error(`RLS context setting failed: expected ${context.userId}, got ${expectedUser}`)
    }
    
    try {
      // Execute user operations with security context
      // All operations use the same transaction connection where RLS context is set
      return await operation(tx)
      
    } catch (error) {
      // Re-throw original error with context
      if (error instanceof Error) {
        error.message = `RLS operation failed for user ${context.userId}: ${error.message}`
      }
      throw error
    }
  })
}

/**
 * Execute database operations with SYSTEM privileges
 * 
 * Use this for:
 * - Price data ingestion
 * - Background jobs and maintenance
 * - Administrative operations
 * 
 * ⚠️ SECURITY WARNING: Only use for system operations, never for user requests
 * 
 * @param operation Database operations to execute with SYSTEM role
 * @returns Result of the database operation
 */
export async function withSystemContext<T>(
  operation: (db: ReturnType<typeof drizzle>) => Promise<T>
): Promise<T> {
  return withRLS(
    { 
      userId: '00000000-0000-0000-0000-000000000000', // System UUID
      roles: ['SYSTEM'] 
    },
    operation
  )
}

/**
 * Execute database operations with ADMIN privileges
 * 
 * Use this for:
 * - Administrative dashboards
 * - User management operations
 * - Cross-user reporting
 * 
 * @param adminUserId The ID of the admin user
 * @param operation Database operations to execute with ADMIN role
 * @returns Result of the database operation
 */
export async function withAdminContext<T>(
  adminUserId: string,
  operation: (db: ReturnType<typeof drizzle>) => Promise<T>
): Promise<T> {
  return withRLS(
    { 
      userId: adminUserId, 
      roles: ['ADMIN'] 
    },
    operation
  )
}

/**
 * Utility function to provision a new user atomically
 * 
 * This calls the database function that prevents race conditions
 * and ensures each user gets a default portfolio
 * 
 * @param userId Supabase user ID
 * @param email User's email address
 * @param role Initial user role (defaults to TRADER)
 * @returns User and portfolio creation results
 */
export async function provisionUser(
  userId: string,
  email: string,
  role: 'TRADER' | 'COACH' | 'ADMIN' = 'TRADER'
): Promise<{
  userId: string
  portfolioId: string
  created: boolean
}> {
  return withSystemContext(async (db) => {
    const result = await db.execute(
      sql`SELECT * FROM app.provision_user(${userId}, ${email}, ${role})`
    )
    
    if (result.rows.length === 0) {
      throw new Error('Failed to provision user')
    }
    
    const row = result.rows[0] as any
    return {
      userId: row.user_id,
      portfolioId: row.portfolio_id,
      created: row.created
    }
  })
}

/**
 * Test RLS policies are working correctly
 * 
 * This function validates that:
 * 1. Users can only see their own data
 * 2. Admins can see all data
 * 3. No data leaks between users
 * 
 * @returns Array of test results
 */
export async function testRLSIsolation(): Promise<Array<{
  testName: string
  passed: boolean
  details: string
}>> {
  return withSystemContext(async (db) => {
    const results = await db.execute(
      sql`SELECT * FROM app.test_rls_isolation()`
    )
    
    return results.rows.map((row: any) => ({
      testName: row.test_name,
      passed: row.passed,
      details: row.details
    }))
  })
}

/**
 * Get database connection pool statistics
 * Useful for monitoring and debugging connection issues
 */
export function getPoolStats() {
  if (testDatabasePool) {
    return {
      totalCount: testDatabasePool.totalCount,
      idleCount: testDatabasePool.idleCount,
      waitingCount: testDatabasePool.waitingCount
    }
  }
  
  // For production postgres-js client, return basic stats
  return {
    totalCount: 10, // Based on our pool configuration
    idleCount: 0,   // postgres-js doesn't expose these metrics easily
    waitingCount: 0
  }
}

/**
 * Execute raw SQL with RLS context (escape hatch for complex queries)
 * 
 * @param context User context for RLS
 * @param query SQL query to execute
 * @param params Query parameters
 * @returns Query results
 */
export async function executeRawSQL<T = any>(
  context: RLSContext,
  query: string,
  params: any[] = []
): Promise<T[]> {
  return withRLS(context, async (db) => {
    const result = await db.execute(sql.raw(query, params))
    return result.rows as T[]
  })
}

// Re-export sql template for complex queries
export { sql }