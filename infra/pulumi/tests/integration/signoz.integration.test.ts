import { describe, it, expect, beforeAll } from "vitest";

const SIGNOZ_URL = process.env.SIGNOZ_URL;
const OTLP_HTTP_ENDPOINT = process.env.OTLP_HTTP_ENDPOINT;

const skipReason = !SIGNOZ_URL || !OTLP_HTTP_ENDPOINT
  ? "Set SIGNOZ_URL and OTLP_HTTP_ENDPOINT to run integration tests"
  : undefined;

function randomHex(bytes: number): string {
  return Array.from({ length: bytes }, () =>
    Math.floor(Math.random() * 256).toString(16).padStart(2, "0")
  ).join("");
}

describe.skipIf(!!skipReason)("SigNoz integration", () => {
  let traceId: string;
  let spanId: string;
  const serviceName = `integration-test-${Date.now()}`;

  beforeAll(() => {
    traceId = randomHex(16);
    spanId = randomHex(8);
  });

  it("should return healthy status", async () => {
    const response = await fetch(`${SIGNOZ_URL}/api/v1/health`);
    expect(response.ok).toBe(true);
    const body = await response.json();
    expect(body.status).toBe("ok");
  });

  it("should accept a trace via OTLP HTTP", async () => {
    const now = Date.now() * 1_000_000; // nanoseconds

    const response = await fetch(`${OTLP_HTTP_ENDPOINT}/v1/traces`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resourceSpans: [
          {
            resource: {
              attributes: [
                { key: "service.name", value: { stringValue: serviceName } },
              ],
            },
            scopeSpans: [
              {
                scope: { name: "integration-test" },
                spans: [
                  {
                    traceId,
                    spanId,
                    name: "test-span",
                    kind: 1,
                    startTimeUnixNano: String(now),
                    endTimeUnixNano: String(now + 1_000_000_000),
                    status: {},
                  },
                ],
              },
            ],
          },
        ],
      }),
    });

    expect(response.ok).toBe(true);
    const body = await response.json();
    expect(body).toHaveProperty("partialSuccess");
  });

  it("should accept logs via OTLP HTTP", async () => {
    const now = Date.now() * 1_000_000;

    const response = await fetch(`${OTLP_HTTP_ENDPOINT}/v1/logs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resourceLogs: [
          {
            resource: {
              attributes: [
                { key: "service.name", value: { stringValue: serviceName } },
              ],
            },
            scopeLogs: [
              {
                scope: { name: "integration-test" },
                logRecords: [
                  {
                    timeUnixNano: String(now),
                    severityNumber: 9,
                    severityText: "INFO",
                    body: { stringValue: "integration test log entry" },
                  },
                ],
              },
            ],
          },
        ],
      }),
    });

    expect(response.ok).toBe(true);
    const body = await response.json();
    expect(body).toHaveProperty("partialSuccess");
  });

  it("should accept metrics via OTLP HTTP", async () => {
    const now = Date.now() * 1_000_000;

    const response = await fetch(`${OTLP_HTTP_ENDPOINT}/v1/metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        resourceMetrics: [
          {
            resource: {
              attributes: [
                { key: "service.name", value: { stringValue: serviceName } },
              ],
            },
            scopeMetrics: [
              {
                scope: { name: "integration-test" },
                metrics: [
                  {
                    name: "integration.test.counter",
                    sum: {
                      dataPoints: [
                        {
                          asInt: "1",
                          startTimeUnixNano: String(now),
                          timeUnixNano: String(now),
                        },
                      ],
                      aggregationTemporality: 2,
                      isMonotonic: true,
                    },
                  },
                ],
              },
            ],
          },
        ],
      }),
    });

    expect(response.ok).toBe(true);
    const body = await response.json();
    expect(body).toHaveProperty("partialSuccess");
  });
});
