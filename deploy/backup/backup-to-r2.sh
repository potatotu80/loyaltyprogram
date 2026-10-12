#!/usr/bin/env bash

set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/contact}"
ENV_FILE="${ENV_FILE:-$APP_DIR/.env}"
BACKUP_LOCAL_DIR="${BACKUP_LOCAL_DIR:-/var/backups/contact}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
BACKUP_KEEP_LOCAL="${BACKUP_KEEP_LOCAL:-false}"
BACKUP_DB_PREFIX="${BACKUP_DB_PREFIX:-db-backups}"
BACKUP_MEDIA_PREFIX="${BACKUP_MEDIA_PREFIX:-media-backups}"
AWS_BIN="${AWS_BIN:-}"

log() {
  printf '[backup][%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    log "missing required command: $1"
    exit 1
  fi
}

resolve_aws_bin() {
  if [[ -n "${AWS_BIN:-}" && -x "${AWS_BIN:-}" ]]; then
    printf '%s\n' "$AWS_BIN"
    return 0
  fi

  local candidates=(
    "${HOME:-}/.local/bin/aws"
    "/usr/local/bin/aws"
    "/usr/bin/aws"
  )

  local candidate
  for candidate in "${candidates[@]}"; do
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done

  if command -v aws >/dev/null 2>&1; then
    command -v aws
    return 0
  fi

  return 1
}

load_env_file() {
  if [[ -f "$ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
  fi
}

normalize_bool() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

build_s3_uri() {
  local key="$1"
  printf 's3://%s/%s' "$BACKUP_R2_BUCKET" "$key"
}

upload_file() {
  local source_file="$1"
  local object_key="$2"

  AWS_ACCESS_KEY_ID="$BACKUP_R2_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$BACKUP_R2_SECRET_ACCESS_KEY" \
  AWS_DEFAULT_REGION="$BACKUP_R2_REGION" \
  "$AWS_BIN" --endpoint-url "$BACKUP_R2_ENDPOINT" s3 cp \
    "$source_file" \
    "$(build_s3_uri "$object_key")" \
    --only-show-errors
}

prune_remote_prefix() {
  local prefix="$1"
  local cutoff_epoch="$2"

  while read -r object_date object_time _ object_key; do
    [[ -z "${object_key:-}" ]] && continue
    local object_epoch
    object_epoch="$(date -d "${object_date} ${object_time}" +%s)"
    if [[ "$object_epoch" -lt "$cutoff_epoch" ]]; then
      log "deleting expired remote backup: ${object_key}"
      AWS_ACCESS_KEY_ID="$BACKUP_R2_ACCESS_KEY_ID" \
      AWS_SECRET_ACCESS_KEY="$BACKUP_R2_SECRET_ACCESS_KEY" \
      AWS_DEFAULT_REGION="$BACKUP_R2_REGION" \
      "$AWS_BIN" --endpoint-url "$BACKUP_R2_ENDPOINT" s3 rm \
        "$(build_s3_uri "$object_key")" \
        --only-show-errors >/dev/null
    fi
  done < <(
    AWS_ACCESS_KEY_ID="$BACKUP_R2_ACCESS_KEY_ID" \
    AWS_SECRET_ACCESS_KEY="$BACKUP_R2_SECRET_ACCESS_KEY" \
    AWS_DEFAULT_REGION="$BACKUP_R2_REGION" \
    "$AWS_BIN" --endpoint-url "$BACKUP_R2_ENDPOINT" s3 ls \
      "$(build_s3_uri "$prefix/")" \
      --recursive
  )
}

main() {
  require_command pg_dump
  require_command gzip
  require_command tar
  require_command date

  AWS_BIN="$(resolve_aws_bin || true)"
  if [[ -z "$AWS_BIN" ]]; then
    log "missing required command: aws"
    log "set AWS_BIN explicitly or install aws via apt/pipx so it is available in PATH or ~/.local/bin/aws"
    exit 1
  fi

  load_env_file

  : "${DATABASE_HOST:?DATABASE_HOST is required}"
  : "${DATABASE_PORT:?DATABASE_PORT is required}"
  : "${DATABASE_NAME:?DATABASE_NAME is required}"
  : "${DATABASE_USERNAME:?DATABASE_USERNAME is required}"
  : "${DATABASE_PASSWORD:?DATABASE_PASSWORD is required}"

  BACKUP_R2_BUCKET="${BACKUP_R2_BUCKET:-${R2_BUCKET_NAME:-}}"
  BACKUP_R2_ENDPOINT="${BACKUP_R2_ENDPOINT:-${R2_ENDPOINT:-}}"
  BACKUP_R2_ACCESS_KEY_ID="${BACKUP_R2_ACCESS_KEY_ID:-${R2_ACCESS_KEY_ID:-}}"
  BACKUP_R2_SECRET_ACCESS_KEY="${BACKUP_R2_SECRET_ACCESS_KEY:-${R2_SECRET_ACCESS_KEY:-}}"
  BACKUP_R2_REGION="${BACKUP_R2_REGION:-${R2_REGION:-auto}}"

  : "${BACKUP_R2_BUCKET:?BACKUP_R2_BUCKET or R2_BUCKET_NAME is required}"
  : "${BACKUP_R2_ENDPOINT:?BACKUP_R2_ENDPOINT or R2_ENDPOINT is required}"
  : "${BACKUP_R2_ACCESS_KEY_ID:?BACKUP_R2_ACCESS_KEY_ID or R2_ACCESS_KEY_ID is required}"
  : "${BACKUP_R2_SECRET_ACCESS_KEY:?BACKUP_R2_SECRET_ACCESS_KEY or R2_SECRET_ACCESS_KEY is required}"

  mkdir -p "$BACKUP_LOCAL_DIR"

  local timestamp
  timestamp="$(date '+%Y-%m-%d-%H%M%S')"

  local db_backup_file media_backup_file
  db_backup_file="$BACKUP_LOCAL_DIR/contact-db-${timestamp}.sql.gz"
  media_backup_file="$BACKUP_LOCAL_DIR/contact-media-${timestamp}.tar.gz"

  local uploads_dir
  uploads_dir="$APP_DIR/public/uploads"

  log "starting database backup"
  PGPASSWORD="$DATABASE_PASSWORD" pg_dump \
    --host "$DATABASE_HOST" \
    --port "$DATABASE_PORT" \
    --username "$DATABASE_USERNAME" \
    --dbname "$DATABASE_NAME" \
    --no-owner \
    --no-privileges | gzip -c > "$db_backup_file"

  log "database backup created: $db_backup_file"
  upload_file "$db_backup_file" "$BACKUP_DB_PREFIX/$(basename "$db_backup_file")"
  log "database backup uploaded"

  if [[ -d "$uploads_dir" ]]; then
    log "starting media library backup from $uploads_dir"
    tar -C "$APP_DIR/public" -czf "$media_backup_file" uploads
    log "media library backup created: $media_backup_file"
    upload_file "$media_backup_file" "$BACKUP_MEDIA_PREFIX/$(basename "$media_backup_file")"
    log "media library backup uploaded"
  else
    log "media library folder not found, skipping media backup: $uploads_dir"
  fi

  local cutoff_epoch
  cutoff_epoch="$(date -d "-${BACKUP_RETENTION_DAYS} days" +%s)"
  prune_remote_prefix "$BACKUP_DB_PREFIX" "$cutoff_epoch"
  prune_remote_prefix "$BACKUP_MEDIA_PREFIX" "$cutoff_epoch"

  if ! normalize_bool "$BACKUP_KEEP_LOCAL"; then
    rm -f "$db_backup_file" "$media_backup_file"
    log "local backup files removed"
  fi

  log "backup completed successfully"
}

main "$@"
