/**
 * 对局数据分析（读 `记录` 面板导出的 JSON）
 *
 * 跑法：`npx vite-node scripts/analyze-logs.ts <导出的文件.json>`
 *
 * 输出三块：
 *   ① 对局概览：每局的主牌/级牌/庄家/闲家得分/是否换庄
 *   ② 胜负与得分：我方胜率、场均闲家得分
 *   ③ **你的出牌 vs AI 建议**：分歧率 + 分歧明细（这是最值钱的一块 ——
 *      分歧局面天然就是"标注题库"的候选，可以直接抄成 `tests/ai/cases/*.json`）
 */

import { readFileSync } from 'node:fs'

const NAMES = ['♠', '♥', '♣', '♦']
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']
const nameOf = (v: number): string =>
  v >= 52 ? (v === 53 ? '大王' : '小王') : `${NAMES[Math.floor(v / 13)]}${RANKS[v % 13]}`
const SEAT = ['南(你)', '西', '北', '东']
const TRUMP = ['♠', '♥', '♣', '♦']
const trumpText = (t: number | string): string => (t === 'NT' ? '无将' : `${TRUMP[t as number]}`)

interface Trick {
  leader: number
  plays: [number, number[]][]
  winner: number
  score: number
}
interface HumanPlay {
  trick: number
  cards: number[]
  ai: number[]
  hint: boolean
  /** 提示当时高亮的那几张（老日志没有这个字段） */
  hintCards?: number[]
}
interface Round {
  seed: number
  round: number
  levelRank: number
  trump: number | string
  dealer: number
  hands: number[][]
  tricks: Trick[]
  human: HumanPlay[]
  settle: { defenderScore: number; dealerChanged: boolean; actualLevels: number }
}
interface File {
  version?: string
  exportedAt?: string
  rounds: Round[]
}

const path = process.argv[2]
if (!path) {
  console.error('用法：npx vite-node scripts/analyze-logs.ts <导出的 json>')
  process.exit(1)
}
const data = JSON.parse(readFileSync(path, 'utf8')) as File
const rounds = data.rounds ?? []
if (rounds.length === 0) {
  console.error('文件里没有对局记录。')
  process.exit(1)
}

const MY_TEAM = 0 // 座位 0/2 同队
const teamOf = (s: number): number => s % 2

/* ---------------- ① 概览 ---------------- */
console.log(`文件：${path}`)
console.log(`版本 ${data.version ?? '?'} · 导出 ${data.exportedAt ?? '?'} · ${rounds.length} 局\n`)
console.log('【对局概览】')
for (const r of rounds) {
  const i = rounds.indexOf(r) + 1
  const myDealer = teamOf(r.dealer) === MY_TEAM
  const win = myDealer ? !r.settle.dealerChanged : r.settle.dealerChanged
  console.log(
    `  ${String(i).padStart(2)}. 主 ${trumpText(r.trump)} 打 ${r.levelRank} · 庄 ${SEAT[r.dealer]} · ` +
      `闲家 ${r.settle.defenderScore} 分 · ${r.settle.dealerChanged ? '换庄' : '庄家方继续'}` +
      ` · 我方${win ? '胜' : '负'} · ${r.tricks.length} 墩 · ${r.human.length} 次出牌`,
  )
}

/* ---------------- ② 胜负 ---------------- */
let wins = 0
let score = 0
for (const r of rounds) {
  const myDealer = teamOf(r.dealer) === MY_TEAM
  if (myDealer ? !r.settle.dealerChanged : r.settle.dealerChanged) wins++
  score += r.settle.defenderScore
}
const pct = (x: number): string => `${Math.round(x * 100)}%`
console.log(
  `\n【胜负】我方 ${wins} 胜 ${rounds.length - wins} 负（${pct(wins / rounds.length)}）· ` +
    `场均闲家 ${Math.round(score / rounds.length)} 分`,
)

/* ---------------- ③ 你的出牌 vs AI ---------------- */
let decisions = 0
let agree = 0
let hints = 0
const diffs: { r: Round; p: HumanPlay; no: number }[] = []
for (const r of rounds) {
  for (const p of r.human) {
    decisions++
    if (p.hint) hints++
    const a = [...p.cards].sort((x, y) => x - y).join(',')
    const b = [...p.ai].sort((x, y) => x - y).join(',')
    if (a === b) agree++
    else diffs.push({ r, p, no: rounds.indexOf(r) + 1 })
  }
}
console.log(
  `\n【你的出牌 vs AI 建议】${decisions} 次决策 · 一致 ${agree}（${pct(agree / Math.max(1, decisions))}）` +
    ` · 分歧 ${diffs.length} · 看提示 ${hints} 次（${pct(hints / Math.max(1, decisions))}）`,
)

/* ---- 提示 vs 你的选择（默认「稳妥」风格给出的那一手） ---- */
let hintGiven = 0
let hintFollowed = 0
const hintDiffs: { where: string; hint: string; played: string; sameAsAi: boolean }[] = []
for (const r of rounds) {
  for (const p of r.human) {
    if (!p.hint || !p.hintCards || p.hintCards.length === 0) continue
    hintGiven++
    const h = [...p.hintCards].sort((a, b) => a - b).join()
    const played = [...p.cards].sort((a, b) => a - b).join()
    const aiKey = [...p.ai].sort((a, b) => a - b).join()
    if (h === played) {
      hintFollowed++
      continue
    }
    hintDiffs.push({
      where: `局${rounds.indexOf(r) + 1} 墩${p.trick + 1}`,
      hint: p.hintCards.map(nameOf).join(' '),
      played: p.cards.map(nameOf).join(' '),
      sameAsAi: played === aiKey,
    })
  }
}
if (hintGiven > 0) {
  console.log(
    `\n【提示 vs 你的选择】看提示 ${hintGiven} 次 · 按提示出 ${hintFollowed}（${pct(hintFollowed / hintGiven)}）` +
      ` · 没按提示 ${hintDiffs.length}`,
  )
  for (const d of hintDiffs.slice(0, 10)) {
    console.log(
      `  ${d.where} 提示 ${d.hint} ｜ 你出 ${d.played}${d.sameAsAi ? '（= L3 的建议）' : ''}`,
    )
  }
  if (hintDiffs.length > 10) console.log(`  …还有 ${hintDiffs.length - 10} 条`)
}

const show = (n: number): void => {
  console.log(`\n【分歧明细（前 ${Math.min(n, diffs.length)} 条）】`)
  for (const d of diffs.slice(0, n)) {
    const t = d.r.tricks[d.p.trick]
    const lead = t ? t.plays[0] : undefined
    console.log(
      `  局${d.no} 第 ${d.p.trick + 1} 墩 · 首出 ${lead ? `${SEAT[lead[0]]} ${lead[1].map(nameOf).join(' ')}` : '?'}` +
        ` · 你出 ${d.p.cards.map(nameOf).join(' ')} · AI 建议 ${d.p.ai.map(nameOf).join(' ')}` +
        `${d.p.hint ? '（你看过提示）' : ''}`,
    )
  }
  if (diffs.length > n) console.log(`  …还有 ${diffs.length - n} 条`)
}
show(10)

/* ---------------- 可转成标注题的分歧 ---------------- */
if (diffs.length > 0) {
  const d = diffs[0]!
  const r = d.r
  console.log('\n【可以这样加一道标注题（tests/ai/cases/*.json）】')
  console.log(
    JSON.stringify(
      {
        id: `from-log-${r.seed}-${d.p.trick}`,
        engine: 'l3',
        desc: '你在实战里出了这手、AI 建议另一手 —— 想清楚哪个对，再决定 expect 写谁',
        trump: r.trump,
        level: r.levelRank,
        myHand: (r.hands[0] ?? []).map(nameOf).join(' '),
        trick: (r.tricks[d.p.trick]?.plays ?? []).map(([seat, cards]) => ({
          seat,
          cards: cards.map(nameOf),
        })),
        expect: d.p.ai.map(nameOf),
      },
      null,
      2,
    ),
  )
}
