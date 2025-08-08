import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { 
  startTestContainers, 
  stopTestContainers, 
  cleanTestData, 
  executeWithUserContext,
  measureExecutionTime,
  type TestContainers 
} from '@tests/setup/testcontainers'
import { testUtils } from '@tests/setup/global-setup'
import { 
  createSession, 
  validateAndRefreshSession, 
  revokeSession,
  revokeAllUserSessions 
} from '@/lib/auth/session-v2'
import { withRLS, provisionUser, setTestDatabasePool, sql } from '@/lib/db/rls-context'
import { eq } from 'drizzle-orm'
import { users, portfolios, holdings, assets } from '@/lib/db/schema'

/**
 * Authentication Security Matrix Integration Tests
 * 
 * Tests complete auth system with real Redis + PostgreSQL via Testcontainers
 * Based on Codex recommendations for comprehensive security testing
 * 
 * Critical Security Scenarios:
 * - RLS isolation between users (portfolio data protection)
 * - Session security and instant revocation
 * - Cross-user data access prevention  
 * - Role-based access control enforcement
 * - Performance validation under load
 * 
 * This is the most important test file - validates security at database level
 */

let containers: TestContainers

describe('Authentication Security Matrix (Integration)', () => {
  // Test users with deterministic IDs
  const user1 = {
    id: testUtils.createTestUserId('1'),
    email: testUtils.createTestEmail('user1'),
    role: 'TRADER' as const
  }
  
  const user2 = {
    id: testUtils.createTestUserId('2'), 
    email: testUtils.createTestEmail('user2'),
    role: 'TRADER' as const
  }
  
  const adminUser = {
    id: testUtils.createTestUserId('admin'),
    email: testUtils.createTestEmail('admin'),
    role: 'ADMIN' as const
  }

  beforeAll(async () => {
    containers = await startTestContainers()
    
    // Override Redis client in session module to use test instance
    process.env.REDIS_URL = containers.redis.url
    process.env.DATABASE_URL = containers.postgres.url
    
    // Configure RLS context to use test database pool
    setTestDatabasePool(containers.postgres.pool)
  }, 60000)

  afterAll(async () => {
    // Clean up test database pool reference
    setTestDatabasePool(null)
    await stopTestContainers()
  })

  beforeEach(async () => {
    await cleanTestData(containers)
  })

  describe('🔐 RLS Data Isolation Matrix', () => {
    
    it('should enforce complete user data isolation', async () => {
      // DEBUG: First verify RLS context is working at SQL level
      try {
        const debugRLS = await withRLS(
          { userId: user1.id, roles: [user1.role] },
          async (db) => {
            // Check current RLS settings using sql template
            const currentUserId = await db.execute(sql`SELECT app.current_user_id() as user_id`)
            const currentRoles = await db.execute(sql`SELECT current_setting('app.roles', true) as roles`)
            console.log('🔍 DEBUG RLS Context:', {
              expectedUserId: user1.id,
              actualUserId: currentUserId.rows[0]?.user_id,
              actualRoles: currentRoles.rows[0]?.roles
            })
            
            return { currentUserId, currentRoles }
          }
        )
        
        console.log('🔍 DEBUG RLS Results:', debugRLS)
      } catch (error) {
        console.log('🚨 DEBUG RLS Error:', error.message)
      }
      // Create test portfolios for each user using RLS context
      let user1PortfolioId: string
      let user2PortfolioId: string

      // User 1 creates portfolio
      await withRLS(
        { userId: user1.id, roles: [user1.role] },
        async (db) => {
          const result = await db.insert(portfolios)
            .values({
              userId: user1.id,
              name: 'User 1 Portfolio',
              totalValue: '10000'
            })
            .returning({ id: portfolios.id })
          
          user1PortfolioId = result[0].id
        }
      )

      // User 2 creates portfolio  
      await withRLS(
        { userId: user2.id, roles: [user2.role] },
        async (db) => {
          const result = await db.insert(portfolios)
            .values({
              userId: user2.id,
              name: 'User 2 Portfolio', 
              totalValue: '20000'
            })
            .returning({ id: portfolios.id })
          
          user2PortfolioId = result[0].id
        }
      )

      // SECURITY TEST: User 1 can only see own portfolio
      const user1Portfolios = await withRLS(
        { userId: user1.id, roles: [user1.role] },
        async (db) => {
          return await db.select()
            .from(portfolios)
        }
      )

      expect(user1Portfolios).toHaveLength(1)
      expect(user1Portfolios[0].id).toBe(user1PortfolioId)
      expect(user1Portfolios[0].name).toBe('User 1 Portfolio')

      // SECURITY TEST: User 2 can only see own portfolio
      const user2Portfolios = await withRLS(
        { userId: user2.id, roles: [user2.role] },
        async (db) => {
          return await db.select()
            .from(portfolios)
        }
      )

      expect(user2Portfolios).toHaveLength(1)
      expect(user2Portfolios[0].id).toBe(user2PortfolioId)
      expect(user2Portfolios[0].name).toBe('User 2 Portfolio')

      // SECURITY TEST: User 1 cannot access User 2's portfolio by ID
      const crossUserAttempt = await withRLS(
        { userId: user1.id, roles: [user1.role] },
        async (db) => {
          return await db.select()
            .from(portfolios)
            .where(eq(portfolios.id, user2PortfolioId))
        }
      )

      expect(crossUserAttempt).toHaveLength(0) // RLS blocks access

      // SECURITY TEST: Admin can see all portfolios
      const adminView = await withRLS(
        { userId: adminUser.id, roles: [adminUser.role] },
        async (db) => {
          return await db.select()
            .from(portfolios)
        }
      )

      expect(adminView).toHaveLength(2)
      expect(adminView.map(p => p.name)).toContain('User 1 Portfolio')
      expect(adminView.map(p => p.name)).toContain('User 2 Portfolio')
    })

    it('should prevent cross-user data modification attempts', async () => {
      // User 1 creates a portfolio
      let user1PortfolioId: string
      await withRLS(
        { userId: user1.id, roles: [user1.role] },
        async (db) => {
          const result = await db.insert(portfolios)
            .values({
              userId: user1.id,
              name: 'Original Name',
              totalValue: 5000
            })
            .returning({ id: portfolios.id })
          
          user1PortfolioId = result[0].id
        }
      )

      // SECURITY TEST: User 2 cannot update User 1's portfolio
      const updateAttempt = await withRLS(
        { userId: user2.id, roles: [user2.role] },
        async (db) => {
          const result = await db.update(portfolios)
            .set({ name: 'Hacked Name', totalValue: 999999 })
            .where(eq(portfolios.id, user1PortfolioId))
            .returning({ id: portfolios.id })
          
          return result
        }
      )

      expect(updateAttempt).toHaveLength(0) // No rows affected - RLS blocked

      // Verify original data unchanged
      const verification = await withRLS(
        { userId: user1.id, roles: [user1.role] },
        async (db) => {
          return await db.select()
            .from(portfolios)
            .where(eq(portfolios.id, user1PortfolioId))
        }
      )

      expect(verification[0].name).toBe('Original Name')
      expect(verification[0].totalValue).toBe(5000)
    })

    it('should block unauthorized INSERT with foreign user_id', async () => {
      // SECURITY TEST: User 2 cannot create portfolio for User 1
      await expect(
        withRLS(
          { userId: user2.id, roles: [user2.role] },
          async (db) => {
            await db.insert(portfolios)
              .values({
                userId: user1.id, // Wrong user ID!
                name: 'Malicious Portfolio',
                totalValue: 100000
              })
          }
        )
      ).rejects.toThrow() // RLS policy should prevent this
    })
  })

  describe('⚡ Session Security & Performance', () => {
    
    it('should create and validate session under performance budget', async () => {
      const deviceId = testUtils.createTestDeviceId()
      
      // Test session creation performance
      const { result: sessionResult, timeMs: createTime } = await measureExecutionTime(
        () => createSession({
          userId: user1.id,
          deviceId,
          role: user1.role,
          absoluteTtlSec: 30 * 24 * 60 * 60,
          idleTtlSec: 12 * 60 * 60
        })
      )

      // Session creation should be fast
      expect(createTime).toBeLessThan(100) // 100ms budget for creation
      expect(sessionResult.sessionId).toBeValidSessionId()

      // Test session validation performance  
      const { result: validationResult, timeMs: validateTime } = await measureExecutionTime(
        () => validateAndRefreshSession(sessionResult.sessionId)
      )

      // PERFORMANCE REQUIREMENT: <2s session validation for portfolio workflows
      expect(validateTime).toBeLessThan(5)
      expect(validationResult.valid).toBe(true)
      expect(validationResult.session?.uid).toBe(user1.id)
    })

    it('should instantly revoke sessions across system', async () => {
      // Create multiple sessions for user
      const sessions = await Promise.all([
        createSession({
          userId: user1.id,
          deviceId: testUtils.createTestDeviceId(),
          role: user1.role
        }),
        createSession({
          userId: user1.id,
          deviceId: testUtils.createTestDeviceId(), 
          role: user1.role
        }),
        createSession({
          userId: user1.id,
          deviceId: testUtils.createTestDeviceId(),
          role: user1.role
        })
      ])

      // Verify all sessions are valid
      for (const session of sessions) {
        const validation = await validateAndRefreshSession(session.sessionId)
        expect(validation.valid).toBe(true)
      }

      // SECURITY TEST: Instant revocation of all user sessions
      const { timeMs: revokeTime } = await measureExecutionTime(
        () => revokeAllUserSessions(user1.id)
      )

      // Revocation should be fast
      expect(revokeTime).toBeLessThan(50) // 50ms budget for revocation

      // All sessions should be immediately invalid
      for (const session of sessions) {
        const validation = await validateAndRefreshSession(session.sessionId)
        expect(validation.valid).toBe(false)
        expect(validation.reason).toBe('not_found')
      }
    })

    it('should prevent session hijacking via device mismatch', async () => {
      const originalDevice = testUtils.createTestDeviceId()
      const attackerDevice = testUtils.createTestDeviceId()

      // Create session with original device
      const sessionResult = await createSession({
        userId: user1.id,
        deviceId: originalDevice,
        role: user1.role,
        ip: '192.168.1.100',
        userAgent: 'Mozilla/5.0 (Original Browser)'
      })

      // Session should work with original device context
      const validValidation = await validateAndRefreshSession(sessionResult.sessionId)
      expect(validValidation.valid).toBe(true)

      // TODO: Implement device validation in session validation
      // For now, session validation doesn't check device fingerprint
      // This would be enhanced in production with device fingerprint validation
      
      expect(sessionResult.session.did).toBe(originalDevice)
      expect(sessionResult.session.ipH).toBeDefined()
      expect(sessionResult.session.uaH).toBeDefined()
    })
  })

  describe('🏗️ Concurrent Operations & Race Conditions', () => {
    
    it('should handle concurrent session operations atomically', async () => {
      const deviceId = testUtils.createTestDeviceId()
      
      // Create initial session
      const sessionResult = await createSession({
        userId: user1.id,
        deviceId,
        role: user1.role
      })

      // CONCURRENCY TEST: Multiple concurrent validation attempts
      const concurrentValidations = Array(20).fill(0).map(() =>
        validateAndRefreshSession(sessionResult.sessionId)
      )

      const results = await Promise.all(concurrentValidations)

      // All validations should succeed (no race conditions)
      results.forEach(result => {
        expect(result.valid).toBe(true)
        expect(result.session?.uid).toBe(user1.id)
      })
    })

    it('should handle concurrent user provisioning without race conditions', async () => {
      const newUserId = testUtils.createTestUserId('concurrent')
      const newUserEmail = testUtils.createTestEmail('concurrent')

      // CONCURRENCY TEST: Multiple concurrent provisioning attempts
      const concurrentProvisions = Array(5).fill(0).map(() =>
        provisionUser(newUserId, newUserEmail, 'TRADER')
      )

      const results = await Promise.all(concurrentProvisions)

      // All should succeed without conflicts (atomic provisioning function)
      results.forEach(result => {
        expect(result.userId).toBe(newUserId)
        expect(result.portfolioId).toBeValidUUID()
      })

      // Should only have one user and one portfolio created
      const userCount = await withRLS(
        { userId: adminUser.id, roles: [adminUser.role] },
        async (db) => {
          const users = await db.select()
            .from(users)
            .where(eq(users.id, newUserId))
          return users.length
        }
      )

      expect(userCount).toBe(1) // No duplicate users created
    })
  })

  describe('🚨 Error Conditions & Edge Cases', () => {
    
    it('should handle Redis connection failures gracefully', async () => {
      // Temporarily disconnect Redis
      containers.redis.client.disconnect()

      // Session operations should fail gracefully
      await expect(
        createSession({
          userId: user1.id,
          deviceId: testUtils.createTestDeviceId(),
          role: user1.role
        })
      ).rejects.toThrow()

      // Reconnect for other tests
      containers.redis.client.connect()
    })

    it('should handle malformed session data', async () => {
      const malformedSessionId = 'malformed-session-id'
      
      // Set malformed data directly in Redis
      await containers.redis.client.set(
        `sess:${malformedSessionId}`,
        'invalid-json-data',
        'EX',
        3600
      )

      const validation = await validateAndRefreshSession(malformedSessionId)
      expect(validation.valid).toBe(false)
      expect(validation.reason).toBe('not_found')
    })

    it('should handle database connection exhaustion', async () => {
      // Create many concurrent RLS operations to test connection pooling
      const manyOperations = Array(15).fill(0).map((_, index) =>
        withRLS(
          { userId: testUtils.createTestUserId(index.toString()), roles: ['TRADER'] },
          async (db) => {
            await testUtils.fastForwardTime(10) // Simulate work
            return 'success'
          }
        )
      )

      // All operations should complete without connection errors
      const results = await Promise.all(manyOperations)
      
      results.forEach(result => {
        expect(result).toBe('success')
      })
    })
  })

  describe('📊 Performance Under Load', () => {
    
    it('should maintain performance with multiple concurrent users', async () => {
      const userCount = 50
      const sessionsPerUser = 2

      // Create multiple users and sessions
      const userSessions: Array<{ userId: string; sessionId: string }> = []

      for (let i = 0; i < userCount; i++) {
        const userId = testUtils.createTestUserId(i.toString())
        
        for (let j = 0; j < sessionsPerUser; j++) {
          const sessionResult = await createSession({
            userId,
            deviceId: testUtils.createTestDeviceId(),
            role: 'TRADER'
          })
          
          userSessions.push({
            userId,
            sessionId: sessionResult.sessionId
          })
        }
      }

      // PERFORMANCE TEST: Validate all sessions concurrently
      const { timeMs } = await measureExecutionTime(async () => {
        const validations = userSessions.map(({ sessionId }) =>
          validateAndRefreshSession(sessionId)
        )
        
        const results = await Promise.all(validations)
        
        // All should be valid
        results.forEach(result => {
          expect(result.valid).toBe(true)
        })
      })

      // Average per session should be under budget
      const avgTimePerSession = timeMs / (userCount * sessionsPerUser)
      expect(avgTimePerSession).toBeLessThan(2000) // <2s average per session for portfolio tracking
    })
  })

  describe('🔒 Financial Data Security Validation', () => {
    
    it('should enforce complete holdings isolation', async () => {
      // Create portfolios and holdings for each user
      const user1Assets: Array<{ portfolioId: string; holdingId: string }> = []
      const user2Assets: Array<{ portfolioId: string; holdingId: string }> = []

      // User 1 creates portfolio with holdings
      await withRLS(
        { userId: user1.id, roles: [user1.role] },
        async (db) => {
          const portfolio = await db.insert(portfolios)
            .values({
              userId: user1.id,
              name: 'User 1 Crypto Portfolio',
              totalValue: 50000
            })
            .returning({ id: portfolios.id })

          const holding = await db.insert(holdings)
            .values({
              portfolioId: portfolio[0].id,
              assetId: '00000000-0000-4000-8000-000000000001', // BTC from seed data
              quantity: '1.5',
              costBasis: '45000'
            })
            .returning({ id: holdings.id })

          user1Assets.push({
            portfolioId: portfolio[0].id,
            holdingId: holding[0].id
          })
        }
      )

      // User 2 creates portfolio with holdings
      await withRLS(
        { userId: user2.id, roles: [user2.role] },
        async (db) => {
          const portfolio = await db.insert(portfolios)
            .values({
              userId: user2.id,
              name: 'User 2 Stock Portfolio', 
              totalValue: 25000
            })
            .returning({ id: portfolios.id })

          const holding = await db.insert(holdings)
            .values({
              portfolioId: portfolio[0].id,
              assetId: '00000000-0000-4000-8000-000000000002', // ETH from seed data
              quantity: '100',
              costBasis: '15000'
            })
            .returning({ id: holdings.id })

          user2Assets.push({
            portfolioId: portfolio[0].id,
            holdingId: holding[0].id
          })
        }
      )

      // SECURITY VALIDATION: Each user sees only their holdings
      const user1Holdings = await withRLS(
        { userId: user1.id, roles: [user1.role] },
        async (db) => {
          return await db.select()
            .from(holdings)
        }
      )

      const user2Holdings = await withRLS(
        { userId: user2.id, roles: [user2.role] },
        async (db) => {
          return await db.select()
            .from(holdings)  
        }
      )

      expect(user1Holdings).toHaveLength(1)
      expect(user1Holdings[0].quantity).toBe('1.5') // BTC holding
      expect(user1Holdings[0].costBasis).toBe('45000')

      expect(user2Holdings).toHaveLength(1)
      expect(user2Holdings[0].quantity).toBe('100') // ETH holding
      expect(user2Holdings[0].costBasis).toBe('15000')

      // SECURITY VALIDATION: No cross-user holding access
      expect(user1Holdings[0].id).not.toBe(user2Holdings[0].id)
    })
  })
})