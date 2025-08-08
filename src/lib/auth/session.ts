import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { Database } from '@/types/supabase'
import { db, users } from '@/lib/db'
import { eq } from 'drizzle-orm'

export interface UserSession {
  id: string // Supabase Auth user ID
  email: string
  role: 'TRADER' | 'COACH' | 'ADMIN'
  localUserId: string // Local PostgreSQL user ID
  authenticated: boolean
}

export interface AuthError {
  authenticated: false
  error: string
  code: 'UNAUTHORIZED' | 'INVALID_TOKEN' | 'USER_NOT_FOUND' | 'DATABASE_ERROR'
}

export type SessionResult = UserSession | AuthError

/**
 * Validates Supabase JWT token and bridges to local PostgreSQL user context
 * This is the critical hybrid auth bridge between remote Supabase Auth and local data
 */
export async function validateSession(): Promise<SessionResult> {
  try {
    // Step 1: Create Supabase client and validate JWT token
    const cookieStore = await cookies()
    const supabase = createServerClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll()
          },
          setAll(cookiesToSet) {
            try {
              cookiesToSet.forEach(({ name, value, options }) => {
                cookieStore.set(name, value, options)
              })
            } catch {
              // Ignore Server Component cookie setting errors
            }
          },
        },
      }
    )

    // Step 2: Get authenticated user from Supabase
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    
    if (authError || !user) {
      return {
        authenticated: false,
        error: 'Invalid or expired authentication token',
        code: 'INVALID_TOKEN'
      }
    }

    // Step 3: Bridge to local PostgreSQL user record
    // This ensures user exists in local DB and maps Supabase ID to local context
    const localUser = await getOrCreateLocalUser({
      supabaseId: user.id,
      email: user.email!,
    })

    if (!localUser) {
      return {
        authenticated: false,
        error: 'User not found in local database',
        code: 'USER_NOT_FOUND'
      }
    }

    // Step 4: Return complete user session context
    return {
      id: user.id, // Supabase Auth user ID  
      email: user.email!,
      role: localUser.role,
      localUserId: localUser.id, // Local PostgreSQL user ID
      authenticated: true
    }

  } catch (error) {
    console.error('Session validation error:', error)
    return {
      authenticated: false,
      error: 'Database connection error during authentication',
      code: 'DATABASE_ERROR'
    }
  }
}

/**
 * Creates or retrieves local PostgreSQL user record for Supabase user
 * This bridges the gap between remote authentication and local data storage
 */
async function getOrCreateLocalUser(params: {
  supabaseId: string
  email: string
}): Promise<{ id: string; role: 'TRADER' | 'COACH' | 'ADMIN' } | null> {
  try {
    // First, try to find existing user by email (primary identifier)
    const existingUser = await db
      .select({
        id: users.id,
        role: users.role,
      })
      .from(users)
      .where(eq(users.email, params.email))
      .limit(1)

    if (existingUser.length > 0) {
      return existingUser[0]
    }

    // If user doesn't exist locally, create them with default TRADER role
    // Note: In production, you might want more sophisticated user provisioning
    const newUser = await db
      .insert(users)
      .values({
        email: params.email,
        role: 'TRADER', // Default role for new users
      })
      .returning({
        id: users.id,
        role: users.role,
      })

    if (newUser.length === 0) {
      return null
    }

    return newUser[0]

  } catch (error) {
    console.error('Error creating/retrieving local user:', error)
    return null
  }
}

/**
 * Utility function to require authenticated session in Server Actions
 * Throws if user is not authenticated, otherwise returns validated session
 */
export async function requireAuth(): Promise<UserSession> {
  const session = await validateSession()
  
  if (!session.authenticated) {
    throw new Error(`Authentication required: ${session.error}`)
  }
  
  return session
}

/**
 * Utility function to require specific role in Server Actions
 * Throws if user doesn't have required role
 */
export async function requireRole(...roles: ('TRADER' | 'COACH' | 'ADMIN')[]): Promise<UserSession> {
  const session = await requireAuth()
  
  if (!roles.includes(session.role)) {
    throw new Error(`Access denied. Required role: ${roles.join(' or ')}, current role: ${session.role}`)
  }
  
  return session
}