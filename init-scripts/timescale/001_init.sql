-- AgentSwitchboard Flight Recorder Schema
-- TimescaleDB initialization script

-- Enable TimescaleDB extension
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Core agent traces table
CREATE TABLE IF NOT EXISTS agent_traces (
    -- Primary identifiers
    trace_id        UUID            NOT NULL DEFAULT gen_random_uuid(),
    span_id         UUID            NOT NULL DEFAULT gen_random_uuid(),
    parent_span_id  UUID,
    
    -- Temporal
    timestamp       TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
    duration_ms     INTEGER,
    
    -- Agent identity
    org_id          VARCHAR(64)     NOT NULL,
    agent_id        VARCHAR(128)    NOT NULL,
    agent_name      VARCHAR(256),
    agent_framework VARCHAR(64),
    
    -- Request classification
    request_type    VARCHAR(32)     NOT NULL,
    intent_category VARCHAR(64),
    risk_score      SMALLINT,
    
    -- Model info
    model_provider  VARCHAR(32),
    model_name      VARCHAR(64),
    
    -- Token economics
    input_tokens    INTEGER,
    output_tokens   INTEGER,
    cost_usd        DECIMAL(10, 6),
    
    -- Content (JSONB for flexible schema)
    request_body    JSONB,
    response_body   JSONB,
    
    -- Reasoning chain
    reasoning_steps JSONB,
    tool_calls      JSONB,
    
    -- Governance
    policy_applied  VARCHAR(128),
    action_taken    VARCHAR(32),
    block_reason    TEXT,
    
    -- Metadata
    client_ip       INET,
    user_agent      TEXT,
    custom_metadata JSONB,
    
    PRIMARY KEY (trace_id, timestamp)
);

-- Convert to hypertable
SELECT create_hypertable('agent_traces', 'timestamp', 
    chunk_time_interval => INTERVAL '1 day',
    if_not_exists => TRUE);

-- Organization table
CREATE TABLE IF NOT EXISTS organizations (
    org_id          VARCHAR(64)     PRIMARY KEY,
    name            VARCHAR(256)    NOT NULL,
    api_token       VARCHAR(128)    UNIQUE NOT NULL,
    settings        JSONB           DEFAULT '{}',
    daily_budget    DECIMAL(10, 2)  DEFAULT 100.00,
    is_active       BOOLEAN         DEFAULT TRUE,
    created_at      TIMESTAMPTZ     DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     DEFAULT NOW()
);

-- Agents registry
CREATE TABLE IF NOT EXISTS agents (
    agent_id        VARCHAR(128)    PRIMARY KEY,
    org_id          VARCHAR(64)     NOT NULL REFERENCES organizations(org_id),
    name            VARCHAR(256)    NOT NULL,
    description     TEXT,
    framework       VARCHAR(64),
    status          VARCHAR(32)     DEFAULT 'active',
    rate_limit      INTEGER         DEFAULT 100,
    policies        JSONB           DEFAULT '[]',
    created_at      TIMESTAMPTZ     DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     DEFAULT NOW()
);

-- Governance policies
CREATE TABLE IF NOT EXISTS policies (
    policy_id       UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          VARCHAR(64)     NOT NULL REFERENCES organizations(org_id),
    name            VARCHAR(128)    NOT NULL,
    description     TEXT,
    rules           JSONB           NOT NULL,
    priority        INTEGER         DEFAULT 0,
    is_active       BOOLEAN         DEFAULT TRUE,
    created_at      TIMESTAMPTZ     DEFAULT NOW(),
    updated_at      TIMESTAMPTZ     DEFAULT NOW()
);

-- Anomalies detected
CREATE TABLE IF NOT EXISTS anomalies (
    anomaly_id      UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          VARCHAR(64)     NOT NULL,
    agent_id        VARCHAR(128)    NOT NULL,
    type            VARCHAR(32)     NOT NULL,
    severity        VARCHAR(16)     NOT NULL,
    details         JSONB           NOT NULL,
    status          VARCHAR(32)     DEFAULT 'active',
    detected_at     TIMESTAMPTZ     DEFAULT NOW(),
    resolved_at     TIMESTAMPTZ,
    resolved_by     VARCHAR(128)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_traces_org_agent 
    ON agent_traces (org_id, agent_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_traces_risk 
    ON agent_traces (risk_score, timestamp DESC) 
    WHERE risk_score > 50;

CREATE INDEX IF NOT EXISTS idx_traces_blocked 
    ON agent_traces (action_taken, timestamp DESC) 
    WHERE action_taken = 'blocked';

CREATE INDEX IF NOT EXISTS idx_traces_cost 
    ON agent_traces (org_id, cost_usd, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_anomalies_active 
    ON anomalies (org_id, status, detected_at DESC) 
    WHERE status = 'active';

-- Insert demo organization
INSERT INTO organizations (org_id, name, api_token, daily_budget) 
VALUES ('org_demo', 'Demo Organization', 'demo_token_abc123', 50.00)
ON CONFLICT (org_id) DO NOTHING;

-- Compression policy (after 7 days)
SELECT add_compression_policy('agent_traces', INTERVAL '7 days', if_not_exists => TRUE);

-- Retention policy (90 days)
SELECT add_retention_policy('agent_traces', INTERVAL '90 days', if_not_exists => TRUE);

-- Continuous aggregates for burn rate calculations
CREATE MATERIALIZED VIEW IF NOT EXISTS hourly_costs
WITH (timescaledb.continuous) AS
SELECT 
    time_bucket('1 hour', timestamp) AS hour,
    org_id,
    agent_id,
    COUNT(*) as request_count,
    SUM(cost_usd) as total_cost,
    SUM(input_tokens) as total_input_tokens,
    SUM(output_tokens) as total_output_tokens
FROM agent_traces
GROUP BY hour, org_id, agent_id;

SELECT add_continuous_aggregate_policy('hourly_costs',
    start_offset => INTERVAL '3 hours',
    end_offset => INTERVAL '1 hour',
    schedule_interval => INTERVAL '1 hour',
    if_not_exists => TRUE);
