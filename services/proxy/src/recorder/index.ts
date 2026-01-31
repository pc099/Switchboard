/**
 * Flight Recorder
 * High-throughput trace logging for agent activity
 */

import { v4 as uuidv4 } from 'uuid';
import { PostgresClient } from '../db/postgres.js';
import { logger } from '../utils/logger.js';
import { FirewallDecision, AgentRequest } from '../firewall/index.js';

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTime: number;
}

export interface TraceData {
  request: AgentRequest;
  response?: any;
  decision: FirewallDecision;
  modelProvider?: string;
  modelName?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  reasoningSteps?: any[];
  toolCalls?: any[];
  clientIp?: string;
  userAgent?: string;
  isShadowEvent?: boolean;
  policyId?: string;
}

// Token pricing (approximate)
const TOKEN_PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4': { input: 0.00003, output: 0.00006 },
  'gpt-4-turbo': { input: 0.00001, output: 0.00003 },
  'gpt-3.5-turbo': { input: 0.0000005, output: 0.0000015 },
  'claude-3-opus': { input: 0.000015, output: 0.000075 },
  'claude-3-sonnet': { input: 0.000003, output: 0.000015 },
  'claude-3-haiku': { input: 0.00000025, output: 0.00000125 },
};

export class FlightRecorder {
  private postgres: PostgresClient;
  private buffer: TraceData[] = [];
  private flushInterval: NodeJS.Timeout;
  
  constructor(postgres: PostgresClient) {
    this.postgres = postgres;
    
    // Batch flush every 1 second for performance
    this.flushInterval = setInterval(() => this.flush(), 1000);
    
    logger.info('Flight Recorder initialized');
  }
  
  createContext(parentSpanId?: string): TraceContext {
    return {
      traceId: uuidv4(),
      spanId: uuidv4(),
      parentSpanId,
      startTime: performance.now(),
    };
  }
  
  async record(context: TraceContext, data: TraceData): Promise<void> {
    const duration = Math.round(performance.now() - context.startTime);
    
    // Auto-register agent
    try {
      await this.postgres.upsertAgent({
        agentId: data.request.agentId,
        orgId: data.request.orgId,
        name: data.request.headers['x-agent-name'] || data.request.agentId,
        framework: data.request.headers['x-agent-framework'],
      });
    } catch (err) {
      // Ignore registration errors (prevent blocking flow)
      logger.warn({ agentId: data.request.agentId, err }, 'Failed to auto-register agent');
    }

    // Estimate tokens if missing (crucial for shadow savings calculation)
    if (!data.inputTokens && data.request.body?.messages) {
      try {
        const text = JSON.stringify(data.request.body.messages);
        data.inputTokens = Math.ceil(text.length / 4); // Crude estimation
        data.outputTokens = 0; // No output for blocked/failed requests
      } catch {
        data.inputTokens = 0;
      }
    }

    // Calculate cost if token info available
    let costUsd = data.costUsd;
    if (!costUsd && data.inputTokens !== undefined && data.modelName) {
      costUsd = this.calculateCost(data.modelName, data.inputTokens, data.outputTokens || 0);
    }
    
    // Extract reasoning steps and tool calls from response
    const { reasoningSteps, toolCalls } = this.extractReasoningChain(data.request.body, data.response);
    
    const trace = {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      orgId: data.request.orgId,
      agentId: data.request.agentId,
      agentName: data.request.headers['x-agent-name'],
      agentFramework: data.request.headers['x-agent-framework'],
      requestType: this.getRequestType(data.request.path),
      intentCategory: data.decision.intentCategory,
      riskScore: data.decision.riskScore,
      modelProvider: data.modelProvider,
      modelName: data.modelName,
      inputTokens: data.inputTokens,
      outputTokens: data.outputTokens,
      costUsd,
      requestBody: data.request.body,
      responseBody: data.response,
      reasoningSteps: data.reasoningSteps || reasoningSteps,
      toolCalls: data.toolCalls || toolCalls,
      policyApplied: data.policyId || data.decision.policyId,
      actionTaken: data.decision.action,
      blockReason: data.decision.reason,
      clientIp: data.clientIp,
      userAgent: data.userAgent,
      durationMs: duration,
      isShadowEvent: data.isShadowEvent || data.decision.isShadowEvent || false,
    };
    
    // Add to buffer for batch insert
    this.buffer.push({ ...data, response: trace });
    
    // Immediate insert for blocked and shadow_blocked actions
    if (data.decision.action === 'blocked' || data.decision.action === 'shadow_blocked') {
      await this.postgres.recordTrace(trace);
      if (data.decision.action === 'blocked') {
        logger.warn({ agentId: data.request.agentId, reason: data.decision.reason }, 'Request blocked');
      } else {
        logger.info({ agentId: data.request.agentId, reason: data.decision.reason }, 'Shadow blocked (allowed in shadow mode)');
      }
    }
  }
  
  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    
    const toFlush = this.buffer.splice(0, 100); // Batch size
    
    try {
      await Promise.all(
        toFlush
          .filter(d => d.decision.action !== 'blocked') // Already inserted
          .map(d => this.postgres.recordTrace(d.response as any))
      );
    } catch (err) {
      logger.error({ err }, 'Failed to flush traces');
      // Re-add to buffer for retry
      this.buffer.unshift(...toFlush);
    }
  }
  
  private calculateCost(model: string, inputTokens: number, outputTokens: number): number {
    const pricing = TOKEN_PRICING[model] || TOKEN_PRICING['gpt-3.5-turbo'];
    return (inputTokens * pricing.input) + (outputTokens * pricing.output);
  }
  
  private getRequestType(path: string): string {
    if (path.includes('chat/completions')) return 'llm_call';
    if (path.includes('embeddings')) return 'embedding';
    if (path.includes('images')) return 'image_generation';
    if (path.includes('audio')) return 'audio';
    if (path.includes('files')) return 'file_operation';
    return 'api_call';
  }
  
  private extractReasoningChain(request: any, response: any): { reasoningSteps: any[]; toolCalls: any[] } {
    const reasoningSteps: any[] = [];
    const toolCalls: any[] = [];
    
    try {
      // Extract messages for context
      if (request?.messages) {
        request.messages.forEach((msg: any, idx: number) => {
          if (msg.role === 'assistant' && msg.content) {
            reasoningSteps.push({
              step_id: idx,
              type: 'thought',
              content: typeof msg.content === 'string' ? msg.content.substring(0, 500) : JSON.stringify(msg.content).substring(0, 500),
              timestamp: new Date().toISOString(),
            });
          }
        });
      }
      
      // Extract tool calls from response
      if (response?.choices?.[0]?.message?.tool_calls) {
        response.choices[0].message.tool_calls.forEach((tc: any, idx: number) => {
          toolCalls.push({
            call_id: tc.id || `tc_${idx}`,
            tool_name: tc.function?.name,
            arguments: tc.function?.arguments,
            status: 'completed',
          });
        });
      }
    } catch {
      // Ignore extraction errors
    }
    
    return { reasoningSteps, toolCalls };
  }
  
  stop(): void {
    clearInterval(this.flushInterval);
    this.flush();
  }
}
