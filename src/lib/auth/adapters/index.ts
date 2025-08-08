/**
 * Authentication Service Adapters
 * 
 * Clean implementations of authentication ports for dependency injection
 * Based on Codex recommendations for production-grade testing architecture
 * 
 * This barrel file exports all adapter implementations:
 * - RedisSessionStore: Redis-backed session storage
 * - PostgresUserRepository: PostgreSQL user data operations with RLS
 * - JWTTokenService: JWT token creation and verification
 * - RLSDatabaseContext: Row Level Security database operations
 * 
 * Usage:
 * ```typescript
 * import { 
 *   RedisSessionStore,
 *   PostgresUserRepository,
 *   JWTTokenService,
 *   RLSDatabaseContext
 * } from '@/lib/auth/adapters'
 * 
 * // Create dependency container
 * const authDependencies = {
 *   sessionStore: new RedisSessionStore(redis),
 *   userRepository: new PostgresUserRepository(),
 *   tokenService: new JWTTokenService(),
 *   databaseContext: new RLSDatabaseContext()
 * }
 * ```
 */

// Session storage implementations
export { RedisSessionStore } from './redis-session-store'

// User repository implementations  
export { PostgresUserRepository } from './postgres-user-repository'

// Token service implementations
export { JWTTokenService } from './jwt-token-service'

// Database context implementations
export { RLSDatabaseContext } from './rls-database-context'

// Re-export ports for convenience
export type {
  SessionStore,
  UserRepository, 
  TokenService,
  DatabaseContext,
  AuthDependencies,
  User,
  UserContext,
  UserProvisionResult,
  TokenPayload,
  PoolStats,
  DatabaseClient,
  RequestContext,
  AuthResult,
  AuthContext,
  UserRole
} from '../ports'