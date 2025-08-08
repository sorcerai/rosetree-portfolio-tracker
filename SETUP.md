# Setup Guide

## 1. Create Supabase Project

1. Go to [supabase.com](https://supabase.com) and create a new project
2. Choose Supabase Pro plan (required for TimescaleDB)
3. Note your project URL and keys

## 2. Enable TimescaleDB Extension

In your Supabase SQL Editor, run:

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;
```

## 3. Environment Configuration

1. Copy `.env.example` to `.env.local`
2. Fill in your Supabase credentials:
   ```
   NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
   NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
   DATABASE_URL=postgresql://postgres:[password]@db.[project].supabase.co:5432/postgres
   ```

## 4. Deploy Database Schema

```bash
npm run db:push
```

This will create all tables and indexes in your Supabase database.

## 5. Set up TimescaleDB Hypertables

In Supabase SQL Editor, run:

```sql
-- Convert price_candles to hypertable
SELECT create_hypertable('price_candles', 'ts');

-- Set up compression (optional)
ALTER TABLE price_candles SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'asset_id',
  timescaledb.compress_orderby = 'ts DESC'
);

-- Auto-compress data older than 7 days
SELECT add_compression_policy('price_candles', INTERVAL '7 days');
```

## 6. Run Development Server

```bash
npm install
npm run dev
```

## 7. Next Steps

- Set up Row Level Security policies
- Configure TOTP authentication
- Add market data providers
- Build portfolio interface

## Troubleshooting

- **Database connection issues**: Check your DATABASE_URL format
- **TimescaleDB extension**: Ensure you're on Supabase Pro
- **Migration errors**: Check Drizzle logs for SQL syntax issues