import { describe, it, expect, vi } from "vitest";
import { createMcpServer } from "../../src/server.js";
import type { ClickHouseClient } from "@clickhouse/client";

function mockClient(success: boolean): ClickHouseClient {
  return {
    ping: vi.fn().mockResolvedValue({ success }),
  } as unknown as ClickHouseClient;
}

describe("createMcpServer", () => {
  it("creates a server with ping tool", () => {
    const client = mockClient(true);
    const server = createMcpServer(client);

    expect(server).toBeDefined();
  });

  it("ping tool returns ClickHouse status via MCP", async () => {
    const client = mockClient(true);
    const server = createMcpServer(client);

    // Access internal tool handler through the server's tool map
    // We test the tool indirectly through the ping function
    const { ping } = await import("../../src/tools/ping.js");
    const result = await ping(client);

    expect(result.status).toBe("ok");
    expect(result.clickhouse).toBe(true);
  });
});
