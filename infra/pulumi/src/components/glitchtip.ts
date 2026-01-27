import type * as pulumi from "@pulumi/pulumi";
import {
  createContainer,
  createDatabase,
  createRedis,
} from "@chrismlittle123/infra";

export interface GlitchTipOptions {
  /** Enable open user registration @default true */
  openRegistration?: boolean;
  /** Default "from" email address @default "noreply@example.com" */
  fromEmail?: string;
}

export interface GlitchTipOutputs {
  url: pulumi.Output<string>;
  databaseEndpoint: pulumi.Output<string>;
  redisEndpoint: pulumi.Output<string>;
}

function buildEnv(secretKey: string, options: GlitchTipOptions): Record<string, string> {
  return {
    SECRET_KEY: secretKey,
    DEFAULT_FROM_EMAIL: options.fromEmail || "noreply@example.com",
    EMAIL_URL: "consolemail://",
    ENABLE_OPEN_USER_REGISTRATION: options.openRegistration !== false ? "true" : "false",
  };
}

export function createGlitchTip(name: string, options: GlitchTipOptions = {}): GlitchTipOutputs {
  const db = createDatabase(`${name}-db`, { size: "small", version: "15", storage: 20 });  // Minimum for AWS RDS
  const redis = createRedis(`${name}-redis`, { size: "small", version: "7.0" });

  // Note: Type assertion needed - Pulumi handles Output<string> at runtime
  const commonEnv = buildEnv(db.secretKey as unknown as string, options);

  const web = createContainer(`${name}-web`, {
    image: "glitchtip/glitchtip:latest",
    port: 8080,
    size: "small",  // Reduced from medium for cost savings
    replicas: 1,
    environment: commonEnv,
    healthCheckPath: "/_health/",
    link: [db],
  });

  // Worker runs Celery for background tasks (return value not needed)
  createContainer(`${name}-worker`, {
    image: "glitchtip/glitchtip:latest",
    port: 8080,
    size: "small",
    replicas: 1,
    environment: { ...commonEnv, CELERY_WORKER_AUTOSCALE: "1,3", CELERY_WORKER_MAX_TASKS_PER_CHILD: "10000" },
    command: ["./bin/run-celery-with-beat.sh"],
    link: [db],
  });

  return { url: web.url, databaseEndpoint: db.endpoint, redisEndpoint: redis.endpoint };
}
