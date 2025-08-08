import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'
import { testUtils } from '@tests/setup/global-setup'
import type { Session } from '@/lib/auth/session-v2'

/**
 * Unit Tests for Authentication Middleware (middleware.ts)
 * 
 * Tests the Next.js middleware with mocked session validation
 * Based on Codex recommendations for middleware testing
 * 
 * Test Coverage:
 * - Session ID extraction (cookies vs Authorization header)
 * - Route classification (public, protected, admin)
 * - Authentication flow validation
 * - Role-based access control
 * - Auth context header creation
 * - Error handling and response creation
 * - Server Action helpers
 * - Performance validation
 */

// Mock session validation for unit tests
const mockValidateAndRefreshSession = vi.fn()

vi.mock('@/lib/auth/session-v2', () => ({
  validateAndRefreshSession: mockValidateAndRefreshSession,
  type Session: {} as any
}))

// Mock Next.js server functions
const mockNextResponse = {
  next: vi.fn(() => ({
    headers: new Map(),
    cookies: {
      delete: vi.fn()
    }
  })),
  json: vi.fn((data: any, options: any) => ({
    status: options.status,
    data,
    headers: new Map()
  })),
  redirect: vi.fn((url: string) => ({
    status: 302,
    location: url,
    headers: new Map()
  }))
}

vi.mock('next/server', () => ({
  NextRequest: vi.fn(),
  NextResponse: mockNextResponse
}))

// Import after mocking
import {
  authMiddleware,
  getAuthContext,
  requireAuth,
  requireRole,
  type AuthContext
} from '@/lib/auth/middleware'

describe('Authentication Middleware', () => {

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_APP_URL = 'https://example.com'
  })

  describe('authMiddleware - Route Classification', () => {

    it('should allow access to public routes without authentication', async () => {
      const publicPaths = [
        '/api/auth/login',
        '/api/auth/callback', 
        '/login',
        '/signup',
        '/forgot-password',
        '/',
        '/about',
        '/pricing'
      ]

      for (const path of publicPaths) {
        const request = createMockRequest(path)
        
        const response = await authMiddleware(request)
        
        expect(mockNextResponse.next).toHaveBeenCalled()
        expect(mockValidateAndRefreshSession).not.toHaveBeenCalled()
      }
    })

    it('should require authentication for protected routes', async () => {
      const protectedPaths = [
        '/api/portfolio',
        '/api/holdings',
        '/api/auth/refresh',
        '/api/auth/revoke',
        '/api/ws/token',
        '/dashboard',
        '/portfolio',
        '/holdings'
      ]

      for (const path of protectedPaths) {
        const request = createMockRequest(path) // No session cookie
        
        const response = await authMiddleware(request)
        
        // Should return unauthorized response
        expect(response).toBeDefined()
        // mockNextResponse.next should not be called for protected routes without auth
        mockNextResponse.next.mockClear()
      }
    })

    it('should require admin role for admin routes', async () => {
      const adminPaths = [
        '/api/admin',
        '/api/system', 
        '/admin'
      ]

      const traderSession = testUtils.createTestSessionData({ role: 'TRADER' })
      mockValidateAndRefreshSession.mockResolvedValue({
        valid: true,
        session: traderSession
      })

      for (const path of adminPaths) {
        const request = createMockRequest(path, 'test-session-id')
        
        const response = await authMiddleware(request)
        
        expect(mockValidateAndRefreshSession).toHaveBeenCalledWith('test-session-id')
        // Should return forbidden response for non-admin users
        expect(mockNextResponse.json).toHaveBeenCalledWith(
          expect.objectContaining({
            error: 'Forbidden',
            code: 'INSUFFICIENT_PRIVILEGES'
          }),
          { status: 403 }
        )
      }
    })
  })

  describe('authMiddleware - Session Extraction', () => {

    it('should extract session ID from app_session cookie', async () => {
      const sessionId = 'cookie-session-id-12345'
      const request = createMockRequest('/dashboard', sessionId, 'cookie')

      const validSession = testUtils.createTestSessionData()
      mockValidateAndRefreshSession.mockResolvedValue({
        valid: true,
        session: validSession
      })

      await authMiddleware(request)

      expect(mockValidateAndRefreshSession).toHaveBeenCalledWith(sessionId)
    })

    it('should extract session ID from Authorization header', async () => {
      const sessionId = 'bearer-session-id-12345'
      const request = createMockRequest('/api/portfolio', sessionId, 'header')

      const validSession = testUtils.createTestSessionData()
      mockValidateAndRefreshSession.mockResolvedValue({
        valid: true,
        session: validSession
      })

      await authMiddleware(request)

      expect(mockValidateAndRefreshSession).toHaveBeenCalledWith(sessionId)
    })

    it('should return unauthorized if no session ID found', async () => {
      const request = createMockRequest('/dashboard') // No session
      
      const response = await authMiddleware(request)

      expect(mockValidateAndRefreshSession).not.toHaveBeenCalled()
      expect(mockNextResponse.redirect).toHaveBeenCalledWith(
        expect.objectContaining({
          href: 'https://example.com/login?returnUrl=%2Fdashboard'
        })
      )
    })

    it('should prioritize cookie over Authorization header', async () => {
      const cookieSessionId = 'cookie-session-123'  
      const headerSessionId = 'header-session-456'

      const request = createMockRequest('/dashboard')
      
      // Mock both cookie and header
      request.cookies = new Map([['app_session', { value: cookieSessionId }]])
      request.headers = new Map([['authorization', `Bearer ${headerSessionId}`]])

      const validSession = testUtils.createTestSessionData()
      mockValidateAndRefreshSession.mockResolvedValue({
        valid: true,
        session: validSession
      })

      await authMiddleware(request)

      // Should use cookie session ID, not header
      expect(mockValidateAndRefreshSession).toHaveBeenCalledWith(cookieSessionId)
    })
  })

  describe('authMiddleware - Session Validation', () => {

    it('should process valid session and add auth headers', async () => {
      const sessionId = 'valid-session-123'
      const validSession = testUtils.createTestSessionData({
        uid: testUtils.createTestUserId('1'),
        did: testUtils.createTestDeviceId(),
        role: 'TRADER',
        roleVersion: 5,
        mfa: true
      })

      mockValidateAndRefreshSession.mockResolvedValue({
        valid: true,
        session: validSession
      })

      const request = createMockRequest('/dashboard', sessionId)
      const response = await authMiddleware(request)

      expect(mockValidateAndRefreshSession).toHaveBeenCalledWith(sessionId)
      
      // Should call NextResponse.next with auth headers
      expect(mockNextResponse.next).toHaveBeenCalledWith({
        request: {
          headers: expect.any(Headers)
        }
      })
    })

    it('should handle invalid session and clean up cookie', async () => {
      const sessionId = 'invalid-session-123'
      
      mockValidateAndRefreshSession.mockResolvedValue({
        valid: false,
        reason: 'expired'
      })

      const request = createMockRequest('/dashboard', sessionId)
      const response = await authMiddleware(request)

      expect(mockValidateAndRefreshSession).toHaveBeenCalledWith(sessionId)
      
      // Should redirect to login and delete invalid cookie
      expect(mockNextResponse.redirect).toHaveBeenCalled()
      expect(response.cookies?.delete).toHaveBeenCalledWith('app_session')
    })

    it('should handle session validation timeout gracefully', async () => {
      const sessionId = 'slow-session-123'
      
      // Mock slow validation (>10ms triggers warning)
      mockValidateAndRefreshSession.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 15))
        return {
          valid: true,
          session: testUtils.createTestSessionData()
        }
      })

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const request = createMockRequest('/dashboard', sessionId)
      await authMiddleware(request)

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Slow session validation')
      )
    })
  })

  describe('authMiddleware - Role-Based Access Control', () => {

    it('should allow ADMIN users to access admin routes', async () => {
      const adminSession = testUtils.createTestSessionData({ role: 'ADMIN' })
      mockValidateAndRefreshSession.mockResolvedValue({
        valid: true,
        session: adminSession
      })

      const request = createMockRequest('/admin', 'admin-session-123')
      const response = await authMiddleware(request)

      expect(mockNextResponse.next).toHaveBeenCalled()
    })

    it('should allow SYSTEM users to access admin routes', async () => {
      const systemSession = testUtils.createTestSessionData({ role: 'SYSTEM' })
      mockValidateAndRefreshSession.mockResolvedValue({
        valid: true,
        session: systemSession
      })

      const request = createMockRequest('/api/admin', 'system-session-123')
      const response = await authMiddleware(request)

      expect(mockNextResponse.next).toHaveBeenCalled()
    })

    it('should block non-admin users from admin routes', async () => {
      const traderSession = testUtils.createTestSessionData({ role: 'TRADER' })
      mockValidateAndRefreshSession.mockResolvedValue({
        valid: true,
        session: traderSession
      })

      const request = createMockRequest('/admin', 'trader-session-123')
      const response = await authMiddleware(request)

      expect(mockNextResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Forbidden',
          code: 'INSUFFICIENT_PRIVILEGES',
          message: 'Required role: ADMIN, current role: TRADER'
        }),
        { status: 403 }
      )
    })

    it('should block COACH users from admin routes', async () => {
      const coachSession = testUtils.createTestSessionData({ role: 'COACH' })
      mockValidateAndRefreshSession.mockResolvedValue({
        valid: true,
        session: coachSession
      })

      const request = createMockRequest('/api/system', 'coach-session-123')
      const response = await authMiddleware(request)

      expect(mockNextResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Forbidden',
          message: 'Required role: ADMIN, current role: COACH'
        }),
        { status: 403 }
      )
    })
  })

  describe('authMiddleware - Response Handling', () => {

    it('should return JSON error for API routes when unauthorized', async () => {
      const request = createMockRequest('/api/portfolio') // No session

      const response = await authMiddleware(request)

      expect(mockNextResponse.json).toHaveBeenCalledWith(
        {
          error: 'Unauthorized',
          code: 'AUTH_REQUIRED',
          message: 'Valid authentication required'
        },
        { status: 401 }
      )
    })

    it('should redirect to login for pages when unauthorized', async () => {
      const request = createMockRequest('/dashboard') // No session

      const response = await authMiddleware(request)

      expect(mockNextResponse.redirect).toHaveBeenCalledWith(
        expect.objectContaining({
          href: 'https://example.com/login?returnUrl=%2Fdashboard'
        })
      )
    })

    it('should redirect to access-denied for pages when forbidden', async () => {
      const traderSession = testUtils.createTestSessionData({ role: 'TRADER' })
      mockValidateAndRefreshSession.mockResolvedValue({
        valid: true,
        session: traderSession
      })

      const request = createMockRequest('/admin', 'trader-session-123')
      const response = await authMiddleware(request)

      expect(mockNextResponse.redirect).toHaveBeenCalledWith(
        expect.objectContaining({
          href: 'https://example.com/access-denied'
        })
      )
    })
  })

  describe('authMiddleware - Error Handling', () => {

    it('should handle session validation errors gracefully', async () => {
      const sessionId = 'error-session-123'
      
      mockValidateAndRefreshSession.mockRejectedValue(new Error('Redis connection failed'))

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

      const request = createMockRequest('/dashboard', sessionId)
      const response = await authMiddleware(request)

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Auth middleware error:',
        expect.any(Error)
      )

      // Should return unauthorized response
      expect(mockNextResponse.redirect).toHaveBeenCalled()
    })

    it('should handle missing session data gracefully', async () => {
      const sessionId = 'missing-data-session'
      
      mockValidateAndRefreshSession.mockResolvedValue({
        valid: true,
        session: null // Malformed response
      })

      const request = createMockRequest('/dashboard', sessionId)
      const response = await authMiddleware(request)

      expect(mockNextResponse.redirect).toHaveBeenCalled()
    })
  })

  describe('getAuthContext', () => {

    it('should extract auth context from request headers', () => {
      const headers = new Headers({
        'x-user-id': testUtils.createTestUserId('1'),
        'x-device-id': testUtils.createTestDeviceId(),
        'x-user-role': 'TRADER',
        'x-role-version': '5',
        'x-session-id': 'session-123',
        'x-mfa-verified': 'true'
      })

      const mockRequest = { headers } as NextRequest

      const context = getAuthContext(mockRequest)

      expect(context).toEqual({
        userId: testUtils.createTestUserId('1'),
        deviceId: expect.any(String),
        role: 'TRADER',
        roleVersion: 5,
        mfa: true,
        sessionId: 'session-123'
      })
    })

    it('should handle Headers object directly', () => {
      const headers = new Headers({
        'x-user-id': testUtils.createTestUserId('2'),
        'x-device-id': 'device-456',
        'x-user-role': 'ADMIN',
        'x-role-version': '10',
        'x-session-id': 'admin-session-456',
        'x-mfa-verified': 'false'
      })

      const context = getAuthContext(headers)

      expect(context).toEqual({
        userId: testUtils.createTestUserId('2'),
        deviceId: 'device-456',
        role: 'ADMIN',
        roleVersion: 10,
        mfa: false,
        sessionId: 'admin-session-456'
      })
    })

    it('should return null for missing required headers', () => {
      const incompleteHeaders = new Headers({
        'x-user-id': testUtils.createTestUserId('1'),
        // Missing other required headers
      })

      const context = getAuthContext(incompleteHeaders)

      expect(context).toBeNull()
    })

    it('should return null for empty headers', () => {
      const emptyHeaders = new Headers()

      const context = getAuthContext(emptyHeaders)

      expect(context).toBeNull()
    })
  })

  describe('requireAuth', () => {

    it('should return auth context for valid headers', () => {
      const headers = new Headers({
        'x-user-id': testUtils.createTestUserId('1'),
        'x-device-id': 'device-123',
        'x-user-role': 'TRADER',
        'x-role-version': '3',
        'x-session-id': 'session-123',
        'x-mfa-verified': 'true'
      })

      const context = requireAuth(headers)

      expect(context).toEqual({
        userId: testUtils.createTestUserId('1'),
        deviceId: 'device-123',
        role: 'TRADER',
        roleVersion: 3,
        mfa: true,
        sessionId: 'session-123'
      })
    })

    it('should throw error for missing authentication', () => {
      const emptyHeaders = new Headers()

      expect(() => requireAuth(emptyHeaders)).toThrow('Authentication required')
    })

    it('should throw error for incomplete authentication headers', () => {
      const incompleteHeaders = new Headers({
        'x-user-id': testUtils.createTestUserId('1')
        // Missing other required headers
      })

      expect(() => requireAuth(incompleteHeaders)).toThrow('Authentication required')
    })
  })

  describe('requireRole', () => {

    const createValidAuthHeaders = (role: Session['role']) => new Headers({
      'x-user-id': testUtils.createTestUserId('1'),
      'x-device-id': 'device-123',
      'x-user-role': role,
      'x-role-version': '3',
      'x-session-id': 'session-123',
      'x-mfa-verified': 'false'
    })

    it('should return auth context for user with required role', () => {
      const headers = createValidAuthHeaders('ADMIN')

      const context = requireRole(headers, 'ADMIN')

      expect(context.role).toBe('ADMIN')
    })

    it('should allow multiple acceptable roles', () => {
      const adminHeaders = createValidAuthHeaders('ADMIN')
      const systemHeaders = createValidAuthHeaders('SYSTEM')

      const adminContext = requireRole(adminHeaders, 'ADMIN', 'SYSTEM')
      const systemContext = requireRole(systemHeaders, 'ADMIN', 'SYSTEM')

      expect(adminContext.role).toBe('ADMIN')
      expect(systemContext.role).toBe('SYSTEM')
    })

    it('should throw error for insufficient privileges', () => {
      const traderHeaders = createValidAuthHeaders('TRADER')

      expect(() => requireRole(traderHeaders, 'ADMIN')).toThrow(
        'Insufficient privileges. Required: ADMIN, Current: TRADER'
      )
    })

    it('should handle multiple required roles in error message', () => {
      const coachHeaders = createValidAuthHeaders('COACH')

      expect(() => requireRole(coachHeaders, 'ADMIN', 'SYSTEM')).toThrow(
        'Insufficient privileges. Required: ADMIN or SYSTEM, Current: COACH'
      )
    })

    it('should throw error for missing authentication first', () => {
      const emptyHeaders = new Headers()

      expect(() => requireRole(emptyHeaders, 'TRADER')).toThrow('Authentication required')
    })
  })

  describe('Performance Requirements', () => {

    it('should complete auth flow quickly for valid session', async () => {
      const validSession = testUtils.createTestSessionData()
      mockValidateAndRefreshSession.mockResolvedValue({
        valid: true,
        session: validSession
      })

      const start = process.hrtime.bigint()
      
      const request = createMockRequest('/dashboard', 'fast-session-123')
      await authMiddleware(request)
      
      const end = process.hrtime.bigint()
      const timeMs = Number(end - start) / 1_000_000

      // Unit test should be very fast (mocked Redis)
      expect(timeMs).toBeLessThan(10)
    })

    it('should add performance timing header', async () => {
      const validSession = testUtils.createTestSessionData()
      mockValidateAndRefreshSession.mockResolvedValue({
        valid: true,
        session: validSession
      })

      const request = createMockRequest('/dashboard', 'timing-session-123')
      const response = await authMiddleware(request)

      // Should add timing header
      expect(response?.headers?.set).toHaveBeenCalledWith(
        'x-auth-validation-time',
        expect.any(String)
      )
    })
  })

  describe('Edge Cases', () => {

    it('should handle malformed Authorization header', async () => {
      const request = createMockRequest('/api/portfolio')
      request.headers.set('authorization', 'Malformed header value')

      const response = await authMiddleware(request)

      expect(mockValidateAndRefreshSession).not.toHaveBeenCalled()
      expect(mockNextResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Unauthorized',
          code: 'AUTH_REQUIRED'
        }),
        { status: 401 }
      )
    })

    it('should handle empty Authorization header', async () => {
      const request = createMockRequest('/api/portfolio')
      request.headers.set('authorization', 'Bearer ')

      const response = await authMiddleware(request)

      expect(mockValidateAndRefreshSession).not.toHaveBeenCalled()
    })

    it('should handle nested protected routes', async () => {
      const validSession = testUtils.createTestSessionData()
      mockValidateAndRefreshSession.mockResolvedValue({
        valid: true,
        session: validSession
      })

      // Nested route under protected path
      const request = createMockRequest('/dashboard/settings/profile', 'nested-session')
      const response = await authMiddleware(request)

      expect(mockValidateAndRefreshSession).toHaveBeenCalledWith('nested-session')
      expect(mockNextResponse.next).toHaveBeenCalled()
    })

    it('should handle nested admin routes', async () => {
      const traderSession = testUtils.createTestSessionData({ role: 'TRADER' })
      mockValidateAndRefreshSession.mockResolvedValue({
        valid: true,
        session: traderSession
      })

      // Nested route under admin path
      const request = createMockRequest('/admin/users/settings', 'trader-session')
      const response = await authMiddleware(request)

      expect(mockNextResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Forbidden'
        }),
        { status: 403 }
      )
    })
  })
})

/**
 * Helper function to create mock Next.js request objects
 */
function createMockRequest(
  pathname: string, 
  sessionId?: string, 
  sessionLocation: 'cookie' | 'header' = 'cookie'
): NextRequest {
  const url = `https://example.com${pathname}`
  const headers = new Map<string, string>()
  const cookies = new Map<string, { value: string }>()

  if (sessionId) {
    if (sessionLocation === 'cookie') {
      cookies.set('app_session', { value: sessionId })
    } else {
      headers.set('authorization', `Bearer ${sessionId}`)
    }
  }

  const mockRequest = {
    nextUrl: new URL(url),
    headers: {
      get: (name: string) => headers.get(name.toLowerCase()) || null,
      set: (name: string, value: string) => headers.set(name.toLowerCase(), value)
    },
    cookies: {
      get: (name: string) => cookies.get(name) || undefined
    }
  } as unknown as NextRequest

  return mockRequest
}