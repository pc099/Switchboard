import { useState, useEffect, useCallback } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

// Types
interface Agent {
  agent_id: string;
  name: string;
  status: 'active' | 'warning' | 'paused' | 'revoked';
  framework?: string;
  cost_per_minute?: number;
}

interface Anomaly {
  anomaly_id: string;
  agent_id: string;
  type: string;
  severity: 'warning' | 'critical';
  details: {
    repeat_count?: number;
    time_window?: string;
    cost?: number;
  };
  detected_at: string;
}

interface Trace {
  trace_id: string;
  agent_id: string;
  action_taken: string;
  intent_category?: string;
  timestamp: string;
}

interface BurnRateData {
  currentRate: number;
  hourlyProjection: number;
  history: { minute: string; cost: number }[];
}

const API_URL = '/api';
const WS_URL = `ws://${window.location.host}/ws`;
const ORG_ID = 'org_demo';

export default function App() {
  // State
  const [burnRate, setBurnRate] = useState<BurnRateData>({ currentRate: 0, hourlyProjection: 0, history: [] });
  const [agents, setAgents] = useState<Agent[]>([]);
  const [anomalies, setAnomalies] = useState<Anomaly[]>([]);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [globalPaused, setGlobalPaused] = useState(false);
  const [wsConnected, setWsConnected] = useState(false);

  // Fetch initial data
  const fetchData = useCallback(async () => {
    try {
      const [burnRes, agentsRes, anomaliesRes, tracesRes] = await Promise.all([
        fetch(`${API_URL}/burn-rate/${ORG_ID}`),
        fetch(`${API_URL}/agents/${ORG_ID}`),
        fetch(`${API_URL}/anomalies/${ORG_ID}`),
        fetch(`${API_URL}/traces/${ORG_ID}?limit=20`),
      ]);

      if (burnRes.ok) setBurnRate(await burnRes.json());
      if (agentsRes.ok) setAgents(await agentsRes.json());
      if (anomaliesRes.ok) setAnomalies(await anomaliesRes.json());
      if (tracesRes.ok) setTraces(await tracesRes.json());
    } catch (err) {
      console.error('Failed to fetch data:', err);
    }
  }, []);

  // WebSocket connection
  useEffect(() => {
    let ws: WebSocket;
    let reconnectTimeout: ReturnType<typeof setTimeout>;

    const connect = () => {
      ws = new WebSocket(WS_URL);

      ws.onopen = () => {
        setWsConnected(true);
        ws.send(JSON.stringify({ action: 'subscribe', orgId: ORG_ID }));
      };

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        switch (data.type) {
          case 'burn_rate':
            setBurnRate(prev => ({ ...prev, currentRate: data.payload.currentRate }));
            break;
          case 'agent_status':
            setAgents(prev => prev.map(a => 
              a.agent_id === data.payload.agentId 
                ? { ...a, status: data.payload.status }
                : a
            ));
            break;
          case 'anomaly_detected':
            setAnomalies(prev => [data.payload, ...prev]);
            break;
          case 'global_pause_status':
            setGlobalPaused(data.payload.paused);
            break;
        }
      };

      ws.onclose = () => {
        setWsConnected(false);
        reconnectTimeout = setTimeout(connect, 3000);
      };
    };

    connect();
    fetchData();

    // Refresh data every 30 seconds
    const interval = setInterval(fetchData, 30000);

    return () => {
      ws?.close();
      clearTimeout(reconnectTimeout);
      clearInterval(interval);
    };
  }, [fetchData]);

  // Actions
  const handlePauseAll = async () => {
    if (!confirm('Are you sure you want to pause ALL agents?')) return;
    
    await fetch(`${API_URL}/control/pause-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: ORG_ID }),
    });
    setGlobalPaused(true);
  };

  const handleResumeAll = async () => {
    await fetch(`${API_URL}/control/resume-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: ORG_ID }),
    });
    setGlobalPaused(false);
  };

  const handleAgentAction = async (agentId: string, action: 'pause' | 'resume' | 'revoke') => {
    const endpoint = action === 'revoke' ? 'revoke-token' : `${action}-agent`;
    await fetch(`${API_URL}/control/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId }),
    });
    fetchData();
  };

  const handleResolveAnomaly = async (anomalyId: string) => {
    await fetch(`${API_URL}/anomalies/${anomalyId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resolvedBy: 'dashboard' }),
    });
    setAnomalies(prev => prev.filter(a => a.anomaly_id !== anomalyId));
  };

  // Computed values
  const activeAgents = agents.filter(a => a.status === 'active').length;
  const blockedToday = traces.filter(t => t.action_taken === 'blocked').length;
  const avgLatency = 6.2; // Would come from metrics

  return (
    <div className="app">
      {/* Header */}
      <header className="header">
        <div className="logo">
          <div className="logo-icon">⚡</div>
          AgentSwitchboard
        </div>
        
        <div className="kill-switch">
          <span className={`status-badge ${wsConnected ? 'connected' : 'disconnected'}`}>
            {wsConnected ? '● Connected' : '○ Disconnected'}
          </span>
          
          {globalPaused ? (
            <button className="btn btn-primary btn-lg" onClick={handleResumeAll}>
              ▶ Resume All Agents
            </button>
          ) : (
            <button className="btn btn-danger btn-lg kill-switch-btn" onClick={handlePauseAll}>
              ⏸ PAUSE ALL AGENTS
            </button>
          )}
        </div>
      </header>

      <main className="main">
        {/* Metrics Grid */}
        <div className="metrics-grid">
          <MetricCard
            title="Burn Rate"
            value={`$${burnRate.currentRate.toFixed(2)}`}
            subtitle="per minute"
            trend={burnRate.currentRate > 1 ? 'up' : 'stable'}
            trendValue={`$${burnRate.hourlyProjection.toFixed(2)}/hr projected`}
            color={burnRate.currentRate > 5 ? 'danger' : burnRate.currentRate > 2 ? 'warning' : 'success'}
          />
          
          <MetricCard
            title="Active Agents"
            value={String(activeAgents)}
            subtitle={`of ${agents.length} total`}
            color="success"
          />
          
          <MetricCard
            title="Blocked Today"
            value={String(blockedToday)}
            subtitle="requests blocked"
            color={blockedToday > 10 ? 'warning' : 'success'}
          />
          
          <MetricCard
            title="Avg Latency"
            value={`${avgLatency}ms`}
            subtitle="firewall overhead"
            color={avgLatency < 10 ? 'success' : 'warning'}
          />
        </div>

        <div className="content-grid">
          {/* Left column */}
          <div>
            {/* Burn Rate Chart */}
            <div className="card" style={{ marginBottom: 'var(--space-xl)' }}>
              <div className="card-header">
                <span className="card-title">Cost Over Time</span>
              </div>
              <div style={{ height: 200 }}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={burnRate.history.slice(-30)}>
                    <XAxis dataKey="minute" tick={{ fill: '#9090a0', fontSize: 10 }} />
                    <YAxis tick={{ fill: '#9090a0', fontSize: 10 }} />
                    <Tooltip
                      contentStyle={{ background: '#1a1a24', border: '1px solid #2a2a3a' }}
                      labelStyle={{ color: '#f0f0f5' }}
                    />
                    <Line
                      type="monotone"
                      dataKey="cost"
                      stroke="#6366f1"
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Agent Fleet */}
            <div className="card">
              <div className="card-header">
                <span className="card-title">Agent Fleet</span>
              </div>
              <div className="agent-list">
                {agents.length === 0 ? (
                  <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 'var(--space-lg)' }}>
                    No agents registered yet
                  </div>
                ) : (
                  agents.map(agent => (
                    <div key={agent.agent_id} className="agent-item">
                      <div className="agent-info">
                        <div className={`agent-status ${agent.status}`} />
                        <div>
                          <div className="agent-name">{agent.name || agent.agent_id}</div>
                          <div className="agent-meta">
                            {agent.framework || 'Unknown'} • {agent.status}
                          </div>
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-md)' }}>
                        <span className="agent-cost">
                          ${(agent.cost_per_minute || 0).toFixed(2)}/min
                        </span>
                        {agent.status === 'active' ? (
                          <button
                            className="btn btn-outline btn-sm"
                            onClick={() => handleAgentAction(agent.agent_id, 'pause')}
                          >
                            Pause
                          </button>
                        ) : agent.status === 'paused' ? (
                          <button
                            className="btn btn-primary btn-sm"
                            onClick={() => handleAgentAction(agent.agent_id, 'resume')}
                          >
                            Resume
                          </button>
                        ) : null}
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => handleAgentAction(agent.agent_id, 'revoke')}
                        >
                          Revoke
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>

          {/* Right column - Anomalies */}
          <div className="card anomaly-panel">
            <div className="card-header">
              <span className="card-title">🚨 Anomalies</span>
              <span style={{ fontSize: '0.875rem', color: 'var(--danger)' }}>
                {anomalies.length} active
              </span>
            </div>
            
            {anomalies.length === 0 ? (
              <div style={{ color: 'var(--text-muted)', textAlign: 'center', padding: 'var(--space-xl)' }}>
                ✓ No anomalies detected
              </div>
            ) : (
              anomalies.map(anomaly => (
                <div key={anomaly.anomaly_id} className="anomaly-item">
                  <div className="anomaly-header">
                    <span className="anomaly-icon">⚠️</span>
                    <span className="anomaly-type">
                      {anomaly.type.replace('_', ' ')}
                    </span>
                  </div>
                  <div className="anomaly-agent">
                    Agent: {anomaly.agent_id}
                  </div>
                  <div className="anomaly-detail">
                    {anomaly.details.repeat_count && (
                      <>{anomaly.details.repeat_count} identical calls in {anomaly.details.time_window}</>
                    )}
                    {anomaly.details.cost && (
                      <>${anomaly.details.cost.toFixed(2)} in 5 minutes</>
                    )}
                  </div>
                  <div style={{ marginTop: 'var(--space-sm)', display: 'flex', gap: 'var(--space-sm)' }}>
                    <button className="btn btn-danger btn-sm">Kill Now</button>
                    <button
                      className="btn btn-outline btn-sm"
                      onClick={() => handleResolveAnomaly(anomaly.anomaly_id)}
                    >
                      Dismiss
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Activity Timeline */}
        <div className="card" style={{ marginTop: 'var(--space-xl)' }}>
          <div className="card-header">
            <span className="card-title">Activity Timeline</span>
          </div>
          <div className="timeline">
            {traces.slice(0, 10).map(trace => (
              <div key={trace.trace_id} className="timeline-item">
                <span className="timeline-time">
                  {new Date(trace.timestamp).toLocaleTimeString()}
                </span>
                <span className="timeline-content">
                  <strong>{trace.agent_id}</strong>
                  {' → '}
                  {trace.intent_category || 'api_call'}
                </span>
                <span className={`timeline-action ${trace.action_taken}`}>
                  {trace.action_taken}
                </span>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}

// Metric Card Component
function MetricCard({
  title,
  value,
  subtitle,
  trend,
  trendValue,
  color = 'success',
}: {
  title: string;
  value: string;
  subtitle: string;
  trend?: 'up' | 'down' | 'stable';
  trendValue?: string;
  color?: 'success' | 'warning' | 'danger';
}) {
  return (
    <div className="card metric-card">
      <div className="card-title">{title}</div>
      <div className={`metric-value ${color}`}>{value}</div>
      <div className="metric-label">{subtitle}</div>
      {trend && trendValue && (
        <div className={`metric-trend ${trend}`}>
          {trend === 'up' ? '↑' : trend === 'down' ? '↓' : '→'} {trendValue}
        </div>
      )}
    </div>
  );
}
