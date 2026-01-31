-- Enable pgvector extension for semantic similarity search
CREATE EXTENSION IF NOT EXISTS vector;

-- Semantic cache table for storing prompt embeddings and responses
CREATE TABLE IF NOT EXISTS semantic_cache (
  cache_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id VARCHAR(100) NOT NULL,
  model VARCHAR(100) NOT NULL,
  prompt_hash VARCHAR(64) NOT NULL,
  prompt_embedding vector(384),  -- MiniLM-L6-v2 outputs 384 dimensions
  prompt_text TEXT,
  response_text TEXT NOT NULL,
  response_tokens INTEGER,
  cost_saved NUMERIC(10, 6) DEFAULT 0,
  hit_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours',
  
  -- Constraints
  CONSTRAINT unique_prompt_per_org_model UNIQUE (org_id, model, prompt_hash)
);

-- Create IVFFlat index for fast approximate nearest neighbor search
-- Lists = 100 is good for tables with 10k-100k rows
CREATE INDEX IF NOT EXISTS idx_semantic_cache_embedding 
  ON semantic_cache 
  USING ivfflat (prompt_embedding vector_cosine_ops) 
  WITH (lists = 100);

-- Index for expiration cleanup
CREATE INDEX IF NOT EXISTS idx_semantic_cache_expires 
  ON semantic_cache (expires_at);

-- Index for org lookups
CREATE INDEX IF NOT EXISTS idx_semantic_cache_org 
  ON semantic_cache (org_id, model);

-- Function to find similar cached responses
CREATE OR REPLACE FUNCTION find_similar_cache(
  p_org_id VARCHAR(100),
  p_model VARCHAR(100),
  p_embedding vector(384),
  p_threshold FLOAT DEFAULT 0.10
)
RETURNS TABLE (
  cache_id UUID,
  response_text TEXT,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    sc.cache_id,
    sc.response_text,
    1 - (sc.prompt_embedding <=> p_embedding) as similarity
  FROM semantic_cache sc
  WHERE sc.org_id = p_org_id
    AND sc.model = p_model
    AND sc.expires_at > NOW()
    AND (sc.prompt_embedding <=> p_embedding) < p_threshold
  ORDER BY sc.prompt_embedding <=> p_embedding
  LIMIT 1;
END;
$$ LANGUAGE plpgsql;

-- Function to increment hit count and update cost savings
CREATE OR REPLACE FUNCTION record_cache_hit(
  p_cache_id UUID,
  p_cost_saved NUMERIC(10, 6)
)
RETURNS VOID AS $$
BEGIN
  UPDATE semantic_cache
  SET 
    hit_count = hit_count + 1,
    cost_saved = cost_saved + p_cost_saved
  WHERE cache_id = p_cache_id;
END;
$$ LANGUAGE plpgsql;

-- Continuous aggregate for cache analytics
CREATE MATERIALIZED VIEW IF NOT EXISTS cache_stats_hourly
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', created_at) AS hour,
  org_id,
  COUNT(*) AS entries_created,
  SUM(hit_count) AS total_hits,
  SUM(cost_saved) AS total_savings
FROM semantic_cache
GROUP BY hour, org_id
WITH NO DATA;

-- Refresh policy for the continuous aggregate
SELECT add_continuous_aggregate_policy('cache_stats_hourly',
  start_offset => INTERVAL '2 hours',
  end_offset => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists => TRUE
);

-- Cleanup job for expired cache entries (runs daily)
SELECT add_job('DELETE FROM semantic_cache WHERE expires_at < NOW()', 
  '1 day',
  if_not_exists => TRUE
);
