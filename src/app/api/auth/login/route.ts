import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createSession } from '@/lib/auth/session-v2'
import { provisionUser } from '@/lib/db/rls-context'

/**
 * Authentication login endpoint
 * 
 * This endpoint bridges Supabase authentication with our Redis session system:
 * 1. Validates Supabase JWT token (one-time verification)
 * 2. Provisions local user atomically (prevents race conditions)
 * 3. Creates fast Redis-backed app session
 * 4. Sets secure httpOnly session cookie
 * 
 * Based on Codex security patterns for financial applications
 */

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!, // Server-side key for user validation
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
)

interface LoginRequest {
  supabaseAccessToken: string  // From Supabase client-side auth
  deviceFingerprint?: string   // Optional device identification
}

interface LoginResponse {
  success: boolean
  userId?: string
  role?: string
  expiresAt?: number
  error?: string
}

export async function POST(request: NextRequest): Promise<NextResponse<LoginResponse>> {
  try {
    const body = await request.json()
    const { supabaseAccessToken, deviceFingerprint } = body as LoginRequest
    
    if (!supabaseAccessToken) {
      return NextResponse.json(
        { success: false, error: 'Missing access token' },
        { status: 400 }
      )
    }
    
    // Step 1: Validate Supabase JWT token (expensive operation, done once)
    const { data: { user }, error: authError } = await supabase.auth.getUser(supabaseAccessToken)
    
    if (authError || !user) {
      console.warn('Invalid Supabase token:', authError?.message)
      return NextResponse.json(
        { success: false, error: 'Invalid authentication token' },
        { status: 401 }
      )
    }
    
    // Step 2: Provision local user atomically (prevents race conditions)
    let localUser
    try {
      localUser = await provisionUser(user.id, user.email!, 'TRADER')
    } catch (error) {
      console.error('User provisioning failed:', error)
      return NextResponse.json(
        { success: false, error: 'User provisioning failed' },
        { status: 500 }
      )
    }
    
    // Step 3: Extract request metadata for security
    const ip = request.headers.get('x-forwarded-for') || 
               request.headers.get('x-real-ip') || 
               'unknown'
    const userAgent = request.headers.get('user-agent') || 'unknown'
    
    // Generate device ID from fingerprint or create new one
    const deviceId = deviceFingerprint || 
                    crypto.randomUUID() + '-' + Date.now()
    
    // Step 4: Create fast Redis session (replaces expensive JWT validation)
    const sessionResult = await createSession({
      userId: localUser.userId,
      deviceId,
      role: 'TRADER', // Will be configurable per user later
      absoluteTtlSec: 30 * 24 * 60 * 60, // 30 days
      idleTtlSec: 12 * 60 * 60,          // 12 hours sliding
      ip,
      userAgent,
      mfa: false // Will implement MFA later
    })
    
    // Step 5: Set secure httpOnly session cookie
    const response = NextResponse.json({
      success: true,
      userId: localUser.userId,
      role: 'TRADER',
      expiresAt: sessionResult.session.exp * 1000 // Convert to milliseconds
    })
    
    // Secure cookie configuration for production
    response.cookies.set('app_session', sessionResult.sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: 12 * 60 * 60, // 12 hours (matches idle TTL)
      priority: 'high'
    })
    
    // Optional: Set device cookie for device recognition
    if (deviceFingerprint) {
      response.cookies.set('device_id', deviceId, {
        httpOnly: false, // Client needs access
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        path: '/',
        maxAge: 365 * 24 * 60 * 60 // 1 year
      })
    }
    
    // Log successful authentication for monitoring
    console.info(`User authenticated: ${localUser.userId} from ${ip}`)
    
    return response
    
  } catch (error) {
    console.error('Login endpoint error:', error)
    
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * Handle preflight CORS requests
 */
export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': process.env.NEXT_PUBLIC_APP_URL || '*',
      'Access-Control-Allow-Methods': 'POST',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Credentials': 'true'
    }
  })
}

/**
 * Login endpoint configuration and usage:
 * 
 * Frontend Usage:
 * ```typescript
 * const { data: { session } } = await supabase.auth.getSession()
 * 
 * const response = await fetch('/api/auth/login', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({
 *     supabaseAccessToken: session.access_token,
 *     deviceFingerprint: getDeviceFingerprint() // optional
 *   })
 * })
 * ```
 * 
 * Security Features:
 * - One-time Supabase JWT validation (expensive crypto ops done once)
 * - Atomic user provisioning (no race conditions)
 * - Device fingerprinting for security
 * - IP and User-Agent logging
 * - Secure session cookie with proper flags
 * 
 * Performance:
 * - Subsequent requests use <5ms Redis validation vs 100ms+ JWT
 * - No network dependency after initial login
 * - Sliding window session refresh
 */