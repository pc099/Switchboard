-- Shadow Mode Schema Migration
-- Adds support for shadow event tracking and policy versioning

-- Add is_shadow_event column to track shadow mode violations
ALTER TABLE agent_traces 
ADD COLUMN IF NOT EXISTS is_shadow_event BOOLEAN DEFAULT false;

-- Add policy_id column to track which policy version was applied
ALTER TABLE agent_traces 
ADD COLUMN IF NOT EXISTS policy_id UUID;

-- Create index for efficient shadow savings queries
CREATE INDEX IF NOT EXISTS idx_traces_shadow 
    ON agent_traces (org_id, is_shadow_event, timestamp DESC)
    WHERE is_shadow_event = true;

-- Create index for shadow_blocked action type
CREATE INDEX IF NOT EXISTS idx_traces_shadow_blocked 
    ON agent_traces (action_taken, timestamp DESC) 
    WHERE action_taken = 'shadow_blocked';

-- Update existing blocked traces to have is_shadow_event = false (if needed)
UPDATE agent_traces 
SET is_shadow_event = false 
WHERE is_shadow_event IS NULL;

-- Create policy versions table to track policy changes
CREATE TABLE IF NOT EXISTS policy_versions (
    policy_id       UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          VARCHAR(64)     NOT NULL,
    version         VARCHAR(32)     NOT NULL,
    config          JSONB           NOT NULL,
    is_active       BOOLEAN         DEFAULT true,
    created_at      TIMESTAMPTZ     DEFAULT NOW(),
    created_by      VARCHAR(128)
);

-- Index for quick active policy lookup
CREATE INDEX IF NOT EXISTS idx_policy_versions_active 
    ON policy_versions (org_id, is_active, created_at DESC)
    WHERE is_active = true;

-- Continuous aggregate for shadow savings (hourly)
DROP MATERIALIZED VIEW IF EXISTS hourly_shadow_savings;
CREATE MATERIALIZED VIEW IF NOT EXISTS hourly_shadow_savings
WITH (timescaledb.continuous) AS
SELECT 
    time_bucket('1 hour', timestamp) AS hour,
    org_id,
    COUNT(*) as shadow_blocked_count,
    SUM(cost_usd) as total_mitigated_cost,
    array_agg(DISTINCT intent_category) as blocked_categories
FROM agent_traces
WHERE is_shadow_event = true
GROUP BY hour, org_id;

SELECT add_continuous_aggregate_policy('hourly_shadow_savings',
    start_offset => INTERVAL '3 hours',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour',
    if_not_exists => TRUE);

-- Success message
DO $$
BEGIN
    RAISE NOTICE 'Shadow mode schema migration completed successfully';
END $$;
