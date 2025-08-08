import { describe, it, expect } from 'vitest'
import { testUtils } from '@tests/setup/global-setup'

/**
 * Simple Unit Test to validate testing infrastructure
 * 
 * This test validates that the testing setup is working correctly
 * without complex mocking or external dependencies
 */

describe('Testing Infrastructure Validation', () => {
  
  it('should validate test utilities work correctly', () => {
    // Test user ID generation
    const userId1 = testUtils.createTestUserId('1')
    const userId2 = testUtils.createTestUserId('2')
    
    expect(userId1).toBeValidUUID()
    expect(userId2).toBeValidUUID()
    expect(userId1).not.toBe(userId2)
    expect(userId1).toBe('00000000-0000-4000-8000-0000000000001')
  })
  
  it('should validate custom matchers work', () => {
    // Test session ID matcher
    const validSessionId = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG'
    const invalidSessionId = 'invalid-session'
    
    expect(validSessionId).toBeValidSessionId()
    expect(invalidSessionId).not.toBeValidSessionId()
  })
  
  it('should validate UUID matcher works', () => {
    const validUuid = '123e4567-e89b-12d3-a456-426614174000'
    const invalidUuid = 'not-a-uuid'
    
    expect(validUuid).toBeValidUUID()
    expect(invalidUuid).not.toBeValidUUID()
  })
  
  it('should validate test session data generation', () => {
    const sessionData = testUtils.createTestSessionData({
      role: 'ADMIN',
      mfa: true
    })
    
    expect(sessionData).toMatchObject({
      v: 1,
      role: 'ADMIN',
      mfa: true,
      rc: 0
    })
    
    expect(sessionData.uid).toBeValidUUID()
    expect(sessionData.iat).toBeTypeOf('number')
    expect(sessionData.exp).toBeGreaterThan(sessionData.iat)
    expect(sessionData.idleExp).toBeGreaterThan(sessionData.iat)
  })
  
  it('should validate environment is set up correctly', () => {
    // Test that environment variables are available
    expect(process.env.NODE_ENV).toBe('test')
    expect(process.env.JWT_SECRET).toBeDefined()
    expect(process.env.NEXT_PUBLIC_APP_URL).toBeDefined()
  })
  
  it('should validate time utilities work', async () => {
    const start = Date.now()
    
    // Fast forward time
    await testUtils.fastForwardTime(1000)
    
    // In test environment with fake timers, the real Date.now() shouldn't change much
    const end = Date.now()
    expect(end - start).toBeLessThan(100) // Should be very fast since it's fake time
  })
})

describe('Test Performance Validation', () => {
  
  it('should run unit tests very quickly', async () => {
    const start = process.hrtime.bigint()
    
    // Simple operations that should be instant
    for (let i = 0; i < 1000; i++) {
      const userId = testUtils.createTestUserId(i.toString())
      expect(userId).toBeValidUUID()
    }
    
    const end = process.hrtime.bigint()
    const timeMs = Number(end - start) / 1_000_000
    
    // Should be very fast for unit tests
    expect(timeMs).toBeLessThan(50)
  })
})