/**
 * 扫「两套策略」的分歧：提示（稳妥）vs L3（最强）。
 *
 * 跑法：`npx vite-node scripts/scan-strategy-divergence.ts --rounds 40`
 *
 * 为什么要它：v1.3.50 修的 bug（队友 A 压得住却不垫分）就是"同一判据两套实现"
 * 漏改了一处。靠读代码找不全，这里改成**按局面类型统计分歧率**：
 * 某类局面分歧率异常高，就说明两套策略在那条判据上不一致。
 *
 * 分类维度：首出/跟牌 × 谁赢着 × 本墩有没有分 × 我能不能压过 × 队友这手安不安全
 */
import { DEFAULT_RULE_CONFIG, cardsScore, teamOf, trickStanding } from '@core'
import type { Card } from '@core'
import { aiPlayFor, choosePlay, chooseSafePlay, newGame, reduce } from '@app/game'
import { HUMAN_SEAT, ctxOf, seatToPlay } from '@app/state'
import type { GameState } from '@app/state'
import { rivalIsSafe } from '@ai/policy'
import { declareAndPass } from '../tests/helpers/declare'

const argv = process.argv.slice(2)
const ri = argv.indexOf('--rounds')
const ROUNDS = ri >= 0 ? Number(argv[ri + 1] ?? 40) : 40

// 按**牌值**归一：两副牌里两张 ♥5 是可互换的，用 id 比会把「同点数不同那张」误算成分歧
const key = (a: readonly Card[]): string =>
  [...a].map((c) => c.value).sort((x, y) => x - y).join(',')
const nameOf = (v: number): string => {
  const S = ['♠', '♥', '♣', '♦']
  const R = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']
  return v >= 52 ? (v === 53 ? '大王' : '小王') : `${S[Math.floor(v / 13)]}${R[v % 13]}`
}
const text = (a: readonly Card[]): string => a.map((c) => nameOf(c.value)).join(' ')

interface Bucket { n: number; diff: number; samples: string[] }
const buckets = new Map<string, Bucket>()
const bump = (k: string, same: boolean, sample: string): void => {
  const b = buckets.get(k) ?? { n: 0, diff: 0, samples: [] }
  b.n++
  if (!same) {
    b.diff++
    if (b.samples.length < 3) b.samples.push(sample)
  }
  buckets.set(k, b)
}

function classify(s: GameState): { tag: string; detail: string } {
  const ctx = ctxOf(s)
  const lead = s.trick.plays[0]
  if (!lead) return { tag: '首出', detail: '' }
  const standing = trickStanding(s.trick.plays, ctx)
  const mineTeam = teamOf(HUMAN_SEAT)
  const winnerTeam = standing ? teamOf(standing.winner.seat) : -1
  const pts = s.trick.plays.reduce((n, p) => n + cardsScore(p.cards as readonly Card[]), 0)
  const remaining = [0, 1, 2, 3].filter(
    (x) => x !== HUMAN_SEAT && !s.trick.plays.some((p) => p.seat === x),
  ) as never
  const opps = [0, 1, 2, 3].filter((x) => x !== HUMAN_SEAT).map((x) => s.hands[x] as readonly Card[])
  const safe =
    standing === null
      ? false
      : rivalIsSafe({ seat: standing.winner.seat, analysis: standing.winner.analysis }, ctx, opps, remaining, HUMAN_SEAT)
  const who = winnerTeam === mineTeam ? (standing!.winner.seat === HUMAN_SEAT ? '我方' : '队友') : '对方'
  return {
    tag: `跟牌 · ${who}赢着 · ${pts > 0 ? '有分' : '无分'} · ${safe ? '守得住' : '可能被压'}`,
    detail: `首出 ${text(lead.cards)}`,
  }
}

let decisions = 0
for (let seed = 1; seed <= ROUNDS; seed++) {
  let s = newGame(DEFAULT_RULE_CONFIG, 2, 0, seed)
  s = declareAndPass(s, 0)
  if (s.phase === 'bury') {
    const hand = s.hands[s.dealer] as readonly Card[]
    s = reduce(s, { type: 'bury', ids: hand.slice(0, 8).map((c) => c.id) })
  }
  for (let i = 0; i < 500 && s.phase === 'play'; i++) {
    const seat = seatToPlay(s)
    if (seat === null) break
    if (seat === HUMAN_SEAT) {
      const a = chooseSafePlay(s, HUMAN_SEAT)
      const b = choosePlay(s, HUMAN_SEAT, 3, { peek: true })
      if (a.length > 0 && b.length > 0) {
        decisions++
        const { tag, detail } = classify(s)
        const same = key(a) === key(b)
        bump(tag, same, `${detail} ｜ 提示 ${text(a)} vs L3 ${text(b)}`)
      }
    }
    const next = aiPlayFor(s, seat, 2)
    if (next === s) break
    s = next
  }
}

console.log(`\n共 ${decisions} 次人类决策\n`)
console.log('局面类型'.padEnd(40) + '次数'.padStart(6) + '分歧'.padStart(6) + '分歧率'.padStart(8))
for (const [k, v] of [...buckets.entries()].sort((a, b) => b[1].diff - a[1].diff)) {
  const rate = ((v.diff / v.n) * 100).toFixed(0)
  console.log(k.padEnd(40) + String(v.n).padStart(6) + String(v.diff).padStart(6) + `${rate}%`.padStart(8))
}
console.log('\n分歧样本（按类型）：')
for (const [k, v] of [...buckets.entries()].sort((a, b) => b[1].diff - a[1].diff)) {
  if (v.diff === 0) continue
  console.log(`\n【${k}】`)
  for (const x of v.samples) console.log('  ' + x)
}
