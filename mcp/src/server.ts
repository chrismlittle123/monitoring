import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClickHouseClient } from "@clickhouse/client";
import { ping } from "./tools/index.js";

export function createMcpServer(clickhouse: ClickHouseClient): McpServer {
  const server = new McpServer({
    name: "monitoring-mcp",
    version: "0.1.0",
  });

  server.tool("ping", "Check MCP server and ClickHouse connectivity", async () => {
    const result = await ping(clickhouse);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  });

  return server;
}
