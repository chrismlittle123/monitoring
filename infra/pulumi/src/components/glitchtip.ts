import * as pulumi from "@pulumi/pulumi";
import {
  createContainer,
  createDatabase,
  createRedis,
} from "@chrismlittle123/infra";

export interface GlitchTipOptions {
  /**
   * Enable open user registration
   * @default true
   */
  openRegistration?: boolean;

  /**
   * Default "from" email address
   * @default "noreply@example.com"
   */
  fromEmail?: string;
}

export interface GlitchTipOutputs {
  /**
   * GlitchTip URL
   */
  url: pulumi.Output<string>;

  /**
   * Database endpoint
   */
  databaseEndpoint: pulumi.Output<string>;

  /**
   * Redis endpoint
   */
  redisEndpoint: pulumi.Output<string>;
}

export function createGlitchTip(name: string, options: GlitchTipOptions = {}): GlitchTipOutputs {
  // Create PostgreSQL database (RDS)
  // The database now generates a secretKey that we can use for Django's SECRET_KEY
  const db = createDatabase(`${name}-db`, {
    size: "small",
    version: "15",
    storage: 20,
  });

  // Create Redis instance (ElastiCache)
  const redis = createRedis(`${name}-redis`, {
    size: "small",
    version: "7.0",
  });

  // Common environment variables for both web and worker
  // Note: Using type assertion because environment is typed as Record<string, string>
  // but Pulumi handles Output<string> values at runtime when building task definitions
  const commonEnv: Record<string, string> = {
    SECRET_KEY: db.secretKey as unknown as string,
    DEFAULT_FROM_EMAIL: options.fromEmail || "noreply@example.com",
    EMAIL_URL: "consolemail://",
    ENABLE_OPEN_USER_REGISTRATION: options.openRegistration !== false ? "true" : "false",
  };

  // Create GlitchTip web container (ECS Fargate)
  // Note: The link feature auto-injects DATABASE_URL from db and REDIS_URL from redis
  const web = createContainer(`${name}-web`, {
    image: "glitchtip/glitchtip:latest",
    port: 8080,  // GlitchTip runs on port 8080 by default
    size: "medium",  // 0.5 vCPU, 1GB - GlitchTip needs a bit more resources
    replicas: 1,
    environment: commonEnv,
    healthCheckPath: "/_health/",
    link: [db],  // Links database (Redis not supported in link yet)
  });

  // Create GlitchTip worker container (ECS Fargate)
  // The worker runs Celery for background tasks
  const worker = createContainer(`${name}-worker`, {
    image: "glitchtip/glitchtip:latest",
    port: 8080,  // GlitchTip runs on port 8080 by default
    size: "small",  // 0.25 vCPU, 0.5GB - worker doesn't need as much
    replicas: 1,
    environment: {
      ...commonEnv,
      CELERY_WORKER_AUTOSCALE: "1,3",
      CELERY_WORKER_MAX_TASKS_PER_CHILD: "10000",
    },
    command: ["./bin/run-celery-with-beat.sh"],
    link: [db],  // Links database (Redis not supported in link yet)
  });

  return {
    url: web.url,
    databaseEndpoint: db.endpoint,
    redisEndpoint: redis.endpoint,
  };
}
