import type { InferSelectModel, InferInsertModel } from 'drizzle-orm'
import type * as schema from '@/lib/db/schema'

// Select types (for reading data)
export type User = InferSelectModel<typeof schema.users>
export type Portfolio = InferSelectModel<typeof schema.portfolios>
export type Asset = InferSelectModel<typeof schema.assets>
export type Holding = InferSelectModel<typeof schema.holdings>
export type PriceCandle = InferSelectModel<typeof schema.priceCandles>
export type PortfolioSnapshot = InferSelectModel<typeof schema.portfolioSnapshots>

// Insert types (for creating data)
export type NewUser = InferInsertModel<typeof schema.users>
export type NewPortfolio = InferInsertModel<typeof schema.portfolios>
export type NewAsset = InferInsertModel<typeof schema.assets>
export type NewHolding = InferInsertModel<typeof schema.holdings>
export type NewPriceCandle = InferInsertModel<typeof schema.priceCandles>
export type NewPortfolioSnapshot = InferInsertModel<typeof schema.portfolioSnapshots>

// Extended types
export type UserRole = 'TRADER' | 'COACH' | 'ADMIN'
export type AssetType = 'STOCK' | 'CRYPTO'

export type PortfolioWithHoldings = Portfolio & {
  holdings: (Holding & {
    asset: Asset
  })[]
}

export type HoldingWithAsset = Holding & {
  asset: Asset
}

export type AssetWithLatestPrice = Asset & {
  latestCandle?: PriceCandle
}