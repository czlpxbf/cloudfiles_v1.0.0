#!/usr/bin/env bash
# Cloudfiles Worker 部署脚本
# 用法:
#   export CLOUDFLARE_ACCOUNT_ID=xxx
#   export CLOUDFLARE_API_TOKEN=xxx        # Pages:Edit 权限
#   bash scripts/deploy-worker.sh
set -euo pipefail
cd "$(dirname "$0")/../apps/api"

if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ] || [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "错误: 需要 CLOUDFLARE_ACCOUNT_ID 与 CLOUDFLARE_API_TOKEN 环境变量"
  exit 1
fi

JWT_SECRET="${JWT_SECRET:-$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")}"
CF_PROJECT_PREFIX="${CF_PROJECT_PREFIX:-cf}"

echo "==> 注入 secrets..."
echo "$JWT_SECRET" | npx wrangler secret put JWT_SECRET
echo "$CLOUDFLARE_ACCOUNT_ID" | npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
echo "$CLOUDFLARE_API_TOKEN" | npx wrangler secret put CLOUDFLARE_API_TOKEN
echo "$CF_PROJECT_PREFIX" | npx wrangler secret put CF_PROJECT_PREFIX
echo "production" | npx wrangler secret put CF_ENV

echo "==> 部署 Worker..."
npx wrangler deploy

echo "==> 完成"
