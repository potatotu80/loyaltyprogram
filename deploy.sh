#!/usr/bin/env bash

set -e

cd "$(dirname "$0")"

echo "Fetching origin..."
git fetch origin

echo "Checking out main..."
git checkout main

echo "Pulling latest code..."
git pull --ff-only origin main

# echo "Installing npm dependencies..."
# npm ci

# echo "Building Strapi admin..."
# NODE_ENV=production npm run build

echo "Restarting PM2..."
pm2 restart loyaltyprogram-strapi --update-env

echo "Deploy completed successfully."
