import { describe, it, expect, beforeEach, vi } from 'vitest'
import { testUtils } from '@tests/setup/global-setup'

/**
 * Unit Tests for RLS Context Wrapper (rls-context.ts)
 * 
 * Tests the database security wrapper with mocked PostgreSQL client
 * Based on Codex recommendations for testing RLS logic
 * 
 * Test Coverage:
 * - User context setting and cleanup
 * - Transaction management
 * - Error handling and rollback
 * - System and admin context helpers
 * - User provisioning logic
 */

// Mock PostgreSQL client for unit tests
const mockClient = {
  query: vi.fn(),
  connect: vi.fn(),
  release: vi.fn(),
  execute: vi.fn()
}

const mockPool = {
  connect: vi.fn(() => mockClient),
  end: vi.fn()
}

// Mock Drizzle ORM
const mockDb = {
  select: vi.fn(),
  insert: vi.fn(), 
  update: vi.fn(),
  delete: vi.fn(),
  execute: vi.fn()
}

vi.mock('pg', () => ({
  Pool: vi.fn(() => mockPool),
  PoolClient: vi.fn()
}))

vi.mock('drizzle-orm/node-postgres', () => ({
  drizzle: vi.fn(() => mockDb)
}))

vi.mock('@/lib/db/index', () => ({
  migrationClient: mockPool
}))

// Import after mocking
import {
  withRLS,
  withSystemContext,
  withAdminContext,
  provisionUser,
  getPoolStats
} from '@/lib/db/rls-context'

describe('RLS Context Wrapper', () => {
  
  beforeEach(() => {
    vi.clearAllMocks()
    mockClient.query.mockResolvedValue({ rows: [] })
  })

  describe('withRLS', () => {
    const testUserId = testUtils.createTestUserId('1')
    const testContext = { 
      userId: testUserId, 
      roles: ['TRADER' as const] 
    }

    it('should execute operation with user context', async () => {
      const mockOperation = vi.fn().mockResolvedValue({ data: 'test' })
      
      const result = await withRLS(testContext, mockOperation)

      // Should connect to database
      expect(mockPool.connect).toHaveBeenCalled()
      
      // Should begin transaction
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN')
      
      // Should set user context for RLS
      expect(mockClient.query).toHaveBeenCalledWith(
        'SELECT app.set_auth($1, $2)',
        [testUserId, ['TRADER']]
      )
      
      // Should execute the operation
      expect(mockOperation).toHaveBeenCalledWith(mockDb)
      
      // Should commit transaction
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT')
      
      // Should release client
      expect(mockClient.release).toHaveBeenCalled()
      
      // Should return operation result
      expect(result).toEqual({ data: 'test' })
    })

    it('should rollback on operation error', async () => {
      const testError = new Error('Database operation failed')
      const mockOperation = vi.fn().mockRejectedValue(testError)
      
      await expect(withRLS(testContext, mockOperation)).rejects.toThrow(
        `RLS operation failed for user ${testUserId}: Database operation failed`
      )

      // Should attempt rollback
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK')
      
      // Should still release client
      expect(mockClient.release).toHaveBeenCalled()
    })

    it('should handle rollback errors gracefully', async () => {
      const testError = new Error('Database operation failed')
      const rollbackError = new Error('Rollback failed')
      
      const mockOperation = vi.fn().mockRejectedValue(testError)
      
      // Mock rollback failure
      mockClient.query.mockImplementation((query) => {
        if (query === 'ROLLBACK') {
          throw rollbackError
        }
        return Promise.resolve({ rows: [] })
      })
      
      // Should still throw original error, not rollback error
      await expect(withRLS(testContext, mockOperation)).rejects.toThrow(
        'Database operation failed'
      )
      
      // Should still release client
      expect(mockClient.release).toHaveBeenCalled()
    })

    it('should always release client even on connection errors', async () => {
      const connectionError = new Error('Connection failed')
      mockClient.query.mockRejectedValue(connectionError)
      
      const mockOperation = vi.fn()
      
      await expect(withRLS(testContext, mockOperation)).rejects.toThrow()
      
      expect(mockClient.release).toHaveBeenCalled()
    })

    it('should support multiple roles', async () => {
      const multiRoleContext = {
        userId: testUserId,
        roles: ['TRADER' as const, 'COACH' as const]
      }
      
      const mockOperation = vi.fn().mockResolvedValue('success')
      
      await withRLS(multiRoleContext, mockOperation)
      
      expect(mockClient.query).toHaveBeenCalledWith(
        'SELECT app.set_auth($1, $2)',
        [testUserId, ['TRADER', 'COACH']]
      )
    })

    it('should handle empty roles array', async () => {
      const noRoleContext = {
        userId: testUserId,
        roles: [] as const
      }
      
      const mockOperation = vi.fn().mockResolvedValue('success')
      
      await withRLS(noRoleContext, mockOperation)
      
      expect(mockClient.query).toHaveBeenCalledWith(
        'SELECT app.set_auth($1, $2)',
        [testUserId, []]
      )
    })
  })

  describe('withSystemContext', () => {
    it('should execute with SYSTEM role and system UUID', async () => {
      const mockOperation = vi.fn().mockResolvedValue('system-result')
      
      const result = await withSystemContext(mockOperation)
      
      expect(mockClient.query).toHaveBeenCalledWith(
        'SELECT app.set_auth($1, $2)',
        ['00000000-0000-0000-0000-000000000000', ['SYSTEM']]
      )
      
      expect(result).toBe('system-result')
      expect(mockOperation).toHaveBeenCalledWith(mockDb)
    })

    it('should handle errors in system context', async () => {
      const systemError = new Error('System operation failed')
      const mockOperation = vi.fn().mockRejectedValue(systemError)
      
      await expect(withSystemContext(mockOperation)).rejects.toThrow(
        'RLS operation failed for user 00000000-0000-0000-0000-000000000000: System operation failed'
      )
    })
  })

  describe('withAdminContext', () => {
    const adminUserId = testUtils.createTestUserId('admin')

    it('should execute with ADMIN role and admin user ID', async () => {
      const mockOperation = vi.fn().mockResolvedValue('admin-result')
      
      const result = await withAdminContext(adminUserId, mockOperation)
      
      expect(mockClient.query).toHaveBeenCalledWith(
        'SELECT app.set_auth($1, $2)',
        [adminUserId, ['ADMIN']]
      )
      
      expect(result).toBe('admin-result')
      expect(mockOperation).toHaveBeenCalledWith(mockDb)
    })
  })

  describe('provisionUser', () => {
    const testEmail = 'test@example.com'
    const testUserId = testUtils.createTestUserId('1')
    const testPortfolioId = 'portfolio-id-123'

    it('should provision user atomically', async () => {
      // Mock successful provisioning result
      mockDb.execute.mockResolvedValue({
        rows: [{
          user_id: testUserId,
          portfolio_id: testPortfolioId,
          created: true
        }]
      })

      const result = await provisionUser(testUserId, testEmail, 'TRADER')

      // Should execute in system context
      expect(mockClient.query).toHaveBeenCalledWith(
        'SELECT app.set_auth($1, $2)',
        ['00000000-0000-0000-0000-000000000000', ['SYSTEM']]
      )

      // Should call atomic provisioning function
      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM app.provision_user'),
        expect.arrayContaining([testUserId, testEmail, 'TRADER'])
      )

      expect(result).toEqual({
        userId: testUserId,
        portfolioId: testPortfolioId,
        created: true
      })
    })

    it('should handle provisioning failure', async () => {
      mockDb.execute.mockResolvedValue({ rows: [] })

      await expect(provisionUser(testUserId, testEmail)).rejects.toThrow(
        'Failed to provision user'
      )
    })

    it('should use default role when not specified', async () => {
      mockDb.execute.mockResolvedValue({
        rows: [{
          user_id: testUserId,
          portfolio_id: testPortfolioId,
          created: true
        }]
      })

      await provisionUser(testUserId, testEmail)

      // Should use 'TRADER' as default role
      expect(mockDb.execute).toHaveBeenCalledWith(
        expect.stringContaining('SELECT * FROM app.provision_user'),
        expect.arrayContaining([testUserId, testEmail, 'TRADER'])
      )
    })

    it('should handle database errors', async () => {
      const dbError = new Error('Unique constraint violation')
      mockDb.execute.mockRejectedValue(dbError)

      await expect(provisionUser(testUserId, testEmail)).rejects.toThrow()
    })
  })

  describe('getPoolStats', () => {
    it('should return pool statistics', () => {
      // Mock pool stats
      mockPool.totalCount = 10
      mockPool.idleCount = 5
      mockPool.waitingCount = 2

      const stats = getPoolStats()

      expect(stats).toEqual({
        totalCount: 10,
        idleCount: 5,
        waitingCount: 2
      })
    })
  })

  describe('Error Handling Edge Cases', () => {
    const testContext = { 
      userId: testUtils.createTestUserId('1'), 
      roles: ['TRADER' as const] 
    }

    it('should handle null/undefined operation', async () => {
      await expect(withRLS(testContext, null as any)).rejects.toThrow()
    })

    it('should handle invalid user ID format', async () => {
      const invalidContext = { 
        userId: 'invalid-uuid', 
        roles: ['TRADER' as const] 
      }
      
      const mockOperation = vi.fn()
      
      // Should still attempt the operation (validation happens at DB level)
      await withRLS(invalidContext, mockOperation)
      
      expect(mockClient.query).toHaveBeenCalledWith(
        'SELECT app.set_auth($1, $2)',
        ['invalid-uuid', ['TRADER']]
      )
    })

    it('should handle context with invalid roles', async () => {
      const invalidRoleContext = { 
        userId: testUtils.createTestUserId('1'), 
        roles: ['INVALID_ROLE' as any] 
      }
      
      const mockOperation = vi.fn().mockResolvedValue('success')
      
      // Should still execute (role validation happens at DB level)
      await withRLS(invalidRoleContext, mockOperation)
      
      expect(mockClient.query).toHaveBeenCalledWith(
        'SELECT app.set_auth($1, $2)',
        [testUtils.createTestUserId('1'), ['INVALID_ROLE']]
      )
    })
  })

  describe('Transaction Isolation', () => {
    it('should use dedicated client for each context', async () => {
      const operation1 = vi.fn().mockResolvedValue('result1')
      const operation2 = vi.fn().mockResolvedValue('result2')
      
      const context1 = { userId: testUtils.createTestUserId('1'), roles: ['TRADER' as const] }
      const context2 = { userId: testUtils.createTestUserId('2'), roles: ['TRADER' as const] }
      
      // Execute concurrently
      await Promise.all([
        withRLS(context1, operation1),
        withRLS(context2, operation2)
      ])
      
      // Should get separate client connections
      expect(mockPool.connect).toHaveBeenCalledTimes(2)
      expect(mockClient.release).toHaveBeenCalledTimes(2)
    })

    it('should maintain transaction boundaries', async () => {
      const mockOperation = vi.fn(async () => {
        // Simulate multiple database operations within transaction
        await mockDb.select()
        await mockDb.insert()
        return 'success'
      })
      
      await withRLS(
        { userId: testUtils.createTestUserId('1'), roles: ['TRADER'] }, 
        mockOperation
      )
      
      // Should have transaction boundaries
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN')
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT')
      
      // Operations should execute within transaction
      expect(mockDb.select).toHaveBeenCalled()
      expect(mockDb.insert).toHaveBeenCalled()
    })
  })

  describe('Performance Considerations', () => {
    it('should execute context operations quickly', async () => {
      const quickOperation = vi.fn().mockResolvedValue('fast')
      
      const start = process.hrtime.bigint()
      
      await withRLS(
        { userId: testUtils.createTestUserId('1'), roles: ['TRADER'] },
        quickOperation
      )
      
      const end = process.hrtime.bigint()
      const timeMs = Number(end - start) / 1_000_000
      
      // Unit test should be very fast (no real DB calls)
      expect(timeMs).toBeLessThan(10)
    })

    it('should minimize database roundtrips', async () => {
      const mockOperation = vi.fn().mockResolvedValue('optimized')
      
      await withRLS(
        { userId: testUtils.createTestUserId('1'), roles: ['TRADER'] },
        mockOperation
      )
      
      // Should have minimal query calls: BEGIN, set_auth, COMMIT
      const queryCount = mockClient.query.mock.calls.length
      expect(queryCount).toBe(3)
    })
  })

  describe('Memory Management', () => {
    it('should release client even on async operation errors', async () => {
      const asyncError = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Async error')), 10)
      })
      
      const mockOperation = vi.fn().mockReturnValue(asyncError)
      
      await expect(withRLS(
        { userId: testUtils.createTestUserId('1'), roles: ['TRADER'] },
        mockOperation
      )).rejects.toThrow('Async error')
      
      expect(mockClient.release).toHaveBeenCalled()
    })
  })
})