import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";

export interface SignozOptions {
  cluster: aws.ecs.Cluster;
  vpc: awsx.ec2.Vpc;
  alb: awsx.lb.ApplicationLoadBalancer;
  tags: Record<string, string>;
  stack: string;
}

export interface SignozOutputs {
  url: pulumi.Output<string>;
  otelEndpoint: pulumi.Output<string>;
}

export function createSignoz(options: SignozOptions): SignozOutputs {
  const { cluster, vpc, alb, tags, stack } = options;
  const name = `signoz-${stack}`;
  const region = aws.config.region || "eu-west-2";

  // ===========================================
  // Cloud Map namespace for service discovery
  // ===========================================
  const namespace = new aws.servicediscovery.PrivateDnsNamespace(`${name}-namespace`, {
    name: "signoz.local",
    vpc: vpc.vpcId,
    tags: { ...tags, Name: `${name}-namespace` },
  });

  // ===========================================
  // Security Groups
  // ===========================================

  // Security group for ClickHouse (internal only)
  const clickhouseSecurityGroup = new aws.ec2.SecurityGroup(`${name}-clickhouse-sg`, {
    name: `${name}-clickhouse-sg`,
    vpcId: vpc.vpcId,
    description: "Security group for ClickHouse",
    ingress: [
      // ClickHouse HTTP
      { protocol: "tcp", fromPort: 8123, toPort: 8123, cidrBlocks: ["10.0.0.0/16"] },
      // ClickHouse native TCP
      { protocol: "tcp", fromPort: 9000, toPort: 9000, cidrBlocks: ["10.0.0.0/16"] },
      // EFS/NFS
      { protocol: "tcp", fromPort: 2049, toPort: 2049, cidrBlocks: ["10.0.0.0/16"] },
    ],
    egress: [
      { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
    ],
    tags: { ...tags, Name: `${name}-clickhouse-sg` },
  });

  // Security group for SigNoz services
  const signozSecurityGroup = new aws.ec2.SecurityGroup(`${name}-sg`, {
    name: `${name}-sg`,
    vpcId: vpc.vpcId,
    description: "Security group for SigNoz services",
    ingress: [
      // SigNoz UI/API
      { protocol: "tcp", fromPort: 8080, toPort: 8080, cidrBlocks: ["0.0.0.0/0"] },
      // OTLP gRPC
      { protocol: "tcp", fromPort: 4317, toPort: 4317, cidrBlocks: ["0.0.0.0/0"] },
      // OTLP HTTP
      { protocol: "tcp", fromPort: 4318, toPort: 4318, cidrBlocks: ["0.0.0.0/0"] },
    ],
    egress: [
      { protocol: "-1", fromPort: 0, toPort: 0, cidrBlocks: ["0.0.0.0/0"] },
    ],
    tags: { ...tags, Name: `${name}-sg` },
  });

  // ===========================================
  // EFS for ClickHouse persistent storage
  // ===========================================
  const efsFileSystem = new aws.efs.FileSystem(`${name}-efs`, {
    encrypted: true,
    performanceMode: "generalPurpose",
    throughputMode: "bursting",
    tags: { ...tags, Name: `${name}-clickhouse-data` },
  });

  // EFS mount targets (one per AZ) - use private subnets
  const mountTargets = vpc.privateSubnetIds.apply((subnetIds) =>
    subnetIds.map(
      (subnetId, i) =>
        new aws.efs.MountTarget(`${name}-efs-mount-${i}`, {
          fileSystemId: efsFileSystem.id,
          subnetId,
          securityGroups: [clickhouseSecurityGroup.id],
        })
    )
  );

  // EFS access point for ClickHouse (uid/gid 101 is clickhouse user)
  const accessPoint = new aws.efs.AccessPoint(`${name}-efs-ap`, {
    fileSystemId: efsFileSystem.id,
    posixUser: { uid: 101, gid: 101 },
    rootDirectory: {
      path: "/clickhouse-data",
      creationInfo: { ownerUid: 101, ownerGid: 101, permissions: "755" },
    },
    tags: { ...tags, Name: `${name}-clickhouse-ap` },
  });

  // ===========================================
  // CloudWatch log groups
  // ===========================================
  const clickhouseLogGroup = new aws.cloudwatch.LogGroup(`${name}-clickhouse-logs`, {
    name: `/ecs/${name}-clickhouse`,
    retentionInDays: 30,
    tags,
  });

  const signozLogGroup = new aws.cloudwatch.LogGroup(`${name}-logs`, {
    name: `/ecs/${name}`,
    retentionInDays: 30,
    tags,
  });

  // ===========================================
  // IAM Roles
  // ===========================================
  const taskRole = new aws.iam.Role(`${name}-task-role`, {
    name: `${name}-task-role`,
    assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Action: "sts:AssumeRole",
          Principal: { Service: "ecs-tasks.amazonaws.com" },
          Effect: "Allow",
        },
      ],
    }),
    tags,
  });

  // EFS policy for task role
  const efsPolicy = new aws.iam.RolePolicy(`${name}-efs-policy`, {
    role: taskRole.name,
    policy: pulumi.interpolate`{
      "Version": "2012-10-17",
      "Statement": [{
        "Effect": "Allow",
        "Action": [
          "elasticfilesystem:ClientMount",
          "elasticfilesystem:ClientWrite",
          "elasticfilesystem:ClientRootAccess"
        ],
        "Resource": "${efsFileSystem.arn}",
        "Condition": {
          "StringEquals": {
            "elasticfilesystem:AccessPointArn": "${accessPoint.arn}"
          }
        }
      }]
    }`,
  });

  const executionRole = new aws.iam.Role(`${name}-execution-role`, {
    name: `${name}-execution-role`,
    assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Action: "sts:AssumeRole",
          Principal: { Service: "ecs-tasks.amazonaws.com" },
          Effect: "Allow",
        },
      ],
    }),
    tags,
  });

  new aws.iam.RolePolicyAttachment(`${name}-execution-policy`, {
    role: executionRole.name,
    policyArn: "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy",
  });

  // ===========================================
  // ClickHouse Service
  // ===========================================

  // Cloud Map service for ClickHouse
  const clickhouseServiceDiscovery = new aws.servicediscovery.Service(`${name}-clickhouse-sd`, {
    name: "clickhouse",
    namespaceId: namespace.id,
    dnsConfig: {
      namespaceId: namespace.id,
      dnsRecords: [{ ttl: 10, type: "A" }],
      routingPolicy: "MULTIVALUE",
    },
    healthCheckCustomConfig: { failureThreshold: 1 },
    tags,
  });

  // ClickHouse task definition
  const clickhouseTaskDefinition = new aws.ecs.TaskDefinition(`${name}-clickhouse-task`, {
    family: `${name}-clickhouse`,
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu: "1024",
    memory: "2048",
    executionRoleArn: executionRole.arn,
    taskRoleArn: taskRole.arn,
    volumes: [{
      name: "clickhouse-data",
      efsVolumeConfiguration: {
        fileSystemId: efsFileSystem.id,
        transitEncryption: "ENABLED",
        authorizationConfig: {
          accessPointId: accessPoint.id,
          iam: "ENABLED",
        },
      },
    }],
    containerDefinitions: pulumi.interpolate`[
      {
        "name": "clickhouse",
        "image": "clickhouse/clickhouse-server:24.1-alpine",
        "essential": true,
        "portMappings": [
          { "containerPort": 8123, "hostPort": 8123, "protocol": "tcp" },
          { "containerPort": 9000, "hostPort": 9000, "protocol": "tcp" }
        ],
        "mountPoints": [{
          "sourceVolume": "clickhouse-data",
          "containerPath": "/var/lib/clickhouse",
          "readOnly": false
        }],
        "environment": [
          { "name": "CLICKHOUSE_DB", "value": "signoz" },
          { "name": "CLICKHOUSE_USER", "value": "default" },
          { "name": "CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT", "value": "1" }
        ],
        "ulimits": [
          { "name": "nofile", "softLimit": 262144, "hardLimit": 262144 }
        ],
        "healthCheck": {
          "command": ["CMD-SHELL", "wget --spider -q localhost:8123/ping || exit 1"],
          "interval": 30,
          "timeout": 5,
          "retries": 3,
          "startPeriod": 60
        },
        "logConfiguration": {
          "logDriver": "awslogs",
          "options": {
            "awslogs-group": "/ecs/${name}-clickhouse",
            "awslogs-region": "${region}",
            "awslogs-stream-prefix": "clickhouse"
          }
        }
      }
    ]`,
    tags,
  });

  // ClickHouse ECS Service
  const clickhouseService = new aws.ecs.Service(`${name}-clickhouse-service`, {
    name: `${name}-clickhouse`,
    cluster: cluster.arn,
    taskDefinition: clickhouseTaskDefinition.arn,
    desiredCount: 1,
    launchType: "FARGATE",
    platformVersion: "1.4.0",
    networkConfiguration: {
      assignPublicIp: false,
      subnets: vpc.privateSubnetIds,
      securityGroups: [clickhouseSecurityGroup.id],
    },
    serviceRegistries: {
      registryArn: clickhouseServiceDiscovery.arn,
    },
    tags,
  });

  // ===========================================
  // SigNoz Service (Frontend + Query + OTel)
  // ===========================================

  // ALB target group for SigNoz UI
  const uiTargetGroup = new aws.lb.TargetGroup(`${name}-ui-tg`, {
    name: `${name}-ui-tg`,
    port: 8080,
    protocol: "HTTP",
    targetType: "ip",
    vpcId: vpc.vpcId,
    healthCheck: {
      enabled: true,
      path: "/api/v1/health",
      port: "8080",
      protocol: "HTTP",
      healthyThreshold: 2,
      unhealthyThreshold: 5,
      timeout: 10,
      interval: 30,
    },
    tags,
  });

  // ALB listener for SigNoz UI (port 3301)
  const uiListener = new aws.lb.Listener(`${name}-ui-listener`, {
    loadBalancerArn: alb.loadBalancer.arn,
    port: 3301,
    protocol: "HTTP",
    defaultActions: [
      {
        type: "forward",
        targetGroupArn: uiTargetGroup.arn,
      },
    ],
    tags,
  });

  // OTEL HTTP target group
  const otelTargetGroup = new aws.lb.TargetGroup(`${name}-otel-tg`, {
    name: `${name}-otel-tg`,
    port: 4318,
    protocol: "HTTP",
    targetType: "ip",
    vpcId: vpc.vpcId,
    healthCheck: {
      enabled: true,
      path: "/",
      port: "4318",
      protocol: "HTTP",
      healthyThreshold: 2,
      unhealthyThreshold: 3,
      timeout: 5,
      interval: 30,
    },
    tags,
  });

  // OTEL HTTP listener
  const otelListener = new aws.lb.Listener(`${name}-otel-listener`, {
    loadBalancerArn: alb.loadBalancer.arn,
    port: 4318,
    protocol: "HTTP",
    defaultActions: [
      {
        type: "forward",
        targetGroupArn: otelTargetGroup.arn,
      },
    ],
    tags,
  });

  // SigNoz task definition with two containers
  const signozTaskDefinition = new aws.ecs.TaskDefinition(`${name}-task`, {
    family: name,
    networkMode: "awsvpc",
    requiresCompatibilities: ["FARGATE"],
    cpu: "1024",
    memory: "2048",
    executionRoleArn: executionRole.arn,
    taskRoleArn: taskRole.arn,
    containerDefinitions: pulumi.interpolate`[
      {
        "name": "signoz",
        "image": "signoz/signoz:v0.108.0",
        "essential": true,
        "portMappings": [
          { "containerPort": 8080, "hostPort": 8080, "protocol": "tcp" }
        ],
        "environment": [
          { "name": "SIGNOZ_LOCAL_DB_PATH", "value": "/var/lib/signoz/signoz.db" },
          { "name": "STORAGE", "value": "clickhouse" },
          { "name": "CLICKHOUSE_HOST", "value": "clickhouse.signoz.local" },
          { "name": "CLICKHOUSE_PORT", "value": "9000" },
          { "name": "TELEMETRY_ENABLED", "value": "false" },
          { "name": "GODEBUG", "value": "netdns=go" }
        ],
        "healthCheck": {
          "command": ["CMD-SHELL", "wget --spider -q localhost:8080/api/v1/health || exit 1"],
          "interval": 30,
          "timeout": 10,
          "retries": 5,
          "startPeriod": 120
        },
        "logConfiguration": {
          "logDriver": "awslogs",
          "options": {
            "awslogs-group": "/ecs/${name}",
            "awslogs-region": "${region}",
            "awslogs-stream-prefix": "signoz"
          }
        }
      },
      {
        "name": "otel-collector",
        "image": "signoz/signoz-otel-collector:v0.129.12",
        "essential": true,
        "entryPoint": ["sh", "-c"],
        "command": ["cat > /tmp/config.yaml << 'EOFCONFIG'\nreceivers:\n  otlp:\n    protocols:\n      grpc:\n        endpoint: 0.0.0.0:4317\n      http:\n        endpoint: 0.0.0.0:4318\nprocessors:\n  batch:\n    send_batch_size: 10000\n    timeout: 10s\nextensions:\n  health_check:\n    endpoint: 0.0.0.0:13133\nexporters:\n  clickhousetraces:\n    datasource: tcp://clickhouse.signoz.local:9000/signoz_traces\n    use_new_schema: true\n  clickhousemetricswrite:\n    endpoint: tcp://clickhouse.signoz.local:9000/signoz_metrics\n    resource_to_telemetry_conversion:\n      enabled: true\n  clickhousemetricswritev2:\n    dsn: tcp://clickhouse.signoz.local:9000/signoz_metrics\n  clickhouselogsexporter:\n    dsn: tcp://clickhouse.signoz.local:9000/signoz_logs\n    timeout: 10s\n    use_new_schema: true\nservice:\n  telemetry:\n    logs:\n      encoding: json\n    metrics:\n      address: 0.0.0.0:8888\n  extensions: [health_check]\n  pipelines:\n    traces:\n      receivers: [otlp]\n      processors: [batch]\n      exporters: [clickhousetraces]\n    metrics:\n      receivers: [otlp]\n      processors: [batch]\n      exporters: [clickhousemetricswrite, clickhousemetricswritev2]\n    logs:\n      receivers: [otlp]\n      processors: [batch]\n      exporters: [clickhouselogsexporter]\nEOFCONFIG\n/signoz-otel-collector --config=/tmp/config.yaml"],
        "portMappings": [
          { "containerPort": 4317, "hostPort": 4317, "protocol": "tcp" },
          { "containerPort": 4318, "hostPort": 4318, "protocol": "tcp" }
        ],
        "environment": [
          { "name": "OTEL_RESOURCE_ATTRIBUTES", "value": "host.name=signoz-otel-collector" },
          { "name": "GODEBUG", "value": "netdns=go" }
        ],
        "healthCheck": {
          "command": ["CMD-SHELL", "wget --spider -q localhost:4318/ || exit 1"],
          "interval": 30,
          "timeout": 5,
          "retries": 3,
          "startPeriod": 60
        },
        "logConfiguration": {
          "logDriver": "awslogs",
          "options": {
            "awslogs-group": "/ecs/${name}",
            "awslogs-region": "${region}",
            "awslogs-stream-prefix": "otel-collector"
          }
        }
      }
    ]`,
    tags,
  });

  // SigNoz ECS Service
  const signozService = new aws.ecs.Service(`${name}-service`, {
    name,
    cluster: cluster.arn,
    taskDefinition: signozTaskDefinition.arn,
    desiredCount: 1,
    launchType: "FARGATE",
    networkConfiguration: {
      assignPublicIp: true,
      subnets: vpc.publicSubnetIds,
      securityGroups: [signozSecurityGroup.id],
    },
    loadBalancers: [
      {
        targetGroupArn: uiTargetGroup.arn,
        containerName: "signoz",
        containerPort: 8080,
      },
      {
        targetGroupArn: otelTargetGroup.arn,
        containerName: "otel-collector",
        containerPort: 4318,
      },
    ],
    tags,
  }, { dependsOn: [clickhouseService] });

  return {
    url: pulumi.interpolate`http://${alb.loadBalancer.dnsName}:3301`,
    otelEndpoint: pulumi.interpolate`http://${alb.loadBalancer.dnsName}:4318`,
  };
}
