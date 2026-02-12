import { createClient, type ClickHouseClient } from "@clickhouse/client";
import type { Config } from "./config.js";

export function createClickHouseClient(config: Config): ClickHouseClient {
  return createClient({
    url: config.clickhouseUrl,
  });
}

export async function checkClickHouseHealth(
  client: ClickHouseClient,
): Promise<boolean> {
  try {
    const result = await client.ping();
    return result.success;
  } catch {
    return false;
  }
}
