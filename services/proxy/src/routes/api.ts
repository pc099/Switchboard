/**
 * Internal API Routes
 * Dashboard and management endpoints
 */

import { Router, Request, Response } from 'express';
import { PostgresClient } from '../db/postgres.js';
import { RedisClient } from '../db/redis.js';
import { WebSocketManager } from '../ws/manager.js';
import { logger } from '../utils/logger.js';

export function apiRouter(
  postgres: PostgresClient,
  redis: RedisClient,
  wsManager: WebSocketManager
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
  router.get('/anomalies/:orgId', async (req: Request, res: Response) => {
    try {
      const { orgId } = req.params;
      const anomalies = await postgres.getActiveAnomalies(orgId);
      res.json(anomalies);
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
  
  // ========================
  // Kill Switch Controls
  // ========================
  
  // Global pause state (in-memory for demo, would use Redis in production)
  let globalPaused = false;
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
      pausedAgents: Array.from(pausedAgents),
    });
  });
  
  return router;
}
