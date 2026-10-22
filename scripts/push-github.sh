#!/usr/bin/env bash
# 一键推送 tractor-remake 到 GitHub
#
# 前置：已执行 `gh auth login`（本机已登录则直接跑）
# 用法：bash scripts/push-github.sh
#
# 认证完全交给 gh CLI —— 令牌由 gh 的凭据存储管理，
# 本脚本不接触令牌明文，也不写进 .git/config。

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_NAME="tractor-remake"
OWNER="duckytan"
API="https://api.github.com"

# ---- 代理 ----
# 本机环境里的 HTTPS_PROXY 指向 WorkBuddy 转发端口，它对 github.com 不通
# （只通 api.github.com），必须显式改成 7890。
# 大小写都要设：Go 客户端优先读 HTTPS_PROXY。
PROXY="${GH_PROXY:-http://127.0.0.1:7890}"
unset all_proxy ALL_PROXY 2>/dev/null || true
export https_proxy="$PROXY" http_proxy="$PROXY"
export HTTPS_PROXY="$PROXY" HTTP_PROXY="$PROXY"

cd "$REPO_DIR"

# ---- 1. 检查 gh 登录状态 ----
echo "==> 检查 gh 登录状态"
if ! gh auth status >/dev/null 2>&1; then
  echo "!! 未登录。请先执行："
  echo "   gh auth login --hostname github.com --git-protocol https --web --skip-ssh-key"
  exit 1
fi
gh auth status 2>&1 | head -3

# ---- 2. 确认远端仓库存在（不存在就建）----
echo "==> 检查仓库 ${OWNER}/${REPO_NAME}"
code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 20 "${API}/repos/${OWNER}/${REPO_NAME}" || true)
if [ "$code" = "200" ]; then
  echo "    仓库已存在"
else
  echo "==> 创建仓库 ${OWNER}/${REPO_NAME}（public）"
  gh repo create "${OWNER}/${REPO_NAME}" \
    --public \
    --description "拖拉机（升级/80分）网页重制版 —— 规则 1:1 复刻 + 渲染层完全重做" \
    2>&1 | tail -3
fi

# ---- 3. 配置 remote ----
echo "==> 配置 remote"
git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/${OWNER}/${REPO_NAME}.git"

# ---- 4. 推送 ----
# 让 git 通过 gh 的凭据助手取令牌，不把令牌写进 .git/config
echo "==> 推送 main 分支"
gh auth setup-git 2>&1 | tail -2
git -c "http.proxy=${PROXY}" push -u origin main

# ---- 5. 推 tag ----
if git rev-parse v0.1.0 >/dev/null 2>&1; then
  echo "==> 推送 tag v0.1.0"
  git -c "http.proxy=${PROXY}" push origin v0.1.0
fi

echo ""
echo "✅ 推送完成：https://github.com/${OWNER}/${REPO_NAME}"
