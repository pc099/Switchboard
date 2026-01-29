/**
 * WebSocket Manager
 * Real-time event broadcasting to Mission Control dashboard
 */

import { WebSocketServer, WebSocket } from 'ws';
import { logger } from '../utils/logger.js';

export type EventType = 
  | 'agent_status'
  | 'burn_rate'
  | 'anomaly_detected'
  | 'trace_event'
  | 'global_pause_status'
  | 'agent_blocked';

export interface WSEvent {
  type: EventType;
  payload: any;
  timestamp: string;
}

interface Client {
  ws: WebSocket;
  orgId?: string;
  subscriptions: Set<EventType>;
}

export class WebSocketManager {
  private clients: Map<string, Client> = new Map();
  private wss: WebSocketServer;
  
  constructor(wss: WebSocketServer) {
    this.wss = wss;
    this.setupServer();
    
    logger.info('WebSocket Manager initialized');
  }
  
  private setupServer(): void {
    this.wss.on('connection', (ws, req) => {
      const clientId = crypto.randomUUID();
      const client: Client = {
        ws,
        subscriptions: new Set(['agent_status', 'burn_rate', 'anomaly_detected']),
      };
      
      this.clients.set(clientId, client);
      logger.debug({ clientId }, 'WebSocket client connected');
      
      ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this.handleMessage(clientId, message);
        } catch (err) {
          logger.error({ err }, 'Invalid WebSocket message');
        }
      });
      
      ws.on('close', () => {
        this.clients.delete(clientId);
        logger.debug({ clientId }, 'WebSocket client disconnected');
      });
      
      // Send initial connection acknowledgment
      this.send(ws, {
        type: 'agent_status',
        payload: { connected: true, clientId },
        timestamp: new Date().toISOString(),
      });
    });
  }
  
  private handleMessage(clientId: string, message: any): void {
    const client = this.clients.get(clientId);
    if (!client) return;
    
    switch (message.action) {
      case 'subscribe':
        if (message.events) {
          message.events.forEach((e: EventType) => client.subscriptions.add(e));
        }
        if (message.orgId) {
          client.orgId = message.orgId;
        }
        break;
        
      case 'unsubscribe':
        if (message.events) {
          message.events.forEach((e: EventType) => client.subscriptions.delete(e));
        }
        break;
    }
  }
  
  /**
   * Broadcast event to all subscribed clients
   */
  broadcast(event: WSEvent, orgId?: string): void {
    this.clients.forEach((client) => {
      // Filter by org if specified
      if (orgId && client.orgId && client.orgId !== orgId) return;
      
      // Filter by subscription
      if (!client.subscriptions.has(event.type)) return;
      
      this.send(client.ws, event);
    });
  }
  
  /**
   * Broadcast burn rate update
   */
  broadcastBurnRate(orgId: string, data: { currentRate: number; hourlyProjection: number }): void {
    this.broadcast({
      type: 'burn_rate',
      payload: { orgId, ...data },
      timestamp: new Date().toISOString(),
    }, orgId);
  }
  
  /**
   * Broadcast agent status change
   */
  broadcastAgentStatus(agentId: string, status: string, metadata?: any): void {
    this.broadcast({
      type: 'agent_status',
      payload: { agentId, status, ...metadata },
      timestamp: new Date().toISOString(),
    });
  }
  
  /**
   * Broadcast anomaly detection
   */
  broadcastAnomaly(orgId: string, anomaly: any): void {
    this.broadcast({
      type: 'anomaly_detected',
      payload: anomaly,
      timestamp: new Date().toISOString(),
    }, orgId);
  }
  
  /**
   * Broadcast blocked request
   */
  broadcastBlocked(orgId: string, agentId: string, reason: string): void {
    this.broadcast({
      type: 'agent_blocked',
      payload: { agentId, reason },
      timestamp: new Date().toISOString(),
    }, orgId);
  }
  
  private send(ws: WebSocket, event: WSEvent): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(event));
    }
  }
}
