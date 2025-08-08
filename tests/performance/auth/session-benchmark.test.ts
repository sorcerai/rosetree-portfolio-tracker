import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestContainers, stopTestContainers, type TestContainers } from '@tests/setup/testcontainers'
import { createSession, validateAndRefreshSession, revokeSession } from '@/lib/auth/session-v2'
import { runSessionPerformanceBenchmark, getSessionPerformanceReport } from '@/lib/auth/session-monitoring'
import { testUtils } from '@tests/setup/global-setup'

/**
 * 🏁 SESSION PERFORMANCE BENCHMARK TESTS
 * 
 * These tests validate that our Redis session validation optimizations
 * meet portfolio tracking performance targets (Google Sheets replacement).
 * Portfolio apps prioritize reliability and reasonable response times (1-5s acceptable).
 * 
 * Benchmarks include:
 * - Single session validation timing for portfolio workflows
 * - Concurrent session validation under typical portfolio load
 * - Performance regression detection for portfolio use cases
 * - Redis pipeline optimization verification
 * - Memory usage and connection pool efficiency
 */

let containers: TestContainers

describe('Session Performance Benchmarks', () => {
  
  beforeAll(async () => {
    console.log('🚀 Starting containers for performance benchmarking...')
    containers = await startTestContainers()
    
    // Use test Redis for benchmarking
    process.env.REDIS_URL = containers.redis.url
  }, 60000)

  afterAll(async () => {
    if (containers) {
      await stopTestContainers()
    }
  })

  beforeEach(async () => {
    // Clear Redis for clean benchmark
    await containers.redis.client.flushdb()
  })

  describe('Single Session Validation Performance', () => {

    it('should validate session within portfolio tracking targets (<2s consistently)', async () => {
      // Create test session
      const { sessionId } = await createSession({
        userId: testUtils.createTestUserId('perf-test'),
        deviceId: testUtils.createTestDeviceId(),
        role: 'TRADER'
      })

      const iterations = 50
      const timings: number[] = []
      
      console.log(`🔥 Running ${iterations} single validation tests...`)

      for (let i = 0; i < iterations; i++) {
        const startTime = process.hrtime.bigint()
        
        const result = await validateAndRefreshSession(sessionId)
        
        const endTime = process.hrtime.bigint()
        const durationMs = Number(endTime - startTime) / 1_000_000
        
        timings.push(durationMs)
        
        expect(result.valid).toBe(true)
        expect(result.session).toBeDefined()
      }

      // Calculate statistics
      const avgTime = timings.reduce((sum, time) => sum + time, 0) / timings.length
      const maxTime = Math.max(...timings)
      const minTime = Math.min(...timings)
      const p95Time = timings.sort((a, b) => a - b)[Math.floor(timings.length * 0.95)]
      
      console.log(`📊 Single Validation Performance:`)
      console.log(`   Average: ${avgTime.toFixed(2)}ms`)
      console.log(`   Min: ${minTime.toFixed(2)}ms`)
      console.log(`   Max: ${maxTime.toFixed(2)}ms`)
      console.log(`   P95: ${p95Time.toFixed(2)}ms`)

      // Performance assertions for portfolio tracking (Google Sheets replacement)
      expect(avgTime).toBeLessThan(2000) // Average must be <2s (portfolio target)
      expect(p95Time).toBeLessThan(5000) // 95% of requests must be <5s
      expect(maxTime).toBeLessThan(10000) // No single request >10s (allows for GC/network spikes)
      
      // Count slow validations (>2s portfolio threshold)
      const slowValidations = timings.filter(time => time > 2000).length
      const slowPercentage = (slowValidations / timings.length) * 100
      
      console.log(`   Slow validations (>2s): ${slowValidations}/${timings.length} (${slowPercentage.toFixed(1)}%)`)
      
      // Less than 10% of validations should be slow for portfolio use
      expect(slowPercentage).toBeLessThan(10)
    })

    it('should handle role version checks efficiently', async () => {
      // Create session with role version tracking
      const { sessionId } = await createSession({
        userId: testUtils.createTestUserId('role-perf-test'),
        deviceId: testUtils.createTestDeviceId(),
        role: 'ADMIN'
      })

      const iterations = 30
      const timings: number[] = []

      for (let i = 0; i < iterations; i++) {
        const startTime = process.hrtime.bigint()
        
        const result = await validateAndRefreshSession(sessionId)
        
        const endTime = process.hrtime.bigint()
        const durationMs = Number(endTime - startTime) / 1_000_000
        
        timings.push(durationMs)
        
        expect(result.valid).toBe(true)
        expect(result.session?.role).toBe('ADMIN')
      }

      const avgTime = timings.reduce((sum, time) => sum + time, 0) / timings.length
      
      console.log(`📊 Role Version Check Performance: ${avgTime.toFixed(2)}ms average`)
      
      // Role version checks should not significantly impact portfolio performance
      expect(avgTime).toBeLessThan(2000) // Portfolio-appropriate threshold
    })
  })

  describe('Concurrent Session Validation Performance', () => {

    it('should handle concurrent validations efficiently', async () => {
      const concurrency = 20
      const sessions = []

      // Create multiple test sessions
      for (let i = 0; i < concurrency; i++) {
        const { sessionId } = await createSession({
          userId: testUtils.createTestUserId(`concurrent-user-${i}`),
          deviceId: testUtils.createTestDeviceId(),
          role: 'TRADER'
        })
        sessions.push(sessionId)
      }

      const startTime = process.hrtime.bigint()
      
      // Execute all validations concurrently
      const results = await Promise.all(
        sessions.map(sessionId => validateAndRefreshSession(sessionId))
      )
      
      const endTime = process.hrtime.bigint()
      const totalTimeMs = Number(endTime - startTime) / 1_000_000
      const avgTimePerRequest = totalTimeMs / concurrency

      console.log(`📊 Concurrent Performance (${concurrency} sessions):`)
      console.log(`   Total time: ${totalTimeMs.toFixed(2)}ms`)
      console.log(`   Average per request: ${avgTimePerRequest.toFixed(2)}ms`)
      console.log(`   Throughput: ${((concurrency / totalTimeMs) * 1000).toFixed(0)} requests/sec`)

      // Verify all validations succeeded
      results.forEach((result, i) => {
        expect(result.valid).toBe(true)
        expect(result.session?.uid).toBe(testUtils.createTestUserId(`concurrent-user-${i}`))
      })

      // Performance assertions for portfolio workflows
      expect(avgTimePerRequest).toBeLessThan(3000) // Portfolio target: <3s per request under load
      expect(totalTimeMs).toBeLessThan(60000) // Total time should be reasonable for portfolio use (1 minute)
    })

    it('should maintain performance under Redis connection pressure', async () => {
      // Create many sessions to stress test Redis connections
      const sessionCount = 50
      const sessionIds: string[] = []

      for (let i = 0; i < sessionCount; i++) {
        const { sessionId } = await createSession({
          userId: testUtils.createTestUserId(`stress-user-${i}`),
          deviceId: testUtils.createTestDeviceId(),
          role: i % 2 === 0 ? 'TRADER' : 'COACH'
        })
        sessionIds.push(sessionId)
      }

      // Perform rapid concurrent validations
      const rounds = 3
      const allTimings: number[] = []

      for (let round = 0; round < rounds; round++) {
        console.log(`🔄 Stress test round ${round + 1}/${rounds}`)
        
        const roundStartTime = process.hrtime.bigint()
        
        const results = await Promise.all(
          sessionIds.map(async sessionId => {
            const start = process.hrtime.bigint()
            const result = await validateAndRefreshSession(sessionId)
            const end = process.hrtime.bigint()
            const duration = Number(end - start) / 1_000_000
            
            allTimings.push(duration)
            return result
          })
        )
        
        const roundEndTime = process.hrtime.bigint()
        const roundTotalTime = Number(roundEndTime - roundStartTime) / 1_000_000
        
        console.log(`   Round ${round + 1} completed in ${roundTotalTime.toFixed(2)}ms`)
        
        // Verify all validations succeeded
        results.forEach(result => {
          expect(result.valid).toBe(true)
        })
      }

      // Analyze stress test results
      const avgTime = allTimings.reduce((sum, time) => sum + time, 0) / allTimings.length
      const p95Time = allTimings.sort((a, b) => a - b)[Math.floor(allTimings.length * 0.95)]
      const maxTime = Math.max(...allTimings)
      
      console.log(`📊 Stress Test Results:`)
      console.log(`   Average: ${avgTime.toFixed(2)}ms`)
      console.log(`   P95: ${p95Time.toFixed(2)}ms`)
      console.log(`   Max: ${maxTime.toFixed(2)}ms`)
      console.log(`   Total operations: ${allTimings.length}`)

      // Performance should remain acceptable under stress for portfolio tracking
      expect(avgTime).toBeLessThan(3000) // Portfolio target: <3s average under stress
      expect(p95Time).toBeLessThan(8000) // P95 should still be reasonable
      expect(maxTime).toBeLessThan(15000) // No request should take >15s
    })
  })

  describe('Performance Monitoring Integration', () => {

    it('should provide accurate performance metrics', async () => {
      // Run the built-in benchmark
      const benchmarkResult = await runSessionPerformanceBenchmark()
      
      console.log(`📊 Built-in Benchmark Results:`)
      console.log(`   Average: ${benchmarkResult.averageTime.toFixed(2)}ms`)
      console.log(`   P95: ${benchmarkResult.p95Time.toFixed(2)}ms`)
      console.log(`   P99: ${benchmarkResult.p99Time.toFixed(2)}ms`)
      console.log(`   Success Rate: ${(benchmarkResult.successRate * 100).toFixed(1)}%`)

      // Verify benchmark results for portfolio workflows
      expect(benchmarkResult.averageTime).toBeLessThan(2000) // Portfolio target
      expect(benchmarkResult.successRate).toBeGreaterThanOrEqual(0.99) // 99% success rate
      expect(benchmarkResult.totalOperations).toBe(100)
    })

    it('should generate comprehensive performance reports', async () => {
      // Create some test sessions and validate them
      const { sessionId } = await createSession({
        userId: testUtils.createTestUserId('report-test'),
        deviceId: testUtils.createTestDeviceId(),
        role: 'TRADER'
      })

      // Perform some validations to generate metrics
      for (let i = 0; i < 10; i++) {
        await validateAndRefreshSession(sessionId)
      }

      const report = await getSessionPerformanceReport()
      
      console.log(`📊 Performance Report:`)
      console.log(`   Status: ${report.performanceStatus}`)
      console.log(`   Redis Connected: ${report.redisHealth.connected}`)
      console.log(`   Recommendations: ${report.recommendations.length}`)

      // Verify report structure
      expect(report.performanceStatus).toBeDefined()
      expect(report.redisHealth.connected).toBe(true)
      expect(report.redisStats).toBeDefined()
      expect(Array.isArray(report.recommendations)).toBe(true)
      
      // Performance status should be good with our optimizations
      expect(['EXCELLENT', 'GOOD']).toContain(report.performanceStatus)
    })
  })

  describe('Memory and Resource Efficiency', () => {

    it('should not leak memory during session operations', async () => {
      const initialMemory = process.memoryUsage()
      
      // Create and validate many sessions
      const sessionIds: string[] = []
      for (let i = 0; i < 100; i++) {
        const { sessionId } = await createSession({
          userId: testUtils.createTestUserId(`memory-test-${i}`),
          deviceId: testUtils.createTestDeviceId(),
          role: 'TRADER'
        })
        sessionIds.push(sessionId)
      }

      // Validate all sessions multiple times
      for (let round = 0; round < 5; round++) {
        await Promise.all(sessionIds.map(id => validateAndRefreshSession(id)))
      }

      // Clean up sessions
      await Promise.all(sessionIds.map(id => revokeSession(id)))
      
      // Force garbage collection if available
      if (global.gc) {
        global.gc()
      }
      
      const finalMemory = process.memoryUsage()
      const memoryIncrease = finalMemory.heapUsed - initialMemory.heapUsed
      
      console.log(`📊 Memory Usage:`)
      console.log(`   Initial heap: ${(initialMemory.heapUsed / 1024 / 1024).toFixed(2)} MB`)
      console.log(`   Final heap: ${(finalMemory.heapUsed / 1024 / 1024).toFixed(2)} MB`)
      console.log(`   Increase: ${(memoryIncrease / 1024 / 1024).toFixed(2)} MB`)

      // Memory increase should be minimal (allow for some test overhead)
      expect(memoryIncrease).toBeLessThan(10 * 1024 * 1024) // Less than 10MB increase
    })
  })
})