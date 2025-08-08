'use server'

import { createAuthenticatedClient } from '@/lib/auth/hybrid-client'
import { revalidatePath } from 'next/cache'

export interface CreatePortfolioResult {
  success: boolean
  data?: { id: string; name: string }
  error?: string
}

export interface AddHoldingResult {
  success: boolean
  data?: { id: string }
  error?: string
}

export interface Portfolio {
  id: string
  name: string
  totalValue: string
  lastRecomputed: Date
  createdAt: Date
  updatedAt: Date
}

export interface Holding {
  id: string
  portfolioId: string
  quantity: string
  costBasis: string
  note: string | null
  createdAt: Date
  asset: {
    id: string
    symbol: string
    name: string
    type: 'STOCK' | 'CRYPTO'
    latestPrice: string | null
  }
}

/**
 * Creates a new portfolio for the authenticated user
 * Demonstrates hybrid auth: Supabase Auth validation + Local PostgreSQL insert
 */
export async function createPortfolioAction(name: string): Promise<CreatePortfolioResult> {
  try {
    if (!name.trim()) {
      return {
        success: false,
        error: 'Portfolio name is required'
      }
    }

    // This automatically validates Supabase JWT and bridges to local PostgreSQL
    const client = await createAuthenticatedClient()
    
    const portfolio = await client.user.createPortfolio({ name: name.trim() })
    
    // Revalidate the portfolios page to show the new portfolio
    revalidatePath('/portfolios')
    revalidatePath('/dashboard')
    
    return {
      success: true,
      data: portfolio
    }
    
  } catch (error) {
    console.error('Error creating portfolio:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to create portfolio'
    }
  }
}

/**
 * Gets all portfolios for the authenticated user
 * Demonstrates secure user-scoped data access
 */
export async function getUserPortfoliosAction(): Promise<Portfolio[]> {
  try {
    const client = await createAuthenticatedClient()
    return await client.user.getPortfolios()
  } catch (error) {
    console.error('Error fetching portfolios:', error)
    throw new Error('Failed to fetch portfolios')
  }
}

/**
 * Gets a specific portfolio by ID (validates ownership)
 * Demonstrates ownership validation in hybrid architecture
 */
export async function getPortfolioByIdAction(portfolioId: string): Promise<Portfolio | null> {
  try {
    const client = await createAuthenticatedClient()
    return await client.portfolio.getById(portfolioId)
  } catch (error) {
    console.error('Error fetching portfolio:', error)
    throw new Error('Failed to fetch portfolio')
  }
}

/**
 * Gets holdings for a portfolio (validates ownership)
 * Demonstrates secure portfolio-scoped data access
 */
export async function getPortfolioHoldingsAction(portfolioId: string): Promise<Holding[]> {
  try {
    const client = await createAuthenticatedClient()
    return await client.portfolio.getHoldings(portfolioId)
  } catch (error) {
    console.error('Error fetching holdings:', error)
    throw new Error('Failed to fetch holdings')
  }
}

/**
 * Adds a holding to a portfolio
 * Demonstrates complex operation: ownership validation + asset creation + holding insert
 */
export async function addHoldingAction(
  portfolioId: string,
  params: {
    symbol: string
    quantity: number
    costBasis: number
    note?: string
  }
): Promise<AddHoldingResult> {
  try {
    // Validate input
    if (!params.symbol.trim()) {
      return { success: false, error: 'Symbol is required' }
    }
    
    if (params.quantity <= 0) {
      return { success: false, error: 'Quantity must be positive' }
    }
    
    if (params.costBasis <= 0) {
      return { success: false, error: 'Cost basis must be positive' }
    }

    // This validates ownership + creates asset if needed + inserts holding
    const client = await createAuthenticatedClient()
    
    const holding = await client.portfolio.addHolding(portfolioId, {
      symbol: params.symbol.toUpperCase().trim(),
      quantity: params.quantity,
      costBasis: params.costBasis,
      note: params.note?.trim() || undefined,
    })
    
    // Revalidate relevant pages to show the new holding
    revalidatePath(`/portfolio/${portfolioId}`)
    revalidatePath('/dashboard')
    
    return {
      success: true,
      data: holding
    }
    
  } catch (error) {
    console.error('Error adding holding:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to add holding'
    }
  }
}

/**
 * Calculates current portfolio value with live prices
 * Demonstrates BigInt scaling and real-time price integration
 */
export async function calculatePortfolioValueAction(portfolioId: string) {
  try {
    const client = await createAuthenticatedClient()
    return await client.portfolio.calculateValue(portfolioId)
  } catch (error) {
    console.error('Error calculating portfolio value:', error)
    throw new Error('Failed to calculate portfolio value')
  }
}

/**
 * Test function to validate the hybrid architecture
 * Can be called from UI to verify session bridging works correctly
 */
export async function testHybridAuthAction(): Promise<{
  success: boolean
  data?: {
    supabaseUserId: string
    localUserId: string
    email: string
    role: string
    authenticated: boolean
  }
  error?: string
}> {
  try {
    const client = await createAuthenticatedClient()
    
    return {
      success: true,
      data: {
        supabaseUserId: client.session.id,
        localUserId: client.session.localUserId,
        email: client.session.email,
        role: client.session.role,
        authenticated: client.session.authenticated,
      }
    }
    
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Authentication test failed'
    }
  }
}

/**
 * Demo function to insert sample price data
 * Demonstrates BigInt price scaling in partitioned tables
 */
export async function insertSamplePriceDataAction(symbol: string, price: number): Promise<{
  success: boolean
  error?: string
}> {
  try {
    const client = await createAuthenticatedClient()
    
    // Get or create the asset
    const asset = await client.assets.getOrCreateAsset(
      symbol.toUpperCase(),
      symbol.match(/^[A-Z]{1,5}$/) ? 'STOCK' : 'CRYPTO'
    )
    
    // Insert sample price data with current timestamp
    await client.assets.insertPriceCandle({
      assetId: asset.id,
      timestamp: new Date(),
      price,
      open: price * 0.99,
      high: price * 1.02,
      low: price * 0.98,
      close: price,
      volume: 1000000,
      source: 'DEMO',
    })
    
    return { success: true }
    
  } catch (error) {
    console.error('Error inserting sample price data:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to insert price data'
    }
  }
}