/**
 * 配对测量：L3「开残局搜索」vs「关残局搜索」谁更强（docs/28 §5 的证据来源）
 *
 * 同一副牌打两遍、座位对调，取平均净分 —— 与 `tests/ai/difficulty.test.ts` 同方法。
 * 报告胜/负/平与净分的 95% 置信区间：**只看「胜率」会被大量平局稀释**
 * （残局搜索只影响最后 ≤2 墩，多数配对局的终局得分完全相同）。
 *
 * 跑法：
 *   npx vite-node scripts/measure-endgame.ts             # 300 副
 *   npx vite-node scripts/measure-endgame.ts --rounds 600
 *
 * 结论（v1.3.29 实测 600 副 × 2）：
 *   胜 68 / 负 7 / 平 525 · 净分 **+0.93 ± 0.29**（95% CI，不含 0）
 *   ⇒ 有统计显著的提升；决胜局里 68:7 说明它几乎不会把局面搞坏。
 *   耗时：单次决策 P95 0.29ms / 最大 3.5ms（牌少时 α-β 剪枝极狠）。
 */
import { DEFAULT_RULE_CONFIG, teamOf } from '@core'
import type { Card } from '@core'
import { aiPlayFor, newGame, reduce } from '@app/game'
import { seatToPlay } from '@app/state'
import type { GameState } from '@app/state'
import { declareAndPass } from '../tests/helpers/declare'
import type { AiLevel } from '@ai/policy'

function pickBuryIds(s: GameState): number[] {
  const hand = s.hands[s.dealer] as readonly Card[]
  return hand.slice(0, 8).map((c) => c.id)
}

function playRound(seed: number, level: AiLevel, swap: boolean, aEndgame: boolean, bEndgame: boolean): GameState {
  let s = newGame(DEFAULT_RULE_CONFIG, level, 0, seed)
  s = declareAndPass(s, 0)
  if (s.phase === 'bury') s = reduce(s, { type: 'bury', ids: pickBuryIds(s) })
  let steps = 0
  while (s.phase === 'play' && steps < 4000) {
    steps++
    const seat = seatToPlay(s)
    if (seat === null) break
    const isA = (seat % 2 === 0) !== swap
    s = aiPlayFor(s, seat, level, { endgame: isA ? aEndgame : bEndgame })
  }
  return s
}

function teamScores(s: GameState): { a: number; b: number } {
  let a = 0
  let b = 0
  for (const t of s.history) {
    if (teamOf(t.winner) === 0) a += t.score
    else b += t.score
  }
  return { a, b }
}

const argv = process.argv.slice(2)
const ri = argv.indexOf('--rounds')
const ROUNDS = ri >= 0 ? Number(argv[ri + 1] ?? 300) : 300
const level: AiLevel = 3
let wins = 0
let losses = 0
let ties = 0
let margin = 0
let sumSq = 0
for (let seed = 1; seed <= ROUNDS; seed++) {
  const s1 = teamScores(playRound(seed, level, false, true, false))
  const s2 = teamScores(playRound(seed, level, true, true, false))
  const m = (s1.a - s1.b + (s2.b - s2.a)) / 2
  margin += m
  sumSq += m * m
  if (m > 0) wins++
  else if (m < 0) losses++
  else ties++
}
const mean = margin / ROUNDS
const sd = Math.sqrt(Math.max(0, sumSq / ROUNDS - mean * mean))
const se = sd / Math.sqrt(ROUNDS)
console.log(
  `L${level} 开残局 vs 关：胜 ${wins} / 负 ${losses} / 平 ${ties}` +
    ` · 净分 ${mean.toFixed(2)} ± ${(1.96 * se).toFixed(2)}（95% CI，n=${ROUNDS}）`,
)
