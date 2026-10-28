/**
 * 被踢检测（docs/42 F1 的落地）
 *
 * 背景：smallnest 的 `Algorithm.cs` 里，插件出的牌一旦被 `TractorRules` 判非法，
 * 会执行 `mainForm.UserAlgorithms[seat] = null` —— **该座位永久降级为内置算法**，
 * 而且界面上没有任何提示。若不检测，跑完几十局得到的"胜率"可能全是它的机器人在打。
 *
 * 判据：每个座位的插件是**独立实例**，`seq` 各自从 1 递增。所以
 *   · 某座位的 seq 断流（后面还有别的座位在调用） ⇒ **疑似被踢**
 *   · 某座位 seq 有跳号 ⇒ 桥丢过请求（很少见，通常是桥崩了重启）
 *
 * 跑法：`npx vite-node tools/smallnest-bridge/bridge/checkKick.ts [log路径]`
 */

import { readFileSync } from 'node:fs'

interface Rec {
  readonly ts: number
  readonly seq: number
  readonly seat: number
  readonly kind: string
  readonly handSize: number
  readonly picked: number[]
  readonly error?: string
}

const path = process.argv[2] ?? 'tools/smallnest-bridge/out/decisions.jsonl'
let lines: string[] = []
try {
  lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '')
} catch {
  console.error(`读不到日志：${path}\n先跑一局（插件会写出日志），再来检查。`)
  process.exit(1)
}

const recs: Rec[] = []
for (const l of lines) {
  try {
    recs.push(JSON.parse(l) as Rec)
  } catch {
    /* 跳过坏行 */
  }
}
if (recs.length === 0) {
  console.error('日志是空的 —— 说明插件**一次都没被调用**（没被加载，或没选中）。')
  process.exit(1)
}

const bySeat = new Map<number, Rec[]>()
for (const r of recs) {
  if (r.seat === undefined) continue
  const arr = bySeat.get(r.seat) ?? []
  arr.push(r)
  bySeat.set(r.seat, arr)
}

const endTs = Math.max(...recs.map((r) => r.ts))
let suspect = 0
console.log(`日志：${path}（${recs.length} 条决策）\n`)

for (const seat of [...bySeat.keys()].sort((a, b) => a - b)) {
  const arr = (bySeat.get(seat) ?? []).sort((a, b) => a.seq - b.seq)
  const gaps: number[] = []
  for (let i = 1; i < arr.length; i++) {
    if (arr[i]!.seq !== arr[i - 1]!.seq + 1) gaps.push(arr[i]!.seq)
  }
  const last = arr[arr.length - 1]!
  // 该座位最后一次调用之后，别的座位还在继续 ⇒ 它可能被踢了
  const later = recs.some((r) => r.seat !== seat && r.ts > last.ts + 1000)
  const empty = arr.filter((r) => r.picked.length === 0).length
  const flag = later
  if (flag) suspect++
  console.log(
    `${flag ? '⚠️ 疑似被踢' : '✅ 正常'} 座位 ${seat}：${arr.length} 手` +
      ` · seq ${arr[0]!.seq}..${last.seq}` +
      `${gaps.length ? ` · 跳号 ${gaps.length} 处（首个 ${gaps[0]}）` : ''}` +
      `${empty ? ` · 空回 ${empty} 次` : ''}` +
      ` · 最后一手在 +${((endTs - last.ts) / 1000).toFixed(1)}s`,
  )
}

console.log(
  `\n${suspect === 0 ? '未发现被踢迹象 ✅' : `${suspect} 个座位疑似被踢 ❌（该局成绩作废）`}`,
)
if (suspect > 0) process.exit(2)
