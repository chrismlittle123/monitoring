import * as pulumi from "@pulumi/pulumi";
import { createInstance } from "@chrismlittle123/infra";

export interface SignozOptions {
  /**
   * Instance size
   * - small: 2GB RAM - minimal for testing (t3.small)
   * - medium: 4GB RAM - recommended for dev/staging (t3.medium)
   * - large: 16GB RAM - recommended for production (t3.xlarge)
   * @default "small"
   */
  size?: "small" | "medium" | "large";

  /**
   * SSH public key for access (optional)
   */
  sshKey?: string;

  /**
   * Admin email for initial registration
   * @default "admin@monitoring.local"
   */
  adminEmail?: string;

  /**
   * Admin password for initial registration
   */
  adminPassword: pulumi.Input<string>;

  /**
   * API key for MCP server authentication
   */
  mcpApiKey: pulumi.Input<string>;
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

  /**
   * Instance ID
   */
  instanceId: pulumi.Output<string>;

  /**
   * MCP server endpoint
   */
  mcpEndpoint: pulumi.Output<string>;
}

/**
 * User data script to install Docker and run SigNoz via Docker Compose.
 * SIGNOZ_ADMIN_EMAIL and SIGNOZ_ADMIN_PASSWORD are interpolated by Pulumi.
 */
function buildSignozUserData(adminEmail: string, adminPassword: pulumi.Input<string>, mcpApiKey: pulumi.Input<string>): pulumi.Output<string> {
  return pulumi.interpolate`#!/bin/bash
set -e

# Log output to file for debugging
exec > >(tee /var/log/user-data.log) 2>&1
echo "Starting SigNoz installation at $(date)"

# Admin credentials (set by Pulumi)
SIGNOZ_ADMIN_EMAIL="${adminEmail}"
SIGNOZ_ADMIN_PASSWORD="${adminPassword}"

# Update system
apt-get update
apt-get upgrade -y

# Install Docker and jq (jq needed for safe JSON construction in registration)
apt-get install -y apt-transport-https ca-certificates curl gnupg lsb-release jq
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin

# Start Docker
systemctl enable docker
systemctl start docker

# Install Docker Compose standalone (for compatibility)
curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
chmod +x /usr/local/bin/docker-compose

# Create data directory
mkdir -p /opt/signoz
cd /opt/signoz

# Clone SigNoz
git clone -b main https://github.com/SigNoz/signoz.git .
cd deploy

# Create override file for resource limits (optimized for t3.medium - 4GB RAM)
# Note: SigNoz v0.108+ uses combined "signoz" service (UI+query) on port 8080
cat > docker-compose.override.yml << 'OVERRIDE'
services:
  clickhouse:
    deploy:
      resources:
        limits:
          memory: 1G
        reservations:
          memory: 512M

  signoz:
    deploy:
      resources:
        limits:
          memory: 384M
        reservations:
          memory: 256M

  otel-collector:
    deploy:
      resources:
        limits:
          memory: 256M
        reservations:
          memory: 128M
OVERRIDE

# Start SigNoz
docker-compose -f docker/docker-compose.yaml -f docker-compose.override.yml up -d

# Create systemd service for auto-restart on reboot
cat > /etc/systemd/system/signoz.service << 'SERVICE'
[Unit]
Description=SigNoz Observability Platform
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/signoz/deploy
ExecStart=/usr/local/bin/docker-compose -f docker/docker-compose.yaml -f docker-compose.override.yml up -d
ExecStop=/usr/local/bin/docker-compose -f docker/docker-compose.yaml -f docker-compose.override.yml down
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable signoz

# Wait for SigNoz to become healthy, then auto-register admin account
echo "Waiting for SigNoz to start..."
for i in $(seq 1 60); do
  if curl -sf http://localhost:8080/api/v1/health > /dev/null 2>&1; then
    echo "SigNoz is healthy after $((i * 10)) seconds"
    break
  fi
  sleep 10
done

# Register admin account (only works on first boot, no-op if already registered)
# Use jq to safely construct JSON (handles special chars in password)
REGISTER_PAYLOAD=$(jq -n \
  --arg email "$SIGNOZ_ADMIN_EMAIL" \
  --arg password "$SIGNOZ_ADMIN_PASSWORD" \
  '{email: $email, name: "Admin", orgName: "monitoring", password: $password}')
REGISTER_RESPONSE=$(curl -s -o /dev/null -w "%{http_code}" \
  http://localhost:8080/api/v1/register \
  -X POST -H "Content-Type: application/json" \
  -d "$REGISTER_PAYLOAD")
echo "Registration response: $REGISTER_RESPONSE"

echo "SigNoz installation completed at $(date)"

# =============================================================================
# MCP Server - colocated with SigNoz, queries ClickHouse directly
# =============================================================================
echo "Setting up MCP server at $(date)"

MCP_API_KEY="${mcpApiKey}"

# Clone monitoring repo and build MCP server image
git clone --depth 1 https://github.com/chrismlittle123/monitoring.git /tmp/monitoring-repo
cp -r /tmp/monitoring-repo/mcp /opt/monitoring-mcp
rm -rf /tmp/monitoring-repo

cd /opt/monitoring-mcp
docker build -t monitoring-mcp:latest .

# Write MCP environment file for Docker Compose
cat > /opt/signoz/deploy/.env.mcp << MCPENV
MCP_API_KEY=$MCP_API_KEY
MCPENV

# Append MCP service to docker-compose override
cat >> /opt/signoz/deploy/docker-compose.override.yml << 'MCP_OVERRIDE'

  monitoring-mcp:
    image: monitoring-mcp:latest
    ports:
      - "3001:3001"
    env_file:
      - .env.mcp
    environment:
      - CLICKHOUSE_URL=http://clickhouse:8123
      - MCP_PORT=3001
    depends_on:
      - clickhouse
    networks:
      - default
    deploy:
      resources:
        limits:
          memory: 128M
    restart: unless-stopped
MCP_OVERRIDE

# Restart services to pick up MCP
cd /opt/signoz/deploy
docker-compose -f docker/docker-compose.yaml -f docker-compose.override.yml up -d

echo "MCP server setup completed at $(date)"
`;
}

export function createSignoz(name: string, options: SignozOptions): SignozOutputs {
  const adminEmail = options.adminEmail || "admin@monitoring.local";
  const userData = buildSignozUserData(adminEmail, options.adminPassword, options.mcpApiKey);

  const instance = createInstance(name, {
    size: options.size || "medium",
    os: "ubuntu-22.04",
    diskSize: 50, // EBS volumes cannot be shrunk, keeping at 50GB
    sshKey: options.sshKey,
    allowHttp: true,   // Port 80 (not used but may be useful)
    allowHttps: true,  // Port 443 (not used but may be useful)
    additionalPorts: [
      { port: 8080, description: "SigNoz UI" },
      { port: 4317, description: "OTLP gRPC receiver" },
      { port: 4318, description: "OTLP HTTP receiver" },
      { port: 3001, description: "MCP server" },
    ],
    userData: userData as unknown as string,
  });

  return {
    url: pulumi.interpolate`http://${instance.publicIp}:8080`,
    otlpHttpEndpoint: pulumi.interpolate`http://${instance.publicIp}:4318`,
    otlpGrpcEndpoint: pulumi.interpolate`${instance.publicIp}:4317`,
    publicIp: instance.publicIp,
    instanceId: instance.instanceId,
    mcpEndpoint: pulumi.interpolate`http://${instance.publicIp}:3001`,
  };
}
