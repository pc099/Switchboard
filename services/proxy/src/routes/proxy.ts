/**
 * Proxy Routes
 * Intercepts and forwards requests to upstream AI providers
 */

import { Router, Request, Response } from 'express';
import { SemanticFirewall, AgentRequest } from '../firewall/index.js';
import { FlightRecorder } from '../recorder/index.js';
import { TrafficController } from '../traffic/index.js';
import { WebSocketManager } from '../ws/manager.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

export function proxyRouter(
  firewall: SemanticFirewall,
  recorder: FlightRecorder,
  trafficController: TrafficController,
  wsManager: WebSocketManager
): Router {
  const router = Router();
  
  // All routes under /v1 are proxied
  router.all('/*', async (req: Request, res: Response) => {
    const startTime = performance.now();
    const traceContext = recorder.createContext();
    
    try {
      // Extract Switchboard token and validate
      const switchboardToken = req.headers['x-switchboard-token'] as string;
      if (!switchboardToken) {
        return res.status(401).json({
          error: {
            message: 'Missing X-Switchboard-Token header',
            type: 'authentication_error',
          },
        });
      }
      
      // Build agent request context
      const agentRequest: AgentRequest = {
        orgId: 'org_demo', // Would come from token validation
        agentId: (req.headers['x-agent-id'] as string) || 'default',
        body: req.body,
        headers: req.headers as Record<string, string>,
        path: req.path,
        method: req.method,
      };
      
      // Step 1: Semantic Firewall evaluation
      const decision = await firewall.evaluate(agentRequest);
      
      if (!decision.allowed) {
        // Record blocked request
        await recorder.record(traceContext, {
          request: agentRequest,
          decision,
          clientIp: req.ip,
          userAgent: req.headers['user-agent'],
        });
        
        // Notify dashboard
        wsManager.broadcastBlocked(agentRequest.orgId, agentRequest.agentId, decision.reason || 'Policy violation');
        
        return res.status(403).json({
          error: {
            message: decision.reason || 'Request blocked by policy',
            type: 'policy_violation',
            code: 'BLOCKED_BY_FIREWALL',
          },
        });
      }
      
      // Step 2: Traffic control (conflict resolution)
      const resource = trafficController.extractResource(req.body);
      if (resource) {
        const isWrite = trafficController.isWriteOperation(req.body, req.method);
        const conflict = await trafficController.requestAccess(
          agentRequest.agentId,
          resource.type,
          resource.path,
          isWrite
        );
        
        if (conflict.resolution === 'rejected') {
          return res.status(409).json({
            error: {
              message: conflict.reason || 'Resource conflict',
              type: 'conflict_error',
              code: 'RESOURCE_LOCKED',
            },
          });
        }
        
        if (conflict.resolution === 'queued' && conflict.waitMs) {
          // Simple backoff - in production would use proper queueing
          await new Promise(resolve => setTimeout(resolve, Math.min(conflict.waitMs ?? 0, 5000)));
        }
      }
      
      // Step 3: Forward to upstream provider
      const upstreamResponse = await forwardToUpstream(req, agentRequest);
      
      // Step 4: Record trace
      const modelName = req.body?.model;
      const usage = upstreamResponse.body?.usage;
      
      await recorder.record(traceContext, {
        request: agentRequest,
        response: upstreamResponse.body,
        decision,
        modelProvider: getProvider(req.headers),
        modelName,
        inputTokens: usage?.prompt_tokens,
        outputTokens: usage?.completion_tokens,
        clientIp: req.ip,
        userAgent: req.headers['user-agent'],
      });
      
      // Step 5: Release traffic lock if applicable
      if (resource) {
        await trafficController.releaseAccess(
          agentRequest.agentId,
          resource.type,
          resource.path
        );
      }
      
      // Add Switchboard headers to response
      res.set({
        'X-Switchboard-Trace-Id': traceContext.traceId,
        'X-Switchboard-Latency-Ms': String(Math.round(performance.now() - startTime)),
        'X-Switchboard-Risk-Score': String(decision.riskScore),
      });
      
      // Return upstream response
      res.status(upstreamResponse.status).json(upstreamResponse.body);
      
    } catch (err) {
      logger.error({ err, path: req.path }, 'Proxy error');
      res.status(502).json({
        error: {
          message: 'Upstream provider error',
          type: 'proxy_error',
        },
      });
    }
  });
  
  return router;
}

async function forwardToUpstream(
  req: Request,
  agentRequest: AgentRequest
): Promise<{ status: number; body: any }> {
  const provider = getProvider(req.headers);
  const upstream = config.upstreams[provider as keyof typeof config.upstreams] || config.upstreams.openai;
  
  const url = `${upstream}${req.path}`;
  
  // Clone headers, removing Switchboard-specific ones and hop-by-hop headers
  const headers: Record<string, string> = {};
  const excludedHeaders = [
    'x-switchboard-',
    'host',
    'connection',
    'content-length',
    'transfer-encoding',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailers',
    'upgrade'
  ];

  for (const [key, value] of Object.entries(req.headers)) {
    if (excludedHeaders.some(ex => key.toLowerCase().startsWith(ex))) continue;
    if (typeof value === 'string') {
      headers[key] = value;
    }
  }
  
  try {
    const response = await fetch(url, {
      method: req.method,
      headers,
      body: req.method !== 'GET' ? JSON.stringify(req.body) : undefined,
    });
    
    const body = await response.json();
    return { status: response.status, body };
  } catch (err) {
    logger.error({ err, url }, 'Upstream request failed');
    throw err;
  }
}

function getProvider(headers: Request['headers']): string {
  const auth = (headers['authorization'] || '') as string;
  
  if (auth.includes('sk-ant-')) return 'anthropic';
  if (auth.includes('AIza')) return 'google';
  return 'openai';
}
