#!/usr/bin/env bash
#
# Audits and renames cloud resources to follow the naming convention:
#   {project}-{name}-{component}-{environment}
#
# For this project: monitoring-{name}-{component}-{environment}
#
# Usage:
#   ./scripts/audit-resource-names.sh [options]
#
# Options:
#   --fix              Actually rename resources (default: audit only)
#   --aws-only         Only process AWS resources
#   --gcp-only         Only process GCP resources
#   --env ENV          Only process specific environment (dev, stag, prod)
#   -h, --help         Show this help message
#
# Examples:
#   ./scripts/audit-resource-names.sh                    # Audit all
#   ./scripts/audit-resource-names.sh --env dev          # Audit dev only
#   ./scripts/audit-resource-names.sh --fix --env stag   # Fix stag resources

set -euo pipefail

# Configuration
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
STANDARDS_FILE="$REPO_ROOT/standards.toml"

# Read project name from standards.toml
if [[ -f "$STANDARDS_FILE" ]]; then
    PROJECT=$(grep -E '^project\s*=' "$STANDARDS_FILE" | awk -F'"' '{print $2}' | head -1)
    if [[ -z "$PROJECT" ]]; then
        echo "Error: 'project' not found in $STANDARDS_FILE [metadata] section" >&2
        exit 1
    fi
else
    echo "Error: standards.toml not found at $STANDARDS_FILE" >&2
    exit 1
fi

AWS_REGION="${AWS_REGION:-eu-west-2}"
FIX_MODE=false
AWS_ONLY=false
GCP_ONLY=false
TARGET_ENV=""

# GCP Projects
declare -a GCP_PROJECTS=("christopher-little-dev" "christopher-little-stag" "christopher-little-prod")

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }
log_header() { echo -e "\n${BLUE}=== $1 ===${NC}"; }
log_ok() { echo -e "  ${GREEN}✓${NC} $1"; }
log_bad() { echo -e "  ${RED}✗${NC} $1 ${CYAN}→${NC} $2"; }
log_skip() { echo -e "  ${YELLOW}⊘${NC} $1 (cannot rename in place)"; }

usage() {
    head -20 "$0" | tail -17
    exit 0
}

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --fix) FIX_MODE=true; shift ;;
        --aws-only) AWS_ONLY=true; shift ;;
        --gcp-only) GCP_ONLY=true; shift ;;
        --env) TARGET_ENV="$2"; shift 2 ;;
        -h|--help) usage ;;
        *) log_error "Unknown option: $1"; usage ;;
    esac
done

# Naming convention functions
expected_secret_name() {
    local name="$1" env="$2"
    echo "${PROJECT}-${name}-secret-${env}"
}

expected_database_name() {
    local name="$1" env="$2"
    echo "${PROJECT}-${name}-database-${env}"
}

expected_container_name() {
    local name="$1" env="$2"
    echo "${PROJECT}-${name}-container-${env}"
}

expected_redis_name() {
    local name="$1" env="$2"
    echo "${PROJECT}-${name}-redis-${env}"
}

expected_instance_name() {
    local name="$1" env="$2"
    echo "${PROJECT}-${name}-instance-${env}"
}

# Check if name follows convention: {project}-{name}-{component}-{env}
check_name() {
    local current="$1" component="$2" env="$3"
    local pattern="^${PROJECT}-[a-z0-9-]+-${component}-${env}$"
    [[ "$current" =~ $pattern ]]
}

# Extract the logical name from a resource name
extract_logical_name() {
    local current="$1" component="$2" env="$3"
    # Try to extract from existing patterns
    local name=""

    # Pattern: {project}-{name}-{component}-{env} (correct)
    if [[ "$current" =~ ^${PROJECT}-(.+)-${component}-${env}$ ]]; then
        name="${BASH_REMATCH[1]}"
    # Pattern: {name}-{env} (missing project/component)
    elif [[ "$current" =~ ^(.+)-${env}$ ]]; then
        name="${BASH_REMATCH[1]}"
    # Pattern: {env}-{name} (env prefix instead of suffix)
    elif [[ "$current" =~ ^${env}-(.+)$ ]]; then
        name="${BASH_REMATCH[1]}"
    # Pattern: {name} (no env at all)
    else
        name="$current"
    fi

    # Clean up common redundancies
    name="${name//-secret/}"
    name="${name//-database/}"
    name="${name//-container/}"
    name="${name//-redis-redis/-redis}"  # Fix redis-redis
    name="${name//-redis/}"
    name="${name//-instance/}"
    name="${name//-${env}/}"  # Remove env if still present
    name="${name//${env}-/}"  # Remove env prefix if present
    name="${name//${PROJECT}-/}"  # Remove project if present

    echo "$name"
}

# Counters
TOTAL=0
CORRECT=0
INCORRECT=0
UNFIXABLE=0

# ============================================================================
# AWS AUDIT FUNCTIONS
# ============================================================================

audit_aws_secrets() {
    local env="$1"
    local profile="$env"

    log_header "AWS Secrets Manager ($env)"

    local secrets
    secrets=$(AWS_PROFILE="$profile" aws secretsmanager list-secrets \
        --region "$AWS_REGION" \
        --query 'SecretList[].Name' \
        --output text 2>/dev/null | tr '\t' '\n') || return 0

    [[ -z "$secrets" ]] && { log_info "No secrets found"; return 0; }

    while read -r secret; do
        [[ -z "$secret" ]] && continue
        ((TOTAL++))

        if check_name "$secret" "secret" "$env"; then
            log_ok "$secret"
            ((CORRECT++))
        else
            local logical_name
            logical_name=$(extract_logical_name "$secret" "secret" "$env")
            local expected
            expected=$(expected_secret_name "$logical_name" "$env")
            log_bad "$secret" "$expected"
            ((INCORRECT++))

            if [[ "$FIX_MODE" == "true" ]]; then
                rename_aws_secret "$profile" "$secret" "$expected"
            fi
        fi
    done <<< "$secrets"
}

rename_aws_secret() {
    local profile="$1" old_name="$2" new_name="$3"

    log_info "Renaming secret: $old_name → $new_name"

    # Get the secret value
    local secret_value
    secret_value=$(AWS_PROFILE="$profile" aws secretsmanager get-secret-value \
        --secret-id "$old_name" \
        --region "$AWS_REGION" \
        --query 'SecretString' \
        --output text 2>/dev/null) || {
        log_error "Failed to get secret value for $old_name"
        return 1
    }

    # Create new secret
    AWS_PROFILE="$profile" aws secretsmanager create-secret \
        --name "$new_name" \
        --secret-string "$secret_value" \
        --region "$AWS_REGION" \
        --tags "Key=Environment,Value=$env" "Key=ManagedBy,Value=audit-resource-names" || {
        log_error "Failed to create new secret $new_name"
        return 1
    }

    # Delete old secret
    AWS_PROFILE="$profile" aws secretsmanager delete-secret \
        --secret-id "$old_name" \
        --force-delete-without-recovery \
        --region "$AWS_REGION" || {
        log_warn "Failed to delete old secret $old_name (new secret created)"
    }

    log_info "Successfully renamed secret"
}

audit_aws_ecs() {
    local env="$1"
    local profile="$env"

    log_header "AWS ECS Clusters ($env)"

    local clusters
    clusters=$(AWS_PROFILE="$profile" aws ecs list-clusters \
        --region "$AWS_REGION" \
        --query 'clusterArns[*]' \
        --output text 2>/dev/null | tr '\t' '\n' | xargs -I{} basename {}) || return 0

    [[ -z "$clusters" ]] && { log_info "No ECS clusters found"; return 0; }

    while read -r cluster; do
        [[ -z "$cluster" ]] && continue
        ((TOTAL++))

        if check_name "$cluster" "container" "$env"; then
            log_ok "$cluster"
            ((CORRECT++))
        else
            local logical_name
            logical_name=$(extract_logical_name "$cluster" "container" "$env")
            local expected
            expected=$(expected_container_name "$logical_name" "$env")
            log_skip "$cluster → $expected"
            ((UNFIXABLE++))
        fi
    done <<< "$clusters"
}

audit_aws_rds() {
    local env="$1"
    local profile="$env"

    log_header "AWS RDS Databases ($env)"

    local databases
    databases=$(AWS_PROFILE="$profile" aws rds describe-db-instances \
        --region "$AWS_REGION" \
        --query 'DBInstances[].DBInstanceIdentifier' \
        --output text 2>/dev/null | tr '\t' '\n') || return 0

    [[ -z "$databases" ]] && { log_info "No RDS databases found"; return 0; }

    while read -r db; do
        [[ -z "$db" ]] && continue
        ((TOTAL++))

        if check_name "$db" "database" "$env"; then
            log_ok "$db"
            ((CORRECT++))
        else
            local logical_name
            logical_name=$(extract_logical_name "$db" "database" "$env")
            local expected
            expected=$(expected_database_name "$logical_name" "$env")
            log_skip "$db → $expected"
            ((UNFIXABLE++))
        fi
    done <<< "$databases"
}

audit_aws_elasticache() {
    local env="$1"
    local profile="$env"

    log_header "AWS ElastiCache ($env)"

    local clusters
    clusters=$(AWS_PROFILE="$profile" aws elasticache describe-cache-clusters \
        --region "$AWS_REGION" \
        --query 'CacheClusters[].CacheClusterId' \
        --output text 2>/dev/null | tr '\t' '\n') || return 0

    [[ -z "$clusters" ]] && { log_info "No ElastiCache clusters found"; return 0; }

    while read -r cluster; do
        [[ -z "$cluster" ]] && continue
        ((TOTAL++))

        if check_name "$cluster" "redis" "$env"; then
            log_ok "$cluster"
            ((CORRECT++))
        else
            local logical_name
            logical_name=$(extract_logical_name "$cluster" "redis" "$env")
            local expected
            expected=$(expected_redis_name "$logical_name" "$env")
            log_skip "$cluster → $expected"
            ((UNFIXABLE++))
        fi
    done <<< "$clusters"
}

# ============================================================================
# GCP AUDIT FUNCTIONS
# ============================================================================

audit_gcp_secrets() {
    local project="$1"
    local env="${project##*-}"  # Extract env from project name

    log_header "GCP Secret Manager ($project)"

    local secrets
    secrets=$(gcloud secrets list --project="$project" --format="value(name)" 2>/dev/null) || {
        log_warn "Secret Manager API not enabled or no access"
        return 0
    }

    [[ -z "$secrets" ]] && { log_info "No secrets found"; return 0; }

    while read -r secret; do
        [[ -z "$secret" ]] && continue
        ((TOTAL++))

        if check_name "$secret" "secret" "$env"; then
            log_ok "$secret"
            ((CORRECT++))
        else
            local logical_name
            logical_name=$(extract_logical_name "$secret" "secret" "$env")
            local expected
            expected=$(expected_secret_name "$logical_name" "$env")
            log_bad "$secret" "$expected"
            ((INCORRECT++))

            if [[ "$FIX_MODE" == "true" ]]; then
                rename_gcp_secret "$project" "$secret" "$expected"
            fi
        fi
    done <<< "$secrets"
}

rename_gcp_secret() {
    local project="$1" old_name="$2" new_name="$3"

    log_info "Renaming GCP secret: $old_name → $new_name"

    # Get the latest secret version
    local secret_value
    secret_value=$(gcloud secrets versions access latest \
        --secret="$old_name" \
        --project="$project" 2>/dev/null) || {
        log_error "Failed to get secret value for $old_name"
        return 1
    }

    # Create new secret
    echo -n "$secret_value" | gcloud secrets create "$new_name" \
        --project="$project" \
        --data-file=- \
        --labels="managed-by=audit-resource-names" || {
        log_error "Failed to create new secret $new_name"
        return 1
    }

    # Delete old secret
    gcloud secrets delete "$old_name" \
        --project="$project" \
        --quiet || {
        log_warn "Failed to delete old secret $old_name (new secret created)"
    }

    log_info "Successfully renamed GCP secret"
}

audit_gcp_cloud_run() {
    local project="$1"
    local env="${project##*-}"

    log_header "GCP Cloud Run ($project)"

    local services
    services=$(gcloud run services list --project="$project" --format="value(metadata.name)" 2>/dev/null) || {
        log_warn "Cloud Run API not enabled or no access"
        return 0
    }

    [[ -z "$services" ]] && { log_info "No Cloud Run services found"; return 0; }

    while read -r service; do
        [[ -z "$service" ]] && continue
        ((TOTAL++))

        if check_name "$service" "container" "$env"; then
            log_ok "$service"
            ((CORRECT++))
        else
            local logical_name
            logical_name=$(extract_logical_name "$service" "container" "$env")
            local expected
            expected=$(expected_container_name "$logical_name" "$env")
            log_skip "$service → $expected"
            ((UNFIXABLE++))
        fi
    done <<< "$services"
}

# ============================================================================
# MAIN
# ============================================================================

echo -e "${BLUE}"
echo "╔══════════════════════════════════════════════════════════════════╗"
echo "║           Resource Naming Convention Audit                       ║"
echo "║                                                                  ║"
echo "║  Convention: {project}-{name}-{component}-{environment}          ║"
echo "║  Project:    ${PROJECT}                                              ║"
echo "╚══════════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

if [[ "$FIX_MODE" == "true" ]]; then
    log_warn "FIX MODE ENABLED - Resources will be renamed!"
    echo ""
    read -p "Are you sure you want to proceed? (yes/no): " confirm
    [[ "$confirm" != "yes" ]] && { log_info "Aborted"; exit 0; }
fi

# Determine environments to audit
if [[ -n "$TARGET_ENV" ]]; then
    ENVS=("$TARGET_ENV")
else
    ENVS=("dev" "stag")  # Skip prod if no profile
fi

# AWS Audit
if [[ "$GCP_ONLY" != "true" ]]; then
    for env in "${ENVS[@]}"; do
        audit_aws_secrets "$env"
        audit_aws_ecs "$env"
        audit_aws_rds "$env"
        audit_aws_elasticache "$env"
    done
fi

# GCP Audit
if [[ "$AWS_ONLY" != "true" ]]; then
    for project in "${GCP_PROJECTS[@]}"; do
        # Filter by target env if specified
        if [[ -n "$TARGET_ENV" ]] && [[ "$project" != *"-$TARGET_ENV" ]]; then
            continue
        fi
        audit_gcp_secrets "$project"
        audit_gcp_cloud_run "$project"
    done
fi

# Summary
echo ""
log_header "SUMMARY"
echo -e "  Total resources:     ${TOTAL}"
echo -e "  ${GREEN}Correct:${NC}             ${CORRECT}"
echo -e "  ${RED}Incorrect:${NC}           ${INCORRECT}"
echo -e "  ${YELLOW}Cannot rename:${NC}       ${UNFIXABLE}"
echo ""

if [[ "$INCORRECT" -gt 0 ]] && [[ "$FIX_MODE" != "true" ]]; then
    log_info "Run with --fix to rename incorrect resources"
fi

if [[ "$UNFIXABLE" -gt 0 ]]; then
    log_warn "Some resources cannot be renamed in place (ECS, RDS, ElastiCache)"
    log_warn "These must be recreated via Pulumi with correct names"
fi

exit 0
