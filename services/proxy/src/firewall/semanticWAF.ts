/**
 * Semantic WAF - Managed Security Rules
 * Detects and blocks sophisticated attack patterns in agent requests
 */

import { logger } from '../utils/logger.js';

export interface WAFRule {
  id: string;
  name: string;
  description: string;
  category: 'prompt_injection' | 'tool_hijacking' | 'pii_exfiltration' | 'data_poisoning';
  severity: 'low' | 'medium' | 'high' | 'critical';
  enabled: boolean;
  patterns: RegExp[];
  action: 'block' | 'log' | 'redact';
}

export interface WAFResult {
  blocked: boolean;
  matchedRules: string[];
  riskScore: number;
  sanitizedContent?: string;
  details: {
    ruleId: string;
    ruleName: string;
    severity: string;
    matchedPattern: string;
  }[];
}

// ======================
// RULE 101: Prompt Injection Detection
// ======================
const PROMPT_INJECTION_PATTERNS = [
  // Direct instruction override
  /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
  /disregard\s+(all\s+)?(previous|prior|above)\s+(instructions?|prompts?)/i,
  /forget\s+(everything|all)\s+(you\s+)?know/i,
  
  // Role manipulation
  /you\s+are\s+(now\s+)?(a\s+)?(different|new|another)\s+(ai|assistant|bot)/i,
  /pretend\s+(you\s+)?(are|to\s+be)\s+/i,
  /act\s+as\s+(if\s+)?(you\s+)?(were|are)\s+/i,
  /roleplay\s+as\s+/i,
  
  // System prompt extraction
  /what\s+(is|are)\s+(your|the)\s+(system\s+)?prompt/i,
  /show\s+me\s+(your|the)\s+(initial|system|original)\s+(prompt|instructions)/i,
  /reveal\s+(your|the)\s+(hidden|secret|system)\s+(prompt|instructions)/i,
  /print\s+(your|the)\s+(system\s+)?prompt/i,
  
  // Jailbreak attempts
  /dan\s+mode/i,
  /developer\s+mode\s+(enabled|activated|on)/i,
  /sudo\s+/i,
  /admin\s+override/i,
  
  // Delimiter injection
  /\[INST\]/i,
  /<<SYS>>/i,
  /<\|im_start\|>/i,
  /\[\/INST\]/i,
];

// ======================
// RULE 102: Tool Hijacking Prevention
// ======================
const TOOL_HIJACKING_PATTERNS = [
  // Dangerous function calls
  /delete_user|drop_table|truncate|rm\s+-rf/i,
  /execute_command|run_shell|system\s*\(/i,
  /eval\s*\(|exec\s*\(/i,
  
  // Database attacks
  /;\s*drop\s+/i,
  /;\s*delete\s+from/i,
  /union\s+select/i,
  /or\s+1\s*=\s*1/i,
  
  // File system access
  /read_file\s*\(.*passwd/i,
  /write_file\s*\(.*\.sh/i,
  /\.\.\/\.\.\/\.\.\//,
  
  // Network exfiltration
  /curl\s+.*\s+\|/i,
  /wget\s+.*\s+-O/i,
  /nc\s+-e/i,
];

// ======================
// RULE 103: PII Exfiltration Detection
// ======================
const PII_PATTERNS = [
  // Email addresses
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  
  // SSN (US)
  /\b\d{3}[-\s]?\d{2}[-\s]?\d{4}\b/g,
  
  // Credit card numbers
  /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
  
  // Phone numbers
  /\b(?:\+?1[-.\s]?)?\(?[2-9]\d{2}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  
  // API keys (common patterns)
  /sk-[a-zA-Z0-9]{20,}/g,
  /sk-ant-[a-zA-Z0-9-]+/g,
  /xoxb-[a-zA-Z0-9-]+/g,
  /ghp_[a-zA-Z0-9]{36}/g,
  
  // AWS keys
  /AKIA[0-9A-Z]{16}/g,
  
  // Passport numbers (generic)
  /\b[A-Z]{1,2}\d{6,9}\b/g,
];

// Default rule set
const DEFAULT_RULES: WAFRule[] = [
  {
    id: 'WAF-101',
    name: 'Prompt Injection Detection',
    description: 'Detects attempts to override system instructions or manipulate AI behavior',
    category: 'prompt_injection',
    severity: 'critical',
    enabled: true,
    patterns: PROMPT_INJECTION_PATTERNS,
    action: 'block',
  },
  {
    id: 'WAF-102',
    name: 'Tool Hijacking Prevention',
    description: 'Prevents malicious tool/function calls that could compromise systems',
    category: 'tool_hijacking',
    severity: 'critical',
    enabled: true,
    patterns: TOOL_HIJACKING_PATTERNS,
    action: 'block',
  },
  {
    id: 'WAF-103',
    name: 'PII Exfiltration Detection',
    description: 'Detects and optionally redacts personally identifiable information',
    category: 'pii_exfiltration',
    severity: 'high',
    enabled: true,
    patterns: PII_PATTERNS,
    action: 'redact',
  },
];

export class SemanticWAF {
  private rules: WAFRule[];
  
  constructor(customRules?: WAFRule[]) {
    this.rules = customRules || [...DEFAULT_RULES];
    logger.info({ ruleCount: this.rules.length }, 'Semantic WAF initialized');
  }
  
  /**
   * Evaluate content against all enabled WAF rules
   */
  evaluate(content: string): WAFResult {
    const result: WAFResult = {
      blocked: false,
      matchedRules: [],
      riskScore: 0,
      details: [],
    };
    
    let processedContent = content;
    
    for (const rule of this.rules) {
      if (!rule.enabled) continue;
      
      for (const pattern of rule.patterns) {
        const matches = content.match(pattern);
        
        if (matches && matches.length > 0) {
          const matchedText = matches[0];
          
          result.matchedRules.push(rule.id);
          result.details.push({
            ruleId: rule.id,
            ruleName: rule.name,
            severity: rule.severity,
            matchedPattern: matchedText.substring(0, 50), // Truncate for logging
          });
          
          // Calculate risk score based on severity
          const severityScores = { low: 0.2, medium: 0.4, high: 0.7, critical: 1.0 };
          result.riskScore = Math.max(result.riskScore, severityScores[rule.severity]);
          
          // Apply action
          if (rule.action === 'block') {
            result.blocked = true;
            logger.warn({
              ruleId: rule.id,
              ruleName: rule.name,
              severity: rule.severity,
              matchedSnippet: matchedText.substring(0, 30),
            }, 'WAF rule triggered - blocking request');
          } else if (rule.action === 'redact') {
            // Redact PII with masked version
            processedContent = processedContent.replace(pattern, '[REDACTED]');
          }
          
          // Only match first pattern per rule to avoid duplicate logging
          break;
        }
      }
    }
    
    if (processedContent !== content) {
      result.sanitizedContent = processedContent;
    }
    
    return result;
  }
  
  /**
   * Enable or disable a specific rule
   */
  setRuleEnabled(ruleId: string, enabled: boolean): boolean {
    const rule = this.rules.find(r => r.id === ruleId);
    if (rule) {
      rule.enabled = enabled;
      logger.info({ ruleId, enabled }, 'WAF rule updated');
      return true;
    }
    return false;
  }
  
  /**
   * Get all rules with their current status
   */
  getRules(): WAFRule[] {
    return this.rules.map(r => ({
      ...r,
      patterns: [], // Don't expose patterns in API response
    }));
  }
  
  /**
   * Add a custom rule
   */
  addRule(rule: WAFRule): void {
    this.rules.push(rule);
    logger.info({ ruleId: rule.id, ruleName: rule.name }, 'Custom WAF rule added');
  }
}

// Export singleton instance
export const semanticWAF = new SemanticWAF();
