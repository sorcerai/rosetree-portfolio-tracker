import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createSession } from '@/lib/auth/session-v2'
import { provisionUser } from '@/lib/db/rls-context'

/**
 * Supabase OAuth callback handler
 * 
 * This endpoint handles OAuth redirects from Supabase Auth:
 * 1. Exchanges authorization code for Supabase session
 * 2. Provisions local user atomically 
 * 3. Creates fast Redis-backed app session
 * 4. Redirects to dashboard with session cookie
 * 
 * Used for Google/GitHub/Apple OAuth flows
 */

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
)

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(request.url)
    const code = searchParams.get('code')
    const error = searchParams.get('error')
    const errorDescription = searchParams.get('error_description')
    
    // Handle OAuth errors
    if (error) {
      console.warn('OAuth callback error:', error, errorDescription)
      
      const errorUrl = new URL('/login', process.env.NEXT_PUBLIC_APP_URL!)
      errorUrl.searchParams.set('error', error)
      errorUrl.searchParams.set('message', errorDescription || 'Authentication failed')
      
      return NextResponse.redirect(errorUrl)
    }
    
    // Handle missing authorization code
    if (!code) {
      console.warn('OAuth callback: missing authorization code')
      
      const errorUrl = new URL('/login', process.env.NEXT_PUBLIC_APP_URL!)
      errorUrl.searchParams.set('error', 'missing_code')
      errorUrl.searchParams.set('message', 'Authorization code missing')
      
      return NextResponse.redirect(errorUrl)
    }
    
    // Step 1: Exchange code for Supabase session
    const { data: sessionData, error: sessionError } = await supabase.auth.exchangeCodeForSession(code)
    
    if (sessionError || !sessionData.user) {
      console.error('Code exchange failed:', sessionError?.message)
      
      const errorUrl = new URL('/login', process.env.NEXT_PUBLIC_APP_URL!)
      errorUrl.searchParams.set('error', 'exchange_failed')
      errorUrl.searchParams.set('message', 'Failed to complete authentication')
      
      return NextResponse.redirect(errorUrl)
    }
    
    const { user, session } = sessionData
    
    // Step 2: Provision local user atomically
    let localUser
    try {
      localUser = await provisionUser(user.id, user.email!, 'TRADER')
    } catch (error) {
      console.error('User provisioning failed in callback:', error)
      
      const errorUrl = new URL('/login', process.env.NEXT_PUBLIC_APP_URL!)
      errorUrl.searchParams.set('error', 'provisioning_failed')
      errorUrl.searchParams.set('message', 'Failed to set up user account')
      
      return NextResponse.redirect(errorUrl)
    }
    
    // Step 3: Extract request metadata for security
    const ip = request.headers.get('x-forwarded-for') || 
               request.headers.get('x-real-ip') || 
               'unknown'
    const userAgent = request.headers.get('user-agent') || 'unknown'
    
    // Generate device ID for OAuth flow (no fingerprinting available)
    const deviceId = `oauth-${crypto.randomUUID()}-${Date.now()}`
    
    // Step 4: Create Redis session
    const sessionResult = await createSession({
      userId: localUser.userId,
      deviceId,
      role: 'TRADER',
      absoluteTtlSec: 30 * 24 * 60 * 60, // 30 days
      idleTtlSec: 12 * 60 * 60,          // 12 hours sliding
      ip,
      userAgent,
      mfa: false
    })
    
    // Step 5: Redirect to dashboard with session cookie
    const dashboardUrl = new URL('/dashboard', process.env.NEXT_PUBLIC_APP_URL!)
    
    // Add success parameters for client-side notifications
    dashboardUrl.searchParams.set('auth', 'success')
    if (localUser.created) {
      dashboardUrl.searchParams.set('newUser', 'true')
    }
    
    const response = NextResponse.redirect(dashboardUrl)
    
    // Set secure session cookie
    response.cookies.set('app_session', sessionResult.sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: 12 * 60 * 60, // 12 hours (matches idle TTL)
      priority: 'high'
    })
    
    // Set device cookie for OAuth flows
    response.cookies.set('device_id', deviceId, {
      httpOnly: false, // Client needs access
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/',
      maxAge: 365 * 24 * 60 * 60 // 1 year
    })
    
    // Log successful OAuth authentication
    console.info(`OAuth authentication successful: ${localUser.userId} via ${user.app_metadata?.provider || 'unknown'} from ${ip}`)
    
    return response
    
  } catch (error) {
    console.error('OAuth callback error:', error)
    
    const errorUrl = new URL('/login', process.env.NEXT_PUBLIC_APP_URL!)
    errorUrl.searchParams.set('error', 'callback_error')
    errorUrl.searchParams.set('message', 'Authentication callback failed')
    
    return NextResponse.redirect(errorUrl)
  }
}

/**
 * OAuth Flow Configuration:
 * 
 * 1. Supabase Project Settings → Authentication → URL Configuration:
 *    - Site URL: https://your-domain.com
 *    - Redirect URLs: https://your-domain.com/api/auth/callback
 * 
 * 2. OAuth Provider Setup (Google example):
 *    - Authorized redirect URI: https://your-domain.com/api/auth/callback
 *    - Client ID/Secret configured in Supabase Auth → Providers
 * 
 * 3. Frontend Usage:
 * ```typescript
 * // Initiate OAuth flow
 * const { error } = await supabase.auth.signInWithOAuth({
 *   provider: 'google',
 *   options: {
 *     redirectTo: `${window.location.origin}/api/auth/callback`
 *   }
 * })
 * ```
 * 
 * Security Features:
 * - Secure code exchange (prevents authorization code interception)
 * - Atomic user provisioning (no race conditions)
 * - Device ID generation for OAuth flows
 * - Comprehensive error handling with user-friendly messages
 * - Session security matching login endpoint
 * 
 * Error Handling:
 * - OAuth provider errors → redirected to login with error message
 * - Missing authorization code → redirected to login
 * - User provisioning failures → redirected to login
 * - All errors logged for monitoring
 */