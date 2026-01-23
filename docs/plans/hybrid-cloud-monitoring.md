# AWS Monitoring Stack Implementation Plan

## Overview

Deploy a monitoring stack using **100% AWS** to leverage $100k in credits:
- **AWS EC2** - SigNoz (observability platform with ClickHouse)
- **AWS ECS Fargate** - GlitchTip (error tracking)
- **AWS RDS** - PostgreSQL for GlitchTip
- **AWS ElastiCache** - Redis for GlitchTip

This stack is "set and forget" infrastructure. Your actual apps (deployed on GCP Cloud Run for fast iteration) will send telemetry to this monitoring stack.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              AWS (eu-west-2)                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  EC2 Instance (t3.medium - 2 vCPU, 4GB RAM)                       │  │
│  │  ┌─────────────────────────────────────────────────────────────┐  │  │
│  │  │  Docker Compose - SigNoz                                    │  │  │
│  │  │  ├── ClickHouse (port 8123, 9000)                          │  │  │
│  │  │  ├── Query Service (port 8080)                             │  │  │
│  │  │  ├── Frontend (port 3301) ─────────────────────────────────┼──┼──┼─► Public
│  │  │  └── OTel Collector (port 4317, 4318) ─────────────────────┼──┼──┼─► Public
│  │  └─────────────────────────────────────────────────────────────┘  │  │
│  │  EBS Volume: 50GB gp3 (ClickHouse data)                           │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  ECS Fargate - GlitchTip                                          │  │
│  │  ┌─────────────────────┐    ┌─────────────────────┐               │  │
│  │  │  Web Service        │    │  Worker Service     │               │  │
│  │  │  (port 8000)        │    │  (Celery)           │               │  │
│  │  └──────────┬──────────┘    └──────────┬──────────┘               │  │
│  │             │                          │                          │  │
│  │             └────────────┬─────────────┘                          │  │
│  │                          │                                        │  │
│  │             ┌────────────┴────────────┐                           │  │
│  │             ▼                         ▼                           │  │
│  │  ┌─────────────────────┐    ┌─────────────────────┐               │  │
│  │  │  RDS PostgreSQL     │    │  ElastiCache Redis  │               │  │
│  │  │  (db.t4g.micro)     │    │  (cache.t4g.micro)  │               │  │
│  │  └─────────────────────┘    └─────────────────────┘               │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  ┌─────────────────────┐                                                │
│  │  ALB (Load Balancer)│──────────────────────────────────────────────► Public
│  │  GlitchTip :443     │                                                │
│  └─────────────────────┘                                                │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

                              Telemetry Flow:
┌─────────────────────────────────────────────────────────────────────────┐
│  Your Apps (GCP Cloud Run - fast iteration)                             │
│  ├── OTLP traces/metrics ──────────────────► AWS EC2:4317 (SigNoz)     │
│  └── Sentry SDK errors ────────────────────► AWS ALB:443 (GlitchTip)   │
└─────────────────────────────────────────────────────────────────────────┘
```

## Cost Estimate (Monthly) - COVERED BY AWS CREDITS

| Component | Service | Size | Est. Cost |
|-----------|---------|------|-----------|
| SigNoz VM | EC2 t3.medium | 2 vCPU, 4GB | ~$30 |
| SigNoz Storage | EBS gp3 | 50GB | ~$5 |
| GlitchTip Web | ECS Fargate | 0.5 vCPU, 1GB | ~$15 |
| GlitchTip Worker | ECS Fargate | 0.5 vCPU, 1GB | ~$15 |
| PostgreSQL | RDS db.t4g.micro | 1 vCPU, 1GB | ~$15 |
| Redis | ElastiCache cache.t4g.micro | 0.5GB | ~$12 |
| Load Balancer | ALB | - | ~$20 |
| **Total** | | | **~$112/month** |
| **With $100k credits** | | | **$0 for ~74 years** 🎉 |

## Implementation Phases

---

## Phase 1: Extend `chrismlittle123/infra` Repo

### 1.1 Add `createInstance` Component for EC2 VMs

**File: `src/components/types.ts`** (additions)

```typescript
// ============================================================================
// Instance (VM)
// ============================================================================

export type InstanceSize = "small" | "medium" | "large";

export interface InstanceOptions {
  /**
   * Instance size tier
   * - small: 1 vCPU, 2GB RAM (t3.small / e2-small)
   * - medium: 2 vCPU, 4GB RAM (t3.medium / e2-medium)
   * - large: 2 vCPU, 8GB RAM (t3.large / e2-standard-2)
   * @default "medium"
   */
  size?: InstanceSize;

  /**
   * Root volume size in GB
   * @default 20
   */
  rootVolumeSize?: number;

  /**
   * Additional data volume size in GB (for persistent data)
   * @default undefined (no additional volume)
   */
  dataVolumeSize?: number;

  /**
   * Ports to open in security group/firewall
   * @default [22]
   */
  ports?: number[];

  /**
   * User data / startup script
   */
  userData?: string;

  /**
   * SSH key name (AWS) or SSH public key (GCP)
   */
  sshKey?: string;
}

export interface InstanceOutputs {
  /**
   * Public IP address
   */
  publicIp: pulumi.Output<string>;

  /**
   * Private IP address
   */
  privateIp: pulumi.Output<string>;

  /**
   * Instance ID
   */
  instanceId: pulumi.Output<string>;

  /**
   * Environment variables for linking
   */
  envVars: Record<string, pulumi.Output<string>>;
}
```

**File: `src/components/aws/instance.ts`**

```typescript
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { getConfig } from "../../config";
import { getTags } from "../../utils/tagging";
import type { InstanceOptions, InstanceOutputs, InstanceSize } from "../types";

const sizeMap: Record<InstanceSize, string> = {
  small: "t3.small",    // 2 vCPU, 2GB
  medium: "t3.medium",  // 2 vCPU, 4GB
  large: "t3.large",    // 2 vCPU, 8GB
};

export function createInstance(name: string, options: InstanceOptions = {}): InstanceOutputs {
  const config = getConfig();
  const instanceName = `${config.project}-${name}-instance-${config.environment}`;

  const size = options.size || "medium";
  const instanceType = sizeMap[size];
  const ports = options.ports || [22];

  // Get latest Amazon Linux 2023 AMI
  const ami = aws.ec2.getAmi({
    mostRecent: true,
    owners: ["amazon"],
    filters: [
      { name: "name", values: ["al2023-ami-*-x86_64"] },
      { name: "virtualization-type", values: ["hvm"] },
    ],
  });

  // Get default VPC
  const defaultVpc = aws.ec2.getVpc({ default: true });

  // Create security group
  const securityGroup = new aws.ec2.SecurityGroup(`${name}-sg`, {
    name: instanceName,
    description: `Security group for ${instanceName}`,
    vpcId: pulumi.output(defaultVpc).apply(v => v.id),
    ingress: ports.map(port => ({
      protocol: "tcp",
      fromPort: port,
      toPort: port,
      cidrBlocks: ["0.0.0.0/0"],
    })),
    egress: [{
      protocol: "-1",
      fromPort: 0,
      toPort: 0,
      cidrBlocks: ["0.0.0.0/0"],
    }],
    tags: getTags(),
  });

  // Create IAM role for instance
  const role = new aws.iam.Role(`${name}-role`, {
    name: instanceName,
    assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Action: "sts:AssumeRole",
        Principal: { Service: "ec2.amazonaws.com" },
        Effect: "Allow",
      }],
    }),
    tags: getTags(),
  });

  // Attach SSM policy for remote access without SSH
  new aws.iam.RolePolicyAttachment(`${name}-ssm-policy`, {
    role: role.name,
    policyArn: "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
  });

  const instanceProfile = new aws.iam.InstanceProfile(`${name}-profile`, {
    name: instanceName,
    role: role.name,
  });

  // Create the instance
  const instance = new aws.ec2.Instance(name, {
    ami: pulumi.output(ami).apply(a => a.id),
    instanceType: instanceType,
    vpcSecurityGroupIds: [securityGroup.id],
    iamInstanceProfile: instanceProfile.name,
    rootBlockDevice: {
      volumeSize: options.rootVolumeSize || 20,
      volumeType: "gp3",
      deleteOnTermination: true,
    },
    userData: options.userData,
    keyName: options.sshKey,
    tags: { ...getTags(), Name: instanceName },
  });

  // Create and attach data volume if specified
  if (options.dataVolumeSize) {
    const dataVolume = new aws.ebs.Volume(`${name}-data`, {
      availabilityZone: instance.availabilityZone,
      size: options.dataVolumeSize,
      type: "gp3",
      tags: { ...getTags(), Name: `${instanceName}-data` },
    });

    new aws.ec2.VolumeAttachment(`${name}-data-attach`, {
      deviceName: "/dev/xvdf",
      volumeId: dataVolume.id,
      instanceId: instance.id,
    });
  }

  const envPrefix = name.toUpperCase().replace(/-/g, "_");

  return {
    publicIp: instance.publicIp,
    privateIp: instance.privateIp,
    instanceId: instance.id,
    envVars: {
      [`${envPrefix}_PUBLIC_IP`]: instance.publicIp,
      [`${envPrefix}_PRIVATE_IP`]: instance.privateIp,
    },
  };
}
```

**File: `src/components/instance.ts`** (dispatcher)

```typescript
import { getConfig } from "../config";
import { createInstance as createInstanceAws } from "./aws/instance";
import type { InstanceOptions, InstanceOutputs, InstanceSize } from "./types";

export type { InstanceOptions, InstanceOutputs, InstanceSize } from "./types";

export function createInstance(name: string, options: InstanceOptions = {}): InstanceOutputs {
  const config = getConfig();

  if (config.cloud === "gcp") {
    const { createInstance: createInstanceGcp } = require("./gcp/instance");
    return createInstanceGcp(name, options);
  }

  return createInstanceAws(name, options);
}
```

### 1.2 Add `createRedis` Component for AWS ElastiCache

**File: `src/components/types.ts`** (additions)

```typescript
// ============================================================================
// Redis
// ============================================================================

export type RedisSize = "small" | "medium" | "large";

export interface RedisOptions {
  /**
   * Redis size tier
   * - small: 0.5GB (cache.t4g.micro)
   * - medium: 1.5GB (cache.t4g.small)
   * - large: 3GB (cache.t4g.medium)
   * @default "small"
   */
  size?: RedisSize;
}

export interface RedisOutputs {
  /**
   * Redis host
   */
  host: pulumi.Output<string>;

  /**
   * Redis port
   */
  port: pulumi.Output<number>;

  /**
   * Redis URL (redis://host:port)
   */
  url: pulumi.Output<string>;

  /**
   * Environment variables for linking
   */
  envVars: Record<string, pulumi.Output<string>>;
}
```

**File: `src/components/aws/redis.ts`**

```typescript
import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import { getConfig } from "../../config";
import { getTags } from "../../utils/tagging";
import type { RedisOptions, RedisOutputs, RedisSize } from "../types";

const sizeMap: Record<RedisSize, string> = {
  small: "cache.t4g.micro",    // 0.5GB
  medium: "cache.t4g.small",   // 1.5GB
  large: "cache.t4g.medium",   // 3GB
};

export function createRedis(name: string, options: RedisOptions = {}): RedisOutputs {
  const config = getConfig();
  const redisName = `${config.project}-${name}-redis-${config.environment}`;

  const size = options.size || "small";
  const nodeType = sizeMap[size];

  // Get default VPC
  const defaultVpc = aws.ec2.getVpc({ default: true });
  const defaultSubnets = aws.ec2.getSubnets({
    filters: [{ name: "vpc-id", values: [pulumi.output(defaultVpc).apply(v => v.id)] }],
  });

  // Create subnet group
  const subnetGroup = new aws.elasticache.SubnetGroup(`${name}-subnet-group`, {
    name: redisName,
    subnetIds: pulumi.output(defaultSubnets).apply(s => s.ids),
    tags: getTags(),
  });

  // Create security group
  const securityGroup = new aws.ec2.SecurityGroup(`${name}-redis-sg`, {
    name: `${redisName}-sg`,
    description: `Security group for ${redisName}`,
    vpcId: pulumi.output(defaultVpc).apply(v => v.id),
    ingress: [{
      protocol: "tcp",
      fromPort: 6379,
      toPort: 6379,
      cidrBlocks: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"],
    }],
    egress: [{
      protocol: "-1",
      fromPort: 0,
      toPort: 0,
      cidrBlocks: ["0.0.0.0/0"],
    }],
    tags: getTags(),
  });

  // Create Redis cluster
  const cluster = new aws.elasticache.Cluster(name, {
    clusterId: redisName.toLowerCase().replace(/[^a-z0-9-]/g, "-").substring(0, 40),
    engine: "redis",
    engineVersion: "7.0",
    nodeType: nodeType,
    numCacheNodes: 1,
    port: 6379,
    subnetGroupName: subnetGroup.name,
    securityGroupIds: [securityGroup.id],
    tags: getTags(),
  });

  const envPrefix = name.toUpperCase().replace(/-/g, "_");
  const host = cluster.cacheNodes.apply(nodes => nodes[0].address);
  const port = pulumi.output(6379);

  return {
    host: host,
    port: port,
    url: pulumi.interpolate`redis://${host}:6379`,
    envVars: {
      [`${envPrefix}_HOST`]: host,
      [`${envPrefix}_PORT`]: pulumi.output("6379"),
      [`${envPrefix}_URL`]: pulumi.interpolate`redis://${host}:6379`,
    },
  };
}
```

**File: `src/components/redis.ts`** (dispatcher)

```typescript
import { getConfig } from "../config";
import { createRedis as createRedisAws } from "./aws/redis";
import type { RedisOptions, RedisOutputs, RedisSize } from "./types";

export type { RedisOptions, RedisOutputs, RedisSize } from "./types";

export function createRedis(name: string, options: RedisOptions = {}): RedisOutputs {
  const config = getConfig();

  if (config.cloud === "gcp") {
    const { createRedis: createRedisGcp } = require("./gcp/redis");
    return createRedisGcp(name, options);
  }

  return createRedisAws(name, options);
}
```

---

## Phase 2: Create SigNoz EC2 Deployment

### 2.1 User Data Script for SigNoz

**File: `infra/pulumi/src/scripts/signoz-setup.sh`**

```bash
#!/bin/bash
set -e

# Install Docker
dnf update -y
dnf install -y docker git
systemctl enable docker
systemctl start docker
usermod -aG docker ec2-user

# Install Docker Compose
curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose

# Format and mount data volume
if [ -b /dev/xvdf ]; then
  mkfs -t xfs /dev/xvdf
  mkdir -p /data
  mount /dev/xvdf /data
  echo '/dev/xvdf /data xfs defaults,nofail 0 2' >> /etc/fstab
fi

# Clone SigNoz
cd /opt
git clone -b main https://github.com/SigNoz/signoz.git
cd signoz/deploy

# Configure for low memory usage
cat > docker-compose.override.yml << 'EOF'
version: "3"
services:
  clickhouse:
    deploy:
      resources:
        limits:
          memory: 2G
    volumes:
      - /data/clickhouse:/var/lib/clickhouse

  query-service:
    deploy:
      resources:
        limits:
          memory: 512M

  frontend:
    deploy:
      resources:
        limits:
          memory: 256M

  otel-collector:
    deploy:
      resources:
        limits:
          memory: 512M
EOF

# Start SigNoz
docker-compose -f docker/clickhouse-setup/docker-compose.yaml -f docker-compose.override.yml up -d

# Create systemd service for auto-restart
cat > /etc/systemd/system/signoz.service << 'EOF'
[Unit]
Description=SigNoz
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/signoz/deploy
ExecStart=/usr/local/bin/docker-compose -f docker/clickhouse-setup/docker-compose.yaml -f docker-compose.override.yml up -d
ExecStop=/usr/local/bin/docker-compose -f docker/clickhouse-setup/docker-compose.yaml -f docker-compose.override.yml down

[Install]
WantedBy=multi-user.target
EOF

systemctl enable signoz
```

### 2.2 SigNoz Component

**File: `infra/pulumi/src/components/signoz.ts`**

```typescript
import * as pulumi from "@pulumi/pulumi";
import * as fs from "fs";
import * as path from "path";
import { createInstance } from "@chrismlittle123/infra";

export interface SignozOptions {
  /**
   * Instance size
   * - small: Not recommended (may OOM)
   * - medium: 4GB RAM - minimum viable
   * - large: 8GB RAM - recommended for production
   * @default "medium"
   */
  size?: "small" | "medium" | "large";

  /**
   * Data volume size in GB for ClickHouse
   * @default 50
   */
  dataVolumeSize?: number;

  /**
   * SSH key name for access
   */
  sshKey?: string;
}

export interface SignozOutputs {
  /**
   * SigNoz UI URL
   */
  url: pulumi.Output<string>;

  /**
   * OTLP HTTP endpoint (port 4318)
   */
  otlpHttpEndpoint: pulumi.Output<string>;

  /**
   * OTLP gRPC endpoint (port 4317)
   */
  otlpGrpcEndpoint: pulumi.Output<string>;

  /**
   * Instance public IP
   */
  publicIp: pulumi.Output<string>;
}

export function createSignoz(name: string, options: SignozOptions = {}): SignozOutputs {
  const userData = fs.readFileSync(
    path.join(__dirname, "scripts/signoz-setup.sh"),
    "utf-8"
  );

  const instance = createInstance(name, {
    size: options.size || "medium",
    dataVolumeSize: options.dataVolumeSize || 50,
    sshKey: options.sshKey,
    ports: [
      22,    // SSH
      3301,  // SigNoz Frontend
      4317,  // OTLP gRPC
      4318,  // OTLP HTTP
    ],
    userData: userData,
  });

  return {
    url: pulumi.interpolate`http://${instance.publicIp}:3301`,
    otlpHttpEndpoint: pulumi.interpolate`http://${instance.publicIp}:4318`,
    otlpGrpcEndpoint: pulumi.interpolate`${instance.publicIp}:4317`,
    publicIp: instance.publicIp,
  };
}
```

---

## Phase 3: Create GlitchTip AWS ECS Deployment

### 3.1 GlitchTip Component

**File: `infra/pulumi/src/components/glitchtip.ts`**

```typescript
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import {
  createContainer,
  createDatabase,
  createRedis,
} from "@chrismlittle123/infra";

export interface GlitchTipOptions {
  /**
   * Custom domain for GlitchTip
   */
  domain?: string;

  /**
   * ACM certificate ARN (required if domain is set)
   */
  certificateArn?: string;

  /**
   * Enable open user registration
   * @default true
   */
  openRegistration?: boolean;
}

export interface GlitchTipOutputs {
  /**
   * GlitchTip URL
   */
  url: pulumi.Output<string>;

  /**
   * Database host
   */
  databaseHost: pulumi.Output<string>;

  /**
   * Redis host
   */
  redisHost: pulumi.Output<string>;
}

export function createGlitchTip(name: string, options: GlitchTipOptions = {}): GlitchTipOutputs {
  // Generate secret key
  const secretKey = new random.RandomPassword(`${name}-secret`, {
    length: 50,
    special: false,
  });

  // Create PostgreSQL database (RDS)
  const db = createDatabase(`${name}-db`, {
    size: "small",
    version: "15",
  });

  // Create Redis instance (ElastiCache)
  const redis = createRedis(`${name}-redis`, {
    size: "small",
  });

  // Common environment variables
  const commonEnv = {
    SECRET_KEY: secretKey.result,
    DATABASE_URL: pulumi.interpolate`postgres://${db.username}:${db.envVars[`${name.toUpperCase().replace(/-/g, "_")}_DB_PASSWORD`]}@${db.host}:${db.port}/${db.database}`,
    REDIS_URL: redis.url,
    GLITCHTIP_DOMAIN: options.domain ? `https://${options.domain}` : "",
    DEFAULT_FROM_EMAIL: "noreply@example.com",
    EMAIL_URL: "consolemail://",
    ENABLE_OPEN_USER_REGISTRATION: options.openRegistration !== false ? "true" : "false",
  };

  // Create GlitchTip web container (ECS Fargate)
  const web = createContainer(`${name}-web`, {
    image: "glitchtip/glitchtip:latest",
    port: 8000,
    size: "small",  // 0.5 vCPU, 1GB
    environment: {
      ...commonEnv,
      PORT: "8000",
    },
    healthCheckPath: "/_health/",
    domain: options.domain,
    certificateArn: options.certificateArn,
    link: [db],
  });

  // Create GlitchTip worker container (ECS Fargate)
  // Note: Worker runs celery beat + worker via custom entrypoint
  const worker = createContainer(`${name}-worker`, {
    image: "glitchtip/glitchtip:latest",
    port: 8000,  // Required for health check but not used for traffic
    size: "small",  // 0.5 vCPU, 1GB
    replicas: 1,
    environment: {
      ...commonEnv,
      // Worker-specific settings
      CELERY_WORKER_AUTOSCALE: "1,3",
      CELERY_WORKER_MAX_TASKS_PER_CHILD: "10000",
    },
    // Note: ECS task definition will need command override for celery
    // command: ["./bin/run-celery-with-beat.sh"]
    link: [db],
  });

  return {
    url: web.url,
    databaseHost: db.host,
    redisHost: redis.host,
  };
}
```

### 3.2 Extend Container Component for Command Override

To run Celery worker, we need to add `command` support to `ContainerOptions`:

**File: `src/components/types.ts`** (addition to ContainerOptions)

```typescript
/**
 * Override the container command (entrypoint args)
 * @example ["./bin/run-celery-with-beat.sh"]
 */
command?: string[];
```

**File: `src/components/aws/container.ts`** (modification)

In the ECS task definition's container definition, add:
```typescript
command: options.command,
```

**Note:** The GlitchTip worker needs to run Celery. Options:
1. Use the built-in `./bin/run-celery-with-beat.sh` script via command override
2. Create a custom Docker image that runs celery by default
3. Use ECS exec to run migrations: `./manage.py migrate`

---

## Phase 4: Main Infrastructure Entry Point

### 4.1 Main Index File

**File: `infra/pulumi/src/index.ts`**

```typescript
import { defineConfig } from "@chrismlittle123/infra";
import { createSignoz } from "./components/signoz";
import { createGlitchTip } from "./components/glitchtip";

// Configure for AWS (100% AWS deployment)
defineConfig({
  cloud: "aws",
  region: "eu-west-2",
  project: "monitoring",
  environment: process.env.PULUMI_STACK || "dev",
});

// Deploy SigNoz on AWS EC2
const signoz = createSignoz("signoz", {
  size: "medium",  // t3.medium: 2 vCPU, 4GB RAM
  dataVolumeSize: 50,
});

// Deploy GlitchTip on AWS ECS Fargate
const glitchtip = createGlitchTip("glitchtip", {
  openRegistration: true,
  // Optional: Add custom domain later
  // domain: "errors.yourdomain.com",
  // certificateArn: "arn:aws:acm:eu-west-2:...",
});

// Export outputs
export const signozUrl = signoz.url;
export const signozOtlpHttp = signoz.otlpHttpEndpoint;
export const signozOtlpGrpc = signoz.otlpGrpcEndpoint;
export const glitchtipUrl = glitchtip.url;
```

---

## Phase 5: GitHub Actions Deployment

### 5.1 Update Deploy Workflow

**File: `.github/workflows/deploy.yml`**

```yaml
name: Deploy

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

env:
  AWS_REGION: eu-west-2

jobs:
  deploy:
    name: Deploy Monitoring Stack
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: infra/pulumi
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v2
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'pnpm'
          cache-dependency-path: infra/pulumi/pnpm-lock.yaml

      - run: pnpm install

      # AWS credentials (OIDC)
      - name: Configure AWS Credentials
        uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: arn:aws:iam::215629979895:role/github-actions-pulumi
          aws-region: ${{ env.AWS_REGION }}

      - name: Install Pulumi
        run: curl -fsSL https://get.pulumi.com | sh && echo "$HOME/.pulumi/bin" >> $GITHUB_PATH

      - name: Deploy
        run: |
          export PATH="$HOME/.pulumi/bin:$PATH"
          pulumi login s3://pulumi-state-215629979895
          pulumi stack select dev --create
          pulumi up --yes
        env:
          PULUMI_CONFIG_PASSPHRASE: ""
```

---

## Implementation Checklist

### Phase 1: Extend infra repo
- [ ] Add `InstanceOptions` and `InstanceOutputs` types
- [ ] Create `src/components/aws/instance.ts`
- [ ] Create `src/components/instance.ts` dispatcher
- [ ] Add `RedisOptions` and `RedisOutputs` types
- [ ] Create `src/components/aws/redis.ts` (ElastiCache)
- [ ] Create `src/components/redis.ts` dispatcher
- [ ] Update `src/index.ts` exports
- [ ] Write tests for new components
- [ ] Publish new version

### Phase 2: SigNoz deployment
- [ ] Create `signoz-setup.sh` user data script
- [ ] Create `src/components/signoz.ts`
- [ ] Test EC2 deployment manually
- [ ] Verify SigNoz UI accessible
- [ ] Verify OTLP endpoints working

### Phase 3: GlitchTip deployment
- [ ] Create `src/components/glitchtip.ts`
- [ ] Add `command` option to `ContainerOptions`
- [ ] Test RDS PostgreSQL connectivity
- [ ] Test ElastiCache Redis connectivity
- [ ] Verify GlitchTip UI accessible
- [ ] Run database migrations

### Phase 4: Integration
- [ ] Update GitHub Actions workflow (already configured for AWS)
- [ ] Deploy full stack
- [ ] Configure DNS (optional)
- [ ] Set up HTTPS via ACM + ALB (optional)

### Phase 5: Verification
- [ ] Send test traces to SigNoz
- [ ] Send test errors to GlitchTip
- [ ] Verify data retention
- [ ] Document access credentials

---

## Open Questions

1. **Domain Names**: Do you want custom domains for the services, or are the default URLs sufficient for now?

2. **HTTPS**: Should we set up SSL/TLS certificates via ACM, or is HTTP acceptable for dev?

3. **GlitchTip Worker**: The worker needs to run `celery` instead of the web server. Recommended approach:
   - Extend `ContainerOptions` to support `command` override (simplest)
   - Alternative: Build a custom Docker image

4. **Secrets Management**: How should we handle the database password for GlitchTip?
   - Store in AWS Secrets Manager and inject at runtime (recommended)
   - Generate via Pulumi and store in Pulumi config

5. **SigNoz Security**: The EC2 instance exposes ports publicly. Options:
   - Add authentication via nginx reverse proxy
   - Use AWS ALB with authentication
   - Restrict to specific IP ranges via security group

---

## References

- [SigNoz Docker Installation](https://signoz.io/docs/install/docker/)
- [SigNoz Architecture](https://signoz.io/docs/architecture/)
- [GlitchTip Self-Hosted Guide](https://glitchtip.com/documentation/install)
- [AWS ECS Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html)
- [AWS ElastiCache for Redis](https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/WhatIs.html)
- [AWS RDS PostgreSQL](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_PostgreSQL.html)
