/**
 * 扣底策略的强度测量：AI 坐庄时，闲家能拿多少分（越低越好）。
 *
 * 跑法：`npx vite-node scripts/measure-bury.ts --rounds 80`
 *
 * 为什么单看这个指标：扣底只影响庄家方。混在一起看总分会把"庄/闲"两种局面搅在一起，
 * 信号被稀释。这里只统计 **AI 坐庄** 的局。
 */
import { DEFAULT_RULE_CONFIG } from '@core'
import type { Card } from '@core'
import { aiPlayFor, chooseBuryIds, newGame, reduce } from '@app/game'
import { seatToPlay } from '@app/state'
import type { GameState } from '@app/state'
import { declareAndPass } from '../tests/helpers/declare'

const argv = process.argv.slice(2)
const ri = argv.indexOf('--rounds')
const ROUNDS = ri >= 0 ? Number(argv[ri + 1] ?? 80) : 80

/**
 * 打一局，**庄家轮流坐**（`seed % 4`）。
 *
 * 为什么不让座位 0 恒坐庄：那样 AI 的 `chooseBuryIds` 根本不会执行
 *（人类庄家走 `bury` 动作，AI 庄家走 `proceedAfterContract` 的自动扣底），
 * 测出来就是"扣底改动零影响"—— 一个很能骗人的结论。
 */
const playRound = (seed: number): { dealer: number; defScore: number } | null => {
  let s = newGame(DEFAULT_RULE_CONFIG, 3, 0, seed)
  const dealerSeat = (seed % 4) as 0 | 1 | 2 | 3
  s = declareAndPass(s, dealerSeat)
  if (s.phase === 'bury') {
    s = reduce(s, { type: 'bury', ids: chooseBuryIds(s, s.dealer) })
  }
  for (let i = 0; i < 600 && s.phase === 'play'; i++) {
    const seat = seatToPlay(s)
    if (seat === null) break
    const next = aiPlayFor(s, seat, 3)
    if (next === s) break
    s = next
  }
  if (s.phase !== 'settle' && s.phase !== 'over') return null
  return { dealer: s.dealer, defScore: s.defenderScore }
}

let aiDealerN = 0, aiDealerSum = 0
let humanDealerN = 0, humanDealerSum = 0
let all = 0
for (let seed = 1; seed <= ROUNDS; seed++) {
  const r = playRound(seed)
  if (!r) continue
  all++
  // 座位 0 是"人类"（这里也由 AI 代打），座位 2 是它的对家 ⇒ 0/2 同队
  if (r.dealer === 0 || r.dealer === 2) { humanDealerN++; humanDealerSum += r.defScore }
  else { aiDealerN++; aiDealerSum += r.defScore }
}
const avg = (s: number, n: number): string => (n ? (s / n).toFixed(1) : '—')
console.log(`跑完 ${all} 局`)
console.log(`  **AI 坐庄 ${aiDealerN} 局 · 闲家平均 ${avg(aiDealerSum, aiDealerN)} 分**（越低越好）`)
console.log(`  我方坐庄 ${humanDealerN} 局 · 闲家平均 ${avg(humanDealerSum, humanDealerN)} 分`)
console.log(`  全局闲家平均 ${avg(aiDealerSum + humanDealerSum, all)} 分`)
