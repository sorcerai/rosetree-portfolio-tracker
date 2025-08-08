import { vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'

/**
 * Global Test Setup
 * 
 * Configures the testing environment with:
 * - Fake timers for deterministic time-based tests
 * - Global mocks for external dependencies
 * - Environment variable validation
 * - Cleanup procedures
 */

// Mock external dependencies that should not be called during tests
vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getUser: vi.fn(),
      getSession: vi.fn(),
      signInWithOAuth: vi.fn(),
      exchangeCodeForSession: vi.fn()
    }
  }))
}))

// Mock Next.js modules that may not be available in Node test environment
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn()
  })),
  useSearchParams: vi.fn(() => new URLSearchParams()),
  usePathname: vi.fn(() => '/test')
}))

vi.mock('next/headers', () => ({
  headers: vi.fn(() => new Headers()),
  cookies: vi.fn(() => ({
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn()
  }))
}))

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn()
}))

// Global test hooks
beforeAll(() => {
  // Validate test environment
  validateTestEnvironment()
  
  // Set consistent timezone for all tests
  process.env.TZ = 'UTC'
  
  // Suppress console.log in tests unless explicitly needed
  if (!process.env.VERBOSE_TESTS) {
    vi.spyOn(console, 'log').mockImplementation(() => {})
  }
  
  // Suppress console.warn for expected warnings in tests
  const originalWarn = console.warn
  vi.spyOn(console, 'warn').mockImplementation((message: string, ...args) => {
    // Allow warnings that we explicitly want to test
    if (message.includes('Auth failed on') || 
        message.includes('Session validation') ||
        message.includes('OAuth callback error')) {
      originalWarn(message, ...args)
    }
    // Suppress other warnings during tests
  })
})

afterAll(() => {
  // Restore all mocks
  vi.restoreAllMocks()
  
  // Reset environment
  delete process.env.TZ
})

beforeEach(() => {
  // Use fake timers for each test (can be overridden per test)
  vi.useFakeTimers()
  
  // Set consistent test time: 2025-08-08 12:00:00 UTC
  const testDate = new Date('2025-08-08T12:00:00.000Z')
  vi.setSystemTime(testDate)
  
  // Clear all mocks before each test
  vi.clearAllMocks()
})

afterEach(() => {
  // Restore real timers after each test
  vi.useRealTimers()
  
  // Clear any pending timers or intervals
  vi.clearAllTimers()
})

/**
 * Validate that required environment variables are set for testing
 */
function validateTestEnvironment() {
  const requiredEnvVars = [
    'JWT_SECRET',
    'WS_JWT_SECRET',
    'NEXT_PUBLIC_APP_URL'
  ]
  
  const missing = requiredEnvVars.filter(varName => !process.env[varName])
  
  if (missing.length > 0) {
    throw new Error(
      `Missing required test environment variables: ${missing.join(', ')}\n` +
      'Please check your vitest.config.ts env configuration.'
    )
  }
  
  // Validate test secrets are not production values
  if (process.env.JWT_SECRET === 'your-production-secret-here') {
    throw new Error('Test environment is using production JWT secret!')
  }
}

/**
 * Test utilities available globally
 */
declare global {
  namespace Vi {
    interface AsymmetricMatchersContaining {
      toBeValidSessionId(): any
      toBeValidUUID(): any
      toBeRecentTimestamp(): any
    }
  }
}

// Custom matchers for authentication testing
expect.extend({
  /**
   * Check if value is a valid session ID (base64url, 43 chars)
   */
  toBeValidSessionId(received: string) {
    const sessionIdRegex = /^[A-Za-z0-9_-]{43}$/
    const pass = typeof received === 'string' && sessionIdRegex.test(received)
    
    return {
      pass,
      message: () => pass
        ? `Expected ${received} not to be a valid session ID`
        : `Expected ${received} to be a valid session ID (43 char base64url)`
    }
  },
  
  /**
   * Check if value is a valid UUID v4
   */
  toBeValidUUID(received: string) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    const pass = typeof received === 'string' && uuidRegex.test(received)
    
    return {
      pass,
      message: () => pass
        ? `Expected ${received} not to be a valid UUID`
        : `Expected ${received} to be a valid UUID v4`
    }
  },
  
  /**
   * Check if timestamp is within last 5 seconds of current time
   */
  toBeRecentTimestamp(received: number) {
    const now = Date.now()
    const fiveSecondsAgo = now - (5 * 1000)
    const pass = received >= fiveSecondsAgo && received <= now
    
    return {
      pass,
      message: () => pass
        ? `Expected ${received} not to be a recent timestamp`
        : `Expected ${received} to be within last 5 seconds (${fiveSecondsAgo} - ${now})`
    }
  }
})

/**
 * Export test utilities for use in individual test files
 */
export const testUtils = {
  /**
   * Create a deterministic test user ID
   */
  createTestUserId: (suffix: string = '1') => 
    `00000000-0000-4000-8000-00000000000${suffix}`,
  
  /**
   * Create a test email address
   */
  createTestEmail: (prefix: string = 'test') => 
    `${prefix}@example.com`,
  
  /**
   * Create test device fingerprint
   */
  createTestDeviceId: () => 
    `test-device-${Math.random().toString(36).substr(2, 9)}`,
  
  /**
   * Fast forward time and run pending timers
   */
  fastForwardTime: async (ms: number) => {
    vi.advanceTimersByTime(ms)
    await vi.runAllTimersAsync()
  },
  
  /**
   * Wait for next tick (useful for async operations)
   */
  waitForNextTick: () => new Promise(resolve => process.nextTick(resolve)),
  
  /**
   * Generate test session data
   */
  createTestSessionData: (overrides: Partial<any> = {}) => ({
    v: 1,
    uid: testUtils.createTestUserId(),
    did: testUtils.createTestDeviceId(),
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60), // 30 days
    idleExp: Math.floor(Date.now() / 1000) + (12 * 60 * 60), // 12 hours
    rc: 0,
    mfa: false,
    role: 'TRADER' as const,
    roleVersion: 1,
    ...overrides
  })
}

// Export for use in test files
export { vi, expect } from 'vitest'