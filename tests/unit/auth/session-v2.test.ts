import { describe, it, expect, beforeEach, vi } from 'vitest'
import { testUtils } from '@tests/setup/global-setup'
import type { Session, CreateSessionParams } from '@/lib/auth/session-v2'

/**
 * Unit Tests for Redis Session Management (session-v2.ts)
 * 
 * Tests the core session logic with mocked Redis for fast execution
 * Based on Codex recommendations for unit testing portfolio tracking auth components
 * 
 * Test Coverage:
 * - Session creation and validation for portfolio workflows
 * - TTL and expiration handling for relaxed portfolio requirements
 * - Session rotation and revocation
 * - Error conditions and edge cases
 * - Performance characteristics for portfolio tracking (Google Sheets replacement)
 */

// Mock Redis for unit tests (integration tests will use real Redis)
vi.mock('ioredis', () => {
  const mockRedis = {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    incr: vi.fn(),
    smembers: vi.fn(),
    sadd: vi.fn(),
    srem: vi.fn(),
    scard: vi.fn(),
    pipeline: vi.fn(() => ({
      set: vi.fn(),
      del: vi.fn(),
      sadd: vi.fn(),
      srem: vi.fn(),
      incr: vi.fn(),
      exec: vi.fn()
    })),
    ping: vi.fn(),
    info: vi.fn(),
    disconnect: vi.fn(),
    connect: vi.fn()
  }
  
  return {
    default: vi.fn(() => mockRedis)
  }
})

// Import after mocking
import {
  createSession,
  validateAndRefreshSession,
  rotateSession,
  revokeSession,
  revokeAllUserSessions,
  updateUserRole,
  getUserSessionCount,
  getSession,
  checkRedisHealth,
  getRedisStats
} from '@/lib/auth/session-v2'

// Get reference to mocked Redis
const mockRedis = vi.mocked(new (await import('ioredis')).default())

describe('Redis Session Management', () => {
  
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('createSession', () => {
    it('should create a valid session with all required fields', async () => {
      // Setup mocks
      mockRedis.incr.mockResolvedValue(1)
      mockRedis.pipeline().exec.mockResolvedValue([])

      const params: CreateSessionParams = {
        userId: testUtils.createTestUserId('1'),
        deviceId: testUtils.createTestDeviceId(),
        role: 'TRADER',
        ip: '192.168.1.1',
        userAgent: 'Mozilla/5.0 (Test Browser)'
      }

      const result = await createSession(params)

      // Validate session ID format (base64url, ~43 chars)
      expect(result.sessionId).toBeValidSessionId()

      // Validate session structure
      expect(result.session).toMatchObject({
        v: 1,
        uid: params.userId,
        did: params.deviceId,
        role: 'TRADER',
        mfa: false,
        rc: 0
      })

      // Validate timestamps
      expect(result.session.iat).toBeTypeOf('number')
      expect(result.session.exp).toBeGreaterThan(result.session.iat)
      expect(result.session.idleExp).toBeGreaterThan(result.session.iat)

      // Validate Redis operations
      expect(mockRedis.pipeline().set).toHaveBeenCalledWith(
        expect.stringMatching(/^sess:/),
        expect.any(String),
        'EX',
        expect.any(Number)
      )
      expect(mockRedis.pipeline().sadd).toHaveBeenCalledWith(
        expect.stringMatching(/^user:sess:/),
        result.sessionId
      )
    })

    it('should hash sensitive data (IP and user agent)', async () => {
      mockRedis.incr.mockResolvedValue(1)
      mockRedis.pipeline().exec.mockResolvedValue([])

      const params: CreateSessionParams = {
        userId: testUtils.createTestUserId('1'),
        deviceId: testUtils.createTestDeviceId(),
        role: 'TRADER',
        ip: '192.168.1.1',
        userAgent: 'Mozilla/5.0'
      }

      const result = await createSession(params)

      // IP and User Agent should be hashed, not stored in plain text
      expect(result.session.ipH).toBeDefined()
      expect(result.session.ipH).not.toBe(params.ip)
      expect(result.session.ipH).toHaveLength(16) // SHA-256 truncated to 16 chars

      expect(result.session.uaH).toBeDefined()  
      expect(result.session.uaH).not.toBe(params.userAgent)
      expect(result.session.uaH).toHaveLength(16)
    })

    it('should handle default TTL values', async () => {
      mockRedis.incr.mockResolvedValue(1)
      mockRedis.pipeline().exec.mockResolvedValue([])

      const params: CreateSessionParams = {
        userId: testUtils.createTestUserId('1'),
        deviceId: testUtils.createTestDeviceId(),
        role: 'TRADER'
      }

      const result = await createSession(params)

      // Default: 30 days absolute, 12 hours idle
      const expectedAbsoluteExp = Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60)
      const expectedIdleExp = Math.floor(Date.now() / 1000) + (12 * 60 * 60)

      expect(result.session.exp).toBe(expectedAbsoluteExp)
      expect(result.session.idleExp).toBe(expectedIdleExp)
    })

    it('should respect custom TTL values', async () => {
      mockRedis.incr.mockResolvedValue(1)
      mockRedis.pipeline().exec.mockResolvedValue([])

      const customAbsolute = 7 * 24 * 60 * 60 // 7 days
      const customIdle = 2 * 60 * 60 // 2 hours

      const params: CreateSessionParams = {
        userId: testUtils.createTestUserId('1'),
        deviceId: testUtils.createTestDeviceId(),
        role: 'TRADER',
        absoluteTtlSec: customAbsolute,
        idleTtlSec: customIdle
      }

      const result = await createSession(params)

      const expectedAbsoluteExp = Math.floor(Date.now() / 1000) + customAbsolute
      const expectedIdleExp = Math.floor(Date.now() / 1000) + customIdle

      expect(result.session.exp).toBe(expectedAbsoluteExp)
      expect(result.session.idleExp).toBe(expectedIdleExp)
    })
  })

  describe('validateAndRefreshSession', () => {
    const testSessionId = 'test-session-id-12345'
    const testSession: Session = testUtils.createTestSessionData({
      uid: testUtils.createTestUserId('1'),
      did: testUtils.createTestDeviceId(),
      roleVersion: 5
    })

    it('should validate and refresh a valid session', async () => {
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(testSession))
      mockRedis.get.mockResolvedValueOnce('5') // Role version matches
      mockRedis.pipeline().exec.mockResolvedValue([])

      const result = await validateAndRefreshSession(testSessionId)

      expect(result.valid).toBe(true)
      expect(result.session).toMatchObject({
        uid: testSession.uid,
        did: testSession.did,
        role: testSession.role
      })

      // Should update idle expiration
      expect(result.session!.idleExp).toBeGreaterThan(testSession.idleExp)

      // Should refresh session in Redis
      expect(mockRedis.pipeline().set).toHaveBeenCalledWith(
        `sess:${testSessionId}`,
        expect.any(String),
        'EX',
        expect.any(Number)
      )
    })

    it('should reject non-existent session', async () => {
      mockRedis.get.mockResolvedValue(null)

      const result = await validateAndRefreshSession(testSessionId)

      expect(result.valid).toBe(false)
      expect(result.reason).toBe('not_found')
      expect(result.session).toBeUndefined()
    })

    it('should reject expired session', async () => {
      const expiredSession = testUtils.createTestSessionData({
        exp: Math.floor(Date.now() / 1000) - 3600 // Expired 1 hour ago
      })

      mockRedis.get.mockResolvedValue(JSON.stringify(expiredSession))
      
      // Mock revoke session calls
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(expiredSession))
      mockRedis.pipeline().exec.mockResolvedValue([])

      const result = await validateAndRefreshSession(testSessionId)

      expect(result.valid).toBe(false)
      expect(result.reason).toBe('expired')
    })

    it('should reject idle expired session', async () => {
      const idleExpiredSession = testUtils.createTestSessionData({
        idleExp: Math.floor(Date.now() / 1000) - 1800 // Idle expired 30 min ago
      })

      mockRedis.get.mockResolvedValue(JSON.stringify(idleExpiredSession))
      
      // Mock revoke session calls
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(idleExpiredSession))
      mockRedis.pipeline().exec.mockResolvedValue([])

      const result = await validateAndRefreshSession(testSessionId)

      expect(result.valid).toBe(false)
      expect(result.reason).toBe('idle_expired')
    })

    it('should reject session with mismatched role version', async () => {
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(testSession))
      mockRedis.get.mockResolvedValueOnce('10') // Role version increased

      // Mock revoke session calls
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(testSession))
      mockRedis.pipeline().exec.mockResolvedValue([])

      const result = await validateAndRefreshSession(testSessionId)

      expect(result.valid).toBe(false)
      expect(result.reason).toBe('role_version_mismatch')
    })

    it('should handle Redis errors gracefully', async () => {
      mockRedis.get.mockRejectedValue(new Error('Redis connection failed'))

      const result = await validateAndRefreshSession(testSessionId)

      expect(result.valid).toBe(false)
      expect(result.reason).toBe('not_found')
    })
  })

  describe('rotateSession', () => {
    const testSessionId = 'test-session-id-12345'
    const testSession: Session = testUtils.createTestSessionData({ rc: 5 })

    it('should increment rotation counter', async () => {
      mockRedis.get.mockResolvedValue(JSON.stringify(testSession))
      mockRedis.set.mockResolvedValue('OK')

      const result = await rotateSession(testSessionId)

      expect(result).toBeDefined()
      expect(result!.rc).toBe(6) // Incremented from 5

      expect(mockRedis.set).toHaveBeenCalledWith(
        `sess:${testSessionId}`,
        expect.stringContaining('"rc":6'),
        'KEEPTTL'
      )
    })

    it('should return null for non-existent session', async () => {
      mockRedis.get.mockResolvedValue(null)

      const result = await rotateSession(testSessionId)

      expect(result).toBeNull()
    })
  })

  describe('revokeSession', () => {
    const testSessionId = 'test-session-id-12345'
    const testUserId = testUtils.createTestUserId('1')

    it('should revoke session with user ID', async () => {
      mockRedis.pipeline().exec.mockResolvedValue([])

      await revokeSession(testSessionId, testUserId)

      expect(mockRedis.pipeline().del).toHaveBeenCalledWith(`sess:${testSessionId}`)
      expect(mockRedis.pipeline().srem).toHaveBeenCalledWith(
        `user:sess:${testUserId}`,
        testSessionId
      )
    })

    it('should revoke session without user ID by fetching from session', async () => {
      const testSession = testUtils.createTestSessionData({ uid: testUserId })
      
      mockRedis.get.mockResolvedValue(JSON.stringify(testSession))
      mockRedis.pipeline().exec.mockResolvedValue([])

      await revokeSession(testSessionId)

      expect(mockRedis.get).toHaveBeenCalledWith(`sess:${testSessionId}`)
      expect(mockRedis.pipeline().del).toHaveBeenCalledWith(`sess:${testSessionId}`)
      expect(mockRedis.pipeline().srem).toHaveBeenCalledWith(
        `user:sess:${testUserId}`,
        testSessionId
      )
    })
  })

  describe('revokeAllUserSessions', () => {
    const testUserId = testUtils.createTestUserId('1')

    it('should revoke all sessions for a user', async () => {
      const sessionIds = ['session-1', 'session-2', 'session-3']
      
      mockRedis.smembers.mockResolvedValue(sessionIds)
      mockRedis.pipeline().exec.mockResolvedValue([])

      await revokeAllUserSessions(testUserId)

      expect(mockRedis.smembers).toHaveBeenCalledWith(`user:sess:${testUserId}`)
      
      // Should delete all sessions
      sessionIds.forEach(sessionId => {
        expect(mockRedis.pipeline().del).toHaveBeenCalledWith(`sess:${sessionId}`)
      })
      
      // Should clear user session tracking
      expect(mockRedis.pipeline().del).toHaveBeenCalledWith(`user:sess:${testUserId}`)
      
      // Should increment role version
      expect(mockRedis.pipeline().incr).toHaveBeenCalledWith(`user:ver:${testUserId}`)
    })

    it('should handle users with no sessions', async () => {
      mockRedis.smembers.mockResolvedValue([])

      await revokeAllUserSessions(testUserId)

      expect(mockRedis.smembers).toHaveBeenCalledWith(`user:sess:${testUserId}`)
      // Should not call pipeline exec since no sessions to revoke
      expect(mockRedis.pipeline().exec).not.toHaveBeenCalled()
    })
  })

  describe('updateUserRole', () => {
    const testUserId = testUtils.createTestUserId('1')

    it('should increment role version', async () => {
      mockRedis.incr.mockResolvedValue(10)

      await updateUserRole(testUserId, 'ADMIN')

      expect(mockRedis.incr).toHaveBeenCalledWith(`user:ver:${testUserId}`)
    })
  })

  describe('getUserSessionCount', () => {
    const testUserId = testUtils.createTestUserId('1')

    it('should return session count', async () => {
      mockRedis.scard.mockResolvedValue(3)

      const count = await getUserSessionCount(testUserId)

      expect(count).toBe(3)
      expect(mockRedis.scard).toHaveBeenCalledWith(`user:sess:${testUserId}`)
    })

    it('should handle Redis errors', async () => {
      mockRedis.scard.mockRejectedValue(new Error('Redis error'))

      const count = await getUserSessionCount(testUserId)

      expect(count).toBe(0)
    })
  })

  describe('getSession', () => {
    const testSessionId = 'test-session-id-12345'

    it('should return parsed session data', async () => {
      const testSession = testUtils.createTestSessionData()
      mockRedis.get.mockResolvedValue(JSON.stringify(testSession))

      const result = await getSession(testSessionId)

      expect(result).toEqual(testSession)
      expect(mockRedis.get).toHaveBeenCalledWith(`sess:${testSessionId}`)
    })

    it('should return null for non-existent session', async () => {
      mockRedis.get.mockResolvedValue(null)

      const result = await getSession(testSessionId)

      expect(result).toBeNull()
    })
  })

  describe('checkRedisHealth', () => {
    it('should return healthy status with latency', async () => {
      mockRedis.ping.mockResolvedValue('PONG')

      const result = await checkRedisHealth()

      expect(result.connected).toBe(true)
      expect(result.latency).toBeTypeOf('number')
      expect(result.latency).toBeGreaterThan(0)
    })

    it('should return unhealthy status on error', async () => {
      mockRedis.ping.mockRejectedValue(new Error('Connection failed'))

      const result = await checkRedisHealth()

      expect(result.connected).toBe(false)
      expect(result.error).toBe('Connection failed')
    })
  })

  describe('Performance Requirements', () => {
    it('should create session in reasonable time', async () => {
      mockRedis.incr.mockResolvedValue(1)
      mockRedis.pipeline().exec.mockResolvedValue([])

      const start = process.hrtime.bigint()
      
      await createSession({
        userId: testUtils.createTestUserId('1'),
        deviceId: testUtils.createTestDeviceId(),
        role: 'TRADER'
      })
      
      const end = process.hrtime.bigint()
      const timeMs = Number(end - start) / 1_000_000

      // Unit test should be very fast (no network calls) - portfolio or HFT doesn't matter for unit tests
      expect(timeMs).toBeLessThan(10)
    })

    it('should validate session in reasonable time', async () => {
      const testSession = testUtils.createTestSessionData()
      mockRedis.get.mockResolvedValueOnce(JSON.stringify(testSession))
      mockRedis.get.mockResolvedValueOnce('1')
      mockRedis.pipeline().exec.mockResolvedValue([])

      const start = process.hrtime.bigint()
      
      await validateAndRefreshSession('test-session-id')
      
      const end = process.hrtime.bigint()
      const timeMs = Number(end - start) / 1_000_000

      // Unit test should be very fast (no network calls) - portfolio or HFT doesn't matter for unit tests
      expect(timeMs).toBeLessThan(10)
    })
  })

  describe('Edge Cases', () => {
    it('should handle malformed session data in Redis', async () => {
      mockRedis.get.mockResolvedValue('invalid-json')

      const result = await validateAndRefreshSession('test-session-id')

      expect(result.valid).toBe(false)
      expect(result.reason).toBe('not_found')
    })

    it('should handle missing fields in session data', async () => {
      const incompleteSession = { uid: 'test', exp: Date.now() } // Missing required fields
      mockRedis.get.mockResolvedValue(JSON.stringify(incompleteSession))

      const result = await validateAndRefreshSession('test-session-id')

      expect(result.valid).toBe(false)
    })

    it('should handle concurrent revocation attempts', async () => {
      mockRedis.pipeline().exec.mockResolvedValue([])

      // Multiple concurrent revocations should not throw
      await Promise.all([
        revokeSession('session-1'),
        revokeSession('session-1'),
        revokeSession('session-1')
      ])

      expect(mockRedis.pipeline().del).toHaveBeenCalledTimes(3)
    })
  })
})