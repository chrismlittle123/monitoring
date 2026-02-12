# Agent Instructions

## Project Overview

monitoring is the observability infrastructure stack (SigNoz on AWS). Built with TypeScript and Pulumi.

- **Tier:** internal
- **Package:** `monitoring`

## Quick Reference

| Task | Command |
|------|---------|
| Install | `pnpm install` |
| Deploy | Push to `main` (CI runs Pulumi automatically) |

**Do not run Pulumi locally** — always deploy via CI by pushing to main.

## Architecture

```
infra/
  pulumi/      # Pulumi IaC (AWS resources, SigNoz, secrets)
docs/
  runbook.md   # Infrastructure runbook (secrets, sizing, destroy procedures)
```

## Standards & Guidelines

This project uses [@standards-kit/conform](https://github.com/chrismlittle123/standards-kit) for coding standards.

- **Config:** `standards.toml` (extends `typescript-internal` from the standards registry)
- **Guidelines:** https://chrismlittle123.github.io/standards/

Use the MCP tools to query standards at any time:

| Tool | Purpose |
|------|---------|
| `get_standards` | Get guidelines matching a context (e.g., `typescript pulumi`) |
| `list_guidelines` | List all available guidelines |
| `get_guideline` | Get a specific guideline by ID |
| `get_ruleset` | Get a tool configuration ruleset (e.g., `typescript-internal`) |

## Workflow

- **Branch:** Create feature branches from `main`
- **CI:** GitHub Actions runs Pulumi on push to `main`
- **Deploy:** Pulumi via CI (push to main triggers `pulumi up`)
- **Commits:** Use conventional commits (`feat:`, `fix:`, `chore:`, etc.)

## MCP Server

An MCP server runs colocated with SigNoz on the EC2 instance, providing coding agents direct access to ClickHouse telemetry data.

- **Source:** `mcp/` directory
- **Port:** 3001 (exposed via security group)
- **Auth:** Bearer token via `MCP_API_KEY` environment variable
- **Secret:** `monitoring-mcp-api-key-secret-dev` (contains `apiKey` and `endpoint`)

### Verifying MCP Server

```bash
MCP_SECRET=$(AWS_PROFILE=dev aws secretsmanager get-secret-value \
  --secret-id monitoring-mcp-api-key-secret-dev \
  --region eu-west-2 --query SecretString --output text)
ENDPOINT=$(echo "$MCP_SECRET" | jq -r .endpoint)
KEY=$(echo "$MCP_SECRET" | jq -r .apiKey)

# Health check (unauthenticated)
curl "$ENDPOINT/health"

# Ping tool (authenticated)
curl -H "Authorization: Bearer $KEY" "$ENDPOINT/mcp" \
  -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"ping"}}'
```

## Project-Specific Notes

- See `docs/runbook.md` for detailed infrastructure operations (secrets, sizing, destroy procedures, SigNoz login)
- AWS account: single environment, OIDC configured for GitHub Actions
- Secrets follow the pattern: `{project}-{name}-secret-{env}`
- Never run Pulumi locally — always use CI
