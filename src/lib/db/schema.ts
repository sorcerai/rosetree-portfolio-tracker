import { pgTable, uuid, text, timestamp, numeric, integer, boolean, index, pgEnum } from 'drizzle-orm/pg-core'
import { relations } from 'drizzle-orm'

// Enums
export const userRoleEnum = pgEnum('user_role', ['TRADER', 'COACH', 'ADMIN'])
export const assetTypeEnum = pgEnum('asset_type', ['STOCK', 'CRYPTO'])

// Users table (extends Supabase Auth)
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  role: userRoleEnum('role').default('TRADER').notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  emailIdx: index('users_email_idx').on(table.email),
  roleIdx: index('users_role_idx').on(table.role),
}))

// Portfolios table
export const portfolios = pgTable('portfolios', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  totalValue: numeric('total_value', { precision: 20, scale: 8 }).default('0').notNull(),
  lastRecomputed: timestamp('last_recomputed').defaultNow().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  userIdIdx: index('portfolios_user_id_idx').on(table.userId),
  nameIdx: index('portfolios_name_idx').on(table.name),
}))

// Assets table
export const assets = pgTable('assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  symbol: text('symbol').notNull().unique(),
  name: text('name').notNull(),
  type: assetTypeEnum('type').notNull(),
  latestPrice: numeric('latest_price', { precision: 20, scale: 8 }),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
  isActive: boolean('is_active').default(true).notNull(),
}, (table) => ({
  symbolIdx: index('assets_symbol_idx').on(table.symbol),
  typeIdx: index('assets_type_idx').on(table.type),
  activeIdx: index('assets_active_idx').on(table.isActive),
}))

// Holdings table  
export const holdings = pgTable('holdings', {
  id: uuid('id').primaryKey().defaultRandom(),
  portfolioId: uuid('portfolio_id').notNull().references(() => portfolios.id, { onDelete: 'cascade' }),
  assetId: uuid('asset_id').notNull().references(() => assets.id),
  quantity: numeric('quantity', { precision: 20, scale: 8 }).notNull(),
  costBasis: numeric('cost_basis', { precision: 20, scale: 8 }).notNull(),
  note: text('note'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (table) => ({
  portfolioIdIdx: index('holdings_portfolio_id_idx').on(table.portfolioId),
  assetIdIdx: index('holdings_asset_id_idx').on(table.assetId),
  portfolioAssetIdx: index('holdings_portfolio_asset_idx').on(table.portfolioId, table.assetId),
}))

// Price candles table (TimescaleDB hypertable)
export const priceCandles = pgTable('price_candles', {
  assetId: uuid('asset_id').notNull().references(() => assets.id),
  ts: timestamp('ts').notNull(),
  open: numeric('open', { precision: 20, scale: 8 }).notNull(),
  high: numeric('high', { precision: 20, scale: 8 }).notNull(),
  low: numeric('low', { precision: 20, scale: 8 }).notNull(),
  close: numeric('close', { precision: 20, scale: 8 }).notNull(),
  volume: numeric('volume', { precision: 20, scale: 0 }),
  source: text('source').notNull(),
}, (table) => ({
  assetTimeIdx: index('price_candles_asset_time_idx').on(table.assetId, table.ts.desc()),
  timeIdx: index('price_candles_time_idx').on(table.ts.desc()),
}))

// Portfolio snapshots table (for daily aggregates)
export const portfolioSnapshots = pgTable('portfolio_snapshots', {
  portfolioId: uuid('portfolio_id').notNull().references(() => portfolios.id, { onDelete: 'cascade' }),
  date: timestamp('date').notNull(),
  totalValue: numeric('total_value', { precision: 20, scale: 8 }).notNull(),
  pnl: numeric('pnl', { precision: 20, scale: 8 }).notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
}, (table) => ({
  portfolioDateIdx: index('portfolio_snapshots_portfolio_date_idx').on(table.portfolioId, table.date.desc()),
  dateIdx: index('portfolio_snapshots_date_idx').on(table.date.desc()),
}))

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  portfolios: many(portfolios),
}))

export const portfoliosRelations = relations(portfolios, ({ one, many }) => ({
  user: one(users, {
    fields: [portfolios.userId],
    references: [users.id],
  }),
  holdings: many(holdings),
  snapshots: many(portfolioSnapshots),
}))

export const assetsRelations = relations(assets, ({ many }) => ({
  holdings: many(holdings),
  priceCandles: many(priceCandles),
}))

export const holdingsRelations = relations(holdings, ({ one }) => ({
  portfolio: one(portfolios, {
    fields: [holdings.portfolioId],
    references: [portfolios.id],
  }),
  asset: one(assets, {
    fields: [holdings.assetId],
    references: [assets.id],
  }),
}))

export const priceCandlesRelations = relations(priceCandles, ({ one }) => ({
  asset: one(assets, {
    fields: [priceCandles.assetId],
    references: [assets.id],
  }),
}))

export const portfolioSnapshotsRelations = relations(portfolioSnapshots, ({ one }) => ({
  portfolio: one(portfolios, {
    fields: [portfolioSnapshots.portfolioId],
    references: [portfolios.id],
  }),
}))