# Observability Stack Specification

## Overview

This document specifies the observability stack for Progression Labs web applications. The stack consists of two self-hosted tools:

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


LOGS (SigNoz)             ✅                    ❌ skip
                     logger.info()
                     logger.error()


TRACES (SigNoz)           ✅                    ❌ skip
                     API request timing


METRICS (SigNoz)          ✅                    ❌ skip
                     request count
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
│  │  ┌───────────┐ ┌─────────┐  │  │            ┌─────────┐      │   │
│  │  │ OTel SDK  │ │ Sentry  │  │  │            │ Sentry  │      │   │
│  │  │           │ │ SDK     │  │  │            │ SDK     │      │   │
│  │  └─────┬─────┘ └────┬────┘  │  │            └────┬────┘      │   │
│  └────────┼────────────┼───────┘  └─────────────────┼───────────┘   │
│           │            │                            │               │
└───────────┼────────────┼────────────────────────────┼───────────────┘
            │            │                            │
            │ OTLP       │ Sentry Protocol            │ Sentry
            │ :4318      │                            │
            ▼            ▼                            ▼
┌─────────────────────────────┐   ┌─────────────────────────────────┐
│          SigNoz             │   │          GlitchTip              │
│       (ECS Fargate)         │   │       (ECS Fargate)             │
│                             │   │                                 │
│  ┌───────────────────────┐  │   │  ┌───────────────────────────┐  │
│  │   ClickHouse (EBS)    │  │   │  │   RDS PostgreSQL          │  │
│  │  (logs, traces,       │  │   │  │  (errors, users,          │  │
│  │   metrics)            │  │   │  │   assignments)            │  │
│  └───────────────────────┘  │   │  └───────────────────────────┘  │
│                             │   │                                 │
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

AWS ECS Fargate (serverless containers). No servers to manage.

## Why ECS Fargate?

- **AWS Credits**: $100k credits make cost irrelevant
- **No server management**: AWS handles patching, scaling, restarts
- **AWS Integration**: Works with IAM, CloudWatch, RDS, etc.
- **Partner alignment**: Learn patterns used by AWS clients

## AWS Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              AWS Account                                     │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                           VPC                                          │ │
│  │                                                                        │ │
│  │   ┌──────────────────────────────────────────────────────────────┐    │ │
│  │   │                    ECS Cluster                                │    │ │
│  │   │                                                               │    │ │
│  │   │  ┌─────────────────────┐    ┌─────────────────────┐          │    │ │
│  │   │  │   SigNoz Service    │    │  GlitchTip Service  │          │    │ │
│  │   │  │   (Fargate)         │    │  (Fargate)          │          │    │ │
│  │   │  │                     │    │                     │          │    │ │
│  │   │  │  - otel-collector   │    │  - web              │          │    │ │
│  │   │  │  - query-service    │    │  - worker           │          │    │ │
│  │   │  │  - frontend         │    │                     │          │    │ │
│  │   │  │  - clickhouse       │    │                     │          │    │ │
│  │   │  └──────────┬──────────┘    └──────────┬──────────┘          │    │ │
│  │   │             │                          │                      │    │ │
│  │   └─────────────┼──────────────────────────┼──────────────────────┘    │ │
│  │                 │                          │                           │ │
│  │   ┌─────────────▼──────────┐    ┌──────────▼───────────┐              │ │
│  │   │   EBS Volume           │    │   RDS PostgreSQL     │              │ │
│  │   │   (ClickHouse data)    │    │   (GlitchTip data)   │              │ │
│  │   └────────────────────────┘    └──────────────────────┘              │ │
│  │                                                                        │ │
│  │   ┌────────────────────────┐                                          │ │
│  │   │   ElastiCache Redis    │                                          │ │
│  │   │   (GlitchTip queue)    │                                          │ │
│  │   └────────────────────────┘                                          │ │
│  │                                                                        │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐ │
│  │                    Application Load Balancer                           │ │
│  │                                                                        │ │
│  │   signoz.example.com:443 ────► SigNoz Frontend                        │ │
│  │   otel.example.com:443 ──────► OTel Collector                         │ │
│  │   errors.example.com:443 ───► GlitchTip                               │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

## AWS Services Used

| Service | Purpose | Estimated Cost |
|---------|---------|----------------|
| **ECS Fargate** | Run containers | ~$200/month |
| **RDS PostgreSQL** | GlitchTip database | ~$50/month |
| **ElastiCache Redis** | GlitchTip job queue | ~$30/month |
| **EBS** | ClickHouse persistent storage | ~$20/month |
| **ALB** | Load balancer + SSL | ~$20/month |
| **Route 53** | DNS | ~$1/month |
| **ACM** | SSL certificates | Free |
| **CloudWatch** | AWS logs (optional) | ~$10/month |
| **Total** | | **~$330/month** |

All covered by AWS credits.

## ECS Task Definitions

### SigNoz Tasks

| Task | CPU | Memory | Notes |
|------|-----|--------|-------|
| signoz-otel-collector | 1 vCPU | 2 GB | Receives telemetry |
| signoz-query-service | 0.5 vCPU | 1 GB | API layer |
| signoz-frontend | 0.25 vCPU | 512 MB | Web UI |
| clickhouse | 2 vCPU | 8 GB | Database (needs EBS) |

### GlitchTip Tasks

| Task | CPU | Memory | Notes |
|------|-----|--------|-------|
| glitchtip-web | 0.5 vCPU | 1 GB | Web UI + API |
| glitchtip-worker | 0.5 vCPU | 1 GB | Background jobs |

## Infrastructure as Code

Pulumi (TypeScript) deployed via GitHub Actions to dev account only.

```
infra/
└── pulumi/
    ├── Pulumi.yaml           # Project config
    ├── package.json          # Dependencies
    ├── tsconfig.json         # TypeScript config
    └── src/
        ├── index.ts          # Main entry point
        └── components/
            ├── signoz.ts     # SigNoz ECS services
            └── glitchtip.ts  # GlitchTip ECS services
```

Deployment: Push to `main` triggers GitHub Actions → deploys to dev AWS account.

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

# Summary

## What Gets Captured

| Signal | Backend | Frontend | Destination |
|--------|---------|----------|-------------|
| Errors (exceptions) | Automatic | Automatic | GlitchTip |
| Logs | Automatic (Fastify logger) | Skip | SigNoz |
| Traces | Automatic (HTTP, DB) | Skip | SigNoz |
| Metrics | Automatic | Skip | SigNoz |

## URLs

| Service | Local Development | Production (AWS) |
|---------|-------------------|------------------|
| SigNoz UI | http://localhost:3301 | https://signoz.example.com |
| GlitchTip UI | http://localhost:8000 | https://errors.example.com |
| OTLP HTTP endpoint | http://localhost:4318 | https://otel.example.com |
| OTLP gRPC endpoint | http://localhost:4317 | otel.example.com:4317 |

## Next Steps

1. [ ] Create Terraform configuration for AWS infrastructure
2. [ ] Deploy SigNoz to ECS Fargate
3. [ ] Deploy GlitchTip to ECS Fargate
4. [ ] Configure DNS (Route 53) and SSL (ACM)
5. [ ] Integrate SDK into one backend service
6. [ ] Integrate SDK into one frontend app
7. [ ] Verify data flows to both dashboards
8. [ ] Set up local development environment (Docker Compose)
