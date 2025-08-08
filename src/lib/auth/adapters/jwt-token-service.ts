import { createHmac, randomBytes } from 'crypto'
import type { TokenService, TokenPayload } from '../ports'

/**
 * JWT-based implementation of TokenService port
 * 
 * Provides secure token creation and verification for:
 * - WebSocket authentication tokens
 * - One-time authentication tokens
 * - API access tokens
 * 
 * Based on production patterns from Codex for financial applications
 * Uses HMAC-SHA256 for fast signing and verification
 */
export class JWTTokenService implements TokenService {
  private readonly jwtSecret: string
  private readonly wsSecret: string
  private readonly issuer: string
  
  // One-time token store (in production, use Redis with TTL)
  private readonly oneTimeTokens = new Map<string, { payload: TokenPayload; expiresAt: number }>()
  
  constructor(options?: {
    jwtSecret?: string
    wsSecret?: string  
    issuer?: string
  }) {
    this.jwtSecret = options?.jwtSecret || process.env.JWT_SECRET!
    this.wsSecret = options?.wsSecret || process.env.WS_JWT_SECRET || this.jwtSecret
    this.issuer = options?.issuer || process.env.NEXT_PUBLIC_APP_URL || 'rosetree-portfolio'
    
    if (!this.jwtSecret) {
      throw new Error('JWT_SECRET environment variable is required')
    }
    
    // Clean up expired one-time tokens every 5 minutes
    setInterval(() => this.cleanupExpiredTokens(), 5 * 60 * 1000)
  }
  
  /**
   * Issue a new JWT token with payload and TTL
   * Uses HMAC-SHA256 for fast signing
   */
  async issue(payload: TokenPayload, ttlSec: number): Promise<string> {
    try {
      const now = Math.floor(Date.now() / 1000)
      const expiresAt = now + ttlSec
      
      const jwtPayload = {
        sub: payload.userId,          // Subject (JWT standard)
        role: payload.role,           // User role
        device: payload.deviceId,     // Device ID (optional)
        session: payload.sessionId,   // Session ID (optional)
        iat: now,                     // Issued at
        exp: expiresAt,              // Expires at
        jti: this.generateJti(),     // JWT ID for uniqueness
        aud: 'api',                  // Audience
        iss: this.issuer,            // Issuer
        ...payload                   // Include any additional payload data
      }
      
      return this.signToken(jwtPayload, this.jwtSecret)
      
    } catch (error) {
      console.error('TokenService.issue error:', error)
      throw new Error(`Failed to issue token: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }
  
  /**
   * Verify and decode JWT token
   * Returns null if token is invalid or expired
   */
  async verify(token: string): Promise<TokenPayload | null> {
    try {
      const payload = this.verifyToken(token, this.jwtSecret)
      if (!payload) return null
      
      // Check expiration
      const now = Math.floor(Date.now() / 1000)
      if (payload.exp && payload.exp < now) {
        return null
      }
      
      // Return normalized TokenPayload
      return {
        userId: payload.sub,
        role: payload.role,
        deviceId: payload.device,
        sessionId: payload.session,
        ...payload
      }
      
    } catch (error) {
      console.error('TokenService.verify error:', error)
      return null
    }
  }
  
  /**
   * Issue one-time use token for WebSocket auth
   * Short-lived token that can only be consumed once
   */
  async issueOneTime(payload: TokenPayload, ttlSec: number): Promise<string> {
    try {
      const now = Math.floor(Date.now() / 1000)
      const expiresAt = now + Math.min(ttlSec, 300) // Max 5 minutes for security
      
      const wsPayload = {
        sub: payload.userId,
        sid: payload.sessionId,
        role: payload.role,
        channels: this.getAuthorizedChannels(payload.userId, payload.role),
        iat: now,
        exp: expiresAt,
        jti: this.generateJti(),
        aud: 'websocket',
        iss: this.issuer,
        ...payload
      }
      
      const token = this.signToken(wsPayload, this.wsSecret)
      
      // Store for one-time consumption tracking
      this.oneTimeTokens.set(wsPayload.jti, {
        payload: {
          userId: payload.userId,
          role: payload.role,
          deviceId: payload.deviceId,
          sessionId: payload.sessionId
        },
        expiresAt: expiresAt * 1000 // Convert to milliseconds
      })
      
      return token
      
    } catch (error) {
      console.error('TokenService.issueOneTime error:', error)
      throw new Error(`Failed to issue one-time token: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }
  
  /**
   * Consume one-time token (single use)
   * Returns payload and removes token from store
   */
  async consumeOneTime(token: string): Promise<TokenPayload | null> {
    try {
      const payload = this.verifyToken(token, this.wsSecret)
      if (!payload || !payload.jti) {
        return null
      }
      
      // Check if token exists in one-time store
      const storedToken = this.oneTimeTokens.get(payload.jti)
      if (!storedToken) {
        // Token already consumed or never existed
        return null
      }
      
      // Check expiration
      const now = Date.now()
      if (storedToken.expiresAt < now) {
        // Remove expired token
        this.oneTimeTokens.delete(payload.jti)
        return null
      }
      
      // Consume token (remove from store)
      this.oneTimeTokens.delete(payload.jti)
      
      return storedToken.payload
      
    } catch (error) {
      console.error('TokenService.consumeOneTime error:', error)
      return null
    }
  }
  
  /**
   * Sign JWT token with HMAC-SHA256
   * Private method for internal token creation
   */
  private signToken(payload: any, secret: string): string {
    const header = {
      typ: 'JWT',
      alg: 'HS256'
    }
    
    const encodedHeader = Buffer.from(JSON.stringify(header)).toString('base64url')
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url')
    
    const signature = createHmac('sha256', secret)
      .update(`${encodedHeader}.${encodedPayload}`)
      .digest('base64url')
    
    return `${encodedHeader}.${encodedPayload}.${signature}`
  }
  
  /**
   * Verify JWT token signature and decode payload
   * Private method for internal token verification
   */
  private verifyToken(token: string, secret: string): any | null {
    try {
      const parts = token.split('.')
      if (parts.length !== 3) {
        return null
      }
      
      const [encodedHeader, encodedPayload, signature] = parts
      
      // Verify signature
      const expectedSignature = createHmac('sha256', secret)
        .update(`${encodedHeader}.${encodedPayload}`)
        .digest('base64url')
      
      if (signature !== expectedSignature) {
        return null
      }
      
      // Decode payload
      const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString())
      return payload
      
    } catch (error) {
      return null
    }
  }
  
  /**
   * Generate unique JWT ID for replay prevention
   */
  private generateJti(): string {
    return randomBytes(16).toString('hex')
  }
  
  /**
   * Get authorized WebSocket channels for user
   * Based on role and user ID
   */
  private getAuthorizedChannels(userId: string, role: string): string[] {
    const channels: string[] = []
    
    // Default channels for all users
    channels.push('prices:public')
    channels.push(`portfolio:${userId}`)
    channels.push(`notifications:${userId}`)
    
    // Role-based channels
    if (role === 'ADMIN' || role === 'SYSTEM') {
      channels.push('system:admin')
      channels.push('portfolios:all')
    }
    
    if (role === 'COACH') {
      channels.push('coach:events')
    }
    
    return channels
  }
  
  /**
   * Clean up expired one-time tokens
   * Runs periodically to prevent memory leaks
   */
  private cleanupExpiredTokens(): void {
    const now = Date.now()
    let cleanedCount = 0
    
    for (const [jti, tokenData] of this.oneTimeTokens.entries()) {
      if (tokenData.expiresAt < now) {
        this.oneTimeTokens.delete(jti)
        cleanedCount++
      }
    }
    
    if (cleanedCount > 0) {
      console.debug(`Cleaned up ${cleanedCount} expired one-time tokens`)
    }
  }
  
  /**
   * Get service health and statistics
   */
  async getHealthStatus(): Promise<{
    healthy: boolean
    oneTimeTokenCount: number
    hasSecrets: boolean
    error?: string
  }> {
    try {
      // Test token creation and verification
      const testPayload: TokenPayload = {
        userId: 'test-user',
        role: 'TRADER'
      }
      
      const token = await this.issue(testPayload, 60)
      const verified = await this.verify(token)
      
      const healthy = verified !== null && verified.userId === testPayload.userId
      
      return {
        healthy,
        oneTimeTokenCount: this.oneTimeTokens.size,
        hasSecrets: !!(this.jwtSecret && this.wsSecret)
      }
      
    } catch (error) {
      return {
        healthy: false,
        oneTimeTokenCount: this.oneTimeTokens.size,
        hasSecrets: !!(this.jwtSecret && this.wsSecret),
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    }
  }
}