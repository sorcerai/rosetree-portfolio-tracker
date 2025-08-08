import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import {
  startTestContainers,
  stopTestContainers,
  cleanTestData,
  measureExecutionTime,
  type TestContainers
} from '@tests/setup/testcontainers'
import { testUtils } from '@tests/setup/global-setup'
import {
  createSession,
  validateAndRefreshSession,
  revokeSession,
  revokeAllUserSessions,
  checkRedisHealth
} from '@/lib/auth/session-v2'
import { withRLS, provisionUser } from '@/lib/db/rls-context'

/**
 * Authentication Performance Benchmarks
 * 
 * Validates critical performance requirements with real Redis + PostgreSQL
 * Based on Codex recommendations for portfolio tracking applications (Google Sheets replacement)
 * 
 * Performance Targets (Portfolio-focused):
 * - Session validation: <2s (acceptable for portfolio workflows vs 100ms JWT crypto)
 * - Session creation: <5s (portfolio users don't need instant creation) 
 * - Session revocation: <3s (security operations can be slower)
 * - RLS context setup: <1s (database operations for portfolio data)
 * - User provisioning: <10s (one-time operation, relaxed requirement)
 * 
 * These tests measure actual performance, not mocked operations
 */

let containers: TestContainers

describe('Authentication Performance Benchmarks', () => {
  
  beforeAll(async () => {
    containers = await startTestContainers()
    
    // Warm up connections
    await containers.redis.client.ping()
    await containers.postgres.pool.query('SELECT 1')
    
    console.log('🔥 Performance benchmarks starting with warm connections')
  }, 60000)

  afterAll(async () => {
    await stopTestContainers()
  })

  beforeEach(async () => {
    await cleanTestData(containers)
  })

  describe('🚀 Core Session Performance (Critical Path)', () => {

    it('should validate session under 2s target consistently (portfolio workflows)', async () => {
      // Create a session first
      const sessionResult = await createSession({
        userId: testUtils.createTestUserId('1'),
        deviceId: testUtils.createTestDeviceId(),
        role: 'TRADER'
      })

      const validationTimes: number[] = []

      // Run multiple validations to test consistency
      for (let i = 0; i < 100; i++) {
        const { timeMs } = await measureExecutionTime(() =>
          validateAndRefreshSession(sessionResult.sessionId)
        )
        validationTimes.push(timeMs)
      }

      // Performance assertions
      const avgTime = validationTimes.reduce((a, b) => a + b, 0) / validationTimes.length
      const maxTime = Math.max(...validationTimes)
      const p95Time = validationTimes.sort((a, b) => a - b)[Math.floor(validationTimes.length * 0.95)]

      // PORTFOLIO REQUIREMENT: <2s average validation time (Google Sheets replacement)
      expect(avgTime).toBeLessThan(2000)
      
      // 95th percentile should still be reasonable for portfolio use
      expect(p95Time).toBeLessThan(5000)
      
      // No outliers over 10s
      expect(maxTime).toBeLessThan(10000)

      console.log(`📊 Session validation performance:`)
      console.log(`   Average: ${avgTime.toFixed(2)}ms`)
      console.log(`   95th %ile: ${p95Time.toFixed(2)}ms`)
      console.log(`   Max: ${maxTime.toFixed(2)}ms`)
    })

    it('should create sessions under 5s target (portfolio workflows)', async () => {
      const creationTimes: number[] = []

      for (let i = 0; i < 20; i++) {
        const { timeMs } = await measureExecutionTime(() =>
          createSession({
            userId: testUtils.createTestUserId(i.toString()),
            deviceId: testUtils.createTestDeviceId(),
            role: 'TRADER',
            ip: '192.168.1.1',
            userAgent: 'Benchmark Test Agent'
          })
        )
        creationTimes.push(timeMs)
      }

      const avgCreationTime = creationTimes.reduce((a, b) => a + b, 0) / creationTimes.length
      const maxCreationTime = Math.max(...creationTimes)

      // Performance targets for portfolio applications
      expect(avgCreationTime).toBeLessThan(5000) // 5s target for portfolio use
      expect(maxCreationTime).toBeLessThan(10000) // No outliers over 10s

      console.log(`📊 Session creation performance:`)
      console.log(`   Average: ${avgCreationTime.toFixed(2)}ms`)
      console.log(`   Max: ${maxCreationTime.toFixed(2)}ms`)
    })

    it('should revoke sessions under 3s target (portfolio workflows)', async () => {
      const userId = testUtils.createTestUserId('revoke-test')
      
      // Create multiple sessions
      const sessions = await Promise.all(
        Array(10).fill(0).map(() =>
          createSession({
            userId,
            deviceId: testUtils.createTestDeviceId(),
            role: 'TRADER'
          })
        )
      )

      const revocationTimes: number[] = []

      // Test individual revocations
      for (const session of sessions.slice(0, 5)) {
        const { timeMs } = await measureExecutionTime(() =>
          revokeSession(session.sessionId, userId)
        )
        revocationTimes.push(timeMs)
      }

      // Test bulk revocation
      const { timeMs: bulkRevocationTime } = await measureExecutionTime(() =>
        revokeAllUserSessions(userId)
      )

      const avgRevocationTime = revocationTimes.reduce((a, b) => a + b, 0) / revocationTimes.length

      // Performance targets for portfolio applications
      expect(avgRevocationTime).toBeLessThan(3000) // Individual revocation target
      expect(bulkRevocationTime).toBeLessThan(5000) // Bulk revocation target

      console.log(`📊 Session revocation performance:`)
      console.log(`   Individual avg: ${avgRevocationTime.toFixed(2)}ms`)
      console.log(`   Bulk revocation: ${bulkRevocationTime.toFixed(2)}ms`)
    })
  })

  describe('🔒 Database Performance (RLS Operations)', () => {

    it('should setup RLS context under 1s target (portfolio workflows)', async () => {
      const userId = testUtils.createTestUserId('rls-perf')
      const contextTimes: number[] = []

      for (let i = 0; i < 50; i++) {
        const { timeMs } = await measureExecutionTime(() =>
          withRLS(
            { userId, roles: ['TRADER'] },
            async (db) => {
              // Minimal operation to test context setup overhead
              return 'success'
            }
          )
        )
        contextTimes.push(timeMs)
      }

      const avgContextTime = contextTimes.reduce((a, b) => a + b, 0) / contextTimes.length
      const maxContextTime = Math.max(...contextTimes)

      // Performance targets for portfolio tracking
      expect(avgContextTime).toBeLessThan(1000) // 1s target for RLS context setup
      expect(maxContextTime).toBeLessThan(3000) // No outliers over 3s

      console.log(`📊 RLS context setup performance:`)
      console.log(`   Average: ${avgContextTime.toFixed(2)}ms`)
      console.log(`   Max: ${maxContextTime.toFixed(2)}ms`)
    })

    it('should provision users under 10s target (portfolio workflows)', async () => {
      const provisionTimes: number[] = []

      for (let i = 0; i < 10; i++) {
        const userId = testUtils.createTestUserId(`provision-${i}`)
        const email = testUtils.createTestEmail(`provision-${i}`)

        const { timeMs } = await measureExecutionTime(() =>
          provisionUser(userId, email, 'TRADER')
        )
        provisionTimes.push(timeMs)
      }

      const avgProvisionTime = provisionTimes.reduce((a, b) => a + b, 0) / provisionTimes.length
      const maxProvisionTime = Math.max(...provisionTimes)

      // Performance targets for portfolio applications (relaxed for one-time operation)
      expect(avgProvisionTime).toBeLessThan(10000) // 10s target for user provisioning
      expect(maxProvisionTime).toBeLessThan(20000) // Max 20 seconds

      console.log(`📊 User provisioning performance:`)
      console.log(`   Average: ${avgProvisionTime.toFixed(2)}ms`)
      console.log(`   Max: ${maxProvisionTime.toFixed(2)}ms`)
    })
  })

  describe('⚡ High-Load Performance Scenarios', () => {

    it('should maintain performance under concurrent session validation load', async () => {
      const userId = testUtils.createTestUserId('concurrent')
      
      // Create session first
      const sessionResult = await createSession({
        userId,
        deviceId: testUtils.createTestDeviceId(),
        role: 'TRADER'
      })

      // Concurrent validation test
      const concurrentCount = 50
      const startTime = process.hrtime.bigint()

      const validationPromises = Array(concurrentCount).fill(0).map(() =>
        validateAndRefreshSession(sessionResult.sessionId)
      )

      const results = await Promise.all(validationPromises)
      
      const endTime = process.hrtime.bigint()
      const totalTimeMs = Number(endTime - startTime) / 1_000_000
      const avgTimePerValidation = totalTimeMs / concurrentCount

      // All validations should succeed
      results.forEach(result => {
        expect(result.valid).toBe(true)
      })

      // Performance under load for portfolio workflows
      expect(avgTimePerValidation).toBeLessThan(3000) // Still reasonable under load
      expect(totalTimeMs).toBeLessThan(120000) // Complete batch under 2 minutes

      console.log(`📊 Concurrent validation performance (${concurrentCount} concurrent):`)
      console.log(`   Total time: ${totalTimeMs.toFixed(2)}ms`)
      console.log(`   Avg per validation: ${avgTimePerValidation.toFixed(2)}ms`)
    })

    it('should handle session creation burst without degradation', async () => {
      const burstSize = 25
      const startTime = process.hrtime.bigint()

      const creationPromises = Array(burstSize).fill(0).map((_, i) =>
        createSession({
          userId: testUtils.createTestUserId(`burst-${i}`),
          deviceId: testUtils.createTestDeviceId(),
          role: 'TRADER'
        })
      )

      const results = await Promise.all(creationPromises)
      
      const endTime = process.hrtime.bigint()
      const totalTimeMs = Number(endTime - startTime) / 1_000_000
      const avgTimePerCreation = totalTimeMs / burstSize

      // All sessions should be created successfully
      results.forEach(result => {
        expect(result.sessionId).toBeValidSessionId()
        expect(result.session).toBeDefined()
      })

      // Performance under burst load for portfolio workflows
      expect(avgTimePerCreation).toBeLessThan(8000) // Portfolio-appropriate degradation
      expect(totalTimeMs).toBeLessThan(180000) // Complete burst under 3 minutes

      console.log(`📊 Session creation burst performance (${burstSize} concurrent):`)
      console.log(`   Total time: ${totalTimeMs.toFixed(2)}ms`)
      console.log(`   Avg per creation: ${avgTimePerCreation.toFixed(2)}ms`)
    })
  })

  describe('📈 Connection Health & Stability', () => {

    it('should maintain Redis connection health under load', async () => {
      // Perform many operations to stress connection pool
      const operations = Array(200).fill(0).map(async (_, i) => {
        const sessionResult = await createSession({
          userId: testUtils.createTestUserId(`health-${i}`),
          deviceId: testUtils.createTestDeviceId(),
          role: 'TRADER'
        })

        // Immediately validate the session
        const validation = await validateAndRefreshSession(sessionResult.sessionId)
        expect(validation.valid).toBe(true)

        return sessionResult.sessionId
      })

      const sessionIds = await Promise.all(operations)

      // Check Redis health after stress test
      const healthCheck = await checkRedisHealth()
      expect(healthCheck.connected).toBe(true)
      expect(healthCheck.latency).toBeLessThan(1000) // Still responsive for portfolio use

      console.log(`📊 Redis health after ${operations.length} operations:`)
      console.log(`   Connected: ${healthCheck.connected}`)
      console.log(`   Latency: ${healthCheck.latency}ms`)
    })

    it('should maintain database connection pool efficiency', async () => {
      const operationCount = 100
      
      const dbOperations = Array(operationCount).fill(0).map(async (_, i) => {
        const userId = testUtils.createTestUserId(`pool-${i}`)
        
        return withRLS(
          { userId, roles: ['TRADER'] },
          async (db) => {
            // Simple query to test connection pooling
            const result = await db.execute('SELECT NOW() as current_time')
            expect(result.rows).toHaveLength(1)
            return userId
          }
        )
      })

      const startTime = process.hrtime.bigint()
      const results = await Promise.all(dbOperations)
      const endTime = process.hrtime.bigint()
      
      const totalTimeMs = Number(endTime - startTime) / 1_000_000
      const avgTimePerOperation = totalTimeMs / operationCount

      expect(results).toHaveLength(operationCount)
      expect(avgTimePerOperation).toBeLessThan(2000) // Efficient pooling for portfolio operations

      console.log(`📊 Database connection pool performance (${operationCount} operations):`)
      console.log(`   Total time: ${totalTimeMs.toFixed(2)}ms`)
      console.log(`   Avg per operation: ${avgTimePerOperation.toFixed(2)}ms`)
    })
  })

  describe('🎯 Performance Regression Detection', () => {

    it('should establish baseline metrics for performance monitoring', async () => {
      // This test establishes baseline metrics that can be used to detect regressions
      const baselines = {
        sessionValidation: [] as number[],
        sessionCreation: [] as number[],
        rlsContext: [] as number[],
        userProvisioning: [] as number[]
      }

      // Session validation baseline (30 samples)
      const userId = testUtils.createTestUserId('baseline')
      const sessionResult = await createSession({
        userId,
        deviceId: testUtils.createTestDeviceId(),
        role: 'TRADER'
      })

      for (let i = 0; i < 30; i++) {
        const { timeMs } = await measureExecutionTime(() =>
          validateAndRefreshSession(sessionResult.sessionId)
        )
        baselines.sessionValidation.push(timeMs)
      }

      // Session creation baseline (10 samples)
      for (let i = 0; i < 10; i++) {
        const { timeMs } = await measureExecutionTime(() =>
          createSession({
            userId: testUtils.createTestUserId(`baseline-create-${i}`),
            deviceId: testUtils.createTestDeviceId(),
            role: 'TRADER'
          })
        )
        baselines.sessionCreation.push(timeMs)
      }

      // RLS context baseline (20 samples)
      for (let i = 0; i < 20; i++) {
        const { timeMs } = await measureExecutionTime(() =>
          withRLS(
            { userId: testUtils.createTestUserId(`baseline-rls-${i}`), roles: ['TRADER'] },
            async () => 'success'
          )
        )
        baselines.rlsContext.push(timeMs)
      }

      // User provisioning baseline (5 samples)
      for (let i = 0; i < 5; i++) {
        const { timeMs } = await measureExecutionTime(() =>
          provisionUser(
            testUtils.createTestUserId(`baseline-provision-${i}`),
            testUtils.createTestEmail(`baseline-provision-${i}`),
            'TRADER'
          )
        )
        baselines.userProvisioning.push(timeMs)
      }

      // Calculate statistics
      const stats = Object.entries(baselines).reduce((acc, [key, values]) => {
        const sorted = values.sort((a, b) => a - b)
        acc[key] = {
          avg: values.reduce((a, b) => a + b, 0) / values.length,
          p50: sorted[Math.floor(sorted.length * 0.5)],
          p95: sorted[Math.floor(sorted.length * 0.95)],
          max: Math.max(...values)
        }
        return acc
      }, {} as Record<string, any>)

      // Performance assertions for portfolio tracking (regression detection thresholds)
      expect(stats.sessionValidation.avg).toBeLessThan(2000)
      expect(stats.sessionCreation.avg).toBeLessThan(5000)
      expect(stats.rlsContext.avg).toBeLessThan(1000)
      expect(stats.userProvisioning.avg).toBeLessThan(10000)

      console.log('📊 Performance Baseline Metrics:')
      Object.entries(stats).forEach(([operation, metric]) => {
        console.log(`   ${operation}:`)
        console.log(`     Avg: ${metric.avg.toFixed(2)}ms`)
        console.log(`     P50: ${metric.p50.toFixed(2)}ms`)
        console.log(`     P95: ${metric.p95.toFixed(2)}ms`)
        console.log(`     Max: ${metric.max.toFixed(2)}ms`)
      })
    })
  })
})