import { describe, it, expect, beforeEach } from "vitest";
import {
  createDatabase,
  createRedis,
  createContainer,
} from "@chrismlittle123/infra";
import { createGlitchTip } from "./glitchtip";

// Get the mock functions
const mockCreateDatabase = createDatabase as ReturnType<typeof import("vitest").vi.fn>;
const mockCreateRedis = createRedis as ReturnType<typeof import("vitest").vi.fn>;
const mockCreateContainer = createContainer as ReturnType<typeof import("vitest").vi.fn>;

describe("createGlitchTip", () => {
  beforeEach(() => {
    mockCreateDatabase.mockClear();
    mockCreateRedis.mockClear();
    mockCreateContainer.mockClear();

    mockCreateDatabase.mockReturnValue({
      endpoint: "db.example.com:5432",
      secretKey: "generated-secret-key",
    });
    mockCreateRedis.mockReturnValue({
      endpoint: "redis.example.com:6379",
    });
    mockCreateContainer.mockReturnValue({
      url: "https://glitchtip.example.com",
    });
  });

  it("should create database with PostgreSQL 15", () => {
    createGlitchTip("test-glitchtip", {});

    expect(mockCreateDatabase).toHaveBeenCalledWith(
      "test-glitchtip-db",
      expect.objectContaining({
        version: "15",
        size: "small",
        storage: 20,
      })
    );
  });

  it("should create Redis instance", () => {
    createGlitchTip("test-glitchtip", {});

    expect(mockCreateRedis).toHaveBeenCalledWith(
      "test-glitchtip-redis",
      expect.objectContaining({
        version: "7.0",
        size: "small",
      })
    );
  });

  it("should create web container with correct config", () => {
    createGlitchTip("test-glitchtip", {});

    expect(mockCreateContainer).toHaveBeenCalledWith(
      "test-glitchtip-web",
      expect.objectContaining({
        image: "glitchtip/glitchtip:latest",
        port: 8080,
        size: "medium",
        healthCheckPath: "/_health/",
      })
    );
  });

  it("should create worker container with Celery command", () => {
    createGlitchTip("test-glitchtip", {});

    expect(mockCreateContainer).toHaveBeenCalledWith(
      "test-glitchtip-worker",
      expect.objectContaining({
        image: "glitchtip/glitchtip:latest",
        size: "small",
        command: ["./bin/run-celery-with-beat.sh"],
      })
    );
  });

  it("should enable open registration by default", () => {
    createGlitchTip("test-glitchtip", {});

    const webContainerCall = mockCreateContainer.mock.calls.find(
      (call) => call[0] === "test-glitchtip-web"
    );
    expect(webContainerCall[1].environment).toMatchObject({
      ENABLE_OPEN_USER_REGISTRATION: "true",
    });
  });

  it("should allow disabling open registration", () => {
    createGlitchTip("test-glitchtip", { openRegistration: false });

    const webContainerCall = mockCreateContainer.mock.calls.find(
      (call) => call[0] === "test-glitchtip-web"
    );
    expect(webContainerCall[1].environment).toMatchObject({
      ENABLE_OPEN_USER_REGISTRATION: "false",
    });
  });

  it("should use custom from email when provided", () => {
    createGlitchTip("test-glitchtip", {
      fromEmail: "alerts@example.com",
    });

    const webContainerCall = mockCreateContainer.mock.calls.find(
      (call) => call[0] === "test-glitchtip-web"
    );
    expect(webContainerCall[1].environment).toMatchObject({
      DEFAULT_FROM_EMAIL: "alerts@example.com",
    });
  });

  it("should use default from email when not provided", () => {
    createGlitchTip("test-glitchtip", {});

    const webContainerCall = mockCreateContainer.mock.calls.find(
      (call) => call[0] === "test-glitchtip-web"
    );
    expect(webContainerCall[1].environment).toMatchObject({
      DEFAULT_FROM_EMAIL: "noreply@example.com",
    });
  });

  it("should return expected output structure", () => {
    const result = createGlitchTip("test-glitchtip", {});

    expect(result).toHaveProperty("url");
    expect(result).toHaveProperty("databaseEndpoint");
    expect(result).toHaveProperty("redisEndpoint");
  });

  it("should link database to web container", () => {
    createGlitchTip("test-glitchtip", {});

    const webContainerCall = mockCreateContainer.mock.calls.find(
      (call) => call[0] === "test-glitchtip-web"
    );

    expect(webContainerCall[1].link).toBeDefined();
    expect(webContainerCall[1].link).toHaveLength(1);
  });

  it("should link database to worker container", () => {
    createGlitchTip("test-glitchtip", {});

    const workerContainerCall = mockCreateContainer.mock.calls.find(
      (call) => call[0] === "test-glitchtip-worker"
    );

    expect(workerContainerCall[1].link).toBeDefined();
    expect(workerContainerCall[1].link).toHaveLength(1);
  });

  it("should configure worker with Celery autoscale settings", () => {
    createGlitchTip("test-glitchtip", {});

    const workerContainerCall = mockCreateContainer.mock.calls.find(
      (call) => call[0] === "test-glitchtip-worker"
    );

    expect(workerContainerCall[1].environment).toMatchObject({
      CELERY_WORKER_AUTOSCALE: "1,3",
      CELERY_WORKER_MAX_TASKS_PER_CHILD: "10000",
    });
  });
});
