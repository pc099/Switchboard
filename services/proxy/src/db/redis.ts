/**
 * Redis client wrapper
 */

import Redis from 'ioredis';
import { logger } from '../utils/logger.js';

export class RedisClient {
  private client: Redis;
  
  constructor(url: string) {
    this.client = new Redis(url, {
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => Math.min(times * 50, 2000),
    });
  }
  
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.client.on('connect', () => {
        logger.info('Connected to Redis');
        resolve();
      });
      this.client.on('error', (err) => {
        logger.error({ err }, 'Redis error');
        reject(err);
      });
    });
  }
  
  async disconnect(): Promise<void> {
    await this.client.quit();
  }
  
  // Token/policy cache operations
  async getOrg(token: string): Promise<any | null> {
    const data = await this.client.get(`org:token:${token}`);
    return data ? JSON.parse(data) : null;
  }
  
  async setOrg(token: string, org: any, ttl = 300): Promise<void> {
    await this.client.setex(`org:token:${token}`, ttl, JSON.stringify(org));
  }
  
  // Policy cache
  async getPolicy(orgId: string): Promise<any | null> {
    const data = await this.client.get(`policy:${orgId}`);
    return data ? JSON.parse(data) : null;
  }
  
  async setPolicy(orgId: string, policy: any, ttl = 60): Promise<void> {
    await this.client.setex(`policy:${orgId}`, ttl, JSON.stringify(policy));
  }
  
  // Distributed locking for traffic control
  async acquireLock(resourceHash: string, agentId: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.client.set(
      `lock:${resourceHash}`,
      JSON.stringify({ agentId, acquiredAt: Date.now() }),
      'EX',
      ttlSeconds,
      'NX'
    );
    return result === 'OK';
  }
  
  async releaseLock(resourceHash: string, agentId: string): Promise<boolean> {
    const data = await this.client.get(`lock:${resourceHash}`);
    if (!data) return true;
    
    const lock = JSON.parse(data);
    if (lock.agentId !== agentId) return false;
    
    await this.client.del(`lock:${resourceHash}`);
    return true;
  }
  
  async getLock(resourceHash: string): Promise<any | null> {
    const data = await this.client.get(`lock:${resourceHash}`);
    return data ? JSON.parse(data) : null;
  }
  
  // Rate limiting
  async checkRateLimit(agentId: string, limit: number, windowSeconds = 60): Promise<{ allowed: boolean; remaining: number }> {
    const key = `rate:${agentId}:${Math.floor(Date.now() / (windowSeconds * 1000))}`;
    const current = await this.client.incr(key);
    
    if (current === 1) {
      await this.client.expire(key, windowSeconds);
    }
    
    return { allowed: current <= limit, remaining: Math.max(0, limit - current) };
  }
  
  // Burn rate tracking
  async trackCost(orgId: string, agentId: string, cost: number): Promise<void> {
    const now = Date.now();
    const minuteKey = `cost:minute:${orgId}:${Math.floor(now / 60000)}`;
    const hourKey = `cost:hour:${orgId}:${Math.floor(now / 3600000)}`;
    
    const multi = this.client.multi();
    multi.incrbyfloat(minuteKey, cost);
    multi.expire(minuteKey, 120);
    multi.incrbyfloat(hourKey, cost);
    multi.expire(hourKey, 7200);
    multi.incrbyfloat(`cost:agent:${agentId}:${Math.floor(now / 60000)}`, cost);
    await multi.exec();
  }
  
  async getBurnRate(orgId: string): Promise<number> {
    const key = `cost:minute:${orgId}:${Math.floor(Date.now() / 60000)}`;
    const cost = await this.client.get(key);
    return cost ? parseFloat(cost) : 0;
  }
  
  // Pub/Sub for real-time events
  async publish(channel: string, message: any): Promise<void> {
    await this.client.publish(channel, JSON.stringify(message));
  }
  
  subscribe(channel: string, handler: (message: any) => void): void {
    const sub = this.client.duplicate();
    sub.subscribe(channel);
    sub.on('message', (_ch, msg) => handler(JSON.parse(msg)));
  }
}
