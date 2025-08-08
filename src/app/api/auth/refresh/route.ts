import { NextRequest, NextResponse } from 'next/server'
import { validateAndRefreshSession, rotateSession } from '@/lib/auth/session-v2'

/**
 * Session refresh endpoint
 * 
 * This endpoint handles session extension and rotation:
 * 1. Validates current session
 * 2. Extends sliding window expiration
 * 3. Optionally rotates session for security events
 * 4. Updates session cookie
 * 
 * Called automatically by middleware or explicitly by client
 */

interface RefreshRequest {
  rotateSession?: boolean  // Force session rotation (for MFA, password change)
}

interface RefreshResponse {
  success: boolean
  expiresAt?: number
  rotationCount?: number
  error?: string
}

export async function POST(request: NextRequest): Promise<NextResponse<RefreshResponse>> {
  try {
    // Extract session ID from cookie
    const sessionId = request.cookies.get('app_session')?.value
    
    if (!sessionId) {
      return NextResponse.json(
        { success: false, error: 'No session found' },
        { status: 401 }
      )
    }
    
    const body = await request.json().catch(() => ({}))
    const { rotateSession: shouldRotate } = body as RefreshRequest
    
    // Step 1: Validate and refresh session (extends sliding window)
    const validationResult = await validateAndRefreshSession(sessionId)
    
    if (!validationResult.valid || !validationResult.session) {
      // Clear invalid session cookie
      const response = NextResponse.json(
        { success: false, error: validationResult.reason || 'Invalid session' },
        { status: 401 }
      )
      
      response.cookies.delete('app_session')
      return response
    }
    
    let session = validationResult.session
    
    // Step 2: Optionally rotate session for security events
    if (shouldRotate) {
      const rotatedSession = await rotateSession(sessionId)
      if (rotatedSession) {
        session = rotatedSession
      }
    }
    
    // Step 3: Update session cookie with new expiration
    const response = NextResponse.json({
      success: true,
      expiresAt: session.exp * 1000, // Convert to milliseconds
      rotationCount: session.rc
    })
    
    // Update cookie with same secure settings as login
    response.cookies.set('app_session', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: 12 * 60 * 60, // 12 hours (idle TTL)
      priority: 'high'
    })
    
    return response
    
  } catch (error) {
    console.error('Session refresh error:', error)
    
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * GET endpoint for session status check
 * Returns current session information without refreshing
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const sessionId = request.cookies.get('app_session')?.value
    
    if (!sessionId) {
      return NextResponse.json(
        { authenticated: false },
        { status: 200 }
      )
    }
    
    // Validate without refresh (read-only check)
    const validationResult = await validateAndRefreshSession(sessionId, 0) // 0 TTL = no refresh
    
    if (!validationResult.valid || !validationResult.session) {
      return NextResponse.json(
        { authenticated: false, reason: validationResult.reason },
        { status: 200 }
      )
    }
    
    const session = validationResult.session
    
    return NextResponse.json({
      authenticated: true,
      userId: session.uid,
      role: session.role,
      expiresAt: session.exp * 1000,
      idleExpiresAt: session.idleExp * 1000,
      mfaVerified: session.mfa,
      rotationCount: session.rc
    })
    
  } catch (error) {
    console.error('Session status error:', error)
    
    return NextResponse.json(
      { authenticated: false, error: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * Usage Examples:
 * 
 * Automatic refresh (called by middleware):
 * ```typescript
 * // Middleware automatically calls this for sliding window
 * POST /api/auth/refresh
 * ```
 * 
 * Force session rotation (after MFA, password change):
 * ```typescript
 * fetch('/api/auth/refresh', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ rotateSession: true })
 * })
 * ```
 * 
 * Check session status:
 * ```typescript
 * const response = await fetch('/api/auth/refresh')
 * const { authenticated, userId, role } = await response.json()
 * ```
 */