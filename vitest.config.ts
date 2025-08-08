import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

/**
 * Vitest Configuration for Authentication System Testing
 * 
 * Multi-project setup based on Codex recommendations:
 * - Unit: Fast tests with mocked IO
 * - Integration: Real Redis + PostgreSQL via Testcontainers
 * - Security: RLS isolation and session security tests
 * - Performance: Benchmarks and load testing
 */

export default defineConfig({
  // Global configuration
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
      '@tests': resolve(__dirname, './tests')
    }
  },
  
  // Test configuration
  test: {
    // Global test settings
    globals: true,
    environment: 'node',
    
    // Test file patterns
    include: [
      'tests/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'
    ],
    
    // Exclude patterns
    exclude: [
      'node_modules',
      'dist',
      '.next',
      'tests/setup/**'
    ],
    
    // Test timeout (important for Testcontainers)
    testTimeout: 30000,
    hookTimeout: 30000,
    
    // Coverage configuration
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.{js,ts}'],
      exclude: [
        'src/**/*.d.ts',
        'src/**/*.test.{js,ts}',
        'src/**/*.spec.{js,ts}',
        'src/lib/db/migrations/**',
        'src/app/**/layout.{js,ts,jsx,tsx}',
        'src/app/**/loading.{js,ts,jsx,tsx}',
        'src/app/**/error.{js,ts,jsx,tsx}',
        'src/app/**/not-found.{js,ts,jsx,tsx}'
      ],
      thresholds: {
        global: {
          branches: 80,
          functions: 90,
          lines: 85,
          statements: 85
        },
        // Higher coverage requirements for auth components
        'src/lib/auth/**': {
          branches: 95,
          functions: 95,
          lines: 95,
          statements: 95
        },
        'src/lib/db/rls-context.ts': {
          branches: 95,
          functions: 95,
          lines: 95,
          statements: 95
        }
      }
    },
    
    // Setup files
    setupFiles: [
      'tests/setup/global-setup.ts'
    ],
    
    // Environment variables for testing
    env: {
      NODE_ENV: 'test',
      // Test database URLs (will be overridden by Testcontainers)
      DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
      REDIS_URL: 'redis://localhost:6379',
      // Test secrets
      JWT_SECRET: 'test-jwt-secret-for-testing-only-not-production',
      WS_JWT_SECRET: 'test-ws-jwt-secret-for-testing-only',
      NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
      NEXT_PUBLIC_SUPABASE_URL: 'https://test.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key'
    }
  },
  
  // Multiple project configuration
  projects: [
    {
      name: 'unit',
      test: {
        include: ['tests/unit/**/*.{test,spec}.{js,ts}'],
        environment: 'node',
        // Fast unit tests - no containers
        testTimeout: 5000
      }
    },
    {
      name: 'integration', 
      test: {
        include: ['tests/integration/**/*.{test,spec}.{js,ts}'],
        environment: 'node',
        // Longer timeout for Testcontainers
        testTimeout: 60000,
        hookTimeout: 60000,
        // Run integration tests sequentially to avoid container conflicts
        pool: 'forks',
        poolOptions: {
          forks: {
            singleFork: true
          }
        }
      }
    },
    {
      name: 'security',
      test: {
        include: ['tests/security/**/*.{test,spec}.{js,ts}'],
        environment: 'node',
        testTimeout: 30000,
        // Security tests should run sequentially for deterministic results
        pool: 'forks',
        poolOptions: {
          forks: {
            singleFork: true
          }
        }
      }
    },
    {
      name: 'performance',
      test: {
        include: ['tests/performance/**/*.{test,spec}.{js,ts}'],
        environment: 'node',
        testTimeout: 120000, // Longer for performance tests
        // Performance tests need dedicated resources
        pool: 'forks',
        poolOptions: {
          forks: {
            singleFork: true
          }
        }
      }
    },
    {
      name: 'e2e',
      test: {
        include: ['tests/e2e/**/*.{test,spec}.{js,ts}'],
        environment: 'node',
        testTimeout: 60000,
        // E2E tests with real Next.js server
        pool: 'forks',
        poolOptions: {
          forks: {
            singleFork: true
          }
        }
      }
    }
  ]
})

/**
 * Usage Examples:
 * 
 * Run all tests:
 * npm test
 * 
 * Run specific project:
 * npm test -- --project unit
 * npm test -- --project integration
 * npm test -- --project security
 * 
 * Run with coverage:
 * npm test -- --coverage
 * 
 * Run in watch mode:
 * npm test -- --watch
 * 
 * Run performance benchmarks:
 * npm test -- --project performance
 * 
 * Run specific test file:
 * npm test -- tests/unit/auth/session-v2.test.ts
 * 
 * Debug mode with verbose output:
 * npm test -- --reporter=verbose --no-coverage
 */