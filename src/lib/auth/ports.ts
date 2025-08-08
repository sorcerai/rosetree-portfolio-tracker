/**
 * Authentication Service Ports (Interfaces)
 * 
 * Clean abstractions for dependency injection and testing
 * Based on Codex recommendations for production-grade testing
 * 
 * These interfaces decouple business logic from external dependencies,
 * making unit testing much easier and eliminating circular import issues
 */

import type { Session } from './session-v2'

/**
 * Session storage abstraction
 * Isolates Redis-specific logic for clean testing
 */
export interface SessionStore {
  /**
   * Retrieve session data by ID
   */
  get(sessionId: string): Promise<Session | null>
  
  /**
   * Store session data with TTL
   */
  set(sessionId: string, session: Session, ttlSec: number): Promise<void>
  
  /**
   * Delete session by ID
   */
  del(sessionId: string): Promise<void>
  
  /**
   * Get all session IDs for a user
   */
  getUserSessions(userId: string): Promise<string[]>
  
  /**
   * Delete all sessions for a user
   */
  delUserSessions(userId: string): Promise<void>
  
  /**
   * Check if store is healthy
   */
  health(): Promise<{ connected: boolean; latency?: number; error?: string }>
  
  /**
   * Increment a counter (for role version tracking)
   */
  incr(key: string): Promise<number>
  
  /**
   * Get session count for a user
   */
  getUserSessionCount(userId: string): Promise<number>
}

/**
 * User repository abstraction
 * Isolates database-specific logic for clean testing
 */
export interface UserRepository {
  /**
   * Find user by ID
   */
  findById(userId: string): Promise<User | null>
  
  /**
   * Find user by email
   */
  findByEmail(email: string): Promise<User | null>
  
  /**
   * Create user atomically with portfolio
   */
  provisionUser(userId: string, email: string, role?: UserRole): Promise<UserProvisionResult>
  
  /**
   * Update user role and increment version
   */
  updateRole(userId: string, role: UserRole): Promise<void>
  
  /**
   * Get user role version (for session invalidation)
   */
  getRoleVersion(userId: string): Promise<number>
}

/**
 * Token service abstraction  
 * Isolates JWT/crypto logic for clean testing
 */
export interface TokenService {
  /**
   * Issue a new token with payload and TTL
   */
  issue(payload: TokenPayload, ttlSec: number): Promise<string>
  
  /**
   * Verify and decode token
   */
  verify(token: string): Promise<TokenPayload | null>
  
  /**
   * Issue one-time use token for WebSocket auth
   */
  issueOneTime(payload: TokenPayload, ttlSec: number): Promise<string>
  
  /**
   * Consume one-time token (single use)
   */
  consumeOneTime(token: string): Promise<TokenPayload | null>
}

/**
 * Database context manager abstraction
 * Isolates RLS and transaction logic for clean testing
 */
export interface DatabaseContext {
  /**
   * Execute operation with user RLS context
   */
  withUserContext<T>(
    context: UserContext,
    operation: (db: DatabaseClient) => Promise<T>
  ): Promise<T>
  
  /**
   * Execute operation with system privileges
   */
  withSystemContext<T>(
    operation: (db: DatabaseClient) => Promise<T>
  ): Promise<T>
  
  /**
   * Execute operation with admin context
   */
  withAdminContext<T>(
    adminUserId: string,
    operation: (db: DatabaseClient) => Promise<T>
  ): Promise<T>
  
  /**
   * Get connection pool stats
   */
  getPoolStats(): PoolStats
}

/**
 * Supporting types
 */
export interface User {
  id: string
  email: string
  role: UserRole
  createdAt: Date
  lastSeenAt?: Date
}

export interface UserContext {
  userId: string
  roles: readonly UserRole[]
}

export interface UserProvisionResult {
  userId: string
  portfolioId: string
  created: boolean
}

export interface TokenPayload {
  userId: string
  role: UserRole
  deviceId?: string
  sessionId?: string
  [key: string]: any
}

export interface PoolStats {
  totalCount: number
  idleCount: number
  waitingCount: number
}

export interface DatabaseClient {
  // Drizzle database client interface
  select: (...args: any[]) => any
  insert: (...args: any[]) => any
  update: (...args: any[]) => any
  delete: (...args: any[]) => any
  execute: (query: string, params?: any[]) => Promise<any>
}

export type UserRole = 'TRADER' | 'COACH' | 'ADMIN' | 'SYSTEM'

/**
 * Authentication service dependencies
 * Main container for all auth-related services
 */
export interface AuthDependencies {
  sessionStore: SessionStore
  userRepository: UserRepository
  tokenService: TokenService
  databaseContext: DatabaseContext
}

/**
 * Request context for middleware
 * Framework-agnostic context for auth decisions
 */
export interface RequestContext {
  path: string
  method: string
  ip?: string
  userAgent?: string
  cookies: Record<string, string>
  headers: Record<string, string>
}

/**
 * Authentication result
 * Standard result from auth operations
 */
export interface AuthResult {
  success: boolean
  user?: User
  session?: Session  
  reason?: string
  redirect?: string
}

/**
 * Authorization context
 * Contains all info needed for access control decisions
 */
export interface AuthContext {
  userId: string
  deviceId: string
  role: UserRole
  roleVersion: number
  mfa: boolean
  sessionId: string
  issuedAt: number
  expiresAt: number
}