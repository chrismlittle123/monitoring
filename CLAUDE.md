# Claude Code Instructions

## Deployment

**ALWAYS deploy by pushing to GitHub on main branch.** The GitHub Actions workflow will automatically run Pulumi to deploy changes.

Do not attempt to run Pulumi locally - use the CI/CD pipeline.

## Infrastructure

- AWS resources are managed via Pulumi in `infra/pulumi/`
- Single environment in AWS account `215629979895`
- State is stored in S3: `s3://pulumi-state-215629979895`
- OIDC is configured for GitHub Actions to assume `github-actions-pulumi` role

## Regenerating the Infrastructure Manifest

The `infra/pulumi/infra-manifest.json` file contains ARNs of deployed AWS resources. To regenerate it:

```bash
cd infra/pulumi

AWS_PROFILE=dev AWS_REGION=eu-west-2 PULUMI_CONFIG_PASSPHRASE="" \
  pulumi login s3://pulumi-state-215629979895 && \
  pulumi stack select dev && \
  pulumi stack export > /tmp/stack-export.json

# Generate manifest from export
node -e "
const infra = require('@chrismlittle123/infra');
const fs = require('fs');
const data = fs.readFileSync('/tmp/stack-export.json', 'utf-8');
const m = infra.parseStackExport(JSON.parse(data));
fs.writeFileSync('infra-manifest.json', JSON.stringify(m, null, 2));
console.log('Manifest regenerated with', m.resources.length, 'resources');
"
```

**Note:** Requires AWS credentials configured for the dev profile.

## Secrets Management

### Naming Convention

Secrets follow the pattern: `{project}-{name}-secret-{env}`

Example: `monitoring-signoz-otlp-endpoint-secret-dev`

### Current Secrets

| Secret | Managed By | Description |
|--------|-----------|-------------|
| `monitoring-signoz-otlp-endpoint-secret-dev` | Pulumi (`createSecret`) | SigNoz OTLP endpoints (HTTP + gRPC) |

The OTLP endpoint secret is created via `createSecret` in `infra/pulumi/src/index.ts`. Pulumi keeps the secret value in sync with the EC2 instance IP on every `pulumi up` — no manual sync step is needed.

### Verifying Secrets

```bash
# Check secret value
AWS_PROFILE=dev aws secretsmanager get-secret-value \
  --secret-id monitoring-signoz-otlp-endpoint-secret-dev \
  --region eu-west-2 --query SecretString --output text | jq .
```

## Destroying Resources

To tear down all resources, use the destroy workflow:

```bash
gh workflow run destroy.yml

# Monitor the workflow
gh run watch <run-id>
```

## Resource Sizing

| Component | Size | Instance Type | RAM |
|-----------|------|---------------|-----|
| SigNoz EC2 | medium | t3.medium | 4GB |

**Note:** SigNoz requires at least `medium` size. The `small` size (t3.micro, 1GB) is insufficient to run ClickHouse + OTel collector + query service.
