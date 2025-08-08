import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers'
import Redis from 'ioredis'
import { Pool, PoolClient } from 'pg'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import { readFileSync } from 'fs'
import { join } from 'path'
import * as schema from '@/lib/db/schema'

/**
 * Testcontainers Setup for Integration Tests
 * 
 * Based on Codex recommendations for testing with real services:
 * - Redis container for session management tests
 * - PostgreSQL container for RLS and database tests
 * - Automatic container lifecycle management
 * - Test data seeding and cleanup
 */

export interface TestContainers {
  redis: {
    container: StartedTestContainer
    client: Redis
    url: string
  }
  postgres: {
    container: StartedTestContainer
    pool: Pool
    url: string
    db: ReturnType<typeof drizzle>
  }
}

let containers: TestContainers | null = null

/**
 * Start test containers for integration tests
 * Called once per test suite that needs real services
 */
export async function startTestContainers(): Promise<TestContainers> {
  if (containers) {
    return containers
  }

  console.log('🐳 Starting test containers...')
  
  try {
    // Start Redis container
    const redisContainer = await new GenericContainer('redis:7-alpine')
      .withExposedPorts(6379)
      .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
      .withStartupTimeout(30000)
      .start()

    const redisPort = redisContainer.getMappedPort(6379)
    const redisUrl = `redis://localhost:${redisPort}`
    
    // Create Redis client
    const redisClient = new Redis(redisUrl, {
      retryDelayOnFailover: 100,
      enableReadyCheck: false,
      maxRetriesPerRequest: 3,
      lazyConnect: false
    })
    
    // Wait for Redis to be ready
    await redisClient.ping()
    
    // Start PostgreSQL container with proper role configuration for RLS testing
    const postgresContainer = await new GenericContainer('postgres:16-alpine')
      .withEnvironment({
        POSTGRES_DB: 'test',
        POSTGRES_USER: 'postgres',  // Use default postgres superuser for setup
        POSTGRES_PASSWORD: 'postgres',
        POSTGRES_HOST_AUTH_METHOD: 'trust' // Allow connections without password for testing
      })
      .withExposedPorts(5432)
      .withWaitStrategy(
        Wait.forLogMessage('database system is ready to accept connections')
      )
      .withStartupTimeout(90000) // Increased timeout
      .start()

    const postgresPort = postgresContainer.getMappedPort(5432)
    const postgresUrl = `postgresql://test:test@localhost:${postgresPort}/test`
    
    console.log(`🐘 PostgreSQL container started on port ${postgresPort}`)
    
    // Wait a bit for the container to fully initialize
    await new Promise(resolve => setTimeout(resolve, 2000))
    
    // First, connect as postgres superuser to set up the test user properly
    const setupPool = new Pool({
      host: 'localhost',
      port: postgresPort,
      database: 'test',
      user: 'postgres',
      password: 'postgres',
      max: 2, // Just for setup
    })
    
    // Create test user with proper RLS permissions (not superuser, not bypassrls)
    console.log('🔧 Creating test user with proper RLS configuration...')
    const setupClient = await setupPool.connect()
    try {
      // Create test user without superuser privileges
      await setupClient.query(`
        CREATE USER test WITH PASSWORD 'test' 
        NOSUPERUSER 
        NOBYPASSRLS 
        LOGIN 
        CREATEDB
      `)
      
      // Grant necessary permissions to test user
      await setupClient.query('GRANT ALL PRIVILEGES ON DATABASE test TO test')
      await setupClient.query('GRANT ALL ON SCHEMA public TO test') 
      await setupClient.query('GRANT ALL ON ALL TABLES IN SCHEMA public TO test')
      await setupClient.query('GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO test')
      await setupClient.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO test')
      await setupClient.query('ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO test')
      
      // Grant schema creation permissions
      await setupClient.query('GRANT CREATE ON DATABASE test TO test')
      await setupClient.query('ALTER DATABASE test OWNER TO test')
      
      console.log('✅ Test user created with proper RLS configuration')
    } catch (error) {
      // Ignore error if user already exists
      if (!error.message.includes('already exists')) {
        throw error
      }
      console.log('✅ Test user already exists')
    } finally {
      setupClient.release()
      await setupPool.end()
    }
    
    // Create PostgreSQL connection pool for the application (using test user)
    const postgresPool = new Pool({
      connectionString: postgresUrl,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000, // Increased timeout
      // Add connection retry settings
      host: 'localhost',
      port: postgresPort,
      database: 'test',
      user: 'test',
      password: 'test'
    })
    
    // Test PostgreSQL connection with retry
    let retries = 5
    let client
    while (retries > 0) {
      try {
        client = await postgresPool.connect()
        await client.query('SELECT 1')
        console.log('✅ PostgreSQL connection test successful')
        client.release()
        break
      } catch (error) {
        console.log(`⚠️  PostgreSQL connection attempt failed, ${retries - 1} retries left:`, error.message)
        if (client) client.release()
        retries--
        if (retries === 0) throw error
        await new Promise(resolve => setTimeout(resolve, 2000))
      }
    }
    
    // Create Drizzle instance
    const db = drizzle(postgresPool, { schema })
    
    // Apply migrations and RLS setup
    await setupTestDatabase(db, postgresPool)
    
    containers = {
      redis: {
        container: redisContainer,
        client: redisClient,
        url: redisUrl
      },
      postgres: {
        container: postgresContainer,
        pool: postgresPool,
        url: postgresUrl,
        db
      }
    }
    
    // Update environment variables for tests
    process.env.REDIS_URL = redisUrl
    process.env.DATABASE_URL = postgresUrl
    
    console.log(`✅ Test containers started:`)
    console.log(`   Redis: ${redisUrl}`)
    console.log(`   PostgreSQL: ${postgresUrl}`)
    
    return containers
    
  } catch (error) {
    console.error('❌ Failed to start test containers:', error)
    throw error
  }
}

/**
 * Stop test containers and cleanup resources
 */
export async function stopTestContainers(): Promise<void> {
  if (!containers) {
    return
  }
  
  console.log('🛑 Stopping test containers...')
  
  try {
    // Close Redis client
    if (containers.redis.client) {
      containers.redis.client.disconnect()
    }
    
    // Close PostgreSQL pool
    if (containers.postgres.pool) {
      await containers.postgres.pool.end()
    }
    
    // Stop containers
    await Promise.all([
      containers.redis.container.stop(),
      containers.postgres.container.stop()
    ])
    
    containers = null
    
    console.log('✅ Test containers stopped')
    
  } catch (error) {
    console.error('❌ Error stopping test containers:', error)
    throw error
  }
}

/**
 * Setup test database with migrations and RLS policies
 */
async function setupTestDatabase(
  db: ReturnType<typeof drizzle>, 
  pool: Pool
): Promise<void> {
  console.log('📚 Setting up test database...')
  
  try {
    // First, ensure the schema exists by creating tables directly
    const client = await pool.connect()
    try {
      // Create tables first (since we may not have migrations set up yet)
      await client.query(`
        CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
        
        CREATE TYPE user_role AS ENUM ('TRADER', 'COACH', 'ADMIN');
        CREATE TYPE asset_type AS ENUM ('STOCK', 'CRYPTO');
        
        CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          email TEXT NOT NULL UNIQUE,
          role user_role DEFAULT 'TRADER' NOT NULL,
          created_at TIMESTAMP DEFAULT NOW() NOT NULL,
          updated_at TIMESTAMP DEFAULT NOW() NOT NULL
        );
        
        CREATE TABLE IF NOT EXISTS assets (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          symbol TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          type asset_type NOT NULL,
          latest_price DECIMAL(20,8),
          updated_at TIMESTAMP DEFAULT NOW() NOT NULL,
          is_active BOOLEAN DEFAULT TRUE NOT NULL
        );
        
        CREATE TABLE IF NOT EXISTS portfolios (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          total_value DECIMAL(20,8) DEFAULT 0 NOT NULL,
          last_recomputed TIMESTAMP DEFAULT NOW() NOT NULL,
          created_at TIMESTAMP DEFAULT NOW() NOT NULL,
          updated_at TIMESTAMP DEFAULT NOW() NOT NULL
        );
        
        CREATE TABLE IF NOT EXISTS holdings (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          portfolio_id UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
          asset_id UUID NOT NULL REFERENCES assets(id),
          quantity DECIMAL(20,8) NOT NULL,
          cost_basis DECIMAL(20,8) NOT NULL,
          note TEXT,
          created_at TIMESTAMP DEFAULT NOW() NOT NULL,
          updated_at TIMESTAMP DEFAULT NOW() NOT NULL
        );

        CREATE TABLE IF NOT EXISTS price_candles (
          asset_id UUID NOT NULL REFERENCES assets(id),
          ts TIMESTAMP NOT NULL,
          price_scaled BIGINT NOT NULL,
          open_scaled BIGINT NOT NULL,
          high_scaled BIGINT NOT NULL,
          low_scaled BIGINT NOT NULL,
          close_scaled BIGINT NOT NULL,
          volume BIGINT,
          source TEXT NOT NULL,
          PRIMARY KEY (asset_id, ts, source)
        );

        CREATE TABLE IF NOT EXISTS price_candles_5m (
          asset_id UUID NOT NULL REFERENCES assets(id),
          ts TIMESTAMP NOT NULL,
          open_scaled BIGINT NOT NULL,
          high_scaled BIGINT NOT NULL,
          low_scaled BIGINT NOT NULL,
          close_scaled BIGINT NOT NULL,
          volume BIGINT,
          source TEXT NOT NULL,
          PRIMARY KEY (asset_id, ts, source)
        );

        CREATE TABLE IF NOT EXISTS price_candles_1h (
          asset_id UUID NOT NULL REFERENCES assets(id),
          ts TIMESTAMP NOT NULL,
          open_scaled BIGINT NOT NULL,
          high_scaled BIGINT NOT NULL,
          low_scaled BIGINT NOT NULL,
          close_scaled BIGINT NOT NULL,
          volume BIGINT,
          source TEXT NOT NULL,
          PRIMARY KEY (asset_id, ts, source)
        );

        CREATE TABLE IF NOT EXISTS price_candles_1d (
          asset_id UUID NOT NULL REFERENCES assets(id),
          ts TIMESTAMP NOT NULL,
          open_scaled BIGINT NOT NULL,
          high_scaled BIGINT NOT NULL,
          low_scaled BIGINT NOT NULL,
          close_scaled BIGINT NOT NULL,
          volume BIGINT,
          source TEXT NOT NULL,
          PRIMARY KEY (asset_id, ts, source)
        );

        CREATE TABLE IF NOT EXISTS portfolio_snapshots (
          portfolio_id UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
          date TIMESTAMP NOT NULL,
          total_value DECIMAL(20,8) NOT NULL,
          pnl DECIMAL(20,8) NOT NULL,
          created_at TIMESTAMP DEFAULT NOW() NOT NULL
        );
      `)
      
      // Apply RLS migration 
      const rlsMigration = readFileSync(
        join(process.cwd(), 'migrations', '001_enable_rls.sql'), 
        'utf-8'
      )
      
      await client.query(rlsMigration)
      
      // Grant permissions to app schema for test user (created by migration)
      await client.query('GRANT USAGE ON SCHEMA app TO test')
      await client.query('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO test')
      await client.query('ALTER DEFAULT PRIVILEGES IN SCHEMA app GRANT EXECUTE ON FUNCTIONS TO test')
      
      console.log('✅ Schema and RLS policies applied with proper test user permissions')
    } finally {
      client.release()
    }
    
    // Seed test data
    await seedTestData(db, pool)
    
    console.log('✅ Test database setup complete')
    
  } catch (error) {
    console.error('❌ Failed to setup test database:', error)
    throw error
  }
}

/**
 * Seed deterministic test data for consistent testing
 */
async function seedTestData(db: ReturnType<typeof drizzle>, pool: Pool): Promise<void> {
  console.log('🌱 Seeding test data...')
  
  const client = await pool.connect()
  try {
    // Test user IDs (deterministic UUIDs)
    const testUsers = [
      { id: '00000000-0000-4000-8000-000000000001', email: 'user1@example.com', role: 'TRADER' as const },
      { id: '00000000-0000-4000-8000-000000000002', email: 'user2@example.com', role: 'TRADER' as const },
      { id: '00000000-0000-4000-8000-000000000003', email: 'admin@example.com', role: 'ADMIN' as const }
    ]
    
    // Temporarily disable RLS for seeding (we'll re-enable it after seeding)
    await client.query(`ALTER TABLE users DISABLE ROW LEVEL SECURITY`)
    await client.query(`ALTER TABLE portfolios DISABLE ROW LEVEL SECURITY`)
    
    try {
      // Insert test users directly (bypassing RLS for setup)
      for (const user of testUsers) {
        // Insert user directly
        await client.query(`
          INSERT INTO users (id, email, role, created_at, updated_at)
          VALUES ($1, $2, $3, NOW(), NOW())
          ON CONFLICT (email) DO UPDATE SET 
            role = EXCLUDED.role,
            updated_at = NOW()
        `, [user.id, user.email, user.role])
        
        // Create default portfolio for each user
        await client.query(`
          INSERT INTO portfolios (id, user_id, name, total_value, created_at, updated_at)
          VALUES (gen_random_uuid(), $1, 'Main Portfolio', 0, NOW(), NOW())
          ON CONFLICT DO NOTHING
        `, [user.id])
      }
      
      console.log('✅ Test users and portfolios seeded')
      
    } finally {
      // Re-enable RLS after seeding
      await client.query(`ALTER TABLE users ENABLE ROW LEVEL SECURITY`)
      await client.query(`ALTER TABLE portfolios ENABLE ROW LEVEL SECURITY`)
      await client.query(`ALTER TABLE users FORCE ROW LEVEL SECURITY`)  
      await client.query(`ALTER TABLE portfolios FORCE ROW LEVEL SECURITY`)
      
      console.log('✅ RLS re-enabled after seeding')
    }
    
    // Insert test assets with deterministic UUIDs
    await client.query(`
      INSERT INTO assets (id, symbol, name, type) 
      VALUES 
        ('00000000-0000-4000-8000-000000000001', 'BTC', 'Bitcoin', 'CRYPTO'),
        ('00000000-0000-4000-8000-000000000002', 'ETH', 'Ethereum', 'CRYPTO'),
        ('00000000-0000-4000-8000-000000000003', 'AAPL', 'Apple Inc.', 'STOCK'),
        ('00000000-0000-4000-8000-000000000004', 'GOOGL', 'Alphabet Inc.', 'STOCK')
      ON CONFLICT (id) DO NOTHING
    `)
    
    console.log('✅ Test data seeded')
  } finally {
    client.release()
  }
}

/**
 * Clean test data between tests (preserves schema)
 */
export async function cleanTestData(containers: TestContainers): Promise<void> {
  // Clear Redis completely
  await containers.redis.client.flushdb()
  
  // Clear PostgreSQL data (but keep schema and RLS policies)
  const client = await containers.postgres.pool.connect()
  try {
    await client.query('BEGIN')
    
    // Delete in correct order to respect foreign keys
    await client.query('DELETE FROM portfolio_snapshots')
    await client.query('DELETE FROM holdings')
    await client.query('DELETE FROM portfolios')
    await client.query('DELETE FROM users')
    
    // Note: No sequences to reset since we use UUID primary keys with uuid_generate_v4()
    
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  
  // Re-seed test data
  await seedTestData(containers.postgres.db, containers.postgres.pool)
}

/**
 * Execute a test with isolated database transaction
 * Automatically rolls back after test completion
 */
export async function withTestTransaction<T>(
  containers: TestContainers,
  test: (client: PoolClient, db: ReturnType<typeof drizzle>) => Promise<T>
): Promise<T> {
  const client = await containers.postgres.pool.connect()
  const db = drizzle(client, { schema })
  
  try {
    await client.query('BEGIN')
    
    const result = await test(client, db)
    
    // Always rollback to keep tests isolated
    await client.query('ROLLBACK')
    
    return result
    
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/**
 * Get fresh Redis client for isolated testing
 */
export function createIsolatedRedisClient(containers: TestContainers): Redis {
  return new Redis(containers.redis.url, {
    retryDelayOnFailover: 100,
    enableReadyCheck: false,
    maxRetriesPerRequest: 3,
    lazyConnect: false,
    keyPrefix: `test-${Date.now()}-` // Unique prefix for isolation
  })
}

/**
 * Helper to execute RLS-enabled queries in tests
 */
export async function executeWithUserContext<T>(
  client: PoolClient,
  userId: string,
  role: string,
  operation: () => Promise<T>
): Promise<T> {
  // Set user context for RLS
  await client.query('SELECT app.set_auth($1, $2)', [userId, [role]])
  
  try {
    return await operation()
  } finally {
    // Clear user context
    await client.query('SELECT app.set_auth(NULL, ARRAY[]::text[])')
  }
}

/**
 * Utility for performance testing - measure execution time
 */
export async function measureExecutionTime<T>(
  operation: () => Promise<T>
): Promise<{ result: T; timeMs: number }> {
  const start = process.hrtime.bigint()
  const result = await operation()
  const end = process.hrtime.bigint()
  
  const timeMs = Number(end - start) / 1_000_000 // Convert nanoseconds to milliseconds
  
  return { result, timeMs }
}

// Export container types for test files
export type { TestContainers }