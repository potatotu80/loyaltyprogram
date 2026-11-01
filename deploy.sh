#!/usr/bin/env bash

set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_REMOTE="${DEPLOY_REMOTE:-origin}"
DEPLOY_BRANCH="${DEPLOY_BRANCH:-main}"
PM2_APP_NAME="${PM2_APP_NAME:-loyaltyprogram-strapi}"
HEALTHCHECK_URL="${HEALTHCHECK_URL:-http://127.0.0.1:1337/admin/}"

log() {
  printf '[deploy][%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

fail() {
  log "ERROR: $*"
  exit 1
}

if [[ "${EUID}" -eq 0 ]]; then
  fail 'Run this script as the application user (for example ubuntu), not with sudo.'
fi

command -v git >/dev/null || fail 'git is required.'
command -v npm >/dev/null || fail 'npm is required.'
command -v pm2 >/dev/null || fail 'pm2 is required.'
command -v curl >/dev/null || fail 'curl is required.'
command -v flock >/dev/null || fail 'flock is required.'

cd "$APP_DIR"
[[ -f .env ]] || fail 'Missing .env. Create the production environment file before deploying.'
git remote get-url "$DEPLOY_REMOTE" >/dev/null 2>&1 || fail "Git remote '$DEPLOY_REMOTE' is not configured."

# Prevent two deployment sessions from rebuilding or restarting Strapi concurrently.
exec 9>"$APP_DIR/.deploy.lock"
flock -n 9 || fail 'Another deployment is already running.'

if ! git diff --quiet || ! git diff --cached --quiet; then
  fail 'Tracked local changes are present. Commit, stash, or resolve them before deploying.'
fi

previous_head="$(git rev-parse HEAD)"
log "Fetching ${DEPLOY_REMOTE}/${DEPLOY_BRANCH}"
git fetch "$DEPLOY_REMOTE" "$DEPLOY_BRANCH"
remote_head="$(git rev-parse "${DEPLOY_REMOTE}/${DEPLOY_BRANCH}")"

if [[ "$previous_head" != "$remote_head" ]]; then
  if ! git merge-base --is-ancestor "$previous_head" "$remote_head"; then
    fail "Local branch is not a fast-forward ancestor of ${DEPLOY_REMOTE}/${DEPLOY_BRANCH}. Resolve the Git history manually."
  fi

  log 'Fast-forwarding application code'
  git merge --ff-only "$remote_head"
else
  log 'Application code is already up to date'
fi

if [[ ! -d node_modules ]] || ! git diff --quiet "$previous_head" HEAD -- package.json package-lock.json; then
  log 'Installing Node.js dependencies'
  npm ci
fi

log 'Building Strapi admin UI'
NODE_ENV=production npm run build

if pm2 describe "$PM2_APP_NAME" >/dev/null 2>&1; then
  log "Restarting PM2 process: $PM2_APP_NAME"
  pm2 restart "$PM2_APP_NAME" --update-env
else
  log "Starting PM2 process: $PM2_APP_NAME"
  pm2 start npm --name "$PM2_APP_NAME" --cwd "$APP_DIR" -- start
fi

pm2 save

log "Waiting for health check: $HEALTHCHECK_URL"
for attempt in {1..15}; do
  if curl --fail --silent --show-error --max-time 3 "$HEALTHCHECK_URL" >/dev/null; then
    log 'Deployment completed successfully'
    exit 0
  fi
  sleep 2
done

fail "Strapi did not become healthy. Check: pm2 logs $PM2_APP_NAME --lines 100"
