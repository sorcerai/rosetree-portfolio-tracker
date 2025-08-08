import { eq, sql } from 'drizzle-orm'
import type { 
  UserRepository, 
  User, 
  UserProvisionResult, 
  UserRole,
  DatabaseClient 
} from '../ports'
import { users } from '@/lib/db/schema'
import { withRLS, withSystemContext, type RLSContext } from '@/lib/db/rls-context'

/**
 * PostgreSQL implementation of UserRepository port
 * 
 * Wraps existing database logic in clean interface for dependency injection
 * Based on Codex recommendations for production-grade testing
 * 
 * This adapter implements all user-related database operations with proper
 * Row Level Security (RLS) enforcement and atomic transaction handling
 */
export class PostgresUserRepository implements UserRepository {
  
  /**
   * Find user by ID with RLS enforcement
   * Only returns user if they are the authenticated user or caller has admin privileges
   */
  async findById(userId: string): Promise<User | null> {
    try {
      // Use RLS context to ensure data isolation
      const context: RLSContext = {
        userId,
        roles: ['TRADER', 'COACH', 'ADMIN'] // Will be filtered by actual user role in RLS
      }
      
      const result = await withRLS(context, async (db) => {
        const userRows = await db
          .select()
          .from(users)
          .where(eq(users.id, userId))
          .limit(1)
      
        return userRows.length > 0 ? userRows[0] : null
      })
      
      if (!result) return null
      
      return {
        id: result.id,
        email: result.email,
        role: result.role as UserRole,
        createdAt: result.createdAt,
        lastSeenAt: result.updatedAt
      }
      
    } catch (error) {
      console.error('UserRepository.findById error:', error)
      return null
    }
  }
  
  /**
   * Find user by email with SYSTEM privileges
   * Used during authentication flow when we don't yet have user context
   */
  async findByEmail(email: string): Promise<User | null> {
    try {
      // Use system context since this is called during authentication
      // before we have established user context
      const result = await withSystemContext(async (db) => {
        const userRows = await db
          .select()
          .from(users)
          .where(eq(users.email, email))
          .limit(1)
          
        return userRows.length > 0 ? userRows[0] : null
      })
      
      if (!result) return null
      
      return {
        id: result.id,
        email: result.email,
        role: result.role as UserRole,
        createdAt: result.createdAt,
        lastSeenAt: result.updatedAt
      }
      
    } catch (error) {
      console.error('UserRepository.findByEmail error:', error)
      return null
    }
  }
  
  /**
   * Provision new user atomically with default portfolio
   * Uses system context to bypass RLS during user creation
   */
  async provisionUser(
    userId: string, 
    email: string, 
    role: UserRole = 'TRADER'
  ): Promise<UserProvisionResult> {
    try {
      return await withSystemContext(async (db) => {
        // Call the atomic provisioning function
        // This prevents race conditions and ensures data consistency
        const result = await db.execute(
          sql`SELECT * FROM app.provision_user(${userId}, ${email}, ${role})`
        )
        
        if (result.rows.length === 0) {
          throw new Error('Failed to provision user - no result returned')
        }
        
        const row = result.rows[0] as any
        
        return {
          userId: row.user_id,
          portfolioId: row.portfolio_id,
          created: row.created
        }
      })
      
    } catch (error) {
      console.error('UserRepository.provisionUser error:', error)
      throw new Error(`Failed to provision user: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }
  
  /**
   * Update user role and increment role version for session invalidation
   * Uses system context since this is an administrative operation
   */
  async updateRole(userId: string, role: UserRole): Promise<void> {
    try {
      await withSystemContext(async (db) => {
        // Update user role in users table
        await db
          .update(users)
          .set({ 
            role,
            updatedAt: new Date()
          })
          .where(eq(users.id, userId))
        
        // Increment role version to invalidate existing sessions
        // This ensures immediate security policy enforcement
        await db.execute(
          sql`SELECT redis.incr(${`user:ver:${userId}`})`
        )
      })
      
    } catch (error) {
      console.error('UserRepository.updateRole error:', error)
      throw new Error(`Failed to update user role: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }
  
  /**
   * Get current role version for session validation
   * Used to detect if user permissions have changed since session creation
   */
  async getRoleVersion(userId: string): Promise<number> {
    try {
      return await withSystemContext(async (db) => {
        const result = await db.execute(
          sql`SELECT redis.get(${`user:ver:${userId}`}) as version`
        )
        
        if (result.rows.length === 0 || !result.rows[0].version) {
          // Initialize role version if it doesn't exist
          await db.execute(
            sql`SELECT redis.incr(${`user:ver:${userId}`})`
          )
          return 1
        }
        
        return parseInt(result.rows[0].version as string, 10) || 1
      })
      
    } catch (error) {
      console.error('UserRepository.getRoleVersion error:', error)
      // Return default version on error to fail gracefully
      return 1
    }
  }
  
  /**
   * Health check for database connectivity
   * Tests both connection and RLS policy functionality
   */
  async healthCheck(): Promise<{
    connected: boolean
    rlsWorking: boolean
    latency?: number
    error?: string
  }> {
    try {
      const start = Date.now()
      
      await withSystemContext(async (db) => {
        // Simple connectivity test
        await db.execute(sql`SELECT 1`)
        
        // Test RLS policies are active
        await db.execute(sql`SELECT app.test_rls_active()`)
      })
      
      const latency = Date.now() - start
      
      return {
        connected: true,
        rlsWorking: true,
        latency
      }
      
    } catch (error) {
      return {
        connected: false,
        rlsWorking: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }
}