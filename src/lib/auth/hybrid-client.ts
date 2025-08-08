import { db, portfolios, holdings, assets, priceCandles } from '@/lib/db'
import { validateSession, requireAuth, requireRole, type UserSession } from './session'
import { scalePrice, unscalePrice } from '@/lib/utils/price-scaling'
import { eq, and } from 'drizzle-orm'
import type { PgDatabase } from 'drizzle-orm/pg-core'

/**
 * Hybrid client that bridges Supabase Auth with local PostgreSQL operations
 * Provides secure, type-safe database operations with automatic session validation
 * 
 * This is the core abstraction for the hybrid architecture:
 * - Remote: Supabase Auth (JWT tokens, user management)  
 * - Local: PostgreSQL data (portfolios, holdings, prices)
 */
export interface AuthenticatedClient {
  /** Current user session context */
  session: UserSession
  
  /** Direct database access (use with caution - prefer domain methods) */
  db: typeof db
  
  /** Price scaling utilities for exact decimal precision */
  prices: {
    scale: typeof scalePrice
    unscale: typeof unscalePrice
  }

  /** User-scoped operations */
  user: {
    /** Get current user's portfolios */
    getPortfolios(): Promise<any[]>
    
    /** Create new portfolio for current user */
    createPortfolio(params: { name: string }): Promise<{ id: string; name: string }>
    
    /** Get user's role */
    getRole(): UserSession['role']
  }

  /** Portfolio-scoped operations */
  portfolio: {
    /** Get portfolio by ID (validates ownership) */
    getById(portfolioId: string): Promise<any>
    
    /** Get portfolio holdings (validates ownership) */
    getHoldings(portfolioId: string): Promise<any[]>
    
    /** Add holding to portfolio (validates ownership) */
    addHolding(portfolioId: string, params: {
      symbol: string
      quantity: number
      costBasis: number
      note?: string
    }): Promise<{ id: string }>
    
    /** Calculate current portfolio value */
    calculateValue(portfolioId: string): Promise<{
      totalValue: number
      holdings: Array<{
        symbol: string
        quantity: number
        currentPrice: number
        value: number
        pnl: number
        pnlPercent: number
      }>
    }>
  }

  /** Asset and price operations */
  assets: {
    /** Get or create asset by symbol */
    getOrCreateAsset(symbol: string, type: 'STOCK' | 'CRYPTO'): Promise<{ id: string; symbol: string }>
    
    /** Get latest price for asset */
    getLatestPrice(assetId: string): Promise<{ price: number; timestamp: Date } | null>
    
    /** Insert price candle (uses BigInt scaling) */
    insertPriceCandle(params: {
      assetId: string
      timestamp: Date
      price: number
      open: number
      high: number
      low: number
      close: number
      volume?: number
      source: string
    }): Promise<void>
  }
}

/**
 * Creates authenticated client with automatic session validation
 * This is the main entry point for Server Actions
 * 
 * @example
 * ```typescript
 * export async function createPortfolioAction(name: string) {
 *   const client = await createAuthenticatedClient()
 *   return await client.user.createPortfolio({ name })
 * }
 * ```
 */
export async function createAuthenticatedClient(): Promise<AuthenticatedClient> {
  const session = await requireAuth()
  
  return {
    session,
    db,
    prices: {
      scale: scalePrice,
      unscale: unscalePrice,
    },

    user: {
      async getPortfolios() {
        return await db
          .select()
          .from(portfolios)
          .where(eq(portfolios.userId, session.localUserId))
          .orderBy(portfolios.createdAt.desc())
      },

      async createPortfolio(params: { name: string }) {
        const result = await db
          .insert(portfolios)
          .values({
            userId: session.localUserId,
            name: params.name,
          })
          .returning({
            id: portfolios.id,
            name: portfolios.name,
          })
        
        return result[0]
      },

      getRole() {
        return session.role
      },
    },

    portfolio: {
      async getById(portfolioId: string) {
        const result = await db
          .select()
          .from(portfolios)
          .where(and(
            eq(portfolios.id, portfolioId),
            eq(portfolios.userId, session.localUserId) // Security: ensure ownership
          ))
          .limit(1)
        
        return result[0] || null
      },

      async getHoldings(portfolioId: string) {
        // Security: First validate portfolio ownership
        const portfolio = await db
          .select({ id: portfolios.id })
          .from(portfolios)
          .where(and(
            eq(portfolios.id, portfolioId),
            eq(portfolios.userId, session.localUserId)
          ))
          .limit(1)
        
        if (portfolio.length === 0) {
          throw new Error('Portfolio not found or access denied')
        }
        
        // Get holdings with asset information
        return await db
          .select({
            id: holdings.id,
            portfolioId: holdings.portfolioId,
            quantity: holdings.quantity,
            costBasis: holdings.costBasis,
            note: holdings.note,
            createdAt: holdings.createdAt,
            asset: {
              id: assets.id,
              symbol: assets.symbol,
              name: assets.name,
              type: assets.type,
              latestPrice: assets.latestPrice,
            },
          })
          .from(holdings)
          .innerJoin(assets, eq(holdings.assetId, assets.id))
          .where(eq(holdings.portfolioId, portfolioId))
          .orderBy(holdings.createdAt.desc())
      },

      async addHolding(portfolioId: string, params: {
        symbol: string
        quantity: number
        costBasis: number
        note?: string
      }) {
        // Security: First validate portfolio ownership
        const portfolio = await db
          .select({ id: portfolios.id })
          .from(portfolios)
          .where(and(
            eq(portfolios.id, portfolioId),
            eq(portfolios.userId, session.localUserId)
          ))
          .limit(1)
        
        if (portfolio.length === 0) {
          throw new Error('Portfolio not found or access denied')
        }
        
        // Determine asset type from symbol (basic heuristic)
        const assetType: 'STOCK' | 'CRYPTO' = params.symbol.match(/^[A-Z]{1,5}$/) ? 'STOCK' : 'CRYPTO'
        
        // Get or create asset
        const asset = await this.assets.getOrCreateAsset(params.symbol.toUpperCase(), assetType)
        
        // Insert holding
        const result = await db
          .insert(holdings)
          .values({
            portfolioId,
            assetId: asset.id,
            quantity: params.quantity.toString(),
            costBasis: params.costBasis.toString(),
            note: params.note,
          })
          .returning({
            id: holdings.id,
          })
        
        return result[0]
      },

      async calculateValue(portfolioId: string) {
        // This is a complex calculation - will implement in separate service
        // For now, return basic structure
        return {
          totalValue: 0,
          holdings: [],
        }
      },
    },

    assets: {
      async getOrCreateAsset(symbol: string, type: 'STOCK' | 'CRYPTO') {
        // Try to find existing asset
        const existing = await db
          .select({
            id: assets.id,
            symbol: assets.symbol,
          })
          .from(assets)
          .where(eq(assets.symbol, symbol))
          .limit(1)
        
        if (existing.length > 0) {
          return existing[0]
        }
        
        // Create new asset
        const result = await db
          .insert(assets)
          .values({
            symbol,
            name: symbol, // Will be enriched later with proper asset name
            type,
          })
          .returning({
            id: assets.id,
            symbol: assets.symbol,
          })
        
        return result[0]
      },

      async getLatestPrice(assetId: string) {
        const result = await db
          .select({
            latestPrice: assets.latestPrice,
            updatedAt: assets.updatedAt,
          })
          .from(assets)
          .where(eq(assets.id, assetId))
          .limit(1)
        
        if (result.length === 0 || !result[0].latestPrice) {
          return null
        }
        
        return {
          price: parseFloat(result[0].latestPrice),
          timestamp: result[0].updatedAt,
        }
      },

      async insertPriceCandle(params: {
        assetId: string
        timestamp: Date
        price: number
        open: number
        high: number
        low: number
        close: number
        volume?: number
        source: string
      }) {
        // Insert with BigInt scaling for exact precision
        await db
          .insert(priceCandles)
          .values({
            assetId: params.assetId,
            ts: params.timestamp,
            priceScaled: scalePrice(params.price),
            openScaled: scalePrice(params.open),
            highScaled: scalePrice(params.high),
            lowScaled: scalePrice(params.low),
            closeScaled: scalePrice(params.close),
            volume: params.volume ? BigInt(params.volume) : null,
            source: params.source,
          })
          .onConflictDoNothing() // Idempotent upserts
      },
    },
  }
}

/**
 * Creates authenticated client with role validation
 * Throws if user doesn't have required role
 * 
 * @example
 * ```typescript
 * export async function adminOnlyAction() {
 *   const client = await createAuthenticatedClientWithRole('ADMIN')
 *   // ... admin operations
 * }
 * ```
 */
export async function createAuthenticatedClientWithRole(
  ...roles: ('TRADER' | 'COACH' | 'ADMIN')[]
): Promise<AuthenticatedClient> {
  const session = await requireRole(...roles)
  return createAuthenticatedClient()
}