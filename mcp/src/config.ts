import { z } from "zod";

const configSchema = z.object({
  clickhouseUrl: z.string().url().default("http://localhost:8123"),
  mcpApiKey: z.string().min(1, "MCP_API_KEY is required"),
  mcpPort: z.coerce.number().int().positive().default(3001),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(): Config {
  return configSchema.parse({
    clickhouseUrl: process.env.CLICKHOUSE_URL || undefined,
    mcpApiKey: process.env.MCP_API_KEY,
    mcpPort: process.env.MCP_PORT || undefined,
  });
}
