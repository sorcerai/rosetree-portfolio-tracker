import type { InferSelectModel, InferInsertModel } from 'drizzle-orm'
import type * as schema from '@/lib/db/schema'

// Select types (for reading data)
export type User = InferSelectModel<typeof schema.users>
export type Portfolio = InferSelectModel<typeof schema.portfolios>
export type Asset = InferSelectModel<typeof schema.assets>
export type Holding = InferSelectModel<typeof schema.holdings>
export type PriceCandle = InferSelectModel<typeof schema.priceCandles>
export type PriceCandle5m = InferSelectModel<typeof schema.priceCandles5m>
export type PriceCandle1h = InferSelectModel<typeof schema.priceCandles1h>
export type PriceCandle1d = InferSelectModel<typeof schema.priceCandles1d>
export type PortfolioSnapshot = InferSelectModel<typeof schema.portfolioSnapshots>

// Insert types (for creating data)
export type NewUser = InferInsertModel<typeof schema.users>
export type NewPortfolio = InferInsertModel<typeof schema.portfolios>
export type NewAsset = InferInsertModel<typeof schema.assets>
export type NewHolding = InferInsertModel<typeof schema.holdings>
export type NewPriceCandle = InferInsertModel<typeof schema.priceCandles>
export type NewPriceCandle5m = InferInsertModel<typeof schema.priceCandles5m>
export type NewPriceCandle1h = InferInsertModel<typeof schema.priceCandles1h>
export type NewPriceCandle1d = InferInsertModel<typeof schema.priceCandles1d>
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

// Price scaling utilities (prices stored as bigint scaled by 1e8)
export type ScaledPrice = {
  priceScaled: bigint
  openScaled: bigint
  highScaled: bigint
  lowScaled: bigint
  closeScaled: bigint
}

export type UnscaledPrice = {
  price: number
  open: number
  high: number
  low: number
  close: number
}

// Enhanced price candle types with unscaled prices for display
export type PriceCandleWithPrices = PriceCandle & UnscaledPrice
export type PriceCandle5mWithPrices = PriceCandle5m & UnscaledPrice
export type PriceCandle1hWithPrices = PriceCandle1h & UnscaledPrice
export type PriceCandle1dWithPrices = PriceCandle1d & UnscaledPrice

// Time-series query types
export type TimeRange = {
  start: Date
  end: Date
}

export type CandlestickData = {
  ts: Date
  open: number
  high: number
  low: number
  close: number
  volume: bigint | null
}