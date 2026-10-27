/**
 * 配对测量：「概率推断（不读牌）」vs「明牌偷看」谁更强（docs/15 KN-10 的证据来源）
 *
 * 同一副牌打两遍、座位对调，取平均净分 —— 与 `tests/ai/difficulty.test.ts` 同方法。
 * 自检：同配置对同配置时净胜率必须恰好 50%。
 *
 * 跑法：
 *   npx vite-node scripts/measure-ai-peek.ts            # 300 副（默认）
 *   npx vite-node scripts/measure-ai-peek.ts --rounds 600
 *
 * 结论（v1.3.29 实测 300 副 × 2）：
 *   L2：49.3%（净分 +0.7）—— 两种信息源**没有差别**
 *   L3：**27.0%**（净分 −7.9）—— 关掉读牌会明显变弱
 * 所以「AI 读牌」默认开启，但在设置里做成了开关（`aiPeekHands`），
 * 想玩得更公平可以关掉。想真正替代它，需要「根据对手出牌更新信念」的
 * 动态模型（docs/28 的 HQ/ΔHQ），静态均匀先验做不到。
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

/** A 队 = belief（不偷看），B 队 = peek（偷看）；swap 时 A 队去奇数位 */
function playRound(seed: number, level: AiLevel, swap: boolean): GameState {
  let s = newGame(DEFAULT_RULE_CONFIG, level, 0, seed)
  s = declareAndPass(s, 0)
  if (s.phase === 'bury') s = reduce(s, { type: 'bury', ids: pickBuryIds(s) })
  let steps = 0
  while (s.phase === 'play' && steps < 4000) {
    steps++
    const seat = seatToPlay(s)
    if (seat === null) break
    const isA = (seat % 2 === 0) !== swap
    s = aiPlayFor(s, seat, level, { peek: !isA })
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
for (const level of [2, 3] as AiLevel[]) {
  let wins = 0
  let margin = 0
  for (let seed = 1; seed <= ROUNDS; seed++) {
    const s1 = teamScores(playRound(seed, level, false))
    const s2 = teamScores(playRound(seed, level, true))
    const m = (s1.a - s1.b + (s2.b - s2.a)) / 2
    margin += m
    if (m > 0) wins++
  }
  console.log(
    `L${level}：概率推断 vs 明牌偷看 = ${((wins / ROUNDS) * 100).toFixed(1)}%（净分 ${(margin / ROUNDS).toFixed(1)}）`,
  )
}
