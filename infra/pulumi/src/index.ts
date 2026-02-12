import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import { createSecret, defineConfig } from "@chrismlittle123/infra";
import { createSignoz } from "./components/signoz";

// Configure for AWS (100% AWS deployment)
defineConfig({
  cloud: "aws",
  region: "eu-west-2",
  project: "monitoring",
  environment: pulumi.getStack(),
});

// Load configuration
const config = new pulumi.Config();

// =============================================================================
// SigNoz - Observability Platform (Traces, Metrics, Logs)
// =============================================================================
// Deployed on EC2 with Docker Compose
// - ClickHouse for storage
// - OTel Collector for ingestion
// - Query Service + Frontend for UI

const signozAdminEmail = "admin@monitoring.local";
const mcpApiKey = new random.RandomPassword("mcp-api-key", {
  length: 48,
  special: false,
});

const signozAdminPassword = new random.RandomPassword("signoz-admin-password", {
  length: 24,
  special: true,
  overrideSpecial: "!@#%&*",  // No $ - it breaks bash variable expansion in user data script
});

const signoz = createSignoz("signoz", {
  size: "medium",  // t3.micro (small) has only 1GB - not enough for SigNoz
  sshKey: config.get("sshPublicKey"),
  adminEmail: signozAdminEmail,
  adminPassword: signozAdminPassword.result,
  mcpApiKey: mcpApiKey.result,
});

// =============================================================================
// Secrets
// =============================================================================

const otlpSecret = createSecret("signoz-otlp-endpoint", {
  value: pulumi.interpolate`{"http":"${signoz.otlpHttpEndpoint}","grpc":"${signoz.otlpGrpcEndpoint}"}` as unknown as string,
});

const adminSecret = createSecret("signoz-admin-credentials", {
  value: pulumi.interpolate`{"email":"${signozAdminEmail}","password":"${signozAdminPassword.result}","url":"${signoz.url}"}` as unknown as string,
});

const mcpSecret = createSecret("mcp-api-key", {
  value: pulumi.interpolate`{"apiKey":"${mcpApiKey.result}","endpoint":"${signoz.mcpEndpoint}"}` as unknown as string,
});

// =============================================================================
// Exports
// =============================================================================

export const otlpSecretName = otlpSecret.secretName;
export const otlpSecretArn = otlpSecret.secretArn;
export const adminSecretName = adminSecret.secretName;
export const adminSecretArn = adminSecret.secretArn;
export const mcpSecretName = mcpSecret.secretName;
export const mcpSecretArn = mcpSecret.secretArn;
export const signozUrl = signoz.url;
export const signozOtlpHttp = signoz.otlpHttpEndpoint;
export const signozOtlpGrpc = signoz.otlpGrpcEndpoint;
export const signozInstanceId = signoz.instanceId;
export const signozPublicIp = signoz.publicIp;
export const mcpEndpoint = signoz.mcpEndpoint;

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

Note: SigNoz may take 5-10 minutes to fully start after EC2 instance launch.
      Check /var/log/user-data.log on the instance for installation progress.
================================================================================
`);
