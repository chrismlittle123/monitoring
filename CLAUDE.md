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
| `monitoring-signoz-admin-credentials-secret-dev` | Pulumi (`createSecret`) | SigNoz admin email, password, and URL |

All secrets are created via `createSecret` in `infra/pulumi/src/index.ts`. Pulumi keeps values in sync with infrastructure on every `pulumi up`.

The admin password is auto-generated via `@pulumi/random.RandomPassword` and the admin account is auto-registered on first boot via the EC2 user data script.

### Verifying Secrets

```bash
# Check OTLP endpoints
AWS_PROFILE=dev aws secretsmanager get-secret-value \
  --secret-id monitoring-signoz-otlp-endpoint-secret-dev \
  --region eu-west-2 --query SecretString --output text | jq .

# Check admin credentials
AWS_PROFILE=dev aws secretsmanager get-secret-value \
  --secret-id monitoring-signoz-admin-credentials-secret-dev \
  --region eu-west-2 --query SecretString --output text | jq .
```

### SigNoz Login

Retrieve credentials from AWS Secrets Manager (see above) and use the v2 session API:

```bash
# Get credentials
CREDS=$(AWS_PROFILE=dev aws secretsmanager get-secret-value \
  --secret-id monitoring-signoz-admin-credentials-secret-dev \
  --region eu-west-2 --query SecretString --output text)
URL=$(echo $CREDS | jq -r .url)
EMAIL=$(echo $CREDS | jq -r .email)
PASSWORD=$(echo $CREDS | jq -r .password)

# Get session context (for org ID)
ORG_ID=$(curl -s "$URL/api/v2/sessions/context?email=$EMAIL&ref=$URL" | jq -r '.data.orgs[0].id')

# Login
curl -s "$URL/api/v2/sessions/email_password" \
  -X POST -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\",\"orgID\":\"$ORG_ID\"}"
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
