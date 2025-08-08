/**
 * Price Scaling Utilities
 * 
 * Prices are stored in the database as bigint scaled by 1e8 for exact precision.
 * This provides up to 8 decimal places of precision for financial calculations
 * while avoiding floating-point arithmetic issues.
 * 
 * Examples:
 * - $123.45 -> 12345000000n (123.45 * 1e8)
 * - $0.00012345 -> 12345n (0.00012345 * 1e8)
 */

const PRICE_SCALE = 100000000n // 1e8 as bigint

/**
 * Convert a number price to scaled bigint for database storage
 */
export function scalePrice(price: number): bigint {
  if (!isFinite(price) || price < 0) {
    throw new Error(`Invalid price: ${price}`)
  }
  
  // Use string conversion to avoid floating point precision issues
  const priceStr = price.toFixed(8) // 8 decimal places max
  const priceFloat = parseFloat(priceStr)
  
  return BigInt(Math.round(priceFloat * 100000000))
}

/**
 * Convert a scaled bigint from database to number for display/calculation
 */
export function unscalePrice(scaledPrice: bigint): number {
  return Number(scaledPrice) / 100000000
}

/**
 * Scale multiple prices at once (for OHLCV data)
 */
export function scalePrices(prices: {
  price: number
  open: number
  high: number
  low: number
  close: number
}) {
  return {
    priceScaled: scalePrice(prices.price),
    openScaled: scalePrice(prices.open),
    highScaled: scalePrice(prices.high),
    lowScaled: scalePrice(prices.low),
    closeScaled: scalePrice(prices.close),
  }
}

/**
 * Unscale multiple prices at once (for OHLCV data)
 */
export function unscalePrices(scaledPrices: {
  priceScaled: bigint
  openScaled: bigint
  highScaled: bigint
  lowScaled: bigint
  closeScaled: bigint
}) {
  return {
    price: unscalePrice(scaledPrices.priceScaled),
    open: unscalePrice(scaledPrices.openScaled),
    high: unscalePrice(scaledPrices.highScaled),
    low: unscalePrice(scaledPrices.lowScaled),
    close: unscalePrice(scaledPrices.closeScaled),
  }
}

/**
 * Convert a price candle from database format to display format
 */
export function unscalePriceCandle<T extends {
  priceScaled: bigint
  openScaled: bigint
  highScaled: bigint
  lowScaled: bigint
  closeScaled: bigint
}>(candle: T) {
  const unscaled = unscalePrices(candle)
  
  return {
    ...candle,
    price: unscaled.price,
    open: unscaled.open,
    high: unscaled.high,
    low: unscaled.low,
    close: unscaled.close,
  }
}

/**
 * Format a scaled price as currency string
 */
export function formatScaledPrice(
  scaledPrice: bigint, 
  currency: string = 'USD',
  locale: string = 'en-US'
): string {
  const price = unscalePrice(scaledPrice)
  
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 8,
  }).format(price)
}

/**
 * Calculate percentage change between two scaled prices
 */
export function calculatePriceChange(
  currentScaled: bigint, 
  previousScaled: bigint
): {
  absolute: number
  percentage: number
} {
  const current = unscalePrice(currentScaled)
  const previous = unscalePrice(previousScaled)
  
  const absolute = current - previous
  const percentage = previous !== 0 ? (absolute / previous) * 100 : 0
  
  return { absolute, percentage }
}

/**
 * Validate that a scaled price is within reasonable bounds
 */
export function validateScaledPrice(scaledPrice: bigint): boolean {
  // Max price: $100,000,000 (reasonable upper bound)
  // Min price: $0.00000001 (1 satoshi equivalent)
  const maxScaled = BigInt('10000000000000000') // $100M * 1e8
  const minScaled = BigInt('1') // $0.00000001 * 1e8
  
  return scaledPrice >= minScaled && scaledPrice <= maxScaled
}

/**
 * Helper for creating test data with scaled prices
 */
export function createTestCandle(price: number, timestamp: Date, source: string = 'test') {
  const scaled = scalePrices({
    price,
    open: price * 0.995,  // 0.5% lower open
    high: price * 1.01,   // 1% higher high
    low: price * 0.99,    // 1% lower low
    close: price,         // close = price
  })
  
  return {
    assetId: crypto.randomUUID(),
    ts: timestamp,
    ...scaled,
    volume: BigInt(Math.floor(Math.random() * 1000000)),
    source,
  }
}