/**
 * Internal API Routes
 * Dashboard and management endpoints
 */

import { Router, Request, Response } from 'express';
import { PostgresClient } from '../db/postgres.js';
import { RedisClient } from '../db/redis.js';
import { WebSocketManager } from '../ws/manager.js';
import { TrafficController } from '../traffic/index.js';
import { PolicyLoader } from '../firewall/policyLoader.js';
import { semanticWAF } from '../firewall/semanticWAF.js';
import { logger } from '../utils/logger.js';

export function apiRouter(
  postgres: PostgresClient,
  redis: RedisClient,
  wsManager: WebSocketManager,
  trafficController: TrafficController,
  policyLoader: PolicyLoader
): Router {
  const router = Router();
  
  // ========================
  // Dashboard Metrics
  // ========================
  
  /**
   * Get current burn rate for organization
   */
  router.get('/burn-rate/:orgId', async (req: Request, res: Response) => {
    try {
      const { orgId } = req.params;
      
      const currentRate = await redis.getBurnRate(orgId);
      const history = await postgres.getBurnRateHistory(orgId, 1);
      
      res.json({
        currentRate,
        hourlyProjection: currentRate * 60,
        history: history.map(h => ({
          minute: h.minute,
          cost: parseFloat(h.cost),
          requests: parseInt(h.requests),
        })),
      });
    } catch (err) {
      logger.error({ err }, 'Failed to get burn rate');
      res.status(500).json({ error: 'Failed to get burn rate' });
    }
  });
  
  /**
   * Get active agents for organization
   */
  router.get('/agents/:orgId', async (req: Request, res: Response) => {
    try {
      const { orgId } = req.params;
      const agents = await postgres.getAgentsByOrg(orgId);
      res.json(agents);
    } catch (err) {
      logger.error({ err }, 'Failed to get agents');
      res.status(500).json({ error: 'Failed to get agents' });
    }
  });
  
  /**
   * Get active anomalies
   */
  router.get('/radar/anomalies/:orgId', async (req: Request, res: Response) => {
    try {
      const { orgId } = req.params;
      // Using direct query for now as getActiveAnomalies might not exist on PostgresClient yet
      // In a real impl, we'd add the method to PostgresClient
      const result = await postgres.query(`
        SELECT * FROM anomaly_events 
        WHERE org_id = $1 
        ORDER BY created_at DESC 
        LIMIT 50
      `, [orgId]);
      
      res.json(result.rows);
    } catch (err) {
      logger.error({ err }, 'Failed to get anomalies');
      res.status(500).json({ error: 'Failed to get anomalies' });
    }
  });
  
  /**
   * Get recent traces
   */
  router.get('/traces/:orgId', async (req: Request, res: Response) => {
    try {
      const { orgId } = req.params;
      const limit = parseInt(req.query.limit as string) || 100;
      const traces = await postgres.getRecentTraces(orgId, limit);
      res.json(traces);
    } catch (err) {
      logger.error({ err }, 'Failed to get traces');
      res.status(500).json({ error: 'Failed to get traces' });
    }
  });
  
  /**
   * Get shadow-blocked traces (last 24h) - requests that would have been blocked
   */
  router.get('/traces/:orgId/shadow', async (req: Request, res: Response) => {
    try {
      const { orgId } = req.params;
      const hours = parseInt(req.query.hours as string) || 24;
      const traces = await postgres.getShadowBlockedTraces(orgId, hours);
      res.json(traces);
    } catch (err) {
      logger.error({ err }, 'Failed to get shadow traces');
      res.status(500).json({ error: 'Failed to get shadow traces' });
    }
  });
  
  /**
   * Get shadow savings summary (total risk mitigated)
   */
  router.get('/shadow-savings/:orgId', async (req: Request, res: Response) => {
    try {
      const { orgId } = req.params;
      const hours = parseInt(req.query.hours as string) || 24;
      const savings = await postgres.getShadowSavings(orgId, hours);
      res.json({
        shadowBlockedCount: savings.count,
        totalMitigatedCost: savings.totalCost,
        periodHours: hours,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to get shadow savings');
      res.status(500).json({ error: 'Failed to get shadow savings' });
    }
  });

  /**
   * Get semantic cache statistics
   */
  router.get('/cache-stats/:orgId', async (req: Request, res: Response) => {
    try {
      const { orgId } = req.params;
      
      const result = await postgres.query(`
        SELECT 
          COUNT(*) as total_entries,
          COALESCE(SUM(hit_count), 0) as total_hits,
          COALESCE(SUM(cost_saved), 0) as total_savings
        FROM semantic_cache
        WHERE org_id = $1 AND expires_at > NOW()
      `, [orgId]);
      
      const row = result.rows[0];
      const totalEntries = parseInt(row?.total_entries || '0');
      const totalHits = parseInt(row?.total_hits || '0');
      const totalSavings = parseFloat(row?.total_savings || '0');
      
      res.json({
        totalEntries,
        totalHits,
        totalSavings,
        hitRate: totalEntries > 0 ? (totalHits / (totalHits + totalEntries) * 100).toFixed(1) : 0,
      });
    } catch (err) {
      logger.error({ err }, 'Failed to get cache stats');
      res.status(500).json({ error: 'Failed to get cache stats' });
    }
  });
  
  /**
   * Get blocked traces (last 24h)
   */
  router.get('/traces/:orgId/blocked', async (req: Request, res: Response) => {
    try {
      const { orgId } = req.params;
      const traces = await postgres.getBlockedTraces(orgId);
      res.json(traces);
    } catch (err) {
      logger.error({ err }, 'Failed to get blocked traces');
      res.status(500).json({ error: 'Failed to get blocked traces' });
    }
  });
  
  /**
   * Get current policy configuration
   */
  router.get('/policies/current', (_req: Request, res: Response) => {
    try {
      const policy = policyLoader.getPolicy();
      res.json(policy);
    } catch (err) {
      logger.error({ err }, 'Failed to get policy');
      res.status(500).json({ error: 'Failed to get policy' });
    }
  });

  /**
   * Update policy configuration
   */
  router.put('/policies', async (req: Request, res: Response) => {
    try {
      const updates = req.body;
      const updatedPolicy = await policyLoader.updatePolicy(updates);
      
      // Broadcast policy update
      wsManager.broadcast({
        type: 'policy_updated',
        payload: updatedPolicy,
        timestamp: new Date().toISOString(),
      });
      
      res.json(updatedPolicy);
    } catch (err) {
      logger.error({ err }, 'Failed to update policy');
      res.status(500).json({ error: 'Failed to update policy' });
    }
  });

  // ========================
  // Kill Switch Controls
  // ========================
  
  // Global pause state (in-memory for demo, would use Redis in production)
  let globalPaused = false;
  // emergencyStopped state moved to TrafficController
  const pausedAgents = new Set<string>();
  
  /**
   * Global pause - stops all agents
   */
  router.post('/control/pause-all', async (req: Request, res: Response) => {
    try {
      const { orgId } = req.body;
      
      globalPaused = true;
      
      // Broadcast to all connected dashboards
      wsManager.broadcast({
        type: 'global_pause_status',
        payload: { paused: true, orgId },
        timestamp: new Date().toISOString(),
      });
      
      logger.warn({ orgId }, 'GLOBAL PAUSE activated');
      res.json({ success: true, status: 'paused' });
    } catch (err) {
      logger.error({ err }, 'Failed to pause');
      res.status(500).json({ error: 'Failed to pause' });
    }
  });
  
  /**
   * Resume all agents
   */
  router.post('/control/resume-all', async (req: Request, res: Response) => {
    try {
      const { orgId } = req.body;
      
      globalPaused = false;
      pausedAgents.clear();
      
      wsManager.broadcast({
        type: 'global_pause_status',
        payload: { paused: false, orgId },
        timestamp: new Date().toISOString(),
      });
      
      logger.info({ orgId }, 'Global pause lifted');
      res.json({ success: true, status: 'resumed' });
    } catch (err) {
      logger.error({ err }, 'Failed to resume');
      res.status(500).json({ error: 'Failed to resume' });
    }
  });
  
  /**
   * Pause specific agent
   */
  router.post('/control/pause-agent', async (req: Request, res: Response) => {
    try {
      const { agentId } = req.body;
      
      pausedAgents.add(agentId);
      await postgres.updateAgentStatus(agentId, 'paused');
      
      wsManager.broadcastAgentStatus(agentId, 'paused');
      
      logger.warn({ agentId }, 'Agent paused');
      res.json({ success: true, agentId, status: 'paused' });
    } catch (err) {
      logger.error({ err }, 'Failed to pause agent');
      res.status(500).json({ error: 'Failed to pause agent' });
    }
  });
  
  /**
   * Resume specific agent
   */
  router.post('/control/resume-agent', async (req: Request, res: Response) => {
    try {
      const { agentId } = req.body;
      
      pausedAgents.delete(agentId);
      await postgres.updateAgentStatus(agentId, 'active');
      
      wsManager.broadcastAgentStatus(agentId, 'active');
      
      logger.info({ agentId }, 'Agent resumed');
      res.json({ success: true, agentId, status: 'active' });
    } catch (err) {
      logger.error({ err }, 'Failed to resume agent');
      res.status(500).json({ error: 'Failed to resume agent' });
    }
  });
  
  /**
   * Revoke agent token (permanent until regenerated)
   */
  router.post('/control/revoke-token', async (req: Request, res: Response) => {
    try {
      const { agentId } = req.body;
      
      await postgres.updateAgentStatus(agentId, 'revoked');
      
      wsManager.broadcastAgentStatus(agentId, 'revoked');
      
      logger.warn({ agentId }, 'Agent token revoked');
      res.json({ success: true, agentId, status: 'revoked' });
    } catch (err) {
      logger.error({ err }, 'Failed to revoke token');
      res.status(500).json({ error: 'Failed to revoke token' });
    }
  });
  
  /**
   * Resolve an anomaly
   */
  router.post('/anomalies/:anomalyId/resolve', async (req: Request, res: Response) => {
    try {
      const { anomalyId } = req.params;
      const { resolvedBy } = req.body;
      
      await postgres.resolveAnomaly(anomalyId, resolvedBy || 'dashboard');
      
      res.json({ success: true, anomalyId, status: 'resolved' });
    } catch (err) {
      logger.error({ err }, 'Failed to resolve anomaly');
      res.status(500).json({ error: 'Failed to resolve anomaly' });
    }
  });
  
  /**
   * Check pause status (used by proxy)
   */
  router.get('/control/status', (_req: Request, res: Response) => {
    res.json({
      globalPaused,
      emergencyStopped: trafficController.isEmergencyStopped(),
      pausedAgents: Array.from(pausedAgents),
    });
  });
  
  /**
   * Emergency stop - rejects ALL requests with 503
   */
  router.post('/control/emergency-stop', async (req: Request, res: Response) => {
    try {
      trafficController.triggerEmergencyStop();
      
      wsManager.broadcastEmergencyStop(true);
      
      logger.error('EMERGENCY STOP ACTIVATED - All requests will be rejected');
      res.json({ success: true, status: 'emergency_stopped' });
    } catch (err) {
      logger.error({ err }, 'Failed to activate emergency stop');
      res.status(500).json({ error: 'Failed to activate emergency stop' });
    }
  });
  
  /**
   * Reset emergency stop
   */
  router.post('/control/emergency-reset', async (req: Request, res: Response) => {
    try {
      trafficController.resetEmergencyStop();
      
      wsManager.broadcastEmergencyStop(false);
      
      logger.info('Emergency stop reset - Normal operations resumed');
      res.json({ success: true, status: 'normal' });
    } catch (err) {
      logger.error({ err }, 'Failed to reset emergency stop');
      res.status(500).json({ error: 'Failed to reset emergency stop' });
    }
  });
  
  // ========================
  // Semantic WAF Management
  // ========================
  
  /**
   * Get WAF rules and status
   */
  router.get('/waf/rules', (_req: Request, res: Response) => {
    try {
      const rules = semanticWAF.getRules();
      res.json({ rules });
    } catch (err) {
      logger.error({ err }, 'Failed to get WAF rules');
      res.status(500).json({ error: 'Failed to get WAF rules' });
    }
  });
  
  /**
   * Toggle WAF rule enabled/disabled
   */
  router.put('/waf/rules/:ruleId', (req: Request, res: Response) => {
    try {
      const { ruleId } = req.params;
      const { enabled } = req.body;
      
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'enabled must be a boolean' });
      }
      
      const success = semanticWAF.setRuleEnabled(ruleId, enabled);
      if (!success) {
        return res.status(404).json({ error: 'Rule not found' });
      }
      
      wsManager.broadcast({
        type: 'waf_rule_updated',
        payload: { ruleId, enabled },
        timestamp: new Date().toISOString()
      });
      res.json({ success: true, ruleId, enabled });
    } catch (err) {
      logger.error({ err }, 'Failed to update WAF rule');
      res.status(500).json({ error: 'Failed to update WAF rule' });
    }
  });
  
  return router;
}

