/**
 * 📊 SESSION PERFORMANCE MONITORING & BENCHMARKING
 * 
 * Portfolio tracking performance monitoring system.
 * Optimized for portfolio management workflows (Google Sheets replacement).
 * 
 * Features:
 * - Real-time performance metrics collection
 * - Portfolio-appropriate alerting thresholds (1-5s acceptable)
 * - Redis connection health monitoring
 * - Session operation statistics
 * - Performance regression detection
 */

import { checkRedisHealth, getRedisStats } from './session-v2'
import { config } from '@/config'

/**
 * Performance metrics for session operations
 */
export interface SessionMetrics {
  // Timing metrics (milliseconds)
  validationTime: number
  redisLatency: number
  serializationTime: number
  
  // Operation counts
  totalValidations: number
  successfulValidations: number
  failedValidations: number
  cacheHits: number
  cacheMisses: number
  
  // Error tracking
  redisErrors: number
  timeoutErrors: number
  serializationErrors: number
  
  // Performance statistics
  averageValidationTime: number
  p95ValidationTime: number
  p99ValidationTime: number
  slowValidations: number // Count of validations > portfolio threshold
}

/**
 * In-memory metrics collector for session performance
 * In production, this would be replaced with a proper metrics store (e.g., Prometheus)
 */
class SessionMetricsCollector {
  private metrics: SessionMetrics = {
    validationTime: 0,
    redisLatency: 0,
    serializationTime: 0,
    totalValidations: 0,
    successfulValidations: 0,
    failedValidations: 0,
    cacheHits: 0,
    cacheMisses: 0,
    redisErrors: 0,
    timeoutErrors: 0,
    serializationErrors: 0,
    averageValidationTime: 0,
    p95ValidationTime: 0,
    p99ValidationTime: 0,
    slowValidations: 0
  }

  private validationTimes: number[] = []
  private readonly MAX_STORED_TIMES = 1000 // Keep last 1000 measurements for percentiles

  /**
   * Record a session validation timing
   */
  recordValidation(durationMs: number, success: boolean, redisLatency?: number): void {
    this.metrics.totalValidations++
    this.metrics.validationTime = durationMs

    if (success) {
      this.metrics.successfulValidations++
      this.metrics.cacheHits++
    } else {
      this.metrics.failedValidations++
      this.metrics.cacheMisses++
    }

    if (redisLatency !== undefined) {
      this.metrics.redisLatency = redisLatency
    }

    // Track slow validations (portfolio apps target <1s, acceptable up to 5s)
    const slowThreshold = config.session.validation.slowWarningThresholdMs
    if (durationMs > slowThreshold) {
      this.metrics.slowValidations++
      const target = config.session.validation.performanceTargetMs
      console.warn(`🐌 Slow session validation: ${durationMs.toFixed(2)}ms (target: <${target}ms for portfolio tracking)`)
    }

    // Store timing for percentile calculations
    this.validationTimes.push(durationMs)
    if (this.validationTimes.length > this.MAX_STORED_TIMES) {
      this.validationTimes.shift() // Remove oldest measurement
    }

    // Update running statistics
    this.updateStatistics()
  }

  /**
   * Record Redis-specific errors
   */
  recordRedisError(errorType: 'connection' | 'timeout' | 'serialization'): void {
    this.metrics.redisErrors++
    
    switch (errorType) {
      case 'timeout':
        this.metrics.timeoutErrors++
        break
      case 'serialization':
        this.metrics.serializationErrors++
        break
    }

    console.error(`🔴 Redis error: ${errorType} (total Redis errors: ${this.metrics.redisErrors})`)
  }

  /**
   * Get current metrics snapshot
   */
  getMetrics(): SessionMetrics {
    return { ...this.metrics }
  }

  /**
   * Reset metrics (useful for testing or periodic resets)
   */
  reset(): void {
    this.metrics = {
      validationTime: 0,
      redisLatency: 0,
      serializationTime: 0,
      totalValidations: 0,
      successfulValidations: 0,
      failedValidations: 0,
      cacheHits: 0,
      cacheMisses: 0,
      redisErrors: 0,
      timeoutErrors: 0,
      serializationErrors: 0,
      averageValidationTime: 0,
      p95ValidationTime: 0,
      p99ValidationTime: 0,
      slowValidations: 0
    }
    this.validationTimes = []
  }

  /**
   * Update calculated statistics
   */
  private updateStatistics(): void {
    if (this.validationTimes.length === 0) return

    // Calculate average
    const sum = this.validationTimes.reduce((acc, time) => acc + time, 0)
    this.metrics.averageValidationTime = sum / this.validationTimes.length

    // Calculate percentiles
    const sortedTimes = [...this.validationTimes].sort((a, b) => a - b)
    const p95Index = Math.floor(sortedTimes.length * 0.95)
    const p99Index = Math.floor(sortedTimes.length * 0.99)
    
    this.metrics.p95ValidationTime = sortedTimes[p95Index] || 0
    this.metrics.p99ValidationTime = sortedTimes[p99Index] || 0
  }
}

// Global metrics collector instance
const metricsCollector = new SessionMetricsCollector()

/**
 * Decorator function to monitor session validation performance
 */
export function withSessionMetrics<T extends any[], R>(
  operation: (...args: T) => Promise<R>
): (...args: T) => Promise<R> {
  return async (...args: T): Promise<R> => {
    const startTime = process.hrtime.bigint()
    let redisLatencyStart: bigint | null = null
    let success = false

    try {
      // Measure Redis latency if this is a Redis operation
      redisLatencyStart = process.hrtime.bigint()
      
      const result = await operation(...args)
      success = true
      
      return result
      
    } catch (error) {
      // Classify and record the error
      if (error instanceof Error) {
        if (error.message.includes('timeout')) {
          metricsCollector.recordRedisError('timeout')
        } else if (error.message.includes('JSON') || error.message.includes('parse')) {
          metricsCollector.recordRedisError('serialization')
        } else {
          metricsCollector.recordRedisError('connection')
        }
      }
      
      throw error
      
    } finally {
      const endTime = process.hrtime.bigint()
      const durationMs = Number(endTime - startTime) / 1_000_000

      let redisLatencyMs: number | undefined
      if (redisLatencyStart) {
        redisLatencyMs = Number(endTime - redisLatencyStart) / 1_000_000
      }

      // Record the timing and success status
      metricsCollector.recordValidation(durationMs, success, redisLatencyMs)
    }
  }
}

/**
 * Get comprehensive session performance report
 */
export async function getSessionPerformanceReport(): Promise<{
  sessionMetrics: SessionMetrics
  redisHealth: Awaited<ReturnType<typeof checkRedisHealth>>
  redisStats: Awaited<ReturnType<typeof getRedisStats>>
  performanceStatus: 'EXCELLENT' | 'GOOD' | 'WARNING' | 'CRITICAL'
  recommendations: string[]
}> {
  const sessionMetrics = metricsCollector.getMetrics()
  const redisHealth = await checkRedisHealth()
  const redisStats = await getRedisStats()
  
  // Determine performance status based on portfolio tracking requirements
  let performanceStatus: 'EXCELLENT' | 'GOOD' | 'WARNING' | 'CRITICAL' = 'EXCELLENT'
  const recommendations: string[] = []
  
  const criticalThreshold = config.session.validation.slowCriticalThresholdMs
  const warningThreshold = config.session.validation.slowWarningThresholdMs
  const targetThreshold = config.session.validation.performanceTargetMs
  const p95Target = config.session.monitoring.p95TargetMs
  
  if (sessionMetrics.averageValidationTime > criticalThreshold) {
    performanceStatus = 'CRITICAL'
    recommendations.push(`CRITICAL: Average session validation time > ${criticalThreshold}ms. Check Redis connection and query optimization.`)
  } else if (sessionMetrics.averageValidationTime > warningThreshold) {
    performanceStatus = 'WARNING'
    recommendations.push(`WARNING: Average session validation time > ${warningThreshold}ms target for portfolio tracking.`)
  } else if (sessionMetrics.p95ValidationTime > p95Target) {
    performanceStatus = 'GOOD'
    recommendations.push(`Good average performance, but P95 > ${p95Target}ms. Monitor for performance regression.`)
  }
  
  if (sessionMetrics.slowValidations > sessionMetrics.totalValidations * 0.10) {
    performanceStatus = performanceStatus === 'EXCELLENT' ? 'WARNING' : performanceStatus
    recommendations.push(`${sessionMetrics.slowValidations} slow validations (>10% of total). Investigate Redis latency.`)
  }
  
  if (sessionMetrics.failedValidations > sessionMetrics.totalValidations * 0.01) {
    performanceStatus = 'CRITICAL'
    recommendations.push('CRITICAL: Session validation failure rate > 1%. Check Redis connectivity.')
  }
  
  if (!redisHealth.connected) {
    performanceStatus = 'CRITICAL'
    recommendations.push('CRITICAL: Redis connection failed. Check Redis server status.')
  } else if (redisHealth.latency && redisHealth.latency > 100) {
    performanceStatus = performanceStatus === 'EXCELLENT' ? 'WARNING' : performanceStatus
    recommendations.push(`Redis ping latency ${redisHealth.latency}ms > 100ms. Check network connectivity.`)
  }
  
  const hitRateThreshold = config.session.monitoring.cacheHitRateThreshold
  if (redisStats.hitRate < hitRateThreshold) {
    recommendations.push(`Redis hit rate ${(redisStats.hitRate * 100).toFixed(1)}% < ${(hitRateThreshold * 100).toFixed(0)}%. Consider memory allocation.`)
  }
  
  if (recommendations.length === 0) {
    recommendations.push('✅ Session performance is optimal for portfolio tracking workflows.')
  }
  
  return {
    sessionMetrics,
    redisHealth,
    redisStats,
    performanceStatus,
    recommendations
  }
}

/**
 * Create performance benchmark test
 */
export async function runSessionPerformanceBenchmark(): Promise<{
  averageTime: number
  p95Time: number
  p99Time: number
  successRate: number
  totalOperations: number
}> {
  console.log('🏁 Starting session performance benchmark...')
  
  const { createSession, validateAndRefreshSession } = await import('./session-v2')
  
  // Reset metrics for clean benchmark
  metricsCollector.reset()
  
  const iterations = 100
  const results: number[] = []
  let successCount = 0
  
  // Create a test session
  const { sessionId } = await createSession({
    userId: 'benchmark-user-12345',
    deviceId: 'benchmark-device-67890',
    role: 'TRADER'
  })
  
  console.log(`⚡ Running ${iterations} session validation operations...`)
  
  for (let i = 0; i < iterations; i++) {
    const startTime = process.hrtime.bigint()
    
    try {
      const result = await validateAndRefreshSession(sessionId)
      const endTime = process.hrtime.bigint()
      const durationMs = Number(endTime - startTime) / 1_000_000
      
      results.push(durationMs)
      
      if (result.valid) {
        successCount++
      }
      
    } catch (error) {
      console.error(`Benchmark iteration ${i} failed:`, error)
    }
  }
  
  // Calculate statistics
  const sortedResults = results.sort((a, b) => a - b)
  const averageTime = results.reduce((sum, time) => sum + time, 0) / results.length
  const p95Time = sortedResults[Math.floor(sortedResults.length * 0.95)] || 0
  const p99Time = sortedResults[Math.floor(sortedResults.length * 0.99)] || 0
  const successRate = successCount / iterations
  
  console.log(`📊 Benchmark Results:`)
  console.log(`   Average: ${averageTime.toFixed(2)}ms`)
  console.log(`   P95: ${p95Time.toFixed(2)}ms`)
  console.log(`   P99: ${p99Time.toFixed(2)}ms`)
  console.log(`   Success Rate: ${(successRate * 100).toFixed(1)}%`)
  
  return {
    averageTime,
    p95Time,
    p99Time,
    successRate,
    totalOperations: iterations
  }
}

/**
 * Export metrics collector for internal use
 */
export { metricsCollector }