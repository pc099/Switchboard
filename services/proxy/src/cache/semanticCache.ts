/**
 * Semantic Cache
 * Caches LLM responses based on semantic similarity of prompts
 */

import { PostgresClient } from '../db/postgres.js';
import { RedisClient } from '../db/redis.js';
import { logger } from '../utils/logger.js';
import { generateEmbedding, hashPrompt, EMBEDDING_DIMENSION_SIZE } from './embeddings.js';

export interface CacheEntry {
  cacheId: string;
  responseText: string;
  similarity: number;
}

export interface CacheConfig {
  similarityThreshold: number; // Cosine distance threshold (lower = stricter)
  ttlSeconds: number;
  enabled: boolean;
}

const DEFAULT_CONFIG: CacheConfig = {
  similarityThreshold: 0.10, // 90% similar
  ttlSeconds: 86400, // 24 hours
  enabled: true,
};

export class SemanticCache {
  private postgres: PostgresClient;
  private redis: RedisClient;
  private config: CacheConfig;
  
  constructor(postgres: PostgresClient, redis: RedisClient, config?: Partial<CacheConfig>) {
    this.postgres = postgres;
    this.redis = redis;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }
  
  /**
   * Look up a semantically similar cached response
   */
  async lookup(
    orgId: string,
    model: string,
    promptText: string
  ): Promise<CacheEntry | null> {
    if (!this.config.enabled) return null;
    
    const startTime = performance.now();
    
    try {
      // First, try exact match via hash (fastest path)
      const promptHash = hashPrompt(promptText);
      const exactMatch = await this.redis.get(`cache:${orgId}:${model}:${promptHash}`);
      
      if (exactMatch) {
        logger.debug({ orgId, model, type: 'exact' }, 'Cache hit (exact match)');
        return {
          cacheId: promptHash,
          responseText: exactMatch,
          similarity: 1.0,
        };
      }
      
      // Generate embedding for semantic search
      const embedding = await generateEmbedding(promptText);
      
      // Query pgvector for similar prompts
      const result = await this.postgres.query(`
        SELECT 
          cache_id,
          response_text,
          1 - (prompt_embedding <=> $1::vector) as similarity
        FROM semantic_cache
        WHERE org_id = $2
          AND model = $3
          AND expires_at > NOW()
          AND (prompt_embedding <=> $1::vector) < $4
        ORDER BY prompt_embedding <=> $1::vector
        LIMIT 1
      `, [`[${embedding.join(',')}]`, orgId, model, this.config.similarityThreshold]);
      
      const latencyMs = Math.round(performance.now() - startTime);
      
      if (result.rows.length > 0) {
        const hit = result.rows[0];
        logger.info({ 
          orgId, 
          model, 
          similarity: hit.similarity.toFixed(3),
          latencyMs 
        }, 'Cache hit (semantic match)');
        
        return {
          cacheId: hit.cache_id,
          responseText: hit.response_text,
          similarity: parseFloat(hit.similarity),
        };
      }
      
      logger.debug({ orgId, model, latencyMs }, 'Cache miss');
      return null;
      
    } catch (err) {
      logger.error({ err }, 'Semantic cache lookup failed');
      return null; // Fail open - don't block requests on cache errors
    }
  }
  
  /**
   * Store a new response in the cache
   */
  async store(
    orgId: string,
    model: string,
    promptText: string,
    responseText: string,
    responseTokens?: number,
    estimatedCost?: number
  ): Promise<void> {
    if (!this.config.enabled) return;
    
    try {
      const promptHash = hashPrompt(promptText);
      const embedding = await generateEmbedding(promptText);
      
      // Store in Redis for exact-match lookup
      await this.redis.setEx(
        `cache:${orgId}:${model}:${promptHash}`,
        this.config.ttlSeconds,
        responseText
      );
      
      // Store in PostgreSQL for semantic lookup
      await this.postgres.query(`
        INSERT INTO semantic_cache (
          org_id, model, prompt_hash, prompt_embedding, 
          prompt_text, response_text, response_tokens
        ) VALUES ($1, $2, $3, $4::vector, $5, $6, $7)
        ON CONFLICT (org_id, model, prompt_hash) 
        DO UPDATE SET 
          response_text = EXCLUDED.response_text,
          response_tokens = EXCLUDED.response_tokens,
          expires_at = NOW() + INTERVAL '${this.config.ttlSeconds} seconds'
      `, [
        orgId,
        model,
        promptHash,
        `[${embedding.join(',')}]`,
        promptText.substring(0, 1000), // Truncate for storage
        responseText,
        responseTokens,
      ]);
      
      logger.debug({ orgId, model, promptHash }, 'Cached response');
      
    } catch (err) {
      logger.error({ err }, 'Failed to store in semantic cache');
      // Don't throw - caching is best-effort
    }
  }
  
  /**
   * Record a cache hit for analytics
   */
  async recordHit(cacheId: string, costSaved: number): Promise<void> {
    try {
      await this.postgres.query(`
        UPDATE semantic_cache
        SET hit_count = hit_count + 1, cost_saved = cost_saved + $2
        WHERE cache_id = $1
      `, [cacheId, costSaved]);
    } catch (err) {
      logger.error({ err }, 'Failed to record cache hit');
    }
  }
  
  /**
   * Get cache statistics for dashboard
   */
  async getStats(orgId: string): Promise<{
    totalEntries: number;
    totalHits: number;
    totalSavings: number;
    hitRate: number;
  }> {
    try {
      const result = await this.postgres.query(`
        SELECT 
          COUNT(*) as total_entries,
          COALESCE(SUM(hit_count), 0) as total_hits,
          COALESCE(SUM(cost_saved), 0) as total_savings
        FROM semantic_cache
        WHERE org_id = $1 AND expires_at > NOW()
      `, [orgId]);
      
      const row = result.rows[0];
      const totalEntries = parseInt(row.total_entries) || 0;
      const totalHits = parseInt(row.total_hits) || 0;
      
      return {
        totalEntries,
        totalHits,
        totalSavings: parseFloat(row.total_savings) || 0,
        hitRate: totalEntries > 0 ? totalHits / (totalHits + totalEntries) : 0,
      };
    } catch (err) {
      logger.error({ err }, 'Failed to get cache stats');
      return { totalEntries: 0, totalHits: 0, totalSavings: 0, hitRate: 0 };
    }
  }
}
