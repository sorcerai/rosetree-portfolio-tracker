# 🌹 Rosetree Portfolio - Docker Development Environment

Local development environment with dual database engine support for A/B performance testing.

## Quick Start

```bash
# PostgreSQL 17 + Redis (default)
make postgres

# TimescaleDB + Redis (alternative)  
make timescale

# Full stack with Next.js
make full

# A/B performance comparison
make benchmark
```

## Architecture

### PostgreSQL 17 Engine
- **Native Partitioning**: Monthly RANGE partitions on `ts` column
- **pg_cron Automation**: Auto-partition creation, cleanup, rollup aggregation
- **BigInt Optimization**: Prices scaled by 1e8 for exact precision
- **Port**: 5432

### TimescaleDB Engine  
- **Hypertables**: 1-month chunk intervals with automatic compression
- **Continuous Aggregates**: Real-time 5m/1h/1d rollups
- **Compression**: Segments by `asset_id`, ordered by `ts DESC`
- **Port**: 5433

### Redis Cache Layer
- **Latest Prices**: `latest:{symbol}` → TTL: 5s crypto, 15min stocks
- **Window Data**: `window:{symbol}:{interval}:{start}:{end}` → TTL: 1-24h
- **Port**: 6379

## Container Profiles

| Profile | Containers | Use Case |
|---------|------------|----------|
| `postgres` | PostgreSQL + Redis | Native partitioning testing |
| `timescale` | TimescaleDB + Redis | Hypertable performance testing |
| `app` | Next.js dev server | Application development |
| `test` | Performance tester | Benchmarking |

## Commands

### Database Management
```bash
# Connect to databases
make psql        # PostgreSQL
make psql-ts     # TimescaleDB  
make redis-cli   # Redis

# Container status
make status
make logs
```

### Development
```bash
# Start development environment
make postgres    # Database + cache
make app         # Start Next.js (requires DB)
make full        # Everything together
```

### Testing
```bash
# Performance testing
make test        # Run test suite
make benchmark   # A/B comparison
```

### Cleanup
```bash
make clean       # Stop containers
make reset       # ⚠️ Delete all data
```

## Environment Variables

### PostgreSQL/TimescaleDB
- `POSTGRES_DB`: `rosetree_portfolio`
- `POSTGRES_USER`: `postgres` 
- `POSTGRES_PASSWORD`: `local_dev_password`

### Next.js App
- `DATABASE_URL`: Auto-configured per profile
- `REDIS_URL`: `redis://redis:6379`
- `NODE_ENV`: `development`

## Performance Comparison

The A/B testing framework compares:

1. **Write Performance**: High-frequency price ingestion
2. **Read Performance**: Time-series queries across date ranges  
3. **Aggregation Performance**: 5m/1h/1d rollup calculations
4. **Storage Efficiency**: Disk usage and compression ratios
5. **Memory Usage**: RAM consumption patterns

Results saved to `./test-results/` with detailed metrics.

## Schema Highlights

### Scaled Integer Prices
```sql
-- Exact precision using bigint (price * 1e8)
price_scaled BIGINT NOT NULL  -- $123.45 → 12345000000
open_scaled BIGINT NOT NULL   -- Avoids floating-point errors  
high_scaled BIGINT NOT NULL   
low_scaled BIGINT NOT NULL
close_scaled BIGINT NOT NULL
```

### Partitioning Strategy
```sql
-- PostgreSQL 17: Monthly range partitions
CREATE TABLE price_candles_2024_08 PARTITION OF price_candles 
FOR VALUES FROM ('2024-08-01') TO ('2024-09-01');

-- TimescaleDB: 1-month chunks with compression
SELECT create_hypertable('price_candles', 'ts', 
    chunk_time_interval => INTERVAL '1 month');
```

### Composite Primary Key
```sql
-- Upsert idempotency for multiple price sources
PRIMARY KEY (asset_id, ts, source)
```

## Data Flow

1. **Price Ingestion**: WebSocket → Scale → Upsert with conflict resolution
2. **Caching**: Latest prices cached with TTL by asset type  
3. **Rollup**: pg_cron/continuous aggregates → pre-computed intervals
4. **Queries**: Partition pruning → index seeks → cache warm

## Monitoring

- **PostgreSQL**: `pg_stat_user_tables`, partition sizes
- **TimescaleDB**: `timescaledb_information.*` views  
- **Redis**: `INFO memory`, key patterns
- **Application**: OpenTelemetry traces (future)