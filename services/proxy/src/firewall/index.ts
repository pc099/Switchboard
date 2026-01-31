/**
 * Semantic Firewall
 * Real-time intent classification and policy enforcement
 * Target: < 10ms latency
 */

import bloomFilters from 'bloom-filters';
import type { BloomFilter as BloomFilterType } from 'bloom-filters';
const { BloomFilter: BloomFilterImpl } = bloomFilters;
import { RedisClient } from '../db/redis.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';
import { PolicyLoader } from './policyLoader.js';
import { semanticWAF } from './semanticWAF.js';

// Pre-compiled dangerous patterns
const DANGEROUS_PATTERNS = [
  // SQL injection / destructive SQL
  /\b(DROP|DELETE|TRUNCATE|ALTER)\s+(TABLE|DATABASE|INDEX)/i,
  /\bDELETE\s+FROM\s+\w+\s*(WHERE\s+1\s*=\s*1|;|\s*$)/i,
  
  // Shell commands
  /\b(rm\s+-rf|sudo\s+rm|chmod\s+777|:(){ :|:& };:)/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  
  // Credential/secret patterns
  /\b(password|secret|api_key|token)\s*[:=]\s*["'][^"']+["']/i,
  
  // External data exfiltration
  /\b(curl|wget|nc|netcat)\s+.*(http|ftp)/i,
];

// PII patterns for Bloom filter
const PII_PATTERNS = [
  // Email
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
  // SSN
  /\b\d{3}-\d{2}-\d{4}\b/,
  // Credit card
  /\b(?:\d{4}[-\s]?){3}\d{4}\b/,
  // Phone numbers
  /\b(?:\+\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/,
];

export interface FirewallDecision {
  allowed: boolean;
  action: 'allowed' | 'blocked' | 'audited' | 'modified' | 'shadow_blocked';
  reason?: string;
  riskScore: number;
  intentCategory?: string;
  latencyMs: number;
  isShadowEvent?: boolean;
  policyId?: string;
}

export interface AgentRequest {
  orgId: string;
  agentId: string;
  body: any;
  headers: Record<string, string>;
  path: string;
  method: string;
}

export class SemanticFirewall {
  private piiBloomFilter: BloomFilterType;
  private redis: RedisClient;
  private policyLoader?: PolicyLoader;
  
  constructor(redis: RedisClient, policyLoader?: PolicyLoader) {
    this.redis = redis;
    this.policyLoader = policyLoader;
    
    // Initialize Bloom filter with PII patterns
    // Size optimized for low false positive rate
    this.piiBloomFilter = new BloomFilterImpl(10000, 7);
    
    // Pre-populate with common PII markers
    const piiMarkers = [
      '@gmail.com', '@yahoo.com', '@hotmail.com', '@outlook.com',
      'ssn:', 'social security', 'credit card', 'card number',
      'password:', 'api_key:', 'bearer ', 'authorization:',
    ];
    piiMarkers.forEach(marker => this.piiBloomFilter.add(marker.toLowerCase()));
    
    logger.info({ shadowMode: this.isShadowMode() }, 'Semantic Firewall initialized');
  }
  
  /**
   * Check if shadow mode is active
   */
  private isShadowMode(): boolean {
    return this.policyLoader?.isShadowMode() ?? config.shadowMode;
  }
  
  /**
   * Get current policy ID for tracing
   */
  private getPolicyId(): string {
    return this.policyLoader?.getPolicyId() ?? 'default';
  }
  
  async evaluate(request: AgentRequest): Promise<FirewallDecision> {
    const startTime = performance.now();
    
    try {
      const bodyStr = request.body 
        ? (typeof request.body === 'string' ? request.body : JSON.stringify(request.body))
        : '';
      const bodyLower = bodyStr.toLowerCase();
      
      // Stage 1: Bloom filter for PII (0.1ms)
      if (config.firewall.blockPII && bodyStr) {
        const piiMatch = this.confirmPII(bodyStr);
        if (piiMatch) {
          logger.info({ piiMatch }, 'PII detected, blocking request');
          return this.blocked('PII detected: ' + piiMatch, 90, 'data_exfiltration', startTime);
        }
      }
      
      // Stage 2: Regex for dangerous patterns (0.3ms)
      if (config.firewall.blockDestructive) {
        const dangerMatch = this.checkDangerousPatterns(bodyStr);
        if (dangerMatch) {
          return this.blocked('Dangerous pattern: ' + dangerMatch, 95, 'destructive', startTime);
        }
      }
      
      // Stage 2.5: Semantic WAF evaluation (1-3ms)
      const wafResult = semanticWAF.evaluate(bodyStr);
      if (wafResult.blocked) {
        const topRule = wafResult.details[0];
        return this.blocked(
          `WAF ${topRule?.ruleId}: ${topRule?.ruleName}`,
          wafResult.riskScore * 100,
          topRule?.ruleId.toLowerCase() || 'waf_violation',
          startTime
        );
      }
      
      // Stage 3: Content-based intent classification (3-5ms)
      const intent = this.classifyIntent(request.body);
      
      // Stage 4: Policy evaluation (0.2ms)
      const policy = await this.redis.getPolicy(request.orgId);
      if (policy) {
        const policyResult = this.evaluatePolicy(intent, policy);
        if (policyResult.blocked) {
          return this.blocked(policyResult.reason!, policyResult.riskScore, intent.category, startTime);
        }
      }
      
      // Calculate risk score
      const riskScore = this.calculateRiskScore(intent, request);
      
      return {
        allowed: true,
        action: riskScore > 70 ? 'audited' : 'allowed',
        riskScore,
        intentCategory: intent.category,
        latencyMs: performance.now() - startTime,
      };
    } catch (err) {
      logger.error({ err }, 'Firewall evaluation error');
      // Fail open with audit
      return {
        allowed: true,
        action: 'audited',
        reason: 'Evaluation error - allowing with audit',
        riskScore: 50,
        latencyMs: performance.now() - startTime,
      };
    }
  }
  
  private checkPIIProbable(text: string): boolean {
    // Quick Bloom filter check
    const words = text.split(/\s+/).slice(0, 100); // Limit for performance
    return words.some(word => this.piiBloomFilter.has(word));
  }
  
  private confirmPII(text: string): string | null {
    for (const pattern of PII_PATTERNS) {
      if (pattern.test(text)) {
        // Return sanitized indicator
        const source = pattern.source;
        if (source.includes('@')) return 'email address';
        if (source.includes('\\d{3}-\\d{2}')) return 'SSN';
        if (source.includes('\\d{4}')) return 'potential credit card';
        return 'phone number';
      }
    }
    return null;
  }
  
  private checkDangerousPatterns(text: string): string | null {
    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(text)) {
        return pattern.source.substring(0, 50);
      }
    }
    return null;
  }
  
  private classifyIntent(body: any): { category: string; confidence: number; keywords: string[] } {
    // Fast keyword-based classification
    const text = body ? JSON.stringify(body).toLowerCase() : '';
    
    const categories: Record<string, { keywords: string[]; weight: number }> = {
      destructive: {
        keywords: ['delete', 'remove', 'drop', 'truncate', 'destroy', 'kill', 'terminate'],
        weight: 1.5,
      },
      data_access: {
        keywords: ['select', 'query', 'fetch', 'read', 'get', 'list', 'search'],
        weight: 0.5,
      },
      data_modification: {
        keywords: ['update', 'insert', 'upsert', 'modify', 'change', 'set'],
        weight: 1.0,
      },
      external_call: {
        keywords: ['http', 'api', 'webhook', 'curl', 'fetch', 'request', 'post'],
        weight: 1.2,
      },
      code_execution: {
        keywords: ['exec', 'eval', 'run', 'execute', 'shell', 'command', 'script'],
        weight: 1.4,
      },
      file_operation: {
        keywords: ['file', 'write', 'save', 'upload', 'download', 'path', 'directory'],
        weight: 1.1,
      },
    };
    
    let maxScore = 0;
    let topCategory = 'unknown';
    let matchedKeywords: string[] = [];
    
    for (const [category, config] of Object.entries(categories)) {
      const matches = config.keywords.filter(kw => text.includes(kw));
      const score = matches.length * config.weight;
      
      if (score > maxScore) {
        maxScore = score;
        topCategory = category;
        matchedKeywords = matches;
      }
    }
    
    return {
      category: topCategory,
      confidence: Math.min(0.95, maxScore / 5),
      keywords: matchedKeywords,
    };
  }
  
  private evaluatePolicy(
    intent: { category: string; confidence: number },
    policy: any
  ): { blocked: boolean; reason?: string; riskScore: number } {
    // Check if category is blocked by policy
    const blockedCategories = policy.rules?.blockedCategories || [];
    
    if (blockedCategories.includes(intent.category)) {
      return {
        blocked: true,
        reason: `Policy blocks ${intent.category} operations`,
        riskScore: 80,
      };
    }
    
    return { blocked: false, riskScore: 30 };
  }
  
  private calculateRiskScore(
    intent: { category: string; confidence: number },
    request: AgentRequest
  ): number {
    let score = 20; // Base score
    
    // Intent-based scoring
    const riskWeights: Record<string, number> = {
      destructive: 40,
      code_execution: 35,
      external_call: 25,
      file_operation: 20,
      data_modification: 15,
      data_access: 5,
    };
    
    score += riskWeights[intent.category] || 10;
    score *= intent.confidence;
    
    // Request-based factors
    if (request.method === 'DELETE') score += 20;
    if (request.path.includes('admin')) score += 10;
    
    return Math.min(100, Math.round(score));
  }
  
  private blocked(
    reason: string,
    riskScore: number,
    category: string,
    startTime: number
  ): FirewallDecision {
    const isShadowMode = this.isShadowMode();
    const policyId = this.getPolicyId();
    
    if (isShadowMode) {
      // In shadow mode: log the violation but allow the request
      logger.info({ reason, category, policyId }, 'Shadow mode: would have blocked request');
      return {
        allowed: true,  // Allow in shadow mode
        action: 'shadow_blocked',
        reason,
        riskScore,
        intentCategory: category,
        latencyMs: performance.now() - startTime,
        isShadowEvent: true,
        policyId,
      };
    }
    
    return {
      allowed: false,
      action: 'blocked',
      reason,
      riskScore,
      intentCategory: category,
      latencyMs: performance.now() - startTime,
      isShadowEvent: false,
      policyId,
    };
  }
}
