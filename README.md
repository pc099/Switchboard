# AgentSwitchboard - Zero-SDK Proxy

> **Anti-Gravity**: Making agent deployment frictionless by removing the "weight" of security and cost concerns.

## 🚀 Quick Start

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f proxy

# Open Mission Control Dashboard
open http://localhost:3000
```

## One-Line Integration

Change your `base_url` — that's it:

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-your-key",
    base_url="http://localhost:8080/v1",  # ← One line change
    default_headers={"X-Switchboard-Token": "demo_token_abc123"}
)

response = client.chat.completions.create(
    model="gpt-4",
    messages=[{"role": "user", "content": "Hello!"}]
)
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Your AI Agents                           │
│         (Python, TypeScript, Mojo - any framework)          │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                 AgentSwitchboard Proxy                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  Semantic   │  │   Traffic   │  │   Flight Recorder   │  │
│  │  Firewall   │  │  Controller │  │     (Traces)        │  │
│  │  (< 10ms)   │  │  (Locking)  │  │                     │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│               Upstream AI Providers                          │
│         (OpenAI, Anthropic, Google, Azure)                  │
└─────────────────────────────────────────────────────────────┘
```

## Features

### 🛡️ Semantic Firewall
- Real-time intent classification (< 10ms latency)
- PII detection via Bloom filters
- Dangerous pattern blocking (SQL injection, shell commands)
- Customizable policies per organization

### ✈️ Flight Recorder
- Full request/response logging
- Reasoning chain capture
- Tool call tracking
- Cost calculation

### 🚦 Traffic Controller
- Multi-agent conflict resolution
- Distributed locking via Redis
- Priority-based queuing

### 📊 Mission Control Dashboard
- Real-time burn rate monitoring
- Agent fleet management
- Anomaly detection
- Global kill switch

## Services

| Service | Port | Description |
|---------|------|-------------|
| `proxy` | 8080 | Main proxy service |
| `dashboard` | 3000 | Mission Control UI |
| `redis` | 6379 | Cache & locking |
| `timescaledb` | 5432 | Trace storage |

## Development

```bash
# Install dependencies
npm install

# Run proxy in dev mode
cd services/proxy && npm run dev

# Run dashboard in dev mode
cd services/dashboard && npm run dev

# Run tests
npm test
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 8080 | Proxy port |
| `REDIS_URL` | redis://localhost:6379 | Redis connection |
| `TIMESCALE_URL` | postgres://... | TimescaleDB connection |
| `UPSTREAM_OPENAI` | https://api.openai.com | OpenAI upstream |

## API Endpoints

### Proxy (mirrors OpenAI API)
- `POST /v1/chat/completions`
- `POST /v1/embeddings`
- `GET /v1/models`

### Internal API
- `GET /api/burn-rate/:orgId`
- `GET /api/agents/:orgId`
- `GET /api/traces/:orgId`
- `POST /api/control/pause-all`
- `POST /api/control/pause-agent`
- `POST /api/control/revoke-token`

## License

MIT
