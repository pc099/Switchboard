/**
 * Traffic Controller
 * Multi-agent conflict resolution with distributed locking
 */

import crypto from 'crypto';
import { RedisClient } from '../db/redis.js';
import { logger } from '../utils/logger.js';
import { config } from '../config.js';

export type ConflictResolution = 'granted' | 'queued' | 'rejected';

export interface ResourceLock {
  resourceHash: string;
  resourceType: string;
  resourcePath: string;
  holderAgentId: string;
  acquiredAt: number;
  ttl: number;
}

export interface ConflictResult {
  resolution: ConflictResolution;
  lock?: ResourceLock;
  waitMs?: number;
  reason?: string;
}

export class TrafficController {
  private redis: RedisClient;
  private lockTtl: number;
  private maxQueueDepth: number;
  
  constructor(redis: RedisClient) {
    this.redis = redis;
    this.lockTtl = config.traffic.lockTtlSeconds;
    this.maxQueueDepth = config.traffic.maxQueueDepth;
    
    logger.info('Traffic Controller initialized');
  }

  // Emergency Stop Controls
  private emergencyStopped = false;

  triggerEmergencyStop(): void {
    this.emergencyStopped = true;
    logger.warn('TRAFFIC CONTROLLER: Emergency stop triggered');
  }

  resetEmergencyStop(): void {
    this.emergencyStopped = false;
    logger.info('TRAFFIC CONTROLLER: Emergency stop reset');
  }

  isEmergencyStopped(): boolean {
    return this.emergencyStopped;
  }
  
  /**
   * Attempt to acquire access to a resource
   */
  async requestAccess(
    agentId: string,
    resourceType: string,
    resourcePath: string,
    isWrite: boolean
  ): Promise<ConflictResult> {
    const resourceHash = this.hashResource(resourceType, resourcePath);
    
    // Check existing lock
    const existingLock = await this.redis.getLock(resourceHash);
    
    if (!existingLock) {
      // No conflict - acquire lock for writes
      if (isWrite) {
        const acquired = await this.redis.acquireLock(resourceHash, agentId, this.lockTtl);
        if (acquired) {
          return {
            resolution: 'granted',
            lock: {
              resourceHash,
              resourceType,
              resourcePath,
              holderAgentId: agentId,
              acquiredAt: Date.now(),
              ttl: this.lockTtl,
            },
          };
        }
      }
      return { resolution: 'granted' };
    }
    
    // Lock exists - determine resolution
    return this.resolveConflict(agentId, resourceHash, existingLock, isWrite);
  }
  
  /**
   * Release a resource lock
   */
  async releaseAccess(agentId: string, resourceType: string, resourcePath: string): Promise<boolean> {
    const resourceHash = this.hashResource(resourceType, resourcePath);
    return this.redis.releaseLock(resourceHash, agentId);
  }
  
  /**
   * Extract resource identifier from request
   */
  extractResource(body: any): { type: string; path: string } | null {
    try {
      // Look for common resource patterns in the request
      const content = JSON.stringify(body).toLowerCase();
      
      // Database operations
      const tableMatch = content.match(/(?:from|into|update|delete\s+from)\s+["']?(\w+)["']?/i);
      if (tableMatch) {
        return { type: 'database_table', path: tableMatch[1] };
      }
      
      // File operations
      const fileMatch = content.match(/(?:file|path)["']?\s*[:=]\s*["']([^"']+)["']/i);
      if (fileMatch) {
        return { type: 'file', path: fileMatch[1] };
      }
      
      // API endpoints
      const urlMatch = content.match(/(?:url|endpoint)["']?\s*[:=]\s*["']([^"']+)["']/i);
      if (urlMatch) {
        return { type: 'api_endpoint', path: urlMatch[1] };
      }
      
      return null;
    } catch {
      return null;
    }
  }
  
  /**
   * Check if operation is a write
   */
  isWriteOperation(body: any, method: string): boolean {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) {
      return true;
    }
    
    const content = JSON.stringify(body).toLowerCase();
    const writeKeywords = ['insert', 'update', 'delete', 'create', 'drop', 'modify', 'write', 'save'];
    return writeKeywords.some(kw => content.includes(kw));
  }
  
  private async resolveConflict(
    agentId: string,
    resourceHash: string,
    existingLock: any,
    isWrite: boolean
  ): Promise<ConflictResult> {
    // Same agent - extend lock
    if (existingLock.agentId === agentId) {
      return { resolution: 'granted' };
    }
    
    // Read operation during write lock - allow with stale data warning
    if (!isWrite) {
      return {
        resolution: 'granted',
        reason: 'Read allowed during write lock (may see stale data)',
      };
    }
    
    // Write-write conflict - queue or reject
    const lockAge = Date.now() - existingLock.acquiredAt;
    const remainingTtl = (this.lockTtl * 1000) - lockAge;
    
    if (remainingTtl > 0 && remainingTtl < 5000) {
      // Lock expires soon - queue the request
      return {
        resolution: 'queued',
        waitMs: remainingTtl + 100,
        reason: `Resource locked by ${existingLock.agentId}, expires in ${remainingTtl}ms`,
      };
    }
    
    // Long-held lock - reject
    return {
      resolution: 'rejected',
      reason: `Resource locked by ${existingLock.agentId}`,
    };
  }
  
  private hashResource(type: string, path: string): string {
    return crypto
      .createHash('sha256')
      .update(`${type}:${path}`)
      .digest('hex')
      .substring(0, 16);
  }
}
