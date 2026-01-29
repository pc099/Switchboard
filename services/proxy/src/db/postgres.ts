/**
 * PostgreSQL/TimescaleDB client wrapper
 */

import pg from 'pg';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

export class PostgresClient {
  private pool: pg.Pool;
  
  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });
  }
  
  async connect(): Promise<void> {
    try {
      const client = await this.pool.connect();
      client.release();
      logger.info('Connected to TimescaleDB');
    } catch (err) {
      logger.error({ err }, 'Failed to connect to TimescaleDB');
      throw err;
    }
  }
  
  async disconnect(): Promise<void> {
    await this.pool.end();
  }
  
  // Organization operations
  async getOrgByToken(token: string): Promise<any | null> {
    const result = await this.pool.query(
      'SELECT * FROM organizations WHERE api_token = $1 AND is_active = true',
      [token]
    );
    return result.rows[0] || null;
  }
  
  async getOrg(orgId: string): Promise<any | null> {
    const result = await this.pool.query(
      'SELECT * FROM organizations WHERE org_id = $1',
      [orgId]
    );
    return result.rows[0] || null;
  }
  
  // Agent operations
  async getAgent(agentId: string): Promise<any | null> {
    const result = await this.pool.query(
      'SELECT * FROM agents WHERE agent_id = $1',
      [agentId]
    );
    return result.rows[0] || null;
  }
  
  async getAgentsByOrg(orgId: string): Promise<any[]> {
    const result = await this.pool.query(
      'SELECT * FROM agents WHERE org_id = $1 ORDER BY name',
      [orgId]
    );
    return result.rows;
  }
  
  async upsertAgent(agent: {
    agentId: string;
    orgId: string;
    name: string;
    framework?: string;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO agents (agent_id, org_id, name, framework, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (agent_id) DO UPDATE SET
         name = EXCLUDED.name,
         framework = EXCLUDED.framework,
         updated_at = NOW()`,
      [agent.agentId, agent.orgId, agent.name, agent.framework]
    );
  }
  
  async updateAgentStatus(agentId: string, status: string): Promise<void> {
    await this.pool.query(
      'UPDATE agents SET status = $2, updated_at = NOW() WHERE agent_id = $1',
      [agentId, status]
    );
  }
  
  // Policy operations
  async getPolicies(orgId: string): Promise<any[]> {
    const result = await this.pool.query(
      'SELECT * FROM policies WHERE org_id = $1 AND is_active = true ORDER BY priority DESC',
      [orgId]
    );
    return result.rows;
  }
  
  // Trace recording
  async recordTrace(trace: {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    orgId: string;
    agentId: string;
    agentName?: string;
    agentFramework?: string;
    requestType: string;
    intentCategory?: string;
    riskScore?: number;
    modelProvider?: string;
    modelName?: string;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    requestBody?: any;
    responseBody?: any;
    reasoningSteps?: any[];
    toolCalls?: any[];
    policyApplied?: string;
    actionTaken: string;
    blockReason?: string;
    clientIp?: string;
    userAgent?: string;
    durationMs?: number;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_traces (
        trace_id, span_id, parent_span_id, org_id, agent_id, agent_name, agent_framework,
        request_type, intent_category, risk_score, model_provider, model_name,
        input_tokens, output_tokens, cost_usd, request_body, response_body,
        reasoning_steps, tool_calls, policy_applied, action_taken, block_reason,
        client_ip, user_agent, duration_ms
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
        $16, $17, $18, $19, $20, $21, $22, $23, $24, $25
      )`,
      [
        trace.traceId,
        trace.spanId,
        trace.parentSpanId,
        trace.orgId,
        trace.agentId,
        trace.agentName,
        trace.agentFramework,
        trace.requestType,
        trace.intentCategory,
        trace.riskScore,
        trace.modelProvider,
        trace.modelName,
        trace.inputTokens,
        trace.outputTokens,
        trace.costUsd,
        JSON.stringify(trace.requestBody),
        JSON.stringify(trace.responseBody),
        JSON.stringify(trace.reasoningSteps),
        JSON.stringify(trace.toolCalls),
        trace.policyApplied,
        trace.actionTaken,
        trace.blockReason,
        trace.clientIp,
        trace.userAgent,
        trace.durationMs,
      ]
    );
  }
  
  // Analytics queries
  async getRecentTraces(orgId: string, limit = 100): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT * FROM agent_traces 
       WHERE org_id = $1 
       ORDER BY timestamp DESC 
       LIMIT $2`,
      [orgId, limit]
    );
    return result.rows;
  }
  
  async getBlockedTraces(orgId: string, hours = 24): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT * FROM agent_traces 
       WHERE org_id = $1 
         AND action_taken = 'blocked'
         AND timestamp > NOW() - INTERVAL '${hours} hours'
       ORDER BY timestamp DESC`,
      [orgId]
    );
    return result.rows;
  }
  
  async getBurnRateHistory(orgId: string, hours = 1): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT 
         time_bucket('1 minute', timestamp) as minute,
         SUM(cost_usd) as cost,
         COUNT(*) as requests
       FROM agent_traces
       WHERE org_id = $1 AND timestamp > NOW() - INTERVAL '${hours} hours'
       GROUP BY minute
       ORDER BY minute DESC`,
      [orgId]
    );
    return result.rows;
  }
  
  // Anomaly operations
  async recordAnomaly(anomaly: {
    orgId: string;
    agentId: string;
    type: string;
    severity: string;
    details: any;
  }): Promise<string> {
    const result = await this.pool.query(
      `INSERT INTO anomalies (org_id, agent_id, type, severity, details)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING anomaly_id`,
      [anomaly.orgId, anomaly.agentId, anomaly.type, anomaly.severity, JSON.stringify(anomaly.details)]
    );
    return result.rows[0].anomaly_id;
  }
  
  async getActiveAnomalies(orgId: string): Promise<any[]> {
    const result = await this.pool.query(
      `SELECT * FROM anomalies 
       WHERE org_id = $1 AND status = 'active'
       ORDER BY detected_at DESC`,
      [orgId]
    );
    return result.rows;
  }
  
  async resolveAnomaly(anomalyId: string, resolvedBy: string): Promise<void> {
    await this.pool.query(
      `UPDATE anomalies 
       SET status = 'resolved', resolved_at = NOW(), resolved_by = $2
       WHERE anomaly_id = $1`,
      [anomalyId, resolvedBy]
    );
  }
}
