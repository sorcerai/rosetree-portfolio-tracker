import { NextRequest, NextResponse } from 'next/server'
import { revokeSession, revokeAllUserSessions } from '@/lib/auth/session-v2'
import { getAuthContext } from '@/lib/auth/middleware'

/**
 * Session revocation endpoint
 * 
 * Provides instant session invalidation for security events:
 * 1. Single session revocation (logout)
 * 2. All user sessions revocation (password change, security breach)
 * 3. Admin-initiated revocation (account suspension)
 * 
 * Critical for financial applications where immediate access revocation is required
 */

interface RevokeRequest {
  scope?: 'current' | 'all' | 'user'  // Default: current session only
  userId?: string                      // Required for 'user' scope (admin only)
  reason?: string                      // Optional reason for logging
}

interface RevokeResponse {
  success: boolean
  sessionsRevoked: number
  error?: string
}

export async function POST(request: NextRequest): Promise<NextResponse<RevokeResponse>> {
  try {
    const body = await request.json().catch(() => ({}))
    const { scope = 'current', userId: targetUserId, reason } = body as RevokeRequest
    
    // Extract current session context
    const sessionId = request.cookies.get('app_session')?.value
    const authContext = getAuthContext(request)
    
    if (!sessionId && scope === 'current') {
      return NextResponse.json(
        { success: false, sessionsRevoked: 0, error: 'No active session to revoke' },
        { status: 400 }
      )
    }
    
    let sessionsRevoked = 0
    
    switch (scope) {
      case 'current': {
        // Revoke current session only (standard logout)
        if (sessionId) {
          await revokeSession(sessionId, authContext?.userId)
          sessionsRevoked = 1
          
          console.info(`Session revoked: ${sessionId} for user ${authContext?.userId}. Reason: ${reason || 'user logout'}`)
        }
        break
      }
      
      case 'all': {
        // Revoke all sessions for current user (password change, security event)
        if (!authContext?.userId) {
          return NextResponse.json(
            { success: false, sessionsRevoked: 0, error: 'Authentication required' },
            { status: 401 }
          )
        }
        
        await revokeAllUserSessions(authContext.userId)
        sessionsRevoked = -1 // Indicates all sessions (unknown count)
        
        console.warn(`All sessions revoked for user ${authContext.userId}. Reason: ${reason || 'user initiated'}`)
        break
      }
      
      case 'user': {
        // Admin-only: Revoke all sessions for specified user
        if (!authContext || (authContext.role !== 'ADMIN' && authContext.role !== 'SYSTEM')) {
          return NextResponse.json(
            { success: false, sessionsRevoked: 0, error: 'Admin privileges required' },
            { status: 403 }
          )
        }
        
        if (!targetUserId) {
          return NextResponse.json(
            { success: false, sessionsRevoked: 0, error: 'User ID required for user scope' },
            { status: 400 }
          )
        }
        
        await revokeAllUserSessions(targetUserId)
        sessionsRevoked = -1 // Indicates all sessions for target user
        
        console.warn(`Admin ${authContext.userId} revoked all sessions for user ${targetUserId}. Reason: ${reason || 'admin action'}`)
        break
      }
      
      default: {
        return NextResponse.json(
          { success: false, sessionsRevoked: 0, error: `Invalid scope: ${scope}` },
          { status: 400 }
        )
      }
    }
    
    // Create response and clear session cookie for current/all scopes
    const response = NextResponse.json({
      success: true,
      sessionsRevoked
    })
    
    if (scope === 'current' || scope === 'all') {
      // Clear session cookie
      response.cookies.delete('app_session')
      
      // Also clear device cookie if present
      response.cookies.delete('device_id')
    }
    
    return response
    
  } catch (error) {
    console.error('Session revocation error:', error)
    
    return NextResponse.json(
      { success: false, sessionsRevoked: 0, error: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * DELETE endpoint for RESTful session termination
 * Equivalent to POST with scope='current'
 */
export async function DELETE(request: NextRequest): Promise<NextResponse<RevokeResponse>> {
  // Delegate to POST with current scope
  const modifiedRequest = new NextRequest(request.url, {
    method: 'POST',
    headers: request.headers,
    body: JSON.stringify({ scope: 'current', reason: 'DELETE request' })
  })
  
  return POST(modifiedRequest)
}

/**
 * Usage Examples:
 * 
 * Standard logout (revoke current session):
 * ```typescript
 * await fetch('/api/auth/revoke', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ scope: 'current' })
 * })
 * ```
 * 
 * Security event (revoke all user sessions):
 * ```typescript
 * await fetch('/api/auth/revoke', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ 
 *     scope: 'all', 
 *     reason: 'password changed' 
 *   })
 * })
 * ```
 * 
 * Admin suspension (revoke all sessions for user):
 * ```typescript
 * await fetch('/api/auth/revoke', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ 
 *     scope: 'user',
 *     userId: 'target-user-id',
 *     reason: 'account suspended'
 *   })
 * })
 * ```
 * 
 * RESTful deletion:
 * ```typescript
 * await fetch('/api/auth/revoke', { method: 'DELETE' })
 * ```
 * 
 * Security Features:
 * - Instant session invalidation (< 1 second)
 * - Comprehensive audit logging
 * - Admin privilege enforcement
 * - Cascading session cleanup (Redis + cookies)
 * - Role-based access control for user scope
 */