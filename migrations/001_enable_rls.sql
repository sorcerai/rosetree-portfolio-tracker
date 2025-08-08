-- Migration 001: Enable Row Level Security for User Data Isolation
-- Critical security fix: Prevent cross-user data access at database level
-- Based on Codex production patterns for financial applications

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Create app schema for security functions
CREATE SCHEMA IF NOT EXISTS app;

-- =============================================================================
-- USER CONTEXT MANAGEMENT FUNCTIONS
-- =============================================================================

-- Function to set user context for RLS policies
-- This is called at the start of each authenticated database transaction
CREATE OR REPLACE FUNCTION app.set_auth(
    p_user_id uuid,
    p_roles text[] DEFAULT ARRAY[]::text[]
) 
RETURNS void 
LANGUAGE sql 
SECURITY DEFINER 
AS $$
    SELECT
        set_config('app.user_id', COALESCE(p_user_id::text, ''), true),
        set_config('app.roles', COALESCE(array_to_string(p_roles, ','), ''), true);
$$;

-- Helper function to check if user has specific role
CREATE OR REPLACE FUNCTION app.has_role(role_name text)
RETURNS boolean 
LANGUAGE sql 
STABLE 
AS $$
    SELECT position(role_name IN current_setting('app.roles', true)) > 0;
$$;

-- Function to get current authenticated user ID
CREATE OR REPLACE FUNCTION app.current_user_id()
RETURNS uuid 
LANGUAGE sql 
STABLE 
AS $$
    SELECT CASE 
        WHEN current_setting('app.user_id', true) = '' THEN NULL
        ELSE current_setting('app.user_id', true)::uuid
    END;
$$;

-- =============================================================================
-- ATOMIC USER PROVISIONING FUNCTION
-- =============================================================================

-- Idempotent user provisioning function
-- Fixes race conditions by handling concurrent user creation atomically
CREATE OR REPLACE FUNCTION app.provision_user(
    p_user_id uuid,
    p_email text,
    p_role user_role DEFAULT 'TRADER'
)
RETURNS TABLE(
    user_id uuid,
    portfolio_id uuid,
    created boolean
) 
LANGUAGE plpgsql 
AS $$
DECLARE
    v_user_created boolean := false;
    v_portfolio_id uuid;
BEGIN
    -- Atomic user upsert with conflict resolution
    INSERT INTO users (id, email, role)
    VALUES (p_user_id, p_email, p_role)
    ON CONFLICT (email) DO UPDATE SET 
        role = EXCLUDED.role,
        updated_at = NOW()
    RETURNING true INTO v_user_created;
    
    -- If user already existed, get user_created status
    IF NOT v_user_created THEN
        SELECT EXISTS(SELECT 1 FROM users WHERE id = p_user_id) INTO v_user_created;
    END IF;
    
    -- Ensure user has default portfolio (idempotent)
    INSERT INTO portfolios (user_id, name, total_value)
    VALUES (p_user_id, 'Main Portfolio', 0)
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_portfolio_id;
    
    -- If portfolio already existed, get its ID
    IF v_portfolio_id IS NULL THEN
        SELECT id INTO v_portfolio_id 
        FROM portfolios 
        WHERE user_id = p_user_id 
        ORDER BY created_at ASC 
        LIMIT 1;
    END IF;
    
    -- Return results
    RETURN QUERY SELECT p_user_id, v_portfolio_id, v_user_created;
END;
$$;

-- =============================================================================
-- ROW LEVEL SECURITY POLICIES
-- =============================================================================

-- Enable RLS on all user-scoped tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE portfolios ENABLE ROW LEVEL SECURITY;
ALTER TABLE holdings ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_candles ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_candles_5m ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_candles_1h ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_candles_1d ENABLE ROW LEVEL SECURITY;
ALTER TABLE portfolio_snapshots ENABLE ROW LEVEL SECURITY;

-- Force RLS for all users (including table owner)
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE portfolios FORCE ROW LEVEL SECURITY;
ALTER TABLE holdings FORCE ROW LEVEL SECURITY;
ALTER TABLE price_candles FORCE ROW LEVEL SECURITY;
ALTER TABLE price_candles_5m FORCE ROW LEVEL SECURITY;
ALTER TABLE price_candles_1h FORCE ROW LEVEL SECURITY;
ALTER TABLE price_candles_1d FORCE ROW LEVEL SECURITY;
ALTER TABLE portfolio_snapshots FORCE ROW LEVEL SECURITY;

-- =============================================================================
-- USERS TABLE POLICIES
-- =============================================================================

-- Users can only access their own user record
DROP POLICY IF EXISTS users_own_data ON users;
CREATE POLICY users_own_data ON users
FOR ALL 
TO PUBLIC  -- Apply policy to all database users including 'test'
USING (
    id = app.current_user_id()
    OR app.has_role('ADMIN')  -- Admins can access all users
    OR app.has_role('SYSTEM') -- System can access all users (for seeding, maintenance)
)
WITH CHECK (
    id = app.current_user_id()
    OR app.has_role('ADMIN')
    OR app.has_role('SYSTEM')
);

-- =============================================================================
-- PORTFOLIOS TABLE POLICIES
-- =============================================================================

-- Users can only access their own portfolios
DROP POLICY IF EXISTS portfolios_owner_access ON portfolios;
CREATE POLICY portfolios_owner_access ON portfolios
FOR ALL 
TO PUBLIC  -- Apply policy to all database users including 'test'
USING (
    user_id = app.current_user_id()
    OR app.has_role('ADMIN')
    OR app.has_role('SYSTEM')  -- System can access all portfolios (for maintenance, reporting)
    OR (app.has_role('COACH') AND user_id IN (
        -- Coaches can access portfolios of users they coach (to be implemented)
        SELECT app.current_user_id() WHERE FALSE  -- Placeholder for coach relationships
    ))
)
WITH CHECK (
    user_id = app.current_user_id()
    OR app.has_role('ADMIN')
    OR app.has_role('SYSTEM')
);

-- =============================================================================
-- HOLDINGS TABLE POLICIES  
-- =============================================================================

-- Users can only access holdings in their own portfolios
DROP POLICY IF EXISTS holdings_portfolio_owner ON holdings;
CREATE POLICY holdings_portfolio_owner ON holdings
FOR ALL
TO PUBLIC  -- Apply policy to all database users including 'test'
USING (
    portfolio_id IN (
        SELECT id FROM portfolios 
        WHERE user_id = app.current_user_id()
    )
    OR app.has_role('ADMIN')
    OR app.has_role('SYSTEM')  -- System can access all holdings (for maintenance, calculations)
)
WITH CHECK (
    portfolio_id IN (
        SELECT id FROM portfolios 
        WHERE user_id = app.current_user_id()
    )
    OR app.has_role('ADMIN')
    OR app.has_role('SYSTEM')
);

-- =============================================================================
-- PRICE CANDLES POLICIES (Read-only for authenticated users)
-- =============================================================================

-- Price data is read-only and accessible to all authenticated users
-- Write access restricted to system processes only
DROP POLICY IF EXISTS price_candles_read_all ON price_candles;
CREATE POLICY price_candles_read_all ON price_candles
FOR SELECT
TO PUBLIC  -- Apply policy to all database users including 'test'
USING (app.current_user_id() IS NOT NULL);

DROP POLICY IF EXISTS price_candles_system_write ON price_candles;
CREATE POLICY price_candles_system_write ON price_candles
FOR INSERT
TO PUBLIC  -- Apply policy to all database users including 'test'
WITH CHECK (app.has_role('SYSTEM'));

-- Apply same policies to rollup tables
DROP POLICY IF EXISTS price_candles_5m_read_all ON price_candles_5m;
CREATE POLICY price_candles_5m_read_all ON price_candles_5m
FOR SELECT
TO PUBLIC  -- Apply policy to all database users including 'test'
USING (app.current_user_id() IS NOT NULL);

DROP POLICY IF EXISTS price_candles_5m_system_write ON price_candles_5m;
CREATE POLICY price_candles_5m_system_write ON price_candles_5m
FOR INSERT
TO PUBLIC  -- Apply policy to all database users including 'test'
WITH CHECK (app.has_role('SYSTEM'));

DROP POLICY IF EXISTS price_candles_1h_read_all ON price_candles_1h;
CREATE POLICY price_candles_1h_read_all ON price_candles_1h
FOR SELECT
TO PUBLIC  -- Apply policy to all database users including 'test'
USING (app.current_user_id() IS NOT NULL);

DROP POLICY IF EXISTS price_candles_1h_system_write ON price_candles_1h;
CREATE POLICY price_candles_1h_system_write ON price_candles_1h
FOR INSERT
TO PUBLIC  -- Apply policy to all database users including 'test'
WITH CHECK (app.has_role('SYSTEM'));

DROP POLICY IF EXISTS price_candles_1d_read_all ON price_candles_1d;
CREATE POLICY price_candles_1d_read_all ON price_candles_1d
FOR SELECT
TO PUBLIC  -- Apply policy to all database users including 'test'
USING (app.current_user_id() IS NOT NULL);

DROP POLICY IF EXISTS price_candles_1d_system_write ON price_candles_1d;
CREATE POLICY price_candles_1d_system_write ON price_candles_1d
FOR INSERT
TO PUBLIC  -- Apply policy to all database users including 'test'
WITH CHECK (app.has_role('SYSTEM'));

-- =============================================================================
-- PORTFOLIO SNAPSHOTS POLICIES
-- =============================================================================

-- Users can only access snapshots of their own portfolios
DROP POLICY IF EXISTS portfolio_snapshots_owner ON portfolio_snapshots;
CREATE POLICY portfolio_snapshots_owner ON portfolio_snapshots
FOR ALL
TO PUBLIC  -- Apply policy to all database users including 'test'
USING (
    portfolio_id IN (
        SELECT id FROM portfolios 
        WHERE user_id = app.current_user_id()
    )
    OR app.has_role('ADMIN')
    OR app.has_role('SYSTEM')  -- System can create snapshots
)
WITH CHECK (
    portfolio_id IN (
        SELECT id FROM portfolios 
        WHERE user_id = app.current_user_id()
    )
    OR app.has_role('ADMIN')
    OR app.has_role('SYSTEM')
);

-- =============================================================================
-- ASSETS TABLE (No RLS - Public reference data)
-- =============================================================================

-- Assets table contains public reference data (symbols, names)
-- No RLS needed as this is not user-specific data
-- All authenticated users can read, only SYSTEM can write

-- =============================================================================
-- PERFORMANCE INDEXES FOR RLS QUERIES
-- =============================================================================

-- Indexes to optimize RLS policy lookups
-- These are critical for performance with RLS enabled

-- Users table - already has primary key on id
CREATE INDEX IF NOT EXISTS users_email_idx ON users(email);

-- Portfolios table - optimize user_id lookups for RLS
CREATE INDEX IF NOT EXISTS portfolios_user_id_idx ON portfolios(user_id);
CREATE INDEX IF NOT EXISTS portfolios_user_created_idx ON portfolios(user_id, created_at);

-- Holdings table - optimize portfolio_id lookups for RLS  
CREATE INDEX IF NOT EXISTS holdings_portfolio_id_idx ON holdings(portfolio_id);
CREATE INDEX IF NOT EXISTS holdings_portfolio_created_idx ON holdings(portfolio_id, created_at DESC);

-- Price candles - optimize asset lookups (already has good indexes)
-- No additional indexes needed for RLS as price data is read-only for users

-- Portfolio snapshots - optimize portfolio_id lookups
CREATE INDEX IF NOT EXISTS portfolio_snapshots_portfolio_id_idx 
ON portfolio_snapshots(portfolio_id);
CREATE INDEX IF NOT EXISTS portfolio_snapshots_portfolio_date_idx 
ON portfolio_snapshots(portfolio_id, date DESC);

-- =============================================================================
-- VALIDATION FUNCTIONS FOR TESTING
-- =============================================================================

-- Function to test RLS policies (for unit testing)
CREATE OR REPLACE FUNCTION app.test_rls_isolation()
RETURNS TABLE(
    test_name text,
    passed boolean,
    details text
)
LANGUAGE plpgsql
AS $$
DECLARE
    test_user_1 uuid := gen_random_uuid();
    test_user_2 uuid := gen_random_uuid();
    test_portfolio_1 uuid;
    test_portfolio_2 uuid;
    row_count integer;
BEGIN
    -- Create test users and portfolios
    PERFORM app.provision_user(test_user_1, 'test1@example.com');
    PERFORM app.provision_user(test_user_2, 'test2@example.com');
    
    SELECT id INTO test_portfolio_1 FROM portfolios WHERE user_id = test_user_1 LIMIT 1;
    SELECT id INTO test_portfolio_2 FROM portfolios WHERE user_id = test_user_2 LIMIT 1;
    
    -- Test 1: User 1 can see their own portfolio
    PERFORM app.set_auth(test_user_1, ARRAY['TRADER']);
    SELECT COUNT(*) INTO row_count FROM portfolios WHERE id = test_portfolio_1;
    
    RETURN QUERY SELECT 
        'User sees own portfolio'::text,
        row_count = 1,
        format('Expected 1, got %s', row_count);
    
    -- Test 2: User 1 cannot see User 2's portfolio
    SELECT COUNT(*) INTO row_count FROM portfolios WHERE id = test_portfolio_2;
    
    RETURN QUERY SELECT
        'User cannot see other portfolio'::text,
        row_count = 0,
        format('Expected 0, got %s', row_count);
    
    -- Test 3: Admin can see all portfolios
    PERFORM app.set_auth(test_user_1, ARRAY['ADMIN']);
    SELECT COUNT(*) INTO row_count FROM portfolios WHERE id IN (test_portfolio_1, test_portfolio_2);
    
    RETURN QUERY SELECT
        'Admin sees all portfolios'::text,
        row_count = 2,
        format('Expected 2, got %s', row_count);
    
    -- Cleanup test data
    DELETE FROM portfolios WHERE id IN (test_portfolio_1, test_portfolio_2);
    DELETE FROM users WHERE id IN (test_user_1, test_user_2);
    
END;
$$;

-- =============================================================================
-- MIGRATION COMPLETE
-- =============================================================================

-- This migration establishes:
-- 1. Row Level Security on all user-scoped tables
-- 2. Atomic user provisioning to prevent race conditions
-- 3. Performance indexes for RLS queries
-- 4. Testing functions for validation
--
-- Critical security improvement: All financial data is now isolated at the database level
-- Performance: Indexes ensure RLS policies execute efficiently
-- Reliability: Atomic provisioning prevents user creation race conditions

COMMENT ON SCHEMA app IS 'Application security functions and utilities for RLS';
COMMENT ON FUNCTION app.set_auth IS 'Sets user context for RLS policies in current transaction';
COMMENT ON FUNCTION app.provision_user IS 'Atomically creates user with default portfolio, prevents race conditions';
COMMENT ON FUNCTION app.test_rls_isolation IS 'Validates RLS policies are working correctly';