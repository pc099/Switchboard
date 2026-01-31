/**
 * Policy Loader
 * Loads and watches policy configuration from file or Redis
 */

import { readFileSync, watch, existsSync } from 'fs';
import { config } from '../config.js';
import { RedisClient } from '../db/redis.js';
import { logger } from '../utils/logger.js';

export interface PolicyConfig {
  version: string;
  policy_id: string;
  max_burn_rate_per_hour: number;
  blocked_intents: string[];
  pii_masking_enabled: boolean;
  shadow_mode: boolean;
  rules: {
    block_pii: boolean;
    block_destructive: boolean;
    block_external_calls: boolean;
    allowed_models: string[];
    max_tokens_per_request: number;
  };
}

const DEFAULT_POLICY: PolicyConfig = {
  version: '1.0.0',
  policy_id: 'default',
  max_burn_rate_per_hour: 100.00,
  blocked_intents: ['destructive', 'code_execution'],
  pii_masking_enabled: true,
  shadow_mode: false,
  rules: {
    block_pii: true,
    block_destructive: true,
    block_external_calls: false,
    allowed_models: [],
    max_tokens_per_request: 10000,
  },
};

export class PolicyLoader {
  private currentPolicy: PolicyConfig = DEFAULT_POLICY;
  private redis: RedisClient;
  private configPath: string;
  private watchAbortController?: AbortController;
  
  constructor(redis: RedisClient) {
    this.redis = redis;
    this.configPath = config.policiesConfigPath;
  }
  
  async initialize(): Promise<void> {
    // Try to load from file first
    if (existsSync(this.configPath)) {
      await this.loadFromFile();
      this.watchFile();
      logger.info({ path: this.configPath }, 'Policy loaded from file');
    } else {
      // Fall back to Redis
      await this.loadFromRedis();
      logger.info('Policy loaded from Redis (file not found)');
    }
  }
  
  private async loadFromFile(): Promise<void> {
    try {
      const content = readFileSync(this.configPath, 'utf-8');
      const parsed = JSON.parse(content) as Partial<PolicyConfig>;
      this.currentPolicy = { ...DEFAULT_POLICY, ...parsed };
    } catch (err) {
      logger.error({ err, path: this.configPath }, 'Failed to load policy from file');
    }
  }
  
  private async loadFromRedis(): Promise<void> {
    try {
      const policy = await this.redis.getPolicy('global');
      if (policy) {
        this.currentPolicy = { ...DEFAULT_POLICY, ...policy };
      }
    } catch (err) {
      logger.error({ err }, 'Failed to load policy from Redis');
    }
  }
  
  private watchFile(): void {
    try {
      this.watchAbortController = new AbortController();
      watch(this.configPath, { signal: this.watchAbortController.signal }, async (eventType) => {
        if (eventType === 'change') {
          logger.info('Policy file changed, reloading...');
          await this.loadFromFile();
        }
      });
    } catch (err) {
      logger.warn({ err }, 'Could not watch policy file for changes');
    }
  }
  
  getPolicy(): PolicyConfig {
    return this.currentPolicy;
  }
  
  async updatePolicy(updates: Partial<PolicyConfig>): Promise<PolicyConfig> {
    this.currentPolicy = { ...this.currentPolicy, ...updates };
    
    // Persist to Redis
    await this.redis.setPolicy('global', this.currentPolicy, 3600);
    
    // Persist to File
    if (this.configPath) {
       await this.persistToFile();
    }
    
    logger.info({ policy_id: this.currentPolicy.policy_id }, 'Policy updated and persisted');
    return this.currentPolicy;
  }

  private async persistToFile(): Promise<void> {
    try {
      const { writeFileSync } = await import('fs');
      writeFileSync(this.configPath, JSON.stringify(this.currentPolicy, null, 2));
    } catch (err) {
       logger.error({ err, path: this.configPath }, 'Failed to persist policy to file');
    }
  }
  
  isShadowMode(): boolean {
    // Config env var takes precedence, then policy file
    return config.shadowMode || this.currentPolicy.shadow_mode;
  }
  
  getPolicyId(): string {
    return this.currentPolicy.policy_id;
  }
  
  stop(): void {
    this.watchAbortController?.abort();
  }
}
