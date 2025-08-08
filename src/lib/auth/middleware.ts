import { NextRequest, NextResponse } from 'next/server'
import { validateAndRefreshSession, type Session } from './session-v2'

/**
 * Lightweight authentication middleware for Next.js 15
 * 
 * Optimized for <5ms session validation (vs 100ms JWT crypto validation)
 * Based on Codex production patterns for financial applications
 * 
 * Features:
 * - Fast Redis-based session validation
 * - Automatic session refresh (sliding window)
 * - Request headers for downstream handlers
 * - Role-based route protection
 * - Graceful error handling
 */

/**
 * Authentication result passed to request handlers
 */
export interface AuthContext {
  userId: string
  deviceId: string
  role: Session['role']
  roleVersion: number
  mfa: boolean
  sessionId: string
}

/**
 * Routes that require authentication
 * Extend this list as needed for your application
 */
const PROTECTED_ROUTES = [
  '/api/portfolio',
  '/api/holdings',
  '/api/auth/refresh',
  '/api/auth/revoke',
  '/api/ws/token',
  '/dashboard',
  '/portfolio',
  '/holdings',
  '/admin'
] as const

/**
 * Admin-only routes that require ADMIN or SYSTEM role
 */
const ADMIN_ROUTES = [
  '/api/admin',
  '/api/system',
  '/admin'
] as const

/**
 * Routes that bypass authentication (public access)
 */
const PUBLIC_ROUTES = [
  '/api/auth/login',
  '/api/auth/callback',
  '/login',
  '/signup',
  '/forgot-password',
  '/',
  '/about',
  '/pricing'
] as const

/**
 * Extract session ID from request cookies
 * Supports multiple cookie formats for compatibility
 * 
 * @param request Next.js request object
 * @returns Session ID or null if not found
 */
function extractSessionId(request: NextRequest): string | null {
  // Primary session cookie (httpOnly, secure)
  const sessionId = request.cookies.get('app_session')?.value
  if (sessionId) return sessionId
  
  // Fallback: Authorization header (for API clients)
  const authHeader = request.headers.get('authorization')
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7)
  }
  
  return null
}

/**
 * Check if route requires authentication
 * 
 * @param pathname Request pathname
 * @returns True if route requires auth
 */
function requiresAuth(pathname: string): boolean {
  // Check public routes first (most common case)
  if (PUBLIC_ROUTES.some(route => pathname === route || pathname.startsWith(route + '/'))) {
    return false
  }
  
  // Check protected routes
  return PROTECTED_ROUTES.some(route => 
    pathname === route || pathname.startsWith(route + '/')
  )
}

/**
 * Check if route requires admin privileges
 * 
 * @param pathname Request pathname
 * @returns True if route requires admin role
 */
function requiresAdmin(pathname: string): boolean {
  return ADMIN_ROUTES.some(route => 
    pathname === route || pathname.startsWith(route + '/')
  )
}

/**
 * Create authentication context headers for downstream handlers
 * 
 * @param session Validated session
 * @param sessionId Session ID
 * @returns Headers object with auth context
 */
function createAuthHeaders(session: Session, sessionId: string): Record<string, string> {
  return {
    'x-user-id': session.uid,
    'x-device-id': session.did,
    'x-user-role': session.role,
    'x-role-version': session.roleVersion.toString(),
    'x-session-id': sessionId,
    'x-mfa-verified': session.mfa.toString(),
    'x-auth-timestamp': Date.now().toString()
  }
}

/**
 * Create unauthorized response with proper error codes
 * 
 * @param reason Reason for authentication failure
 * @param pathname Current pathname for logging
 * @returns Unauthorized response
 */
function createUnauthorizedResponse(
  reason: string,
  pathname: string
): NextResponse {
  console.warn(`Auth failed on ${pathname}: ${reason}`)
  
  // For API routes, return JSON error
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { 
        error: 'Unauthorized',
        code: 'AUTH_REQUIRED',
        message: 'Valid authentication required'
      },
      { status: 401 }
    )
  }
  
  // For pages, redirect to login with return URL
  const loginUrl = new URL('/login', process.env.NEXT_PUBLIC_APP_URL)
  loginUrl.searchParams.set('returnUrl', pathname)
  
  return NextResponse.redirect(loginUrl)
}

/**
 * Create forbidden response for insufficient privileges
 * 
 * @param pathname Current pathname
 * @param requiredRole Required role
 * @param userRole User's current role
 * @returns Forbidden response
 */
function createForbiddenResponse(
  pathname: string,
  requiredRole: string,
  userRole: string
): NextResponse {
  console.warn(`Access denied on ${pathname}: user role ${userRole}, required ${requiredRole}`)
  
  // For API routes, return JSON error
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      {
        error: 'Forbidden',
        code: 'INSUFFICIENT_PRIVILEGES',
        message: `Required role: ${requiredRole}, current role: ${userRole}`
      },
      { status: 403 }
    )
  }
  
  // For pages, redirect to access denied page
  return NextResponse.redirect(new URL('/access-denied', process.env.NEXT_PUBLIC_APP_URL))
}

/**
 * Main authentication middleware function
 * 
 * This function:
 * 1. Extracts session ID from cookies/headers
 * 2. Validates session against Redis (fast lookup)
 * 3. Refreshes session automatically (sliding window)
 * 4. Sets auth context headers for downstream handlers
 * 5. Enforces role-based access control
 * 
 * @param request Next.js request object
 * @returns Modified response with auth context or redirect
 */
export async function authMiddleware(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl
  
  // Skip auth for public routes
  if (!requiresAuth(pathname)) {
    return NextResponse.next()
  }
  
  try {
    // Extract session ID (fast operation)
    const sessionId = extractSessionId(request)
    if (!sessionId) {
      return createUnauthorizedResponse('No session ID', pathname)
    }
    
    // Validate and refresh session (Redis operation, <5ms target)
    const startTime = Date.now()
    const result = await validateAndRefreshSession(sessionId)
    const validationTime = Date.now() - startTime
    
    // Log slow session validations for monitoring
    if (validationTime > 10) {
      console.warn(`Slow session validation: ${validationTime}ms for ${pathname}`)
    }
    
    if (!result.valid || !result.session) {
      // Clean up invalid session cookie
      const response = createUnauthorizedResponse(result.reason || 'Invalid session', pathname)
      response.cookies.delete('app_session')
      return response
    }
    
    const { session } = result
    
    // Check admin role requirements
    if (requiresAdmin(pathname)) {
      if (session.role !== 'ADMIN' && session.role !== 'SYSTEM') {
        return createForbiddenResponse(pathname, 'ADMIN', session.role)
      }
    }
    
    // Create response with auth context headers
    const response = NextResponse.next({
      request: {
        headers: new Headers(request.headers)
      }
    })
    
    // Add auth context headers for downstream handlers
    const authHeaders = createAuthHeaders(session, sessionId)
    for (const [key, value] of Object.entries(authHeaders)) {
      response.headers.set(key, value)
    }
    
    // Add performance timing header
    response.headers.set('x-auth-validation-time', validationTime.toString())
    
    return response
    
  } catch (error) {
    // Log error but don't expose internal details
    console.error('Auth middleware error:', error)
    
    return createUnauthorizedResponse('Authentication error', pathname)
  }
}

/**
 * Utility function to extract auth context from request headers
 * Use this in API routes and Server Actions to get authenticated user info
 * 
 * @param request Next.js request object or headers
 * @returns Auth context or null if not authenticated
 */
export function getAuthContext(
  request: NextRequest | Request | Headers
): AuthContext | null {
  let headers: Headers
  
  if (request instanceof Headers) {
    headers = request
  } else {
    headers = request.headers
  }
  
  const userId = headers.get('x-user-id')
  const deviceId = headers.get('x-device-id')
  const role = headers.get('x-user-role') as Session['role']
  const roleVersion = headers.get('x-role-version')
  const sessionId = headers.get('x-session-id')
  const mfa = headers.get('x-mfa-verified')
  
  if (!userId || !deviceId || !role || !roleVersion || !sessionId) {
    return null
  }
  
  return {
    userId,
    deviceId,
    role,
    roleVersion: parseInt(roleVersion),
    mfa: mfa === 'true',
    sessionId
  }
}

/**
 * Server Action helper to require authentication
 * Throws error if not authenticated, returns context if valid
 * 
 * @param headers Request headers from Server Action
 * @returns Auth context
 * @throws Error if not authenticated
 */
export function requireAuth(headers: Headers): AuthContext {
  const context = getAuthContext(headers)
  
  if (!context) {
    throw new Error('Authentication required')
  }
  
  return context
}

/**
 * Server Action helper to require specific role
 * Throws error if insufficient privileges
 * 
 * @param headers Request headers from Server Action
 * @param requiredRoles Required roles (user must have at least one)
 * @returns Auth context
 * @throws Error if insufficient privileges
 */
export function requireRole(
  headers: Headers,
  ...requiredRoles: Session['role'][]
): AuthContext {
  const context = requireAuth(headers)
  
  if (!requiredRoles.includes(context.role)) {
    throw new Error(
      `Insufficient privileges. Required: ${requiredRoles.join(' or ')}, Current: ${context.role}`
    )
  }
  
  return context
}

/**
 * Middleware configuration for Next.js
 * Define which routes should be processed by the middleware
 */
export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
}