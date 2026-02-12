import { loadConfig } from "./config.js";
import { createClickHouseClient, checkClickHouseHealth } from "./clickhouse.js";
import { createMcpServer } from "./server.js";
import { startHttpServer } from "./transport.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const clickhouse = createClickHouseClient(config);

  // Retry health check for Docker Compose startup ordering
  const maxAttempts = 30;
  const delayMs = 2000;
  let healthy = false;

  for (let i = 1; i <= maxAttempts; i++) {
    healthy = await checkClickHouseHealth(clickhouse);
    if (healthy) {
      console.log(`ClickHouse healthy after ${i} attempt(s)`);
      break;
    }
    if (i < maxAttempts) {
      console.log(
        `ClickHouse not ready (attempt ${i}/${maxAttempts}), retrying in ${delayMs}ms...`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  if (!healthy) {
    console.error(
      `ClickHouse not reachable after ${maxAttempts} attempts, exiting`,
    );
    process.exit(1);
  }

  const server = createMcpServer(clickhouse);
  await startHttpServer(server, config);
  console.log(`MCP server listening on port ${config.mcpPort}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
