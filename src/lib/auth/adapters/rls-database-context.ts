import type { 
  DatabaseContext, 
  UserContext, 
  DatabaseClient,
  PoolStats,
  UserRole 
} from '../ports'
import { 
  withRLS, 
  withSystemContext, 
  withAdminContext,
  getPoolStats as getDbPoolStats,
  type RLSContext 
} from '@/lib/db/rls-context'

/**
 * Row Level Security implementation of DatabaseContext port
 * 
 * Wraps the existing RLS context functionality in clean interface
 * for dependency injection and testing. Based on Codex recommendations
 * for production-grade financial application security.
 * 
 * This adapter provides:
 * - User-scoped database operations with RLS enforcement
 * - System-level operations for administrative tasks
 * - Admin operations with elevated privileges
 * - Connection pool management and monitoring
 * 
 * All operations are atomic and use dedicated database transactions
 * for data consistency and security isolation.
 */
export class RLSDatabaseContext implements DatabaseContext {
  
  /**
   * Execute operation with user RLS context
   * 
   * This is the primary method for user-facing operations.
   * All queries executed within this context are automatically
   * filtered by PostgreSQL Row Level Security policies.
   * 
   * @param context User ID and roles for RLS enforcement
   * @param operation Database operation to execute
   * @returns Result of the database operation
   */
  async withUserContext<T>(
    context: UserContext,
    operation: (db: DatabaseClient) => Promise<T>
  ): Promise<T> {
    try {
      const rlsContext: RLSContext = {
        userId: context.userId,
        roles: context.roles as ('TRADER' | 'COACH' | 'ADMIN' | 'SYSTEM')[]
      }
      
      return await withRLS(rlsContext, operation)
      
    } catch (error) {
      console.error('DatabaseContext.withUserContext error:', error)
      throw new Error(`User context operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }
  
  /**
   * Execute operation with system privileges
   * 
   * ⚠️ SECURITY WARNING: Only use for system operations, never for user requests
   * 
   * Use cases:
   * - Price data ingestion
   * - Background jobs and maintenance
   * - User provisioning during authentication
   * - Database migrations and schema updates
   * 
   * @param operation Database operation to execute with SYSTEM role
   * @returns Result of the database operation
   */
  async withSystemContext<T>(
    operation: (db: DatabaseClient) => Promise<T>
  ): Promise<T> {
    try {
      return await withSystemContext(operation)
      
    } catch (error) {
      console.error('DatabaseContext.withSystemContext error:', error)
      throw new Error(`System context operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }
  
  /**
   * Execute operation with admin context
   * 
   * Use cases:
   * - Administrative dashboards
   * - User management operations
   * - Cross-user reporting and analytics
   * - System monitoring and health checks
   * 
   * @param adminUserId The ID of the admin user performing the operation
   * @param operation Database operation to execute with ADMIN role
   * @returns Result of the database operation
   */
  async withAdminContext<T>(
    adminUserId: string,
    operation: (db: DatabaseClient) => Promise<T>
  ): Promise<T> {
    try {
      return await withAdminContext(adminUserId, operation)
      
    } catch (error) {
      console.error('DatabaseContext.withAdminContext error:', error)
      throw new Error(`Admin context operation failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }
  
  /**
   * Get connection pool statistics
   * 
   * Useful for:
   * - Monitoring database performance
   * - Debugging connection issues
   * - Capacity planning
   * - Health checks
   * 
   * @returns Current connection pool statistics
   */
  getPoolStats(): PoolStats {
    try {
      const stats = getDbPoolStats()
      
      return {
        totalCount: stats.totalCount,
        idleCount: stats.idleCount,
        waitingCount: stats.waitingCount
      }
      
    } catch (error) {
      console.error('DatabaseContext.getPoolStats error:', error)
      
      // Return safe defaults if stats unavailable
      return {
        totalCount: 0,
        idleCount: 0,
        waitingCount: 0
      }
    }
  }
  
  /**
   * Test database connectivity and RLS policies
   * 
   * Verifies:
   * - Database connection is working
   * - RLS policies are active and functioning
   * - Connection pool is healthy
   * - System can execute all context types
   * 
   * @returns Health check results
   */
  async healthCheck(): Promise<{
    connected: boolean
    rlsActive: boolean
    poolHealthy: boolean
    systemContextWorking: boolean
    adminContextWorking: boolean
    latency?: number
    error?: string
  }> {
    try {
      const start = Date.now()
      
      // Test system context
      let systemContextWorking = false
      try {
        await this.withSystemContext(async (db) => {
          await db.execute('SELECT 1')
        })
        systemContextWorking = true
      } catch (error) {
        console.error('System context test failed:', error)
      }
      
      // Test admin context with system user ID
      let adminContextWorking = false
      try {
        await this.withAdminContext('00000000-0000-0000-0000-000000000000', async (db) => {
          await db.execute('SELECT 1')
        })
        adminContextWorking = true
      } catch (error) {
        console.error('Admin context test failed:', error)
      }
      
      // Test RLS is active
      let rlsActive = false
      try {
        await this.withSystemContext(async (db) => {
          await db.execute('SELECT app.test_rls_active()')
        })
        rlsActive = true
      } catch (error) {
        console.error('RLS test failed:', error)
      }
      
      // Check pool health
      const poolStats = this.getPoolStats()
      const poolHealthy = poolStats.totalCount > 0
      
      const latency = Date.now() - start
      const connected = systemContextWorking || adminContextWorking
      
      return {
        connected,
        rlsActive,
        poolHealthy,
        systemContextWorking,
        adminContextWorking,
        latency
      }
      
    } catch (error) {
      return {
        connected: false,
        rlsActive: false,
        poolHealthy: false,
        systemContextWorking: false,
        adminContextWorking: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }
  
  /**
   * Execute raw SQL with user context (escape hatch for complex queries)
   * 
   * Use sparingly - prefer using the Drizzle ORM where possible
   * for type safety and query building.
   * 
   * @param context User context for RLS
   * @param query SQL query to execute
   * @param params Query parameters
   * @returns Query results
   */
  async executeRaw<T = any>(
    context: UserContext,
    query: string,
    params: any[] = []
  ): Promise<T[]> {
    try {
      return await this.withUserContext(context, async (db) => {
        const result = await db.execute(query, params)
        return result as T[]
      })
      
    } catch (error) {
      console.error('DatabaseContext.executeRaw error:', error)
      throw new Error(`Raw SQL execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }
  
  /**
   * Begin a transaction within user context
   * 
   * All operations within the transaction will maintain the same
   * RLS context and can be atomically committed or rolled back.
   * 
   * Note: The underlying withUserContext already provides transaction
   * semantics, but this method makes it explicit for complex operations.
   * 
   * @param context User context for RLS
   * @param operation Transaction operations to execute
   * @returns Result of the transaction
   */
  async transaction<T>(
    context: UserContext,
    operation: (db: DatabaseClient) => Promise<T>
  ): Promise<T> {
    // withUserContext already provides transaction semantics
    // This is a semantic wrapper for clarity in complex operations
    return this.withUserContext(context, operation)
  }
  
  /**
   * Get database version and configuration info
   * 
   * Useful for:
   * - Compatibility checks
   * - Feature detection
   * - Debugging configuration issues
   * 
   * @returns Database version and configuration information
   */
  async getDbInfo(): Promise<{
    version: string
    rlsEnabled: boolean
    extensions: string[]
    settings: Record<string, string>
  }> {
    try {
      return await this.withSystemContext(async (db) => {
        // Get PostgreSQL version
        const versionResult = await db.execute('SELECT version()')
        const version = versionResult[0]?.version || 'Unknown'
        
        // Check if RLS is enabled
        const rlsResult = await db.execute(
          'SELECT setting FROM pg_settings WHERE name = \'row_security\''
        )
        const rlsEnabled = rlsResult[0]?.setting === 'on'
        
        // Get installed extensions
        const extensionsResult = await db.execute(
          'SELECT extname FROM pg_extension ORDER BY extname'
        )
        const extensions = extensionsResult.map((row: any) => row.extname)
        
        // Get relevant settings
        const settingsResult = await db.execute(`
          SELECT name, setting 
          FROM pg_settings 
          WHERE name IN ('max_connections', 'shared_buffers', 'work_mem')
          ORDER BY name
        `)
        const settings: Record<string, string> = {}
        settingsResult.forEach((row: any) => {
          settings[row.name] = row.setting
        })
        
        return {
          version,
          rlsEnabled,
          extensions,
          settings
        }
      })
      
    } catch (error) {
      console.error('DatabaseContext.getDbInfo error:', error)
      return {
        version: 'Unknown',
        rlsEnabled: false,
        extensions: [],
        settings: {}
      }
    }
  }
}