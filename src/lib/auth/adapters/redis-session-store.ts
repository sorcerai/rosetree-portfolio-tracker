import Redis from 'ioredis'
import type { SessionStore } from '../ports'
import type { Session } from '../session-v2'

/**
 * Redis implementation of SessionStore port
 * 
 * Wraps the existing Redis session logic in a clean interface
 * for dependency injection and testing
 */
export class RedisSessionStore implements SessionStore {
  constructor(private redis: Redis) {}

  async get(sessionId: string): Promise<Session | null> {
    try {
      const data = await this.redis.get(`sess:${sessionId}`)
      if (!data) return null
      
      return JSON.parse(data) as Session
    } catch (error) {
      console.error('Session get error:', error)
      return null
    }
  }

  async set(sessionId: string, session: Session, ttlSec: number): Promise<void> {
    try {
      await this.redis.set(
        `sess:${sessionId}`,
        JSON.stringify(session),
        'EX',
        ttlSec
      )
    } catch (error) {
      console.error('Session set error:', error)
      throw new Error('Failed to store session')
    }
  }

  async del(sessionId: string): Promise<void> {
    try {
      const pipeline = this.redis.pipeline()
      pipeline.del(`sess:${sessionId}`)
      await pipeline.exec()
    } catch (error) {
      console.error('Session delete error:', error)
      throw new Error('Failed to delete session')
    }
  }

  async getUserSessions(userId: string): Promise<string[]> {
    try {
      return await this.redis.smembers(`user:sess:${userId}`)
    } catch (error) {
      console.error('Get user sessions error:', error)
      return []
    }
  }

  async delUserSessions(userId: string): Promise<void> {
    try {
      const sessionIds = await this.getUserSessions(userId)
      if (sessionIds.length === 0) return

      const pipeline = this.redis.pipeline()
      
      // Delete all session keys
      sessionIds.forEach(sessionId => {
        pipeline.del(`sess:${sessionId}`)
      })
      
      // Delete user session tracking
      pipeline.del(`user:sess:${userId}`)
      
      // Increment role version to invalidate any cached sessions
      pipeline.incr(`user:ver:${userId}`)
      
      await pipeline.exec()
    } catch (error) {
      console.error('Delete user sessions error:', error)
      throw new Error('Failed to delete user sessions')
    }
  }

  async health(): Promise<{ connected: boolean; latency?: number; error?: string }> {
    try {
      const start = Date.now()
      await this.redis.ping()
      const latency = Date.now() - start
      
      return { connected: true, latency }
    } catch (error) {
      return { 
        connected: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }
    }
  }

  async incr(key: string): Promise<number> {
    try {
      return await this.redis.incr(key)
    } catch (error) {
      console.error('Increment error:', error)
      throw new Error('Failed to increment counter')
    }
  }

  async getUserSessionCount(userId: string): Promise<number> {
    try {
      return await this.redis.scard(`user:sess:${userId}`)
    } catch (error) {
      console.error('Get user session count error:', error)
      return 0
    }
  }

  /**
   * Helper method to add session to user tracking
   */
  async trackUserSession(userId: string, sessionId: string): Promise<void> {
    try {
      await this.redis.sadd(`user:sess:${userId}`, sessionId)
    } catch (error) {
      console.error('Track user session error:', error)
      throw new Error('Failed to track user session')
    }
  }

  /**
   * Helper method to remove session from user tracking  
   */
  async untrackUserSession(userId: string, sessionId: string): Promise<void> {
    try {
      await this.redis.srem(`user:sess:${userId}`, sessionId)
    } catch (error) {
      console.error('Untrack user session error:', error)
      throw new Error('Failed to untrack user session')
    }
  }

  /**
   * Atomic session creation with user tracking
   */
  async createWithTracking(
    sessionId: string, 
    session: Session, 
    ttlSec: number
  ): Promise<void> {
    try {
      const pipeline = this.redis.pipeline()
      
      // Store session
      pipeline.set(`sess:${sessionId}`, JSON.stringify(session), 'EX', ttlSec)
      
      // Track session for user
      pipeline.sadd(`user:sess:${session.uid}`, sessionId)
      
      await pipeline.exec()
    } catch (error) {
      console.error('Create session with tracking error:', error)
      throw new Error('Failed to create session with tracking')
    }
  }

  /**
   * Atomic session deletion with user tracking cleanup
   */
  async deleteWithTracking(sessionId: string, userId?: string): Promise<void> {
    try {
      const pipeline = this.redis.pipeline()
      
      // If userId not provided, fetch from session
      if (!userId) {
        const session = await this.get(sessionId)
        if (session) {
          userId = session.uid
        }
      }
      
      // Delete session
      pipeline.del(`sess:${sessionId}`)
      
      // Remove from user tracking if we have userId
      if (userId) {
        pipeline.srem(`user:sess:${userId}`, sessionId)
      }
      
      await pipeline.exec()
    } catch (error) {
      console.error('Delete session with tracking error:', error)
      throw new Error('Failed to delete session with tracking')
    }
  }
}