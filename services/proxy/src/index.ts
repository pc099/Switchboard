/**
 * AgentSwitchboard - Zero-SDK Proxy
 * Main entry point
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { proxyRouter } from './routes/proxy.js';
import { apiRouter } from './routes/api.js';
import { SemanticFirewall } from './firewall/index.js';
import { PolicyLoader } from './firewall/policyLoader.js';
import { FlightRecorder } from './recorder/index.js';
import { TrafficController } from './traffic/index.js';
import { RedisClient } from './db/redis.js';
import { PostgresClient } from './db/postgres.js';
import { WebSocketManager } from './ws/manager.js';
import { SemanticCache } from './cache/semanticCache.js';
import { initializeEmbeddings } from './cache/embeddings.js';
import { RadarDetector } from './radar/detector.js';

async function main() {
  // Initialize services
  logger.info('Starting AgentSwitchboard Proxy...');
  
  // Database connections
  const redis = new RedisClient(config.redisUrl);
  const postgres = new PostgresClient(config.timescaleUrl);
  
  await redis.connect();
  await postgres.connect();
  
  // Policy loader
  const policyLoader = new PolicyLoader(redis);
  await policyLoader.initialize();
  
  // Initialize embedding model for semantic cache (may take 2-5s on first load)
  logger.info('Initializing embedding model...');
  await initializeEmbeddings();
  
  // Core services
  const firewall = new SemanticFirewall(redis, policyLoader);
  const recorder = new FlightRecorder(postgres);
  const trafficController = new TrafficController(redis);
  const semanticCache = new SemanticCache(postgres, redis);
  
  // Express app
  const app = express();
  const server = createServer(app);
  
  // WebSocket for real-time dashboard
  const wss = new WebSocketServer({ server, path: '/ws' });
  const wsManager = new WebSocketManager(wss);

  // Agentic Radar
  const radar = new RadarDetector(postgres, wsManager);
  radar.start();
  
  // Middleware
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cors());
  app.use(compression());
  app.use(express.json({ limit: '10mb' }));
  
  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
  });
  
  // Internal API routes
  app.use('/api', apiRouter(postgres, redis, wsManager, trafficController, policyLoader));
  
  // Proxy routes (matches OpenAI/Anthropic API structure)
  app.use('/v1', proxyRouter(firewall, recorder, trafficController, wsManager, semanticCache));
  
  // Error handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, 'Unhandled error');
    res.status(500).json({ error: { message: 'Internal server error' } });
  });
  
  // Start server
  server.listen(config.port, () => {
    logger.info(`Proxy listening on port ${config.port}`);
    logger.info(`Dashboard API: http://localhost:${config.port}/api`);
    logger.info(`Proxy endpoint: http://localhost:${config.port}/v1`);
  });
  
  // Graceful shutdown
  process.on('SIGTERM', async () => {
    logger.info('Shutting down...');
    await redis.disconnect();
    await postgres.disconnect();
    server.close();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start proxy');
  process.exit(1);
});
