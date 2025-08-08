import { randomBytes, createHash } from 'crypto'
import Redis from 'ioredis'
import { config } from '@/config'

/**
 * Portfolio tracking session management with Redis backing store
 * Optimized for portfolio tracking workflows (Google Sheets replacement)
 * 
 * Key features:
 * - Portfolio-appropriate response times (1-5s acceptable)
 * - Session revocation capability for security
 * - Device fingerprinting for security
 * - Sliding window expiration
 * - Role-based access with version control
 * - Better performance than manual Google Sheets workflows
 */

// Redis client optimized for portfolio tracking workflows
const redis = new Redis(config.redis.connectionString, {
  // Connection settings optimized for portfolio tracking (Google Sheets replacement)
  connectTimeout: config.redis.connectTimeoutMs,
  commandTimeout: config.redis.commandTimeoutMs, // Portfolio-appropriate timeout
  retryDelayOnFailover: config.redis.retryDelayOnFailoverMs,
  enableReadyCheck: false,
  maxRetriesPerRequest: config.redis.maxRetriesPerRequest,
  lazyConnect: true,
  
  // Portfolio-friendly offline queue handling
  enableOfflineQueue: config.redis.enableOfflineQueue,
  
  // Custom retry strategy for portfolio operations
  retryStrategy(times: number): number | null {
    const maxDelay = config.env === 'portfolio' ? 5000 : 2000 // More patient for portfolio
    const delay = Math.min(times * 100, maxDelay)
    
    // Allow more retries for portfolio use (less time pressure)
    const maxRetries = config.env === 'portfolio' ? 8 : 5
    if (times > maxRetries) {
      console.error(`Redis connection failed after ${maxRetries} retries`)
      return null
    }
    
    return delay
  },
  
  // Connection pool settings for portfolio operations
  keepAlive: 30000, // Keep connections alive for 30 seconds
  maxMemoryPolicy: 'allkeys-lru', // Evict least recently used keys if memory full
  
  // Monitoring and logging
  showFriendlyErrorStack: process.env.NODE_ENV !== 'production',
})

/**
 * Session data structure (stored as JSON in Redis)
 * Optimized for minimal memory usage and fast serialization
 */
export interface Session {
  v: 1                     // Schema version for migrations
  uid: string             // Local PostgreSQL user ID  
  did: string             // Device ID for device binding
  iat: number             // Issued at (Unix timestamp)
  exp: number             // Absolute expiry (Unix timestamp)
  idleExp: number         // Sliding expiry (Unix timestamp)
  rc: number              // Rotation counter (for MFA/security events)
  mfa: boolean            // MFA verification status
  role: 'TRADER' | 'COACH' | 'ADMIN' | 'SYSTEM'
  roleVersion: number     // Role version for instant role changes
  ipH?: string            // Hashed IP address (privacy + security)
  uaH?: string            // Hashed user agent (device fingerprinting)
}

/**
 * Session creation parameters
 */
export interface CreateSessionParams {
  userId: string
  deviceId: string
  role: Session['role']
  absoluteTtlSec?: number  // Default: 30 days
  idleTtlSec?: number     // Default: 12 hours  
  ip?: string
  userAgent?: string
  mfa?: boolean
}

/**
 * Session validation result
 */
export interface SessionValidationResult {
  valid: boolean
  session?: Session
  reason?: 'not_found' | 'expired' | 'idle_expired' | 'role_version_mismatch'
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Generate cryptographically secure session ID
 * 32 bytes = 256 bits of entropy, base64url encoded
 */
function generateSessionId(): string {
  return randomBytes(32)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * Hash sensitive data (IP addresses, user agents) for privacy and security
 * Uses SHA-256 to reduce cardinality while maintaining security
 */
function hashSensitiveData(data: string): string {
  return createHash('sha256').update(data).digest('hex').substring(0, 16)
}

/**
 * Get current Unix timestamp
 */
function now(): number {
  return Math.floor(Date.now() / 1000)
}

// =============================================================================
// REDIS KEY PATTERNS
// =============================================================================

/**
 * Redis key patterns for session management
 * Designed for fast lookups and efficient memory usage
 */
const RedisKeys = {
  session: (sessionId: string) => `sess:${sessionId}`,
  userSessions: (userId: string) => `user:sess:${userId}`,
  userRoleVersion: (userId: string) => `user:ver:${userId}`,
  deviceSessions: (deviceId: string) => `dev:sess:${deviceId}`,
} as const

// =============================================================================
// SESSION MANAGEMENT FUNCTIONS
// =============================================================================

/**
 * Create a new session with Redis storage
 * 
 * @param params Session creation parameters
 * @returns Session ID and session data
 */
export async function createSession(params: CreateSessionParams): Promise<{
  sessionId: string
  session: Session
}> {
  const sessionId = generateSessionId()
  const currentTime = now()
  
  // Default TTLs optimized for financial applications
  const absoluteTtl = params.absoluteTtlSec || (30 * 24 * 60 * 60) // 30 days
  const idleTtl = params.idleTtlSec || (12 * 60 * 60)              // 12 hours
  
  // Get current role version (for instant role change propagation)
  const roleVersion = await redis.incr(RedisKeys.userRoleVersion(params.userId)) - 1
  
  const session: Session = {
    v: 1,
    uid: params.userId,
    did: params.deviceId,
    iat: currentTime,
    exp: currentTime + absoluteTtl,
    idleExp: currentTime + idleTtl,
    rc: 0,
    mfa: params.mfa || false,
    role: params.role,
    roleVersion,
    ipH: params.ip ? hashSensitiveData(params.ip) : undefined,
    uaH: params.userAgent ? hashSensitiveData(params.userAgent) : undefined,
  }
  
  // Calculate Redis TTL (minimum of idle and absolute expiry)
  const redisTtl = Math.min(idleTtl, absoluteTtl)
  
  // Atomic Redis operations for session creation
  const pipeline = redis.pipeline()
  
  // Store session data
  pipeline.set(
    RedisKeys.session(sessionId),
    JSON.stringify(session),
    'EX',
    redisTtl
  )
  
  // Track session for user-wide revocation
  pipeline.sadd(RedisKeys.userSessions(params.userId), sessionId)
  
  // Track session for device-wide operations (optional)
  if (params.deviceId) {
    pipeline.sadd(RedisKeys.deviceSessions(params.deviceId), sessionId)
  }
  
  await pipeline.exec()
  
  return { sessionId, session }
}

/**
 * Validate and refresh a session (sliding window)
 * 
 * This is the core function called on every authenticated request
 * Optimized for <5ms execution time with reduced Redis round trips
 * Includes performance monitoring for production observability
 * 
 * @param sessionId Session ID from cookie/header
 * @param idleTtlSec Idle TTL for sliding window (default: 12 hours)
 * @returns Session validation result
 */
export async function validateAndRefreshSession(
  sessionId: string,
  idleTtlSec: number = 12 * 60 * 60
): Promise<SessionValidationResult> {
  const startTime = process.hrtime.bigint()
  try {
    // PERFORMANCE OPTIMIZATION: Single Redis round trip for session lookup
    const sessionData = await redis.get(RedisKeys.session(sessionId))
    
    if (!sessionData) {
      return { valid: false, reason: 'not_found' }
    }
    
    const session: Session = JSON.parse(sessionData)
    const currentTime = now()
    
    // Check absolute expiration
    if (currentTime >= session.exp) {
      // Clean up expired session
      await revokeSession(sessionId, session.uid)
      return { valid: false, reason: 'expired' }
    }
    
    // Check idle expiration
    if (currentTime >= session.idleExp) {
      await revokeSession(sessionId, session.uid)
      return { valid: false, reason: 'idle_expired' }
    }
    
    // PERFORMANCE OPTIMIZATION: Pipeline role version check and session refresh
    // This reduces 2 sequential operations to 1 pipeline execution
    const pipeline = redis.pipeline()
    pipeline.get(RedisKeys.userRoleVersion(session.uid))
    
    // Update sliding window expiration
    session.idleExp = currentTime + idleTtlSec
    const newTtl = Math.min(session.exp - currentTime, idleTtlSec)
    
    // Add session refresh to the same pipeline
    pipeline.set(RedisKeys.session(sessionId), JSON.stringify(session), 'EX', newTtl)
    
    const results = await pipeline.exec()
    
    // Check pipeline execution results
    if (!results || results.length !== 2) {
      console.error('Session validation pipeline failed:', results)
      return { valid: false, reason: 'not_found' }
    }
    
    // Extract role version from pipeline results
    const [roleVersionResult, sessionRefreshResult] = results
    const [roleVersionError, currentRoleVersion] = roleVersionResult
    const [sessionRefreshError] = sessionRefreshResult
    
    // Check role version for instant role changes
    if (!roleVersionError && currentRoleVersion && parseInt(currentRoleVersion as string) !== session.roleVersion) {
      await revokeSession(sessionId, session.uid)
      return { valid: false, reason: 'role_version_mismatch' }
    }
    
    // Log session refresh failures for monitoring
    if (sessionRefreshError) {
      console.error('Session refresh failed in pipeline:', sessionRefreshError)
      // Don't fail validation, but log for monitoring
    }
    
    return { valid: true, session }
    
  } catch (error) {
    console.error('Session validation error:', error)
    return { valid: false, reason: 'not_found' }
  } finally {
    // Record performance metrics for monitoring
    const endTime = process.hrtime.bigint()
    const durationMs = Number(endTime - startTime) / 1_000_000
    
    // Log slow validations for portfolio tracking context
    const slowThreshold = config.session.validation.slowWarningThresholdMs
    if (durationMs > slowThreshold) {
      console.warn(`🐌 Slow session validation: ${durationMs.toFixed(2)}ms (target: <${config.session.validation.performanceTargetMs}ms for portfolio) for session: ${sessionId.substring(0, 8)}...`)
    }
    
    // In development, log performance for portfolio context
    if (process.env.NODE_ENV === 'development') {
      const performance = durationMs <= config.session.validation.performanceTargetMs ? '⚡' : 
                         durationMs <= slowThreshold ? '✅' : '🐌'
      console.log(`📊 Portfolio session validation: ${performance} ${durationMs.toFixed(2)}ms`)
    }
  }
}

/**
 * Rotate session (increment rotation counter)
 * Used for MFA verification or security events
 * 
 * @param sessionId Session ID to rotate
 * @returns Updated session or null if not found
 */
export async function rotateSession(sessionId: string): Promise<Session | null> {
  try {
    const sessionData = await redis.get(RedisKeys.session(sessionId))
    if (!sessionData) return null
    
    const session: Session = JSON.parse(sessionData)
    session.rc += 1
    
    // Update session with same TTL
    await redis.set(
      RedisKeys.session(sessionId),
      JSON.stringify(session),
      'KEEPTTL'
    )
    
    return session
    
  } catch (error) {
    console.error('Session rotation error:', error)
    return null
  }
}

/**
 * Revoke a specific session
 * 
 * @param sessionId Session ID to revoke
 * @param userId User ID (optional, for cleanup optimization)
 */
export async function revokeSession(sessionId: string, userId?: string): Promise<void> {
  try {
    // Get session data if userId not provided
    let sessionUserId = userId
    if (!sessionUserId) {
      const sessionData = await redis.get(RedisKeys.session(sessionId))
      if (sessionData) {
        const session: Session = JSON.parse(sessionData)
        sessionUserId = session.uid
      }
    }
    
    const pipeline = redis.pipeline()
    
    // Delete session
    pipeline.del(RedisKeys.session(sessionId))
    
    // Remove from user session tracking
    if (sessionUserId) {
      pipeline.srem(RedisKeys.userSessions(sessionUserId), sessionId)
    }
    
    await pipeline.exec()
    
  } catch (error) {
    console.error('Session revocation error:', error)
  }
}

/**
 * Revoke all sessions for a user
 * Used for security events, password changes, account suspension
 * 
 * @param userId User ID
 */
export async function revokeAllUserSessions(userId: string): Promise<void> {
  try {
    // Get all session IDs for the user
    const sessionIds = await redis.smembers(RedisKeys.userSessions(userId))
    
    if (sessionIds.length === 0) return
    
    const pipeline = redis.pipeline()
    
    // Delete all sessions
    for (const sessionId of sessionIds) {
      pipeline.del(RedisKeys.session(sessionId))
    }
    
    // Clear user session tracking
    pipeline.del(RedisKeys.userSessions(userId))
    
    // Increment role version to invalidate any cached sessions
    pipeline.incr(RedisKeys.userRoleVersion(userId))
    
    await pipeline.exec()
    
  } catch (error) {
    console.error('User session revocation error:', error)
  }
}

/**
 * Update user role and invalidate existing sessions
 * Enables instant role changes across all user sessions
 * 
 * @param userId User ID
 * @param newRole New role to assign
 */
export async function updateUserRole(
  userId: string, 
  newRole: Session['role']
): Promise<void> {
  try {
    // Increment role version to invalidate existing sessions
    await redis.incr(RedisKeys.userRoleVersion(userId))
    
    // Note: User will need to create a new session with the updated role
    // This ensures clean role transitions without stale permissions
    
  } catch (error) {
    console.error('Role update error:', error)
  }
}

/**
 * Get active session count for a user
 * Useful for monitoring and security analysis
 * 
 * @param userId User ID
 * @returns Number of active sessions
 */
export async function getUserSessionCount(userId: string): Promise<number> {
  try {
    return await redis.scard(RedisKeys.userSessions(userId))
  } catch (error) {
    console.error('Session count error:', error)
    return 0
  }
}

/**
 * Get session information by ID (for debugging/monitoring)
 * 
 * @param sessionId Session ID
 * @returns Session data or null
 */
export async function getSession(sessionId: string): Promise<Session | null> {
  try {
    const sessionData = await redis.get(RedisKeys.session(sessionId))
    return sessionData ? JSON.parse(sessionData) : null
  } catch (error) {
    console.error('Get session error:', error)
    return null
  }
}

/**
 * Redis connection health check
 * Used by monitoring and health check endpoints
 */
export async function checkRedisHealth(): Promise<{
  connected: boolean
  latency?: number
  error?: string
}> {
  try {
    const start = Date.now()
    await redis.ping()
    const latency = Date.now() - start
    
    return { connected: true, latency }
  } catch (error) {
    return { 
      connected: false, 
      error: error instanceof Error ? error.message : 'Unknown error'
    }
  }
}

/**
 * Get Redis memory and performance statistics
 * For monitoring and capacity planning
 */
export async function getRedisStats(): Promise<{
  memory: { used: string; peak: string }
  connections: number
  keyspaceHits: number
  keyspaceMisses: number
  hitRate: number
}> {
  try {
    const info = await redis.info('memory,stats,clients')
    const lines = info.split('\r\n')
    const stats: any = {}
    
    for (const line of lines) {
      const [key, value] = line.split(':')
      if (key && value) {
        stats[key] = value
      }
    }
    
    const keyspaceHits = parseInt(stats.keyspace_hits || '0')
    const keyspaceMisses = parseInt(stats.keyspace_misses || '0')
    const hitRate = keyspaceHits + keyspaceMisses > 0 
      ? keyspaceHits / (keyspaceHits + keyspaceMisses) 
      : 0
    
    return {
      memory: {
        used: stats.used_memory_human || '0',
        peak: stats.used_memory_peak_human || '0'
      },
      connections: parseInt(stats.connected_clients || '0'),
      keyspaceHits,
      keyspaceMisses,
      hitRate: Math.round(hitRate * 100) / 100
    }
  } catch (error) {
    console.error('Redis stats error:', error)
    throw error
  }
}

// Graceful Redis connection cleanup
process.on('SIGTERM', () => {
  redis.disconnect()
})

process.on('SIGINT', () => {
  redis.disconnect()
})