# Monitoring

Monitoring, logging and observability stack.

## Services

### SigNoz (Observability)

OpenTelemetry-native observability platform for traces, metrics, and logs.

- **UI**: http://{signoz-ip}:8080
- **OTLP gRPC**: {signoz-ip}:4317
- **OTLP HTTP**: http://{signoz-ip}:4318

## Deployment

Deployed via Pulumi using `@chrismlittle123/infra` package. Push to `main` branch triggers GitHub Actions deployment.

```bash
# Manual deployment (not recommended - use CI/CD)
cd infra/pulumi
pulumi up
```

## Sending Traces

Configure your application's OpenTelemetry SDK:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://{signoz-ip}:4318
```

Test with curl:

```bash
curl -X POST http://{signoz-ip}:4318/v1/traces \
  -H "Content-Type: application/json" \
  -d '{
    "resourceSpans": [{
      "resource": {
        "attributes": [{"key": "service.name", "value": {"stringValue": "test-service"}}]
      },
      "scopeSpans": [{
        "scope": {"name": "test"},
        "spans": [{
          "traceId": "5B8EFFF798038103D269B633813FC60C",
          "spanId": "EEE19B7EC3C1B174",
          "name": "test-span",
          "kind": 1,
          "startTimeUnixNano": "1706000000000000000",
          "endTimeUnixNano": "1706000001000000000"
        }]
      }]
    }]
  }'
```

## Important Notes

### SigNoz User Signup Required

SigNoz v0.108+ requires creating a user account via the UI before the otel-collector will accept traces. This is by design - the collector uses opamp (Open Agent Management Protocol) to receive its configuration dynamically from the SigNoz server, which requires an organization to exist first.

**After deploying SigNoz:**
1. Navigate to the SigNoz UI (port 8080)
2. Create a user account
3. The otel-collector will then receive its configuration and start accepting traces on ports 4317/4318
