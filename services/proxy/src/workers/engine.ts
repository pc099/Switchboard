/**
 * Worker Engine
 * Executes custom agent logic in a secure sandbox
 */

import vm from 'vm';
import { logger } from '../utils/logger.js';

export interface WorkerContext {
  request: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body: any;
  };
  response?: {
    status: number;
    body: any;
    headers: Record<string, string>;
  };
  log: (message: string) => void;
  env: Record<string, string>;
}

export interface WorkerResult {
  modified: boolean;
  request?: WorkerContext['request'];
  response?: WorkerContext['response'];
  logs: string[];
  executionTimeMs: number;
  error?: string;
}

export class WorkerEngine {
  private timeoutMs: number;
  
  constructor(timeoutMs = 50) {
    this.timeoutMs = timeoutMs;
  }
  
  /**
   * Execute a worker script in a sandbox
   */
  async execute(
    scriptCode: string, 
    context: WorkerContext
  ): Promise<WorkerResult> {
    const startTime = performance.now();
    const logs: string[] = [];
    
    // Sandbox environment
    const sandbox = {
      // Input data
      ctx: JSON.parse(JSON.stringify(context)), // Deep copy to prevent outside mutation
      
      // Utilities
      console: {
        log: (...args: any[]) => logs.push(args.map(a => String(a)).join(' ')),
        error: (...args: any[]) => logs.push('ERROR: ' + args.map(a => String(a)).join(' ')),
      },
      
      // Output holder
      result: {
        modified: false,
        request: null,
        response: null,
      },
    };
    
    vm.createContext(sandbox);
    
    // wrapper to make user code execution cleaner
    // User code is expected to access 'ctx' and set 'result'
    const wrappedCode = `
      (function() {
        try {
          ${scriptCode}
        } catch (err) {
          throw err;
        }
      })();
    `;
    
    try {
      vm.runInContext(wrappedCode, sandbox, {
        timeout: this.timeoutMs,
        displayErrors: true,
      });
      
      return {
        modified: sandbox.result.modified,
        request: sandbox.result.request || undefined,
        response: sandbox.result.response || undefined,
        logs,
        executionTimeMs: Math.round(performance.now() - startTime),
      };
      
    } catch (err: any) {
      logger.error({ err, scriptCode: scriptCode.substring(0, 50) }, 'Worker execution failed');
      return {
        modified: false,
        logs,
        executionTimeMs: Math.round(performance.now() - startTime),
        error: err.message || 'Execution failed',
      };
    }
  }
}

// Export singleton
export const workerEngine = new WorkerEngine();
