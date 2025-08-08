import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestContainers, stopTestContainers, type TestContainers } from '@tests/setup/testcontainers'
import { setTestDatabasePool, withRLS } from '@/lib/db/rls-context'
import { createSession } from '@/lib/auth/session-v2'
import { authMiddleware, getAuthContext, requireAuth, requireRole } from '@/lib/auth/middleware'
import { NextRequest } from 'next/server'
import { sql } from 'drizzle-orm'
import { testUtils } from '@tests/setup/global-setup'

/**
 * 🔒 RBAC SECURITY MATRIX TESTS
 * 
 * Comprehensive testing of Role-Based Access Control (RBAC) for portfolio tracking applications.
 * This test suite validates the complete security matrix of user roles and permissions:
 * 
 * ROLE HIERARCHY:
 * - TRADER: Basic access to own portfolios and holdings
 * - COACH: Access to own data + limited coaching features  
 * - ADMIN: Full system access + user management
 * - SYSTEM: Unrestricted access for system operations
 * 
 * SECURITY LAYERS:
 * 1. Database RLS policies (table-level isolation)
 * 2. Application middleware (route-level protection)
 * 3. API authorization (resource-level access)
 * 4. Cross-role data isolation validation
 * 
 * Based on portfolio management security requirements
 */

let containers: TestContainers

// Test user matrix for comprehensive RBAC testing
const TEST_USERS = [
  { role: 'TRADER' as const, suffix: 'trader', description: 'Basic portfolio management' },
  { role: 'COACH' as const, suffix: 'coach', description: 'Coaching and mentoring features' },
  { role: 'ADMIN' as const, suffix: 'admin', description: 'Full system administration' },
  { role: 'SYSTEM' as const, suffix: 'system', description: 'System-level operations' }
] as const

// Route access matrix - defines which roles can access which routes
const ROUTE_ACCESS_MATRIX = {
  // Public routes (all roles)
  '/': ['TRADER', 'COACH', 'ADMIN', 'SYSTEM'],
  '/login': ['TRADER', 'COACH', 'ADMIN', 'SYSTEM'],
  
  // User routes (authenticated users)
  '/dashboard': ['TRADER', 'COACH', 'ADMIN', 'SYSTEM'],
  '/portfolio': ['TRADER', 'COACH', 'ADMIN', 'SYSTEM'],
  '/holdings': ['TRADER', 'COACH', 'ADMIN', 'SYSTEM'],
  
  // API routes (authenticated users)
  '/api/portfolio': ['TRADER', 'COACH', 'ADMIN', 'SYSTEM'],
  '/api/holdings': ['TRADER', 'COACH', 'ADMIN', 'SYSTEM'],
  '/api/auth/refresh': ['TRADER', 'COACH', 'ADMIN', 'SYSTEM'],
  
  // Coach-only routes
  '/coaching': ['COACH', 'ADMIN', 'SYSTEM'],
  '/api/coaching': ['COACH', 'ADMIN', 'SYSTEM'],
  
  // Admin-only routes
  '/admin': ['ADMIN', 'SYSTEM'],
  '/admin/users': ['ADMIN', 'SYSTEM'],
  '/api/admin': ['ADMIN', 'SYSTEM'],
  '/api/admin/users': ['ADMIN', 'SYSTEM'],
  '/api/system': ['ADMIN', 'SYSTEM']
} as const

describe('RBAC Security Matrix Tests', () => {
  
  beforeAll(async () => {
    console.log('🔒 Starting RBAC security matrix validation...')
    containers = await startTestContainers()
    setTestDatabasePool(containers.postgres.pool)
    
    // Override Redis for session testing
    process.env.REDIS_URL = containers.redis.url
  }, 60000)

  afterAll(async () => {
    if (containers) {
      await stopTestContainers()
    }
  })

  beforeEach(async () => {
    // Clear Redis sessions between tests
    await containers.redis.client.flushdb()
  })

  describe('Database RLS Role Isolation', () => {

    it('should enforce data isolation between all user roles', async () => {
      console.log('🔍 Testing database-level role isolation...')
      
      const testResults = []
      
      for (const userRole of TEST_USERS) {
        const userId = testUtils.createTestUserId(userRole.suffix)
        
        // Test data access for each role
        const portfolios = await withRLS(
          { userId, roles: [userRole.role] },
          async (db) => {
            const result = await db.execute(sql`
              SELECT p.id, p.user_id, p.name, u.email, u.role
              FROM portfolios p
              JOIN users u ON p.user_id = u.id
              ORDER BY p.created_at
            `)
            return result.rows
          }
        )
        
        const users = await withRLS(
          { userId, roles: [userRole.role] },
          async (db) => {
            const result = await db.execute(sql`
              SELECT id, email, role FROM users ORDER BY created_at
            `)
            return result.rows
          }
        )
        
        console.log(`   ${userRole.role}: sees ${portfolios.length} portfolios, ${users.length} users`)
        
        // Validate role-based data access
        if (userRole.role === 'ADMIN' || userRole.role === 'SYSTEM') {
          // Admin/System should see all data
          testResults.push({
            role: userRole.role,
            canSeeAllPortfolios: portfolios.length >= 3,
            canSeeAllUsers: users.length >= 3,
            hasElevatedAccess: true
          })
        } else {
          // Regular users should only see their own data
          const ownPortfolios = portfolios.filter(p => p.user_id === userId)
          const ownUsers = users.filter(u => u.id === userId)
          
          testResults.push({
            role: userRole.role,
            canSeeAllPortfolios: false,
            canSeeAllUsers: false,
            seesOnlyOwnData: ownPortfolios.length === portfolios.length && ownUsers.length === users.length,
            hasDataIsolation: portfolios.every(p => p.user_id === userId)
          })
        }
      }
      
      // Assert security requirements
      testResults.forEach(result => {
        if (result.role === 'ADMIN' || result.role === 'SYSTEM') {
          expect(result.canSeeAllPortfolios).toBe(true)
          expect(result.canSeeAllUsers).toBe(true)
        } else {
          expect(result.seesOnlyOwnData).toBe(true)
          expect(result.hasDataIsolation).toBe(true)
        }
      })
    })

    it('should prevent cross-role data leakage', async () => {
      console.log('🔍 Testing cross-role data leakage prevention...')
      
      const traderUserId = testUtils.createTestUserId('trader')
      const coachUserId = testUtils.createTestUserId('coach')
      
      // Trader tries to access Coach's data
      const traderViewsCoachData = await withRLS(
        { userId: traderUserId, roles: ['TRADER'] },
        async (db) => {
          const result = await db.execute(sql`
            SELECT p.id, p.user_id 
            FROM portfolios p 
            WHERE p.user_id = ${sql.raw(`'${coachUserId}'`)}
          `)
          return result.rows
        }
      )
      
      // Coach tries to access Trader's data  
      const coachViewsTraderData = await withRLS(
        { userId: coachUserId, roles: ['COACH'] },
        async (db) => {
          const result = await db.execute(sql`
            SELECT p.id, p.user_id 
            FROM portfolios p 
            WHERE p.user_id = ${sql.raw(`'${traderUserId}'`)}
          `)
          return result.rows
        }
      )
      
      // Both should return empty results (no cross-role access)
      expect(traderViewsCoachData.length).toBe(0)
      expect(coachViewsTraderData.length).toBe(0)
      
      console.log('✅ Cross-role data leakage prevented successfully')
    })
  })

  describe('Middleware Route Protection', () => {

    it('should enforce route access matrix correctly', async () => {
      console.log('🔍 Testing route access matrix enforcement...')
      
      // Create sessions for each role
      const sessionsByRole = new Map()
      
      for (const userRole of TEST_USERS) {
        const { sessionId } = await createSession({
          userId: testUtils.createTestUserId(userRole.suffix),
          deviceId: testUtils.createTestDeviceId(),
          role: userRole.role
        })
        sessionsByRole.set(userRole.role, sessionId)
      }
      
      const testResults = []
      
      // Test each route against each role
      for (const [route, allowedRoles] of Object.entries(ROUTE_ACCESS_MATRIX)) {
        for (const userRole of TEST_USERS) {
          const sessionId = sessionsByRole.get(userRole.role)
          const request = createTestRequest(route, sessionId)
          
          const response = await authMiddleware(request)
          const shouldHaveAccess = allowedRoles.includes(userRole.role)
          
          // Check if access was granted/denied as expected
          const hasAccess = response.headers.get('x-user-role') === userRole.role
          const isRedirect = response.status === 302
          const isUnauthorized = response.status === 401 || response.status === 403
          
          testResults.push({
            route,
            role: userRole.role,
            shouldHaveAccess,
            hasAccess: hasAccess || (!isRedirect && !isUnauthorized),
            actualResponse: hasAccess ? 'granted' : (isRedirect ? 'redirect' : 'denied')
          })
        }
      }
      
      // Analyze results
      const failures = testResults.filter(r => r.shouldHaveAccess !== r.hasAccess)
      
      console.log(`📊 Route Access Results: ${testResults.length} tests, ${failures.length} failures`)
      
      if (failures.length > 0) {
        console.log('❌ Access control failures:')
        failures.forEach(f => {
          console.log(`   ${f.route} + ${f.role}: expected ${f.shouldHaveAccess ? 'ALLOW' : 'DENY'}, got ${f.actualResponse}`)
        })
      }
      
      // Assert no security failures
      expect(failures.length).toBe(0)
    })

    it('should handle admin route protection specifically', async () => {
      console.log('🔍 Testing admin route protection...')
      
      const adminRoutes = ['/admin', '/admin/users', '/api/admin', '/api/system']
      const results = []
      
      for (const route of adminRoutes) {
        // Test non-admin access (should be denied)
        for (const role of ['TRADER', 'COACH']) {
          const { sessionId } = await createSession({
            userId: testUtils.createTestUserId(`${role.toLowerCase()}-denied`),
            deviceId: testUtils.createTestDeviceId(),
            role: role as 'TRADER' | 'COACH'
          })
          
          const request = createTestRequest(route, sessionId)
          const response = await authMiddleware(request)
          
          const isDenied = response.status === 302 || response.status === 403
          results.push({
            route,
            role,
            isDenied,
            expectedDenied: true
          })
        }
        
        // Test admin access (should be allowed)
        for (const role of ['ADMIN', 'SYSTEM']) {
          const { sessionId } = await createSession({
            userId: testUtils.createTestUserId(`${role.toLowerCase()}-allowed`),
            deviceId: testUtils.createTestDeviceId(),
            role: role as 'ADMIN' | 'SYSTEM'
          })
          
          const request = createTestRequest(route, sessionId)
          const response = await authMiddleware(request)
          
          const isAllowed = response.headers.get('x-user-role') === role
          results.push({
            route,
            role,
            isAllowed,
            expectedAllowed: true
          })
        }
      }
      
      // Verify all admin protections work
      const failures = results.filter(r => 
        (r.expectedDenied && !r.isDenied) || (r.expectedAllowed && !r.isAllowed)
      )
      
      console.log(`📊 Admin Route Protection: ${results.length} tests, ${failures.length} failures`)
      expect(failures.length).toBe(0)
    })
  })

  describe('API Authorization Helpers', () => {

    it('should validate requireAuth helper correctly', async () => {
      // Test with valid auth headers
      const validHeaders = new Headers({
        'x-user-id': testUtils.createTestUserId('auth-test'),
        'x-device-id': testUtils.createTestDeviceId(),
        'x-user-role': 'TRADER',
        'x-role-version': '1',
        'x-session-id': 'test-session-123',
        'x-mfa-verified': 'true'
      })
      
      const context = requireAuth(validHeaders)
      expect(context).toBeDefined()
      expect(context.role).toBe('TRADER')
      expect(context.mfa).toBe(true)
      
      // Test with missing auth headers
      const emptyHeaders = new Headers()
      expect(() => requireAuth(emptyHeaders)).toThrow('Authentication required')
    })

    it('should validate requireRole helper with role hierarchy', async () => {
      const createRoleHeaders = (role: string) => new Headers({
        'x-user-id': testUtils.createTestUserId('role-test'),
        'x-device-id': testUtils.createTestDeviceId(),
        'x-user-role': role,
        'x-role-version': '1',
        'x-session-id': 'test-session-123',
        'x-mfa-verified': 'false'
      })
      
      // Test ADMIN role requirement
      const adminHeaders = createRoleHeaders('ADMIN')
      const systemHeaders = createRoleHeaders('SYSTEM')
      const traderHeaders = createRoleHeaders('TRADER')
      
      // Admin and System should pass admin requirement
      expect(() => requireRole(adminHeaders, 'ADMIN')).not.toThrow()
      expect(() => requireRole(systemHeaders, 'ADMIN', 'SYSTEM')).not.toThrow()
      
      // Trader should fail admin requirement
      expect(() => requireRole(traderHeaders, 'ADMIN')).toThrow(/Insufficient privileges/)
      
      // Multi-role requirements
      expect(() => requireRole(adminHeaders, 'ADMIN', 'SYSTEM')).not.toThrow()
      expect(() => requireRole(systemHeaders, 'ADMIN', 'SYSTEM')).not.toThrow()
      expect(() => requireRole(traderHeaders, 'ADMIN', 'SYSTEM')).toThrow(/ADMIN or SYSTEM/)
    })

    it('should validate getAuthContext extraction', async () => {
      const testHeaders = new Headers({
        'x-user-id': testUtils.createTestUserId('context-test'),
        'x-device-id': 'device-12345',
        'x-user-role': 'COACH',
        'x-role-version': '5',
        'x-session-id': 'session-67890',
        'x-mfa-verified': 'true'
      })
      
      const context = getAuthContext(testHeaders)
      
      expect(context).toEqual({
        userId: testUtils.createTestUserId('context-test'),
        deviceId: 'device-12345',
        role: 'COACH',
        roleVersion: 5,
        sessionId: 'session-67890',
        mfa: true
      })
      
      // Test with incomplete headers
      const incompleteHeaders = new Headers({
        'x-user-id': testUtils.createTestUserId('incomplete')
      })
      
      expect(getAuthContext(incompleteHeaders)).toBeNull()
    })
  })

  describe('Security Edge Cases', () => {

    it('should handle role escalation attempts', async () => {
      // Create a TRADER session
      const { sessionId } = await createSession({
        userId: testUtils.createTestUserId('escalation-test'),
        deviceId: testUtils.createTestDeviceId(),
        role: 'TRADER'
      })
      
      // Try to access admin route with trader session
      const request = createTestRequest('/admin', sessionId)
      const response = await authMiddleware(request)
      
      // Should be denied access
      expect(response.status).toBeOneOf([302, 403])
      expect(response.headers.get('x-user-role')).not.toBe('ADMIN')
    })

    it('should handle session tampering attempts', async () => {
      // Create valid session
      const { sessionId } = await createSession({
        userId: testUtils.createTestUserId('tamper-test'),
        deviceId: testUtils.createTestDeviceId(),
        role: 'TRADER'
      })
      
      // Tamper with the session ID
      const tamperedSessionId = sessionId.replace(/.$/, 'X') // Change last character
      
      const request = createTestRequest('/dashboard', tamperedSessionId)
      const response = await authMiddleware(request)
      
      // Should be denied access
      expect(response.status).toBe(302)
      expect(response.headers.get('location')).toContain('/login')
    })

    it('should handle concurrent role changes', async () => {
      const userId = testUtils.createTestUserId('role-change-test')
      
      // Create initial session
      const { sessionId } = await createSession({
        userId,
        deviceId: testUtils.createTestDeviceId(),
        role: 'TRADER'
      })
      
      // Verify initial access works
      let request = createTestRequest('/dashboard', sessionId)
      let response = await authMiddleware(request)
      expect(response.headers.get('x-user-role')).toBe('TRADER')
      
      // Simulate role change (this would trigger role version increment)
      // In a real system, this would be done through admin tools
      // For test, we'll create a new session with different role for same user
      const { sessionId: newSessionId } = await createSession({
        userId,
        deviceId: testUtils.createTestDeviceId(),
        role: 'ADMIN'
      })
      
      // New session should work with admin role
      request = createTestRequest('/admin', newSessionId)
      response = await authMiddleware(request)
      expect(response.headers.get('x-user-role')).toBe('ADMIN')
      
      // Old session should still work but with old role (no access to admin)
      request = createTestRequest('/admin', sessionId)
      response = await authMiddleware(request)
      expect(response.status).toBeOneOf([302, 403]) // Should be denied admin access
    })
  })

  describe('Performance Under Security Load', () => {

    it('should maintain performance with complex role checks', async () => {
      console.log('⚡ Testing RBAC performance under load...')
      
      // Create sessions for different roles
      const sessions = await Promise.all(
        TEST_USERS.map(async (userRole) => {
          const { sessionId } = await createSession({
            userId: testUtils.createTestUserId(`perf-${userRole.suffix}`),
            deviceId: testUtils.createTestDeviceId(),
            role: userRole.role
          })
          return { role: userRole.role, sessionId }
        })
      )
      
      // Test concurrent role-based access
      const concurrentRequests = 50
      const promises = []
      
      for (let i = 0; i < concurrentRequests; i++) {
        const session = sessions[i % sessions.length]
        const route = i % 2 === 0 ? '/dashboard' : '/api/portfolio'
        
        const request = createTestRequest(route, session.sessionId)
        promises.push(authMiddleware(request))
      }
      
      const startTime = process.hrtime.bigint()
      const responses = await Promise.all(promises)
      const endTime = process.hrtime.bigint()
      
      const totalTimeMs = Number(endTime - startTime) / 1_000_000
      const avgTimeMs = totalTimeMs / concurrentRequests
      
      console.log(`📊 RBAC Performance: ${concurrentRequests} requests in ${totalTimeMs.toFixed(2)}ms (avg: ${avgTimeMs.toFixed(2)}ms)`)
      
      // Verify all requests were processed correctly
      responses.forEach((response, i) => {
        const session = sessions[i % sessions.length]
        expect(response.headers.get('x-user-role')).toBe(session.role)
      })
      
      // Performance should be acceptable even with complex RBAC
      expect(avgTimeMs).toBeLessThan(50) // Allow reasonable time for complex role checks
    })
  })
})

/**
 * Helper to create test requests for middleware testing
 */
function createTestRequest(pathname: string, sessionId?: string): NextRequest {
  const url = `http://localhost:3000${pathname}`
  const headers = new Headers()
  
  if (sessionId) {
    headers.set('cookie', `app_session=${sessionId}`)
  }
  
  return new NextRequest(url, {
    headers,
    method: 'GET'
  })
}

/**
 * Custom Vitest matcher for multiple possible values
 */
expect.extend({
  toBeOneOf(received: any, expected: any[]) {
    const pass = expected.includes(received)
    return {
      pass,
      message: () => `expected ${received} to be one of ${expected.join(', ')}`
    }
  }
})