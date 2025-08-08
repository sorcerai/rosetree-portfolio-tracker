-- Database initialization script for rosetree-portfolio local development
-- Works for both PostgreSQL 17 and TimescaleDB

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- pg_cron extension will be created after database setup

-- TimescaleDB-specific initialization (will be skipped if not TimescaleDB)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
        -- TimescaleDB is available, create extension
        CREATE EXTENSION IF NOT EXISTS "timescaledb";
    END IF;
END
$$;

-- Create enums
DO $$ BEGIN
    CREATE TYPE user_role AS ENUM ('TRADER', 'COACH', 'ADMIN');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE asset_type AS ENUM ('STOCK', 'CRYPTO');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email TEXT NOT NULL UNIQUE,
    role user_role DEFAULT 'TRADER' NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS users_email_idx ON users(email);
CREATE INDEX IF NOT EXISTS users_role_idx ON users(role);

-- Assets table
CREATE TABLE IF NOT EXISTS assets (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    symbol TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    type asset_type NOT NULL,
    latest_price NUMERIC(20,8),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    is_active BOOLEAN DEFAULT true NOT NULL
);

CREATE INDEX IF NOT EXISTS assets_symbol_idx ON assets(symbol);
CREATE INDEX IF NOT EXISTS assets_type_idx ON assets(type);
CREATE INDEX IF NOT EXISTS assets_active_idx ON assets(is_active);

-- Portfolios table
CREATE TABLE IF NOT EXISTS portfolios (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    total_value NUMERIC(20,8) DEFAULT '0' NOT NULL,
    last_recomputed TIMESTAMP DEFAULT NOW() NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS portfolios_user_id_idx ON portfolios(user_id);
CREATE INDEX IF NOT EXISTS portfolios_name_idx ON portfolios(name);

-- Holdings table
CREATE TABLE IF NOT EXISTS holdings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    portfolio_id UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    asset_id UUID NOT NULL REFERENCES assets(id),
    quantity NUMERIC(20,8) NOT NULL,
    cost_basis NUMERIC(20,8) NOT NULL,
    note TEXT,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS holdings_portfolio_id_idx ON holdings(portfolio_id);
CREATE INDEX IF NOT EXISTS holdings_asset_id_idx ON holdings(asset_id);
CREATE INDEX IF NOT EXISTS holdings_portfolio_asset_idx ON holdings(portfolio_id, asset_id);

-- Price candles table (main partitioned table)
-- Using bigint for scaled prices: price * 1e8 for exact precision
CREATE TABLE IF NOT EXISTS price_candles (
    asset_id UUID NOT NULL REFERENCES assets(id),
    ts TIMESTAMP NOT NULL,
    price_scaled BIGINT NOT NULL,  -- price * 1e8
    open_scaled BIGINT NOT NULL,   -- open * 1e8
    high_scaled BIGINT NOT NULL,   -- high * 1e8
    low_scaled BIGINT NOT NULL,    -- low * 1e8
    close_scaled BIGINT NOT NULL,  -- close * 1e8
    volume BIGINT,
    source TEXT NOT NULL,
    PRIMARY KEY (asset_id, ts, source)
);

-- Optimized indexes for time-series queries
CREATE INDEX IF NOT EXISTS price_candles_asset_time_idx ON price_candles(asset_id, ts DESC);
CREATE INDEX IF NOT EXISTS price_candles_time_idx ON price_candles(ts DESC);

-- Rollup tables for pre-aggregated data
CREATE TABLE IF NOT EXISTS price_candles_5m (
    asset_id UUID NOT NULL REFERENCES assets(id),
    ts TIMESTAMP NOT NULL,
    open_scaled BIGINT NOT NULL,
    high_scaled BIGINT NOT NULL,
    low_scaled BIGINT NOT NULL,
    close_scaled BIGINT NOT NULL,
    volume BIGINT,
    source TEXT NOT NULL,
    PRIMARY KEY (asset_id, ts, source)
);

CREATE INDEX IF NOT EXISTS price_candles_5m_asset_time_idx ON price_candles_5m(asset_id, ts DESC);
CREATE INDEX IF NOT EXISTS price_candles_5m_time_idx ON price_candles_5m(ts DESC);

CREATE TABLE IF NOT EXISTS price_candles_1h (
    asset_id UUID NOT NULL REFERENCES assets(id),
    ts TIMESTAMP NOT NULL,
    open_scaled BIGINT NOT NULL,
    high_scaled BIGINT NOT NULL,
    low_scaled BIGINT NOT NULL,
    close_scaled BIGINT NOT NULL,
    volume BIGINT,
    source TEXT NOT NULL,
    PRIMARY KEY (asset_id, ts, source)
);

CREATE INDEX IF NOT EXISTS price_candles_1h_asset_time_idx ON price_candles_1h(asset_id, ts DESC);
CREATE INDEX IF NOT EXISTS price_candles_1h_time_idx ON price_candles_1h(ts DESC);

CREATE TABLE IF NOT EXISTS price_candles_1d (
    asset_id UUID NOT NULL REFERENCES assets(id),
    ts TIMESTAMP NOT NULL,
    open_scaled BIGINT NOT NULL,
    high_scaled BIGINT NOT NULL,
    low_scaled BIGINT NOT NULL,
    close_scaled BIGINT NOT NULL,
    volume BIGINT,
    source TEXT NOT NULL,
    PRIMARY KEY (asset_id, ts, source)
);

CREATE INDEX IF NOT EXISTS price_candles_1d_asset_time_idx ON price_candles_1d(asset_id, ts DESC);
CREATE INDEX IF NOT EXISTS price_candles_1d_time_idx ON price_candles_1d(ts DESC);

-- Portfolio snapshots for daily aggregates
CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    portfolio_id UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
    date TIMESTAMP NOT NULL,
    total_value NUMERIC(20,8) NOT NULL,
    pnl NUMERIC(20,8) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS portfolio_snapshots_portfolio_date_idx ON portfolio_snapshots(portfolio_id, date DESC);
CREATE INDEX IF NOT EXISTS portfolio_snapshots_date_idx ON portfolio_snapshots(date DESC);

COMMIT;