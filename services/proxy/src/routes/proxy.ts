/**
 * Proxy Routes
 * Intercepts and forwards requests to upstream AI providers
 */

import { Router, Request, Response } from 'express';
import { SemanticFirewall, AgentRequest } from '../firewall/index.js';
import { FlightRecorder } from '../recorder/index.js';
import { TrafficController } from '../traffic/index.js';
import { WebSocketManager } from '../ws/manager.js';
import { SemanticCache } from '../cache/semanticCache.js';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { workerEngine } from '../workers/engine.js';
import { workerRegistry } from '../workers/registry.js';
import { WorkerContext } from '../workers/engine.js';

export function proxyRouter(
  firewall: SemanticFirewall,
  recorder: FlightRecorder,
  trafficController: TrafficController,
  wsManager: WebSocketManager,
  semanticCache: SemanticCache
): Router {
  const router = Router();
  
  // All routes under /v1 are proxied
  router.all('/*', async (req: Request, res: Response) => {
    // 0. Emergency Stop Check
    if (trafficController.isEmergencyStopped()) {
      return res.status(503).json({
        error: {
          message: 'System globally paused (Emergency Stop)',
          type: 'service_unavailable',
          code: 'EMERGENCY_STOP',
        },
      });
    }

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

      // Step 0.5: Pre-request Workers (Edge Logic)
      const preWorkers = workerRegistry.getWorkers('pre_request');
      if (preWorkers.length > 0) {
        const workerCtx: WorkerContext = {
          request: {
            method: agentRequest.method,
            path: agentRequest.path,
            headers: agentRequest.headers,
            body: agentRequest.body
          },
          log: (msg) => logger.debug({ worker: 'pre' }, msg),
          env: {}
        };

        for (const worker of preWorkers) {
          const result = await workerEngine.execute(worker.code, workerCtx);
          if (result.modified && result.request) {
            agentRequest.headers = result.request.headers;
            agentRequest.body = result.request.body;
            req.body = result.request.body; // Update express req for downstream
          }
          if (result.response) {
            // Worker generated a response (short-circuit)
            return res.status(result.response.status).set(result.response.headers).json(result.response.body);
          }
        }
      }
      
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
      
      // Step 3: Semantic Cache lookup
      const modelName = req.body?.model || 'gpt-3.5-turbo';
      const promptText = extractPromptText(req.body);
      let cacheHit = false;
      let cachedResponse: any = null;

      if (promptText) {
        const cached = await semanticCache.lookup(agentRequest.orgId, modelName, promptText);
        if (cached) {
          cacheHit = true;
          cachedResponse = JSON.parse(cached.responseText);
          
          // Estimate cost saved (based on typical token pricing)
          const estimatedCost = 0.002; // ~$0.002 per cached response
          await semanticCache.recordHit(cached.cacheId, estimatedCost);
          
          logger.info({ 
            agentId: agentRequest.agentId, 
            similarity: cached.similarity.toFixed(3) 
          }, 'Semantic cache hit');
        }
      }

      // Step 4: Forward to upstream (or use cached response)
      let upstreamResponse: { status: number; body: any };
      
      if (cacheHit && cachedResponse) {
        upstreamResponse = { status: 200, body: cachedResponse };
      } else {
        upstreamResponse = await forwardToUpstream(req, agentRequest);
        
        // Store successful responses in cache
        if (upstreamResponse.status === 200 && promptText) {
          const usage = upstreamResponse.body?.usage;
          semanticCache.store(
            agentRequest.orgId,
            modelName,
            promptText,
            JSON.stringify(upstreamResponse.body),
            usage?.total_tokens
          ).catch(err => logger.warn({ err }, 'Failed to cache response'));
        }

        }

      // Step 4.5: Post-response Workers
      let finalResponse = upstreamResponse;
      const postWorkers = workerRegistry.getWorkers('post_response');
      
      if (postWorkers.length > 0) {
        const workerCtx: WorkerContext = {
          request: {
            method: agentRequest.method,
            path: agentRequest.path,
            headers: agentRequest.headers,
            body: agentRequest.body
          },
          response: {
            status: upstreamResponse.status,
            body: upstreamResponse.body,
            headers: {}
          },
          log: (msg) => logger.debug({ worker: 'post' }, msg),
          env: {}
        };

        for (const worker of postWorkers) {
          const result = await workerEngine.execute(worker.code, workerCtx);
          if (result.modified && result.response) {
            finalResponse = {
              status: result.response.status,
              body: result.response.body
            };
          }
        }
      }

      
      // Step 5: Record trace
      const usage = finalResponse.body?.usage;
      
      await recorder.record(traceContext, {
        request: agentRequest,
        response: finalResponse.body,
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
        'X-Switchboard-Cache': cacheHit ? 'HIT' : 'MISS',
      });
      
      // Return upstream response
      res.status(finalResponse.status).json(finalResponse.body);
      
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

/**
 * Extract the prompt text from a request body for cache key generation
 */
function extractPromptText(body: any): string | null {
  if (!body) return null;
  
  try {
    // OpenAI chat completion format
    if (body.messages && Array.isArray(body.messages)) {
      return body.messages
        .map((m: any) => `${m.role}:${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`)
        .join('|');
    }
    
    // OpenAI legacy completion format
    if (body.prompt) {
      return typeof body.prompt === 'string' ? body.prompt : JSON.stringify(body.prompt);
    }
    
    // Anthropic format
    if (body.human_prompt || body.prompt) {
      return body.human_prompt || body.prompt;
    }
    
    return null;
  } catch {
    return null;
  }
}
