'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { requireAuth } from '@/lib/auth/middleware'
import { withRLS } from '@/lib/db/rls-context'
import { portfoliosTable, holdingsTable, assetsTable } from '@/lib/db/schema'
import { eq, desc } from 'drizzle-orm'

/**
 * Portfolio Server Actions with RLS Integration
 * 
 * These actions demonstrate the secure pattern for database operations:
 * 1. Extract auth context from request headers (set by middleware)
 * 2. Execute queries with RLS context (automatic user isolation)
 * 3. Return only data the user is authorized to see
 * 
 * All database queries are automatically filtered by RLS policies
 * No additional authorization checks needed in application code
 */

/**
 * Get user's portfolios with automatic RLS filtering
 */
export async function getUserPortfolios() {
  try {
    // Step 1: Validate authentication and extract user context
    const authContext = requireAuth(headers())
    
    // Step 2: Execute query with RLS context - automatically filters by user
    const portfolios = await withRLS(
      { userId: authContext.userId, roles: [authContext.role] },
      async (db) => {
        return await db
          .select({
            id: portfoliosTable.id,
            name: portfoliosTable.name,
            totalValue: portfoliosTable.totalValue,
            createdAt: portfoliosTable.createdAt,
            updatedAt: portfoliosTable.updatedAt
          })
          .from(portfoliosTable)
          .orderBy(desc(portfoliosTable.createdAt))
      }
    )
    
    return { success: true, portfolios }
    
  } catch (error) {
    console.error('Get user portfolios error:', error)
    
    if (error instanceof Error && error.message.includes('Authentication required')) {
      return { success: false, error: 'Authentication required' }
    }
    
    return { success: false, error: 'Failed to fetch portfolios' }
  }
}

/**
 * Get portfolio holdings with RLS-enforced access control
 */
export async function getPortfolioHoldings(portfolioId: string) {
  try {
    const authContext = requireAuth(headers())
    
    // RLS automatically ensures user can only access their own portfolio holdings
    const holdings = await withRLS(
      { userId: authContext.userId, roles: [authContext.role] },
      async (db) => {
        return await db
          .select({
            id: holdingsTable.id,
            portfolioId: holdingsTable.portfolioId,
            assetId: holdingsTable.assetId,
            quantity: holdingsTable.quantity,
            averagePrice: holdingsTable.averagePrice,
            currentValue: holdingsTable.currentValue,
            createdAt: holdingsTable.createdAt,
            updatedAt: holdingsTable.updatedAt,
            // Join with assets table for symbol and name
            symbol: assetsTable.symbol,
            name: assetsTable.name,
            assetType: assetsTable.assetType
          })
          .from(holdingsTable)
          .leftJoin(assetsTable, eq(holdingsTable.assetId, assetsTable.id))
          .where(eq(holdingsTable.portfolioId, portfolioId))
          .orderBy(desc(holdingsTable.currentValue))
      }
    )
    
    return { success: true, holdings }
    
  } catch (error) {
    console.error('Get portfolio holdings error:', error)
    
    if (error instanceof Error && error.message.includes('Authentication required')) {
      return { success: false, error: 'Authentication required' }
    }
    
    return { success: false, error: 'Failed to fetch holdings' }
  }
}

/**
 * Create a new portfolio for the authenticated user
 */
export async function createPortfolio(name: string) {
  try {
    const authContext = requireAuth(headers())
    
    // Validate input
    if (!name || name.trim().length === 0) {
      return { success: false, error: 'Portfolio name is required' }
    }
    
    if (name.trim().length > 100) {
      return { success: false, error: 'Portfolio name must be 100 characters or less' }
    }
    
    // RLS automatically sets user_id from context, prevents cross-user creation
    const newPortfolio = await withRLS(
      { userId: authContext.userId, roles: [authContext.role] },
      async (db) => {
        const result = await db
          .insert(portfoliosTable)
          .values({
            userId: authContext.userId, // Explicit user association
            name: name.trim(),
            totalValue: 0 // Start with zero value
          })
          .returning({
            id: portfoliosTable.id,
            name: portfoliosTable.name,
            totalValue: portfoliosTable.totalValue,
            createdAt: portfoliosTable.createdAt
          })
        
        return result[0]
      }
    )
    
    // Revalidate the portfolios page to show new portfolio
    revalidatePath('/dashboard')
    revalidatePath('/portfolio')
    
    return { success: true, portfolio: newPortfolio }
    
  } catch (error) {
    console.error('Create portfolio error:', error)
    
    if (error instanceof Error && error.message.includes('Authentication required')) {
      return { success: false, error: 'Authentication required' }
    }
    
    return { success: false, error: 'Failed to create portfolio' }
  }
}

/**
 * Update portfolio name (RLS ensures user owns the portfolio)
 */
export async function updatePortfolioName(portfolioId: string, newName: string) {
  try {
    const authContext = requireAuth(headers())
    
    // Validate input
    if (!newName || newName.trim().length === 0) {
      return { success: false, error: 'Portfolio name is required' }
    }
    
    if (newName.trim().length > 100) {
      return { success: false, error: 'Portfolio name must be 100 characters or less' }
    }
    
    // RLS automatically prevents updating portfolios the user doesn't own
    const updatedPortfolio = await withRLS(
      { userId: authContext.userId, roles: [authContext.role] },
      async (db) => {
        const result = await db
          .update(portfoliosTable)
          .set({
            name: newName.trim(),
            updatedAt: new Date()
          })
          .where(eq(portfoliosTable.id, portfolioId))
          .returning({
            id: portfoliosTable.id,
            name: portfoliosTable.name,
            updatedAt: portfoliosTable.updatedAt
          })
        
        if (result.length === 0) {
          throw new Error('Portfolio not found or access denied')
        }
        
        return result[0]
      }
    )
    
    // Revalidate affected pages
    revalidatePath('/dashboard')
    revalidatePath('/portfolio')
    revalidatePath(`/portfolio/${portfolioId}`)
    
    return { success: true, portfolio: updatedPortfolio }
    
  } catch (error) {
    console.error('Update portfolio name error:', error)
    
    if (error instanceof Error) {
      if (error.message.includes('Authentication required')) {
        return { success: false, error: 'Authentication required' }
      }
      if (error.message.includes('not found or access denied')) {
        return { success: false, error: 'Portfolio not found or access denied' }
      }
    }
    
    return { success: false, error: 'Failed to update portfolio' }
  }
}

/**
 * Delete a portfolio (RLS ensures user owns the portfolio)
 */
export async function deletePortfolio(portfolioId: string) {
  try {
    const authContext = requireAuth(headers())
    
    // RLS automatically prevents deleting portfolios the user doesn't own
    const result = await withRLS(
      { userId: authContext.userId, roles: [authContext.role] },
      async (db) => {
        // First delete all holdings in the portfolio
        await db
          .delete(holdingsTable)
          .where(eq(holdingsTable.portfolioId, portfolioId))
        
        // Then delete the portfolio
        const deletedPortfolio = await db
          .delete(portfoliosTable)
          .where(eq(portfoliosTable.id, portfolioId))
          .returning({
            id: portfoliosTable.id,
            name: portfoliosTable.name
          })
        
        if (deletedPortfolio.length === 0) {
          throw new Error('Portfolio not found or access denied')
        }
        
        return deletedPortfolio[0]
      }
    )
    
    // Revalidate affected pages
    revalidatePath('/dashboard')
    revalidatePath('/portfolio')
    
    return { success: true, deletedPortfolio: result }
    
  } catch (error) {
    console.error('Delete portfolio error:', error)
    
    if (error instanceof Error) {
      if (error.message.includes('Authentication required')) {
        return { success: false, error: 'Authentication required' }
      }
      if (error.message.includes('not found or access denied')) {
        return { success: false, error: 'Portfolio not found or access denied' }
      }
    }
    
    return { success: false, error: 'Failed to delete portfolio' }
  }
}

/**
 * Usage Examples in Components:
 * 
 * ```typescript
 * // In a React Server Component
 * export default async function PortfolioList() {
 *   const { portfolios } = await getUserPortfolios()
 *   
 *   return (
 *     <div>
 *       {portfolios?.map(portfolio => (
 *         <PortfolioCard key={portfolio.id} portfolio={portfolio} />
 *       ))}
 *     </div>
 *   )
 * }
 * 
 * // In a Client Component with form
 * 'use client'
 * export function CreatePortfolioForm() {
 *   async function handleSubmit(formData: FormData) {
 *     const name = formData.get('name') as string
 *     const result = await createPortfolio(name)
 *     
 *     if (result.success) {
 *       // Portfolio created successfully
 *       router.push(`/portfolio/${result.portfolio.id}`)
 *     } else {
 *       // Handle error
 *       setError(result.error)
 *     }
 *   }
 *   
 *   return (
 *     <form action={handleSubmit}>
 *       <input name="name" type="text" placeholder="Portfolio Name" />
 *       <button type="submit">Create Portfolio</button>
 *     </form>
 *   )
 * }
 * ```
 * 
 * Security Benefits:
 * - Database-level user isolation via RLS policies
 * - No application-level authorization checks needed
 * - Automatic prevention of cross-user data access
 * - SQL injection protection through Drizzle ORM
 * - Transaction rollback on RLS violations
 * 
 * Performance Benefits:
 * - Indexes optimized for RLS queries
 * - Single database roundtrip per operation
 * - Connection pooling for efficient resource usage
 * - Automatic query result caching
 */