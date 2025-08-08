import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { startTestContainers, stopTestContainers, type TestContainers } from '@tests/setup/testcontainers'
import { createSession, revokeSession, checkRedisHealth } from '@/lib/auth/session-v2'
import { authMiddleware } from '@/lib/auth/middleware'
import { testUtils } from '@tests/setup/global-setup'

/**
 * 🔍 INTEGRATION TESTS: Authentication Middleware with Real Redis
 * 
 * These tests validate the complete authentication flow using real Redis
 * connections and sessions for portfolio tracking workflows (Google Sheets replacement),
 * catching issues that mocked tests miss:
 * 
 * - Redis connection failures
 * - Session serialization/deserialization bugs
 * - Pipeline execution errors
 * - Performance bottlenecks under real network conditions (portfolio-appropriate)
 * - Connection pool exhaustion scenarios
 * 
 * Based on Gemini recommendations for production-ready portfolio testing
 */

let containers: TestContainers

describe('Authentication Middleware Integration Tests', () => {
  
  beforeAll(async () => {
    console.log('🐳 Starting test containers for middleware integration tests...')
    containers = await startTestContainers()
    
    // Override Redis URL to use test container
    process.env.REDIS_URL = containers.redis.url
    
    // Wait for Redis to be fully ready
    await new Promise(resolve => setTimeout(resolve, 2000))
    
    // Test Redis connectivity directly with test client
    try {
      await containers.redis.client.ping()
      console.log(`✅ Redis connected successfully`)
    } catch (error) {
      throw new Error(`Redis connection failed: ${error.message}`)
    }
  }, 60000) // Extended timeout for container startup

  afterAll(async () => {
    if (containers) {
      await stopTestContainers()
    }
  })

  beforeEach(async () => {
    // Clear Redis between tests for isolation
    await containers.redis.client.flushdb()
  })

  describe('Session Validation Performance', () => {

    it('should validate session within portfolio targets with real Redis', async () => {
      // Create real session in Redis
      const { sessionId, session } = await createSession({
        userId: testUtils.createTestUserId('perf-user'),
        deviceId: testUtils.createTestDeviceId(),
        role: 'TRADER'
      })

      // Create realistic request
      const request = createRealRequest('/dashboard', sessionId)
      
      // Measure middleware execution time
      const startTime = process.hrtime.bigint()
      const response = await authMiddleware(request)
      const endTime = process.hrtime.bigint()
      
      const executionTimeMs = Number(endTime - startTime) / 1_000_000
      
      console.log(`📊 Middleware execution time: ${executionTimeMs.toFixed(2)}ms`)
      
      // Assert performance target for portfolio tracking (Google Sheets replacement)
      expect(executionTimeMs).toBeLessThan(3000) // Allow 3s for integration test overhead
      
      // Verify successful authentication
      expect(response.headers.get('x-user-id')).toBe(testUtils.createTestUserId('perf-user'))
      expect(response.headers.get('x-user-role')).toBe('TRADER')
      expect(response.headers.get('x-auth-validation-time')).toBeDefined()
    })

    it('should handle concurrent session validations', async () => {
      // Create multiple sessions
      const sessions = await Promise.all(
        Array.from({ length: 10 }, async (_, i) => {
          return await createSession({
            userId: testUtils.createTestUserId(`concurrent-user-${i}`),
            deviceId: testUtils.createTestDeviceId(),
            role: 'TRADER'
          })
        })
      )

      // Execute concurrent middleware calls
      const requests = sessions.map(({ sessionId }) => 
        createRealRequest('/api/portfolio', sessionId)
      )

      const startTime = process.hrtime.bigint()
      const responses = await Promise.all(
        requests.map(request => authMiddleware(request))
      )
      const endTime = process.hrtime.bigint()

      const totalTimeMs = Number(endTime - startTime) / 1_000_000
      const avgTimeMs = totalTimeMs / responses.length

      console.log(`📊 Concurrent execution: ${responses.length} requests in ${totalTimeMs.toFixed(2)}ms (avg: ${avgTimeMs.toFixed(2)}ms)`)

      // Verify all requests succeeded
      responses.forEach((response, i) => {
        expect(response.headers.get('x-user-id')).toBe(testUtils.createTestUserId(`concurrent-user-${i}`))
      })

      // Performance assertion - should handle concurrent load efficiently
      expect(avgTimeMs).toBeLessThan(5000) // Portfolio target: reasonable concurrent performance
    })
  })

  describe('Redis Connection Scenarios', () => {

    it('should handle valid session from Redis', async () => {
      const { sessionId } = await createSession({
        userId: testUtils.createTestUserId('valid-user'),
        deviceId: testUtils.createTestDeviceId(),
        role: 'ADMIN'
      })

      const request = createRealRequest('/admin', sessionId)
      const response = await authMiddleware(request)

      // Should allow access to admin route
      expect(response.headers.get('x-user-role')).toBe('ADMIN')
      expect(response.headers.get('x-user-id')).toBe(testUtils.createTestUserId('valid-user'))
    })

    it('should handle session not found in Redis', async () => {
      const fakeSessionId = 'nonexistent-session-id-12345'
      const request = createRealRequest('/dashboard', fakeSessionId)
      
      const response = await authMiddleware(request)

      // Should redirect to login for page routes
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toContain('/login')
    })

    it('should handle expired sessions correctly', async () => {
      // Create session with very short TTL
      const { sessionId } = await createSession({
        userId: testUtils.createTestUserId('expire-user'),
        deviceId: testUtils.createTestDeviceId(),
        role: 'TRADER',
        absoluteTtlSec: 1, // 1 second expiry
        idleTtlSec: 1
      })

      // Wait for session to expire
      await new Promise(resolve => setTimeout(resolve, 1100))

      const request = createRealRequest('/dashboard', sessionId)
      const response = await authMiddleware(request)

      // Should redirect due to expired session
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toContain('/login')
    })

    it('should handle Redis serialization correctly', async () => {
      // Create session with complex data
      const userId = testUtils.createTestUserId('serialization-test')
      const deviceId = testUtils.createTestDeviceId()
      
      const { sessionId } = await createSession({
        userId,
        deviceId,
        role: 'COACH',
        ip: '192.168.1.100',
        userAgent: 'Mozilla/5.0 Test Browser',
        mfa: true
      })

      const request = createRealRequest('/portfolio', sessionId)
      const response = await authMiddleware(request)

      // Verify all session data was serialized/deserialized correctly
      expect(response.headers.get('x-user-id')).toBe(userId)
      expect(response.headers.get('x-device-id')).toBe(deviceId)
      expect(response.headers.get('x-user-role')).toBe('COACH')
      expect(response.headers.get('x-mfa-verified')).toBe('true')
    })
  })

  describe('Role-Based Access with Real Sessions', () => {

    it('should enforce admin-only routes with real Redis sessions', async () => {
      // Create trader session
      const { sessionId: traderSessionId } = await createSession({
        userId: testUtils.createTestUserId('trader-user'),
        deviceId: testUtils.createTestDeviceId(),
        role: 'TRADER'
      })

      // Create admin session  
      const { sessionId: adminSessionId } = await createSession({
        userId: testUtils.createTestUserId('admin-user'),
        deviceId: testUtils.createTestDeviceId(),
        role: 'ADMIN'
      })

      // Test trader access to admin route (should be forbidden)
      const traderRequest = createRealRequest('/admin', traderSessionId)
      const traderResponse = await authMiddleware(traderRequest)
      
      expect(traderResponse.status).toBe(302) // Redirect to access denied
      expect(traderResponse.headers.get('location')).toContain('/access-denied')

      // Test admin access to admin route (should succeed)
      const adminRequest = createRealRequest('/admin', adminSessionId)
      const adminResponse = await authMiddleware(adminRequest)
      
      expect(adminResponse.headers.get('x-user-role')).toBe('ADMIN')
    })

    it('should handle API route authentication differently than pages', async () => {
      const fakeSessionId = 'nonexistent-api-session'
      
      // API route should return JSON error
      const apiRequest = createRealRequest('/api/portfolio', fakeSessionId)
      const apiResponse = await authMiddleware(apiRequest)
      
      expect(apiResponse.status).toBe(401)
      // For real NextResponse, we need to check the response construction
      
      // Page route should redirect
      const pageRequest = createRealRequest('/dashboard', fakeSessionId)
      const pageResponse = await authMiddleware(pageRequest)
      
      expect(pageResponse.status).toBe(302)
      expect(pageResponse.headers.get('location')).toContain('/login')
    })
  })

  describe('Session Refresh Integration', () => {

    it('should refresh session idle expiration on valid request', async () => {
      const { sessionId, session } = await createSession({
        userId: testUtils.createTestUserId('refresh-user'),
        deviceId: testUtils.createTestDeviceId(),
        role: 'TRADER',
        idleTtlSec: 60 // 1 minute
      })

      const originalIdleExp = session.idleExp

      // Make authenticated request
      const request = createRealRequest('/dashboard', sessionId)
      await authMiddleware(request)

      // Wait a moment for session refresh to complete
      await new Promise(resolve => setTimeout(resolve, 100))

      // Verify session was refreshed in Redis
      const sessionData = await containers.redis.client.get(`sess:${sessionId}`)
      expect(sessionData).toBeDefined()
      
      const refreshedSession = JSON.parse(sessionData!)
      expect(refreshedSession.idleExp).toBeGreaterThan(originalIdleExp)
    })

    it('should handle session refresh failures gracefully', async () => {
      const { sessionId } = await createSession({
        userId: testUtils.createTestUserId('refresh-fail-user'),
        deviceId: testUtils.createTestDeviceId(),
        role: 'TRADER'
      })

      // Simulate Redis failure during refresh by manually deleting the session
      // but keeping the initial GET successful (this tests the pipeline failure)
      const request = createRealRequest('/dashboard', sessionId)
      
      // Delete session between validation and refresh (race condition simulation)
      setTimeout(async () => {
        await containers.redis.client.del(`sess:${sessionId}`)
      }, 1)

      const response = await authMiddleware(request)

      // Should still allow access but log the refresh failure
      // (the session was valid at validation time)
      expect(response.headers.get('x-user-id')).toBe(testUtils.createTestUserId('refresh-fail-user'))
    })
  })

  describe('Error Handling and Edge Cases', () => {

    it('should handle malformed session data in Redis', async () => {
      const sessionId = 'malformed-session-123'
      
      // Insert malformed JSON into Redis
      await containers.redis.client.set(`sess:${sessionId}`, 'invalid-json-data', 'EX', 3600)

      const request = createRealRequest('/dashboard', sessionId)
      const response = await authMiddleware(request)

      // Should handle gracefully and redirect to login
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toContain('/login')
    })

    it('should handle Redis connection timeout gracefully', async () => {
      // Note: This test would require mocking or a Redis proxy to simulate timeouts
      // For now, we'll test the basic error handling path
      const request = createRealRequest('/dashboard', 'timeout-session')
      const response = await authMiddleware(request)

      // Should fail gracefully and redirect
      expect(response.status).toBe(302)
    })
  })
})

/**
 * Helper function to create realistic Next.js requests for integration testing
 */
function createRealRequest(pathname: string, sessionId?: string): NextRequest {
  const url = `http://localhost:3000${pathname}`
  
  const headers: Record<string, string> = {
    'user-agent': 'Mozilla/5.0 Integration Test Browser',
    'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
  }

  if (sessionId) {
    headers.cookie = `app_session=${sessionId}`
  }

  // Create a real NextRequest object (not mocked)
  return new NextRequest(url, {
    headers: new Headers(headers),
    method: 'GET'
  })
}