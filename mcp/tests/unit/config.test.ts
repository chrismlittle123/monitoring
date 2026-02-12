import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("loads config with all env vars set", () => {
    process.env.CLICKHOUSE_URL = "http://clickhouse:8123";
    process.env.MCP_API_KEY = "test-key";
    process.env.MCP_PORT = "4000";

    const config = loadConfig();

    expect(config.clickhouseUrl).toBe("http://clickhouse:8123");
    expect(config.mcpApiKey).toBe("test-key");
    expect(config.mcpPort).toBe(4000);
  });

  it("uses default clickhouse URL and port", () => {
    process.env.MCP_API_KEY = "test-key";
    delete process.env.CLICKHOUSE_URL;
    delete process.env.MCP_PORT;

    const config = loadConfig();

    expect(config.clickhouseUrl).toBe("http://localhost:8123");
    expect(config.mcpPort).toBe(3001);
  });

  it("throws when MCP_API_KEY is missing", () => {
    delete process.env.MCP_API_KEY;

    expect(() => loadConfig()).toThrow();
  });

  it("throws when MCP_API_KEY is empty", () => {
    process.env.MCP_API_KEY = "";

    expect(() => loadConfig()).toThrow();
  });

  it("throws when CLICKHOUSE_URL is not a valid URL", () => {
    process.env.MCP_API_KEY = "test-key";
    process.env.CLICKHOUSE_URL = "not-a-url";

    expect(() => loadConfig()).toThrow();
  });
});
