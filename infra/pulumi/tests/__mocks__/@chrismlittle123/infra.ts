import { vi } from "vitest";

export const createInstance = vi.fn(() => ({
  publicIp: "1.2.3.4",
  instanceId: "i-1234567890abcdef0",
}));

export const createDatabase = vi.fn(() => ({
  endpoint: "db.example.com:5432",
  secretKey: "generated-secret-key",
}));

export const createRedis = vi.fn(() => ({
  endpoint: "redis.example.com:6379",
}));

export const createContainer = vi.fn(() => ({
  url: "https://app.example.com",
}));

export const defineConfig = vi.fn();
