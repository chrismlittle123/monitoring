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
}

/**
 * User data script to install Docker and run SigNoz via Docker Compose
 */
const signozUserData = `#!/bin/bash
set -e

# Log output to file for debugging
exec > >(tee /var/log/user-data.log) 2>&1
echo "Starting SigNoz installation at $(date)"

# Update system
apt-get update
apt-get upgrade -y

# Install Docker
apt-get install -y apt-transport-https ca-certificates curl gnupg lsb-release
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

echo "SigNoz installation completed at $(date)"
`;

export function createSignoz(name: string, options: SignozOptions = {}): SignozOutputs {
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
    ],
    userData: signozUserData,
  });

  return {
    url: pulumi.interpolate`http://${instance.publicIp}:8080`,
    otlpHttpEndpoint: pulumi.interpolate`http://${instance.publicIp}:4318`,
    otlpGrpcEndpoint: pulumi.interpolate`${instance.publicIp}:4317`,
    publicIp: instance.publicIp,
    instanceId: instance.instanceId,
  };
}
