import { describe, it, expect, vi } from 'vitest'

/**
 * Adapter Implementation Tests
 * 
 * Verifies that all authentication service adapters implement
 * their respective ports correctly and can be instantiated
 * without errors. These tests focus on interface compliance
 * and basic functionality rather than full integration.
 * 
 * Based on Codex recommendations for port/adapter testing
 */

// Mock Redis for testing
vi.mock('ioredis', () => ({
  default: vi.fn(() => ({
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
    ping: vi.fn()
  }))
}))

// Mock database context dependencies
vi.mock('@/lib/db/rls-context', () => ({
  withRLS: vi.fn(),
  withSystemContext: vi.fn(),
  withAdminContext: vi.fn(),
  getPoolStats: vi.fn(() => ({
    totalCount: 5,
    idleCount: 3,
    waitingCount: 0
  }))
}))

describe('Authentication Service Adapters', () => {
  
  describe('RedisSessionStore', () => {
    it('should implement SessionStore interface correctly', async () => {
      const { RedisSessionStore } = await import('@/lib/auth/adapters/redis-session-store')
      
      // Mock Redis instance
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
          exec: vi.fn().mockResolvedValue([])
        })),
        ping: vi.fn()
      }
      
      const sessionStore = new RedisSessionStore(mockRedis as any)
      
      // Verify interface methods exist
      expect(typeof sessionStore.get).toBe('function')
      expect(typeof sessionStore.set).toBe('function')  
      expect(typeof sessionStore.del).toBe('function')
      expect(typeof sessionStore.getUserSessions).toBe('function')
      expect(typeof sessionStore.delUserSessions).toBe('function')
      expect(typeof sessionStore.health).toBe('function')
      expect(typeof sessionStore.incr).toBe('function')
      expect(typeof sessionStore.getUserSessionCount).toBe('function')
    })
    
    it('should handle basic session operations', async () => {
      const { RedisSessionStore } = await import('@/lib/auth/adapters/redis-session-store')
      
      const mockRedis = {
        get: vi.fn().mockResolvedValue('{"uid":"test-user","v":1}'),
        set: vi.fn().mockResolvedValue('OK'),
        del: vi.fn(),
        incr: vi.fn(),
        smembers: vi.fn(),
        sadd: vi.fn(),
        srem: vi.fn(),
        scard: vi.fn().mockResolvedValue(2),
        pipeline: vi.fn(() => ({
          set: vi.fn(),
          del: vi.fn(),
          sadd: vi.fn(),
          srem: vi.fn(),
          incr: vi.fn(),
          exec: vi.fn().mockResolvedValue([])
        })),
        ping: vi.fn().mockResolvedValue('PONG')
      }
      
      const sessionStore = new RedisSessionStore(mockRedis as any)
      
      // Test session retrieval
      const session = await sessionStore.get('test-session-id')
      expect(session).toEqual({ uid: 'test-user', v: 1 })
      
      // Test session count
      const count = await sessionStore.getUserSessionCount('test-user')
      expect(count).toBe(2)
      
      // Test health check
      const health = await sessionStore.health()
      expect(health.connected).toBe(true)
    })
  })
  
  describe('PostgresUserRepository', () => {
    it('should implement UserRepository interface correctly', async () => {
      const { PostgresUserRepository } = await import('@/lib/auth/adapters/postgres-user-repository')
      
      const userRepository = new PostgresUserRepository()
      
      // Verify interface methods exist
      expect(typeof userRepository.findById).toBe('function')
      expect(typeof userRepository.findByEmail).toBe('function')
      expect(typeof userRepository.provisionUser).toBe('function')
      expect(typeof userRepository.updateRole).toBe('function')
      expect(typeof userRepository.getRoleVersion).toBe('function')
    })
  })
  
  describe('JWTTokenService', () => {
    it('should implement TokenService interface correctly', async () => {
      const { JWTTokenService } = await import('@/lib/auth/adapters/jwt-token-service')
      
      const tokenService = new JWTTokenService({
        jwtSecret: 'test-secret',
        wsSecret: 'test-ws-secret',
        issuer: 'test-issuer'
      })
      
      // Verify interface methods exist
      expect(typeof tokenService.issue).toBe('function')
      expect(typeof tokenService.verify).toBe('function')
      expect(typeof tokenService.issueOneTime).toBe('function')
      expect(typeof tokenService.consumeOneTime).toBe('function')
    })
    
    it('should issue and verify tokens correctly', async () => {
      const { JWTTokenService } = await import('@/lib/auth/adapters/jwt-token-service')
      
      const tokenService = new JWTTokenService({
        jwtSecret: 'test-secret',
        wsSecret: 'test-ws-secret',
        issuer: 'test-issuer'
      })
      
      const payload = {
        userId: 'test-user',
        role: 'TRADER' as const,
        deviceId: 'test-device'
      }
      
      // Issue token
      const token = await tokenService.issue(payload, 3600)
      expect(typeof token).toBe('string')
      expect(token.split('.').length).toBe(3) // JWT format
      
      // Verify token
      const verified = await tokenService.verify(token)
      expect(verified).toMatchObject({
        userId: payload.userId,
        role: payload.role,
        deviceId: payload.deviceId
      })
    })
    
    it('should handle one-time tokens correctly', async () => {
      const { JWTTokenService } = await import('@/lib/auth/adapters/jwt-token-service')
      
      const tokenService = new JWTTokenService({
        jwtSecret: 'test-secret', 
        wsSecret: 'test-ws-secret',
        issuer: 'test-issuer'
      })
      
      const payload = {
        userId: 'test-user',
        role: 'TRADER' as const,
        sessionId: 'test-session'
      }
      
      // Issue one-time token
      const oneTimeToken = await tokenService.issueOneTime(payload, 60)
      expect(typeof oneTimeToken).toBe('string')
      
      // Consume token (should work once)
      const consumed = await tokenService.consumeOneTime(oneTimeToken)
      expect(consumed).toMatchObject({
        userId: payload.userId,
        role: payload.role,
        sessionId: payload.sessionId
      })
      
      // Try to consume again (should fail)
      const consumedAgain = await tokenService.consumeOneTime(oneTimeToken)
      expect(consumedAgain).toBeNull()
    })
  })
  
  describe('RLSDatabaseContext', () => {
    it('should implement DatabaseContext interface correctly', async () => {
      const { RLSDatabaseContext } = await import('@/lib/auth/adapters/rls-database-context')
      
      const databaseContext = new RLSDatabaseContext()
      
      // Verify interface methods exist
      expect(typeof databaseContext.withUserContext).toBe('function')
      expect(typeof databaseContext.withSystemContext).toBe('function')
      expect(typeof databaseContext.withAdminContext).toBe('function')
      expect(typeof databaseContext.getPoolStats).toBe('function')
    })
    
    it('should return pool stats', async () => {
      const { RLSDatabaseContext } = await import('@/lib/auth/adapters/rls-database-context')
      
      const databaseContext = new RLSDatabaseContext()
      const stats = databaseContext.getPoolStats()
      
      expect(stats).toMatchObject({
        totalCount: expect.any(Number),
        idleCount: expect.any(Number),
        waitingCount: expect.any(Number)
      })
    })
  })
  
  describe('Adapter Integration', () => {
    it('should export all adapters from index', async () => {
      const adapters = await import('@/lib/auth/adapters')
      
      expect(adapters.RedisSessionStore).toBeDefined()
      expect(adapters.PostgresUserRepository).toBeDefined()
      expect(adapters.JWTTokenService).toBeDefined()
      expect(adapters.RLSDatabaseContext).toBeDefined()
    })
    
    it('should allow creating auth dependencies container', async () => {
      const {
        RedisSessionStore,
        PostgresUserRepository,
        JWTTokenService,
        RLSDatabaseContext
      } = await import('@/lib/auth/adapters')
      
      // Mock Redis instance
      const mockRedis = { ping: vi.fn() }
      
      const authDependencies = {
        sessionStore: new RedisSessionStore(mockRedis as any),
        userRepository: new PostgresUserRepository(),
        tokenService: new JWTTokenService({ jwtSecret: 'test' }),
        databaseContext: new RLSDatabaseContext()
      }
      
      expect(authDependencies.sessionStore).toBeInstanceOf(RedisSessionStore)
      expect(authDependencies.userRepository).toBeInstanceOf(PostgresUserRepository)
      expect(authDependencies.tokenService).toBeInstanceOf(JWTTokenService)
      expect(authDependencies.databaseContext).toBeInstanceOf(RLSDatabaseContext)
    })
  })
  
  describe('Error Handling', () => {
    it('should handle missing JWT secret', async () => {
      const { JWTTokenService } = await import('@/lib/auth/adapters/jwt-token-service')
      
      // Remove JWT_SECRET from environment for this test
      const originalEnv = process.env.JWT_SECRET
      delete process.env.JWT_SECRET
      
      expect(() => {
        new JWTTokenService({ jwtSecret: '' })
      }).toThrow('JWT_SECRET')
      
      // Restore environment
      if (originalEnv) {
        process.env.JWT_SECRET = originalEnv
      }
    })
    
    it('should handle Redis connection errors gracefully', async () => {
      const { RedisSessionStore } = await import('@/lib/auth/adapters/redis-session-store')
      
      const mockRedis = {
        get: vi.fn().mockRejectedValue(new Error('Connection failed')),
        ping: vi.fn().mockRejectedValue(new Error('Connection failed'))
      }
      
      const sessionStore = new RedisSessionStore(mockRedis as any)
      
      // Should not throw, should return null
      const session = await sessionStore.get('test-id')
      expect(session).toBeNull()
      
      // Health check should report unhealthy
      const health = await sessionStore.health()
      expect(health.connected).toBe(false)
      expect(health.error).toContain('Connection failed')
    })
  })
})