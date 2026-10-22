#!/usr/bin/env bash
# 一键推送 tractor-remake 到 GitHub
#
# 用法：GH_TOKEN=ghp_xxx bash scripts/push-github.sh
#
# 令牌只存在于当前 shell 环境的临时变量里，
# 通过 git 的 http.extraHeader 传给远端 —— 不写进 .git/config，也不落盘。

set -euo pipefail

REPO_DIR="D:/WorkBuddy/逆向REA/tractor-remake"
REPO_NAME="tractor-remake"
OWNER="duckytan"
API="https://api.github.com"

if [ -z "${GH_TOKEN:-}" ]; then
  echo "!! 请先设置 GH_TOKEN 环境变量"
  exit 1
fi

export https_proxy="${https_proxy:-http://127.0.0.1:7890}"
export http_proxy="${http_proxy:-http://127.0.0.1:7890}"

cd "$REPO_DIR"

# ---- 1. 建仓（已存在就跳过）----
echo "==> 检查仓库 ${OWNER}/${REPO_NAME}"
code=$(curl -sS -o /tmp/gh_repo.json -w "%{http_code}" \
  -H "Authorization: Bearer ${GH_TOKEN}" \
  -H "Accept: application/vnd.github+json" \
  "${API}/repos/${OWNER}/${REPO_NAME}" || true)

if [ "$code" = "200" ]; then
  echo "    仓库已存在，跳过创建"
else
  echo "==> 创建仓库 ${OWNER}/${REPO_NAME}（public）"
  curl -sS --retry 3 --retry-delay 2 --retry-all-errors -X POST \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    -d "{\"name\":\"${REPO_NAME}\",\"private\":false,\"autoInit\":false,\"description\":\"拖拉机（升级/80分）网页重制版 —— 规则 1:1 复刻 + 渲染层完全重做\"}" \
    "${API}/user/repos" | head -c 400
  echo ""
fi

# ---- 2. 配置 remote ----
echo "==> 配置 remote"
git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/${OWNER}/${REPO_NAME}.git"

# ---- 3. 推送（令牌走 extraHeader，不进 .git/config）----
AUTH=$(printf 'x-access-token:%s' "${GH_TOKEN}" | base64 | tr -d '\n')

echo "==> 推送 main 分支"
git -c "http.extraHeader=Authorization: Basic ${AUTH}" \
    -c "http.proxy=${http_proxy}" \
    push -u origin main

# ---- 4. 打 tag ----
if git rev-parse v0.1.0 >/dev/null 2>&1; then
  echo "==> 推送 tag v0.1.0"
  git -c "http.extraHeader=Authorization: Basic ${AUTH}" \
      -c "http.proxy=${http_proxy}" \
      push origin v0.1.0
fi

echo ""
echo "✅ 推送完成：https://github.com/${OWNER}/${REPO_NAME}"
