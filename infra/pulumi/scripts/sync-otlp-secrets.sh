#!/usr/bin/env bash
#
# Syncs SigNoz OTLP endpoint from Pulumi stack outputs to AWS and GCP secrets
# across all environments (dev, stag, prod).
#
# The OTLP endpoint is fetched from the source environment (default: stag)
# and synced to secrets in all target AWS accounts and optionally GCP.
#
# Usage:
#   ./scripts/sync-otlp-secrets.sh [options]
#
# Options:
#   --source ENV       Source environment to fetch OTLP endpoint from (default: stag)
#   --targets ENV,...  Comma-separated target environments (default: dev,stag,prod)
#   --aws-only         Only sync to AWS, skip GCP
#   --gcp-only         Only sync to GCP, skip AWS
#   --dry-run          Show what would be done without making changes
#   -h, --help         Show this help message
#
# Environment Variables:
#   GCP_PROJECT        GCP project ID (required for GCP sync)
#   AWS_REGION         AWS region (default: eu-west-2)
#
# Prerequisites:
#   - AWS CLI configured with profiles: dev, stag, prod
#   - gcloud CLI configured and authenticated
#   - Pulumi CLI installed
#
# Examples:
#   ./scripts/sync-otlp-secrets.sh
#   ./scripts/sync-otlp-secrets.sh --source stag --targets dev,stag,prod
#   ./scripts/sync-otlp-secrets.sh --aws-only
#   GCP_PROJECT=my-project ./scripts/sync-otlp-secrets.sh

set -euo pipefail

# Default configuration
SOURCE_ENV="stag"
TARGET_ENVS="dev,stag,prod"
AWS_REGION="${AWS_REGION:-eu-west-2}"
GCP_PROJECT="${GCP_PROJECT:-}"

# Read project name from standards.toml for consistent naming
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
STANDARDS_FILE="$REPO_ROOT/standards.toml"

if [[ -f "$STANDARDS_FILE" ]]; then
    PROJECT=$(grep -E '^project\s*=' "$STANDARDS_FILE" | awk -F'"' '{print $2}' | head -1)
fi
PROJECT="${PROJECT:-monitoring}"

# Secret name follows convention: {project}-{name}-secret-{env}
# The env suffix is added per-environment in sync_aws_secret()
SECRET_BASE_NAME="${PROJECT}-signoz-otlp-endpoint-secret"
SYNC_AWS=true
SYNC_GCP=true
DRY_RUN=false

# Get Pulumi state bucket for an environment
get_pulumi_bucket() {
    local env="$1"
    case "$env" in
        dev)  echo "s3://pulumi-state-215629979895" ;;
        stag) echo "s3://pulumi-state-978212996213" ;;
        prod) echo "s3://pulumi-state-prod" ;;  # Update with actual prod bucket
    esac
}

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_step() { echo -e "${BLUE}[STEP]${NC} $1"; }

usage() {
    head -35 "$0" | tail -30
    exit 0
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --source)
            SOURCE_ENV="$2"
            shift 2
            ;;
        --targets)
            TARGET_ENVS="$2"
            shift 2
            ;;
        --aws-only)
            SYNC_GCP=false
            shift
            ;;
        --gcp-only)
            SYNC_AWS=false
            shift
            ;;
        --dry-run)
            DRY_RUN=true
            shift
            ;;
        -h|--help)
            usage
            ;;
        *)
            log_error "Unknown option: $1"
            usage
            ;;
    esac
done

# Validate source environment
if [[ ! "$SOURCE_ENV" =~ ^(dev|stag|prod)$ ]]; then
    log_error "Invalid source environment: $SOURCE_ENV. Must be one of: dev, stag, prod"
    exit 1
fi

# Convert targets to array
IFS=',' read -ra TARGETS <<< "$TARGET_ENVS"

# Validate target environments
for env in "${TARGETS[@]}"; do
    if [[ ! "$env" =~ ^(dev|stag|prod)$ ]]; then
        log_error "Invalid target environment: $env. Must be one of: dev, stag, prod"
        exit 1
    fi
done

log_info "=== SigNoz OTLP Endpoint Secret Sync ==="
log_info "Source environment: $SOURCE_ENV"
log_info "Target environments: ${TARGETS[*]}"
log_info "AWS sync: $SYNC_AWS"
log_info "GCP sync: $SYNC_GCP"
[[ "$DRY_RUN" == "true" ]] && log_warn "DRY RUN MODE - no changes will be made"
echo ""

# Change to script directory's parent (infra/pulumi)
cd "$(dirname "$0")/.."

# Fetch OTLP endpoint from source environment
log_step "Fetching OTLP endpoint from $SOURCE_ENV environment..."

export AWS_PROFILE="$SOURCE_ENV"
PULUMI_STATE_BUCKET=$(get_pulumi_bucket "$SOURCE_ENV")

PULUMI_CONFIG_PASSPHRASE="${PULUMI_CONFIG_PASSPHRASE:-}" pulumi login "$PULUMI_STATE_BUCKET" --non-interactive 2>/dev/null
PULUMI_CONFIG_PASSPHRASE="${PULUMI_CONFIG_PASSPHRASE:-}" pulumi stack select "$SOURCE_ENV" 2>/dev/null

OTLP_HTTP=$(PULUMI_CONFIG_PASSPHRASE="${PULUMI_CONFIG_PASSPHRASE:-}" pulumi stack output signozOtlpHttp 2>/dev/null || echo "")
OTLP_GRPC=$(PULUMI_CONFIG_PASSPHRASE="${PULUMI_CONFIG_PASSPHRASE:-}" pulumi stack output signozOtlpGrpc 2>/dev/null || echo "")

if [[ -z "$OTLP_HTTP" ]]; then
    log_error "Failed to get otlpHttpEndpoint from Pulumi stack '$SOURCE_ENV'"
    log_error "Make sure SigNoz is deployed in the $SOURCE_ENV environment"
    exit 1
fi

log_info "OTLP HTTP Endpoint: $OTLP_HTTP"
log_info "OTLP gRPC Endpoint: $OTLP_GRPC"
echo ""

# Create JSON secret value
SECRET_VALUE=$(cat <<EOF
{
  "http": "$OTLP_HTTP",
  "grpc": "$OTLP_GRPC",
  "source_environment": "$SOURCE_ENV"
}
EOF
)

# Sync to AWS Secrets Manager for a specific environment
sync_aws_secret() {
    local env="$1"
    local secret_name="${SECRET_BASE_NAME}-${env}"

    log_step "Syncing to AWS Secrets Manager ($env account)..."
    log_info "Secret name: $secret_name"

    export AWS_PROFILE="$env"

    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "[DRY RUN] Would create/update secret '$secret_name' in $env account"
        return 0
    fi

    # Check if secret exists
    if aws secretsmanager describe-secret --secret-id "$secret_name" --region "$AWS_REGION" &>/dev/null; then
        log_info "Updating existing secret: $secret_name"
        aws secretsmanager put-secret-value \
            --secret-id "$secret_name" \
            --secret-string "$SECRET_VALUE" \
            --region "$AWS_REGION"
    else
        log_info "Creating new secret: $secret_name"
        aws secretsmanager create-secret \
            --name "$secret_name" \
            --description "SigNoz OTLP endpoints (source: $SOURCE_ENV)" \
            --secret-string "$SECRET_VALUE" \
            --region "$AWS_REGION" \
            --tags "Key=Environment,Value=$env" "Key=SourceEnvironment,Value=$SOURCE_ENV" "Key=ManagedBy,Value=sync-otlp-secrets"
    fi

    log_info "AWS secret synced to $env account"
}

# Sync to GCP Secret Manager for a specific environment
sync_gcp_secret() {
    local env="$1"
    local gcp_project="christopher-little-${env}"
    local secret_name="${SECRET_BASE_NAME}-${env}"

    log_step "Syncing to GCP Secret Manager ($gcp_project)..."
    log_info "Secret name: $secret_name"

    if [[ "$DRY_RUN" == "true" ]]; then
        log_info "[DRY RUN] Would create/update secret '$secret_name' in GCP project $gcp_project"
        return 0
    fi

    # Check if Secret Manager API is enabled
    if ! gcloud secrets list --project="$gcp_project" --limit=1 &>/dev/null; then
        log_warn "Secret Manager API not enabled in $gcp_project, skipping"
        return 0
    fi

    # Check if secret exists
    if gcloud secrets describe "$secret_name" --project="$gcp_project" &>/dev/null; then
        log_info "Adding new version to existing secret: $secret_name"
        echo -n "$SECRET_VALUE" | gcloud secrets versions add "$secret_name" \
            --project="$gcp_project" \
            --data-file=-
    else
        log_info "Creating new secret: $secret_name"
        echo -n "$SECRET_VALUE" | gcloud secrets create "$secret_name" \
            --project="$gcp_project" \
            --data-file=- \
            --labels="source-environment=$SOURCE_ENV,managed-by=sync-otlp-secrets"
    fi

    log_info "GCP secret synced to $gcp_project"
}

# Run AWS sync for all target environments
if [[ "$SYNC_AWS" == "true" ]]; then
    for env in "${TARGETS[@]}"; do
        sync_aws_secret "$env"
        echo ""
    done
fi

# Run GCP sync for all target environments
if [[ "$SYNC_GCP" == "true" ]]; then
    for env in "${TARGETS[@]}"; do
        sync_gcp_secret "$env"
        echo ""
    done
fi

log_info "=== Secret sync completed successfully! ==="
echo ""
log_info "To retrieve the secrets:"
for env in "${TARGETS[@]}"; do
    log_info "  AWS ($env): AWS_PROFILE=$env aws secretsmanager get-secret-value --secret-id ${SECRET_BASE_NAME}-${env} --region $AWS_REGION --query SecretString --output text"
    log_info "  GCP ($env): gcloud secrets versions access latest --secret=${SECRET_BASE_NAME}-${env} --project=christopher-little-${env}"
done
