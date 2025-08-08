/**
 * 📊 PORTFOLIO TRACKING CONFIGURATION
 * 
 * Environment-aware configuration system for portfolio tracking application.
 * Optimized to replace manual Google Sheets workflows with appropriate
 * performance expectations (2-5s response times, 1-5min auto-updates).
 * 
 * Configuration Hierarchy:
 * 1. Default values (in code)
 * 2. Profile files (portfolio.json, local-dev.json, etc.)
 * 3. Environment variables (PORTFOLIO_*)
 * 4. CLI flags (--profile, --redis-timeout, etc.)
 */

import { readFileSync } from 'fs'
import { join } from 'path'

/**
 * Configuration interface for portfolio tracking application
 */
export interface PortfolioConfig {
  env: string
  
  // Redis configuration for portfolio data
  redis: {
    connectionString: string
    commandTimeoutMs: number
    connectTimeoutMs: number
    maxRetriesPerRequest: number
    retryDelayOnFailoverMs: number
    enableOfflineQueue: boolean
  }
  
  // Session management for portfolio users
  session: {
    validation: {
      slowWarningThresholdMs: number
      slowCriticalThresholdMs: number
      performanceTargetMs: number
    }
    monitoring: {
      p95TargetMs: number
      p99TargetMs: number
      cacheHitRateThreshold: number
      alertingEnabled: boolean
    }
    timeouts: {
      absoluteTtlSec: number
      idleTtlSec: number
    }
  }
  
  // Portfolio-specific settings
  portfolio: {
    autoUpdateIntervalMs: number
    batchProcessingEnabled: boolean
    realTimeUpdatesRequired: boolean
  }
  
  // Testing configuration
  testing: {
    integrationTestTimeoutMs: number
    performanceTestP95TargetMs: number
    performanceTestP99TargetMs: number
    enablePerformanceAssertions: boolean
  }
}

/**
 * Default configuration optimized for portfolio tracking
 * (Better than Google Sheets, but not HFT requirements)
 */
const defaultConfig: PortfolioConfig = {
  env: 'portfolio',
  
  redis: {
    connectionString: process.env.REDIS_URL || 'redis://localhost:6379',
    commandTimeoutMs: 30000, // 30s - Allow time for portfolio calculations
    connectTimeoutMs: 10000,  // 10s - Patient connection for local dev
    maxRetriesPerRequest: 3,
    retryDelayOnFailoverMs: 200,
    enableOfflineQueue: true  // Forgiving for portfolio use
  },
  
  session: {
    validation: {
      slowWarningThresholdMs: 2000,    // 2s - Warn if slower than Google Sheets
      slowCriticalThresholdMs: 10000,  // 10s - Critical if genuinely slow
      performanceTargetMs: 1000        // 1s - Target better than spreadsheets
    },
    monitoring: {
      p95TargetMs: 2000,               // 2s P95 - Good portfolio UX
      p99TargetMs: 5000,               // 5s P99 - Still acceptable
      cacheHitRateThreshold: 0.90,     // 90% - Slightly relaxed
      alertingEnabled: true
    },
    timeouts: {
      absoluteTtlSec: 30 * 24 * 60 * 60, // 30 days
      idleTtlSec: 24 * 60 * 60            // 24 hours - Portfolio user patterns
    }
  },
  
  portfolio: {
    autoUpdateIntervalMs: 5 * 60 * 1000, // 5 minutes - Not real-time
    batchProcessingEnabled: true,         // Enable batch operations
    realTimeUpdatesRequired: false       // Portfolio tracking, not trading
  },
  
  testing: {
    integrationTestTimeoutMs: 10000,     // 10s - Generous for CI/CD
    performanceTestP95TargetMs: 2000,    // 2s P95 target for tests
    performanceTestP99TargetMs: 5000,    // 5s P99 target for tests
    enablePerformanceAssertions: false   // Focus on functionality
  }
}

/**
 * Load configuration profile from file
 */
function loadProfile(profileName: string): Partial<PortfolioConfig> {
  try {
    const profilePath = join(__dirname, 'profiles', `${profileName}.json`)
    const profileContent = readFileSync(profilePath, 'utf8')
    return JSON.parse(profileContent)
  } catch (error) {
    console.warn(`Failed to load profile '${profileName}':`, error instanceof Error ? error.message : error)
    return {}
  }
}

/**
 * Apply environment variable overrides
 */
function applyEnvironmentOverrides(config: PortfolioConfig): PortfolioConfig {
  return {
    ...config,
    redis: {
      ...config.redis,
      commandTimeoutMs: parseInt(process.env.PORTFOLIO_REDIS_TIMEOUT_MS || '') || config.redis.commandTimeoutMs,
      connectTimeoutMs: parseInt(process.env.PORTFOLIO_REDIS_CONNECT_TIMEOUT_MS || '') || config.redis.connectTimeoutMs,
    },
    session: {
      ...config.session,
      validation: {
        ...config.session.validation,
        slowWarningThresholdMs: parseInt(process.env.PORTFOLIO_SLOW_WARN_MS || '') || config.session.validation.slowWarningThresholdMs,
        slowCriticalThresholdMs: parseInt(process.env.PORTFOLIO_SLOW_CRIT_MS || '') || config.session.validation.slowCriticalThresholdMs,
      },
      monitoring: {
        ...config.session.monitoring,
        p95TargetMs: parseInt(process.env.PORTFOLIO_P95_TARGET_MS || '') || config.session.monitoring.p95TargetMs,
        p99TargetMs: parseInt(process.env.PORTFOLIO_P99_TARGET_MS || '') || config.session.monitoring.p99TargetMs,
        alertingEnabled: process.env.PORTFOLIO_ALERTING_ENABLED === 'false' ? false : config.session.monitoring.alertingEnabled,
      }
    },
    portfolio: {
      ...config.portfolio,
      autoUpdateIntervalMs: parseInt(process.env.PORTFOLIO_UPDATE_INTERVAL_MS || '') || config.portfolio.autoUpdateIntervalMs,
    },
    testing: {
      ...config.testing,
      integrationTestTimeoutMs: parseInt(process.env.PORTFOLIO_TEST_TIMEOUT_MS || '') || config.testing.integrationTestTimeoutMs,
      enablePerformanceAssertions: process.env.PORTFOLIO_PERF_ASSERTIONS === 'true' ? true : config.testing.enablePerformanceAssertions,
    }
  }
}

/**
 * Create the final configuration by merging layers
 */
function createConfig(): PortfolioConfig {
  // Start with defaults
  let config = { ...defaultConfig }
  
  // Detect environment and load appropriate profile
  const profile = process.env.PORTFOLIO_PROFILE || process.env.NODE_ENV || 'portfolio'
  config.env = profile
  
  // Load and merge profile
  const profileOverrides = loadProfile(profile)
  config = {
    ...config,
    ...profileOverrides,
    redis: { ...config.redis, ...profileOverrides.redis },
    session: {
      ...config.session,
      ...profileOverrides.session,
      validation: { ...config.session.validation, ...profileOverrides.session?.validation },
      monitoring: { ...config.session.monitoring, ...profileOverrides.session?.monitoring },
      timeouts: { ...config.session.timeouts, ...profileOverrides.session?.timeouts },
    },
    portfolio: { ...config.portfolio, ...profileOverrides.portfolio },
    testing: { ...config.testing, ...profileOverrides.testing },
  }
  
  // Apply environment variable overrides
  config = applyEnvironmentOverrides(config)
  
  return config
}

/**
 * Global configuration instance
 */
export const config = createConfig()

/**
 * Helper functions for common configuration access
 */
export const isPortfolioMode = () => config.portfolio.realTimeUpdatesRequired === false
export const isPerformanceTestingEnabled = () => config.testing.enablePerformanceAssertions
export const getSessionValidationTimeout = () => config.session.validation.slowCriticalThresholdMs
export const getRedisCommandTimeout = () => config.redis.commandTimeoutMs
export const getPortfolioUpdateInterval = () => config.portfolio.autoUpdateIntervalMs

/**
 * Development helper to log current configuration
 */
export const logConfigSummary = () => {
  if (process.env.NODE_ENV === 'development') {
    console.log('📊 Portfolio Configuration Loaded:')
    console.log(`   Environment: ${config.env}`)
    console.log(`   Redis Timeout: ${config.redis.commandTimeoutMs}ms`)
    console.log(`   Session Target: ${config.session.validation.performanceTargetMs}ms`)
    console.log(`   P95 Target: ${config.session.monitoring.p95TargetMs}ms`)
    console.log(`   Auto-Update: ${config.portfolio.autoUpdateIntervalMs}ms`)
    console.log(`   Real-Time Required: ${config.portfolio.realTimeUpdatesRequired}`)
  }
}

// Log configuration on import in development
logConfigSummary()