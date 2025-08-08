import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startTestContainers, stopTestContainers } from '@tests/setup/testcontainers'

/**
 * Debug test to check Testcontainers connection issues
 */

describe('Testcontainers Debug', () => {
  let containers: any

  beforeAll(async () => {
    console.log('⏳ Starting container debug test...')
    try {
      containers = await startTestContainers()
      console.log('✅ Containers started successfully')
    } catch (error) {
      console.error('❌ Container startup failed:', error)
      throw error
    }
  }, 120000) // 2 minute timeout

  afterAll(async () => {
    if (containers) {
      await stopTestContainers()
    }
  })

  it('should successfully connect to Redis', async () => {
    expect(containers).toBeDefined()
    expect(containers.redis).toBeDefined()
    
    // Test Redis connection
    const pong = await containers.redis.client.ping()
    expect(pong).toBe('PONG')
  })

  it('should successfully connect to PostgreSQL', async () => {
    expect(containers).toBeDefined()
    expect(containers.postgres).toBeDefined()
    
    // Test PostgreSQL connection
    const result = await containers.postgres.db.execute('SELECT 1 as test')
    expect(result).toBeDefined()
  })
})