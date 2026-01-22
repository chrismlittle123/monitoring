# Observability Stack Specification

## Overview

This document specifies the observability stack for Palindrom web applications. The stack consists of two self-hosted tools:

| Tool | Purpose | Backend Database |
|------|---------|------------------|
| **SigNoz** | Logs, traces, metrics | ClickHouse |
| **GlitchTip** | Error tracking | PostgreSQL |

## What Each Tool Covers

```
                        BACKEND              FRONTEND
                        (Fastify)            (React)
                        ─────────            ───────

ERRORS (GlitchTip)        ✅                    ✅
                     throw new Error()     throw new Error()
                     uncaught exceptions   uncaught exceptions


LOGS (SigNoz)             ✅                   ⚠️ optional
                     logger.info()         (usually skip)
                     logger.error()


TRACES (SigNoz)           ✅                    ✅
                     API request timing    page load, API calls


METRICS (SigNoz)          ✅                    ✅
                     request count         web vitals
                     response times
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           WEB APPS                                   │
│                                                                      │
│  ┌─────────────────────────────┐  ┌─────────────────────────────┐   │
│  │     Fastify Backend         │  │       React Frontend        │   │
│  │                             │  │                             │   │
│  │  ┌───────────┐ ┌─────────┐  │  │  ┌───────────┐ ┌─────────┐  │   │
│  │  │ OTel SDK  │ │ Sentry  │  │  │  │ OTel SDK  │ │ Sentry  │  │   │
│  │  │           │ │ SDK     │  │  │  │ (optional)│ │ SDK     │  │   │
│  │  └─────┬─────┘ └────┬────┘  │  │  └─────┬─────┘ └────┬────┘  │   │
│  └────────┼────────────┼───────┘  └────────┼────────────┼───────┘   │
│           │            │                   │            │           │
└───────────┼────────────┼───────────────────┼────────────┼───────────┘
            │            │                   │            │
            │ OTLP       │ Sentry Protocol   │ OTLP       │ Sentry
            │ :4318      │ :8000             │ :4318      │ :8000
            ▼            ▼                   ▼            ▼
┌─────────────────────────────┐   ┌─────────────────────────────────┐
│          SigNoz             │   │          GlitchTip              │
│                             │   │                                 │
│  ┌───────────────────────┐  │   │  ┌───────────────────────────┐  │
│  │      ClickHouse       │  │   │  │       PostgreSQL          │  │
│  │  (logs, traces,       │  │   │  │  (errors, users,          │  │
│  │   metrics)            │  │   │  │   assignments)            │  │
│  └───────────────────────┘  │   │  └───────────────────────────┘  │
│                             │   │                                 │
│  UI: http://localhost:3301  │   │  UI: http://localhost:8000      │
└─────────────────────────────┘   └─────────────────────────────────┘
```

## Errors vs Logs: When to Use What

| Scenario | Tool | Why |
|----------|------|-----|
| Unhandled exception crashes the request | GlitchTip | Automatic capture with stack trace |
| Expected error (e.g., validation failed) | SigNoz (log) | Not a bug, just log it |
| Debugging "what happened before the crash" | SigNoz (logs + traces) | See the sequence of events |
| "How many users hit this bug?" | GlitchTip | Groups errors, counts affected users |
| "Is my API slow?" | SigNoz (traces + metrics) | See latency percentiles |

---

# Infrastructure

## Deployment Method

Docker Compose on a single server. Can migrate to Kubernetes later if needed.

## Services to Deploy

### SigNoz Stack

| Service | Purpose | Port |
|---------|---------|------|
| signoz-otel-collector | Receives telemetry from apps | 4317 (gRPC), 4318 (HTTP) |
| signoz-query-service | API for querying data | 8080 |
| signoz-frontend | Web UI | 3301 |
| clickhouse | Database | 9000 |
| zookeeper | ClickHouse coordination | 2181 |

### GlitchTip Stack

| Service | Purpose | Port |
|---------|---------|------|
| glitchtip-web | Web UI + API | 8000 |
| glitchtip-worker | Background job processing | - |
| postgresql | Database | 5432 |
| redis | Job queue | 6379 |

## Resource Requirements

| Component | CPU | Memory | Storage |
|-----------|-----|--------|---------|
| SigNoz (total) | 4 cores | 8-12 GB | 50-100 GB SSD |
| GlitchTip (total) | 1 core | 2 GB | 10 GB |
| **Total** | 5 cores | 10-14 GB | 60-110 GB |

Recommended: Single server with 8 cores, 16 GB RAM, 150 GB SSD.

## Docker Compose Files

TODO: Create `infra/docker-compose.signoz.yml` and `infra/docker-compose.glitchtip.yml`

---

# SDK Integration

## Backend (Fastify)

### Dependencies

```bash
npm install @opentelemetry/api \
  @opentelemetry/sdk-node \
  @opentelemetry/auto-instrumentations-node \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/exporter-logs-otlp-http \
  @sentry/node
```

### OpenTelemetry Setup (SigNoz)

```typescript
// src/instrumentation.ts
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';

const sdk = new NodeSDK({
  serviceName: process.env.SERVICE_NAME || 'api',
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces',
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();

process.on('SIGTERM', () => {
  sdk.shutdown().then(() => process.exit(0));
});
```

```typescript
// src/index.ts
import './instrumentation'; // Must be first import
import Fastify from 'fastify';

const app = Fastify({ logger: true });

// ... rest of your app
```

### Sentry Setup (GlitchTip)

```typescript
// src/sentry.ts
import * as Sentry from '@sentry/node';

Sentry.init({
  dsn: process.env.GLITCHTIP_DSN, // e.g., "http://key@localhost:8000/1"
  environment: process.env.NODE_ENV || 'development',
  tracesSampleRate: 1.0,
});

export { Sentry };
```

```typescript
// src/index.ts
import './instrumentation';
import './sentry';
import Fastify from 'fastify';
import { Sentry } from './sentry';

const app = Fastify({ logger: true });

// Error handler
app.setErrorHandler((error, request, reply) => {
  Sentry.captureException(error);
  reply.status(500).send({ error: 'Internal Server Error' });
});

// ... rest of your app
```

### Environment Variables (Backend)

```bash
# SigNoz
SERVICE_NAME=my-api
OTEL_EXPORTER_OTLP_ENDPOINT=http://signoz:4318

# GlitchTip
GLITCHTIP_DSN=http://key@glitchtip:8000/1
NODE_ENV=production
```

---

## Frontend (React)

### Dependencies

```bash
npm install @sentry/react
```

### Sentry Setup (GlitchTip)

```typescript
// src/sentry.ts
import * as Sentry from '@sentry/react';

Sentry.init({
  dsn: import.meta.env.VITE_GLITCHTIP_DSN,
  environment: import.meta.env.MODE,
  integrations: [
    Sentry.browserTracingIntegration(),
  ],
  tracesSampleRate: 1.0,
});

export { Sentry };
```

```typescript
// src/main.tsx
import './sentry';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

### Error Boundary

```tsx
// src/components/ErrorBoundary.tsx
import * as Sentry from '@sentry/react';

export const ErrorBoundary = Sentry.ErrorBoundary;

// Usage in App.tsx
import { ErrorBoundary } from './components/ErrorBoundary';

function App() {
  return (
    <ErrorBoundary fallback={<p>Something went wrong</p>}>
      <MyApp />
    </ErrorBoundary>
  );
}
```

### Environment Variables (Frontend)

```bash
# .env
VITE_GLITCHTIP_DSN=http://key@glitchtip.yourdomain.com/1
```

---

## Frontend Traces (Optional)

Only add if you need frontend performance tracing (page loads, API call timing).

```bash
npm install @opentelemetry/api \
  @opentelemetry/sdk-trace-web \
  @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/instrumentation-fetch \
  @opentelemetry/instrumentation-document-load
```

```typescript
// src/tracing.ts
import { WebTracerProvider } from '@opentelemetry/sdk-trace-web';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch';
import { DocumentLoadInstrumentation } from '@opentelemetry/instrumentation-document-load';

const provider = new WebTracerProvider();

provider.addSpanProcessor(
  new BatchSpanProcessor(
    new OTLPTraceExporter({
      url: import.meta.env.VITE_OTEL_ENDPOINT || 'http://localhost:4318/v1/traces',
    })
  )
);

provider.register();

registerInstrumentations({
  instrumentations: [
    new FetchInstrumentation(),
    new DocumentLoadInstrumentation(),
  ],
});
```

---

# Summary

## What Gets Captured

| Signal | Backend | Frontend | Destination |
|--------|---------|----------|-------------|
| Errors (exceptions) | Automatic | Automatic | GlitchTip |
| Logs | Automatic (Fastify logger) | Skip | SigNoz |
| Traces | Automatic (HTTP, DB) | Optional | SigNoz |
| Metrics | Automatic | Optional | SigNoz |

## URLs (Local Development)

| Service | URL |
|---------|-----|
| SigNoz UI | http://localhost:3301 |
| GlitchTip UI | http://localhost:8000 |
| OTLP HTTP endpoint | http://localhost:4318 |
| OTLP gRPC endpoint | http://localhost:4317 |

## Next Steps

1. [ ] Set up infrastructure (Docker Compose files)
2. [ ] Deploy SigNoz locally
3. [ ] Deploy GlitchTip locally
4. [ ] Integrate SDK into one backend service
5. [ ] Integrate SDK into one frontend app
6. [ ] Verify data flows to both dashboards
7. [ ] Document production deployment
