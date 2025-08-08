-- Partitioning setup for time-series data
-- Handles both PostgreSQL 17 native partitioning and TimescaleDB hypertables

-- PostgreSQL 17 Native Partitioning Setup
DO $$
DECLARE
    start_date DATE;
    end_date DATE;
    partition_date DATE;
    partition_name TEXT;
BEGIN
    -- Only set up native partitioning if TimescaleDB is NOT available
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
        RAISE NOTICE 'Setting up PostgreSQL 17 native partitioning';
        
        -- Convert price_candles to partitioned table
        -- First, check if it's already partitioned
        IF NOT EXISTS (
            SELECT 1 FROM pg_class 
            WHERE relname = 'price_candles' 
            AND relkind = 'p'  -- partitioned table
        ) THEN
            -- Create new partitioned table
            CREATE TABLE price_candles_new (
                asset_id UUID NOT NULL REFERENCES assets(id),
                ts TIMESTAMP NOT NULL,
                price_scaled BIGINT NOT NULL,
                open_scaled BIGINT NOT NULL,
                high_scaled BIGINT NOT NULL,
                low_scaled BIGINT NOT NULL,
                close_scaled BIGINT NOT NULL,
                volume BIGINT,
                source TEXT NOT NULL,
                PRIMARY KEY (asset_id, ts, source)
            ) PARTITION BY RANGE (ts);
            
            -- Drop old table and rename
            DROP TABLE IF EXISTS price_candles CASCADE;
            ALTER TABLE price_candles_new RENAME TO price_candles;
            
            -- Recreate indexes on partitioned table
            CREATE INDEX price_candles_asset_time_idx ON price_candles(asset_id, ts DESC);
            CREATE INDEX price_candles_time_idx ON price_candles(ts DESC);
            
            -- Create initial partitions (6 months worth)
            start_date := DATE_TRUNC('month', CURRENT_DATE - INTERVAL '3 months');
            end_date := DATE_TRUNC('month', CURRENT_DATE + INTERVAL '3 months');
            partition_date := start_date;
            
            WHILE partition_date < end_date LOOP
                partition_name := 'price_candles_' || TO_CHAR(partition_date, 'YYYY_MM');
                
                EXECUTE format(
                    'CREATE TABLE %I PARTITION OF price_candles 
                     FOR VALUES FROM (%L) TO (%L)',
                    partition_name,
                    partition_date,
                    partition_date + INTERVAL '1 month'
                );
                
                -- Create indexes on partition
                EXECUTE format(
                    'CREATE INDEX %I ON %I(asset_id, ts DESC)',
                    partition_name || '_asset_time_idx',
                    partition_name
                );
                
                partition_date := partition_date + INTERVAL '1 month';
            END LOOP;
            
            RAISE NOTICE 'Created PostgreSQL 17 partitioned table with % partitions', 
                (end_date - start_date) / 30;
        END IF;
        
    ELSE
        -- TimescaleDB Setup
        RAISE NOTICE 'Setting up TimescaleDB hypertables';
        
        -- Convert to hypertable with 1 month chunk interval
        SELECT create_hypertable(
            'price_candles', 
            'ts',
            chunk_time_interval => INTERVAL '1 month',
            if_not_exists => TRUE
        );
        
        -- Enable compression (compress chunks older than 1 week)
        ALTER TABLE price_candles SET (
            timescaledb.compress,
            timescaledb.compress_segmentby = 'asset_id',
            timescaledb.compress_orderby = 'ts DESC'
        );
        
        -- Auto-compression policy
        SELECT add_compression_policy('price_candles', INTERVAL '7 days', if_not_exists => TRUE);
        
        -- Data retention policy (keep 2 years)
        SELECT add_retention_policy('price_candles', INTERVAL '2 years', if_not_exists => TRUE);
        
        -- Setup continuous aggregates for rollup tables
        CREATE MATERIALIZED VIEW IF NOT EXISTS price_candles_5m_continuous
        WITH (timescaledb.continuous) AS
        SELECT 
            asset_id,
            time_bucket('5 minutes', ts) AS ts,
            FIRST(open_scaled, ts) AS open_scaled,
            MAX(high_scaled) AS high_scaled,
            MIN(low_scaled) AS low_scaled,
            LAST(close_scaled, ts) AS close_scaled,
            SUM(volume) AS volume,
            FIRST(source, ts) AS source
        FROM price_candles
        GROUP BY asset_id, time_bucket('5 minutes', ts);
        
        CREATE MATERIALIZED VIEW IF NOT EXISTS price_candles_1h_continuous  
        WITH (timescaledb.continuous) AS
        SELECT 
            asset_id,
            time_bucket('1 hour', ts) AS ts,
            FIRST(open_scaled, ts) AS open_scaled,
            MAX(high_scaled) AS high_scaled,
            MIN(low_scaled) AS low_scaled,
            LAST(close_scaled, ts) AS close_scaled,
            SUM(volume) AS volume,
            FIRST(source, ts) AS source
        FROM price_candles
        GROUP BY asset_id, time_bucket('1 hour', ts);
        
        CREATE MATERIALIZED VIEW IF NOT EXISTS price_candles_1d_continuous
        WITH (timescaledb.continuous) AS
        SELECT 
            asset_id,
            time_bucket('1 day', ts) AS ts,
            FIRST(open_scaled, ts) AS open_scaled,
            MAX(high_scaled) AS high_scaled,
            MIN(low_scaled) AS low_scaled,
            LAST(close_scaled, ts) AS close_scaled,
            SUM(volume) AS volume,
            FIRST(source, ts) AS source
        FROM price_candles
        GROUP BY asset_id, time_bucket('1 day', ts);
        
        -- Refresh policies for continuous aggregates
        SELECT add_continuous_aggregate_policy('price_candles_5m_continuous',
            start_offset => INTERVAL '1 hour',
            end_offset => INTERVAL '5 minutes',
            schedule_interval => INTERVAL '5 minutes',
            if_not_exists => TRUE);
            
        SELECT add_continuous_aggregate_policy('price_candles_1h_continuous',
            start_offset => INTERVAL '6 hours', 
            end_offset => INTERVAL '1 hour',
            schedule_interval => INTERVAL '1 hour',
            if_not_exists => TRUE);
            
        SELECT add_continuous_aggregate_policy('price_candles_1d_continuous',
            start_offset => INTERVAL '3 days',
            end_offset => INTERVAL '1 day', 
            schedule_interval => INTERVAL '1 day',
            if_not_exists => TRUE);
            
        RAISE NOTICE 'TimescaleDB hypertables and continuous aggregates configured';
    END IF;
END
$$;

COMMIT;