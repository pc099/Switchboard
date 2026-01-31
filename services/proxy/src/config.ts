/**
 * Configuration management
 */

export const config = {
  // Server
  port: parseInt(process.env.PORT || '8080'),
  nodeEnv: process.env.NODE_ENV || 'development',
  
  // Database
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  timescaleUrl: process.env.TIMESCALE_URL || 'postgres://switchboard:password@localhost:5432/traces',
  
  // Upstream providers
  upstreams: {
    openai: process.env.UPSTREAM_OPENAI || 'https://api.openai.com',
    anthropic: process.env.UPSTREAM_ANTHROPIC || 'https://api.anthropic.com',
    google: process.env.UPSTREAM_GOOGLE || 'https://generativelanguage.googleapis.com',
  },
  
  // Firewall settings
  firewall: {
    maxLatencyMs: parseInt(process.env.FIREWALL_MAX_LATENCY_MS || '10'),
    blockDestructive: process.env.FIREWALL_BLOCK_DESTRUCTIVE !== 'false',
    blockPII: process.env.FIREWALL_BLOCK_PII !== 'false',
  },
  
  // Shadow Mode settings
  shadowMode: process.env.SHADOW_MODE === 'true',
  policiesConfigPath: process.env.POLICIES_CONFIG_PATH || './config/policies.json',
  
  // Traffic control
  traffic: {
    lockTtlSeconds: parseInt(process.env.LOCK_TTL_SECONDS || '30'),
    maxQueueDepth: parseInt(process.env.MAX_QUEUE_DEPTH || '5'),
  },
  
  // Emergency stop
  emergencyStopEnabled: process.env.EMERGENCY_STOP_ENABLED === 'true',
  
  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',
} as const;

