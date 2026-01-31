/**
 * Worker Registry
 * Manages available worker scripts
 */

import { logger } from '../utils/logger.js';

export interface WorkerScript {
  id: string;
  name: string;
  trigger: 'pre_request' | 'post_response';
  code: string;
  enabled: boolean;
  order: number;
}

// Default workers
const DEFAULT_WORKERS: WorkerScript[] = [
  {
    id: 'pii-redactor',
    name: 'Custom PII Redactor',
    trigger: 'pre_request',
    enabled: false,
    order: 10,
    code: `
      // Example: Redact email addresses in prompt
      if (ctx.request.body && ctx.request.body.messages) {
        const str = JSON.stringify(ctx.request.body);
        if (str.includes('@')) {
          const redacted = str.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}/g, '[EMAIL_REDACTED]');
          ctx.request.body = JSON.parse(redacted);
          result.modified = true;
          result.request = ctx.request;
          console.log('Redacted PII from request');
        }
      }
    `
  },
  {
    id: 'header-injector',
    name: 'Inject Trace Header',
    trigger: 'pre_request',
    enabled: true,
    order: 20,
    code: `
      // Add a custom header to upstream request
      ctx.request.headers['x-processed-by'] = 'switchboard-worker';
      result.modified = true;
      result.request = ctx.request;
    `
  }
];

export class WorkerRegistry {
  private workers: Map<string, WorkerScript> = new Map();
  
  constructor() {
    // Load defaults
    DEFAULT_WORKERS.forEach(w => this.workers.set(w.id, w));
    logger.info({ count: this.workers.size }, 'Worker registry initialized');
  }
  
  /**
   * Get active workers for a specific phase
   */
  getWorkers(trigger: 'pre_request' | 'post_response'): WorkerScript[] {
    return Array.from(this.workers.values())
      .filter(w => w.enabled && w.trigger === trigger)
      .sort((a, b) => a.order - b.order);
  }
  
  /**
   * Add or update a worker
   */
  register(worker: WorkerScript): void {
    this.workers.set(worker.id, worker);
    logger.info({ id: worker.id, name: worker.name }, 'Worker registered');
  }
  
  /**
   * Get all workers
   */
  getAll(): WorkerScript[] {
    return Array.from(this.workers.values());
  }
}

export const workerRegistry = new WorkerRegistry();
