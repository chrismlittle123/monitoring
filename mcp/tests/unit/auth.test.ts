import { describe, it, expect, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { startHttpServer } from "../../src/transport.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "../../src/config.js";

function getTestConfig(port: number): Config {
  return {
    clickhouseUrl: "http://localhost:8123",
    mcpApiKey: "test-secret-key",
    mcpPort: port,
  };
}

describe("HTTP auth", () => {
  const servers: Server[] = [];

  afterAll(async () => {
    for (const s of servers) {
      await new Promise<void>((resolve) => s.close(() => resolve()));
    }
  });

  it("returns 200 for unauthenticated /health", async () => {
    const config = getTestConfig(0);
    const mcpServer = new McpServer({ name: "test", version: "0.0.1" });
    const server = await startHttpServer(mcpServer, config);
    servers.push(server);

    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const res = await fetch(`http://localhost:${port}/health`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("returns 401 for missing auth header", async () => {
    const config = getTestConfig(0);
    const mcpServer = new McpServer({ name: "test", version: "0.0.1" });
    const server = await startHttpServer(mcpServer, config);
    servers.push(server);

    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const res = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 for wrong auth token", async () => {
    const config = getTestConfig(0);
    const mcpServer = new McpServer({ name: "test", version: "0.0.1" });
    const server = await startHttpServer(mcpServer, config);
    servers.push(server);

    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;

    const res = await fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer wrong-key",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });
});
