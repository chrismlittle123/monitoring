import * as pulumi from "@pulumi/pulumi";
import { defineConfig } from "@chrismlittle123/infra";
import { createSignoz } from "./components/signoz";
import { createGlitchTip } from "./components/glitchtip";

// Configure for AWS (100% AWS deployment)
defineConfig({
  cloud: "aws",
  region: "eu-west-2",
  project: "monitoring",
  environment: pulumi.getStack(),
});

// =============================================================================
// SigNoz - Observability Platform (Traces, Metrics, Logs)
// =============================================================================
// Deployed on EC2 with Docker Compose
// - ClickHouse for storage
// - OTel Collector for ingestion
// - Query Service + Frontend for UI

const signoz = createSignoz("signoz", {
  size: "medium",  // t3.medium: 2 vCPU, 4GB RAM
});

// =============================================================================
// GlitchTip - Error Tracking (Sentry-compatible)
// =============================================================================
// Deployed on ECS Fargate
// - Web service for UI and API
// - Worker service for background processing (Celery)
// - RDS PostgreSQL for storage
// - ElastiCache Redis for caching/queues

const glitchtip = createGlitchTip("glitchtip", {
  openRegistration: true,
});

// =============================================================================
// Exports
// =============================================================================

// SigNoz outputs
export const signozUrl = signoz.url;
export const signozOtlpHttp = signoz.otlpHttpEndpoint;
export const signozOtlpGrpc = signoz.otlpGrpcEndpoint;
export const signozInstanceId = signoz.instanceId;
export const signozPublicIp = signoz.publicIp;

// GlitchTip outputs
export const glitchtipUrl = glitchtip.url;
export const glitchtipDatabaseEndpoint = glitchtip.databaseEndpoint;
export const glitchtipRedisEndpoint = glitchtip.redisEndpoint;

// Instructions for connecting your apps
export const instructions = pulumi.output(`
================================================================================
MONITORING STACK DEPLOYED
================================================================================

SigNoz (Observability):
  UI: ${signoz.url}
  OTLP HTTP: ${signoz.otlpHttpEndpoint}
  OTLP gRPC: ${signoz.otlpGrpcEndpoint}

  To send traces from your app, set:
    OTEL_EXPORTER_OTLP_ENDPOINT=${signoz.otlpHttpEndpoint}

GlitchTip (Error Tracking):
  UI: ${glitchtip.url}

  After deployment, create an account and get your DSN from the project settings.
  Then configure your Sentry SDK:
    SENTRY_DSN=<your-dsn-from-glitchtip>

Note: SigNoz may take 5-10 minutes to fully start after EC2 instance launch.
      Check /var/log/user-data.log on the instance for installation progress.
================================================================================
`);
