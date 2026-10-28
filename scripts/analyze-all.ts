/**
 * 一键跑完整分析（概览 + 推演判定 + 打分归因）。
 *
 * 跑法：`npx vite-node scripts/analyze-all.ts <导出的 json>`
 *
 * 三个子分析各管一件事，分开跑容易漏：
 *   · analyze-logs       —— 对局概览 / 胜负 / 分歧明细
 *   · judge-divergences  —— 推演判定「这手谁更优」
 *   · explain-divergences—— 打分归因「为什么会不一样」
 */

import { spawnSync } from 'node:child_process'

const path = process.argv[2]
if (!path) {
  console.error('用法：npx vite-node scripts/analyze-all.ts <导出的 json>')
  process.exit(1)
}

const steps = ['analyze-logs', 'judge-divergences', 'explain-divergences']
for (const s of steps) {
  const r = spawnSync(
    process.execPath,
    ['node_modules/vite-node/vite-node.mjs', `scripts/${s}.ts`, path],
    { stdio: 'inherit', env: process.env },
  )
  if (r.status !== 0) {
    console.error(`\n[${s}] 退出码 ${r.status} —— 后面的分析跳过`)
    process.exit(r.status ?? 1)
  }
  console.log('\n' + '─'.repeat(78))
}
