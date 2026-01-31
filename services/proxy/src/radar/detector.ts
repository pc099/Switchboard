/**
 * Agentic Radar - Anomaly Detector
 * Monitors agent behavior for outliers and potential hallucinations
 */

import { PostgresClient } from '../db/postgres.js';
import { logger } from '../utils/logger.js';
import { WebSocketManager } from '../ws/manager.js';

export interface AnomalyEvent {
  id: string;
  orgId: string;
  agentId: string;
  type: 'high_token_usage' | 'high_cost' | 'latency_spike' | 'error_spike';
  severity: 'low' | 'medium' | 'high' | 'critical';
  details: any;
  timestamp: Date;
}

export class RadarDetector {
  private postgres: PostgresClient;
  private wsManager: WebSocketManager;
  private checkInterval: NodeJS.Timeout | null = null;
  
  constructor(postgres: PostgresClient, wsManager: WebSocketManager) {
    this.postgres = postgres;
    this.wsManager = wsManager;
  }
  
  /**
   * Start periodic anomaly detection
   */
  start(intervalMs = 60000): void {
    if (this.checkInterval) return;
    
    logger.info('Radar Anomaly Detector started');
    this.checkInterval = setInterval(() => {
      this.detectAnomalies().catch(err => 
        logger.error({ err }, 'Anomaly detection failed')
      );
    }, intervalMs);
  }
  
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
  }
  
  /**
   * Run detection logic
   */
  async detectAnomalies(): Promise<void> {
    await this.detectTokenSpikes();
  }
  
  /**
   * Detect agents with unusually high token usage (Z-Score > 3)
   */
  private async detectTokenSpikes(): Promise<void> {
    try {
      // Calculate Z-Score for recent requests
      // Uses a 1-hour window for stats
      const result = await this.postgres.query(`
        WITH agent_stats AS (
          SELECT 
            agent_id,
            org_id,
            AVG(token_count) as mean_tokens,
            STDDEV(token_count) as stddev_tokens
          FROM agent_traces
          WHERE created_at > NOW() - INTERVAL '24 hours'
          GROUP BY agent_id, org_id
          HAVING COUNT(*) > 10  -- Need minimum sample size
        ),
        recent_traces AS (
          SELECT 
            t.agent_id,
            t.org_id,
            t.token_count,
            t.created_at
          FROM agent_traces t
          WHERE t.created_at > NOW() - INTERVAL '5 minutes'
        )
        SELECT 
          r.agent_id,
          r.org_id,
          r.token_count,
          s.mean_tokens,
          s.stddev_tokens,
          (r.token_count - s.mean_tokens) / NULLIF(s.stddev_tokens, 0) as z_score
        FROM recent_traces r
        JOIN agent_stats s ON r.agent_id = s.agent_id
        WHERE (r.token_count - s.mean_tokens) / NULLIF(s.stddev_tokens, 0) > 3.0
      `);
      
      for (const row of result.rows) {
        const anomaly: AnomalyEvent = {
          id: crypto.randomUUID(),
          orgId: row.org_id,
          agentId: row.agent_id,
          type: 'high_token_usage',
          severity: row.z_score > 5 ? 'critical' : 'high',
          details: {
            token_count: row.token_count,
            mean: Math.round(row.mean_tokens),
            z_score: parseFloat(row.z_score).toFixed(2),
          },
          timestamp: new Date(),
        };
        
        logger.warn({ anomaly }, 'Radar detected anomaly');
        this.wsManager.broadcastAnomaly(row.org_id, anomaly);
      }
      
    } catch (err) {
      logger.error({ err }, 'Failed to detect token spikes');
    }
  }
}
