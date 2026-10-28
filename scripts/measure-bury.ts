/**
 * 扣底策略的强度测量：AI 坐庄时，闲家能拿多少分（越低越好）。
 *
 * 跑法：`npx vite-node scripts/measure-bury.ts --rounds 80`
 *
 * 为什么单看这个指标：扣底只影响庄家方。混在一起看总分会把「庄/闲」两种局面搅在一起，
 * 信号被稀释。这里只统计 **AI 坐庄** 的局。
 *
 * ## v1.3.47 修：这个脚本之前根本没测到扣底
 *
 * 旧实现是 `s = declareAndPass(s, seed % 4)` —— 而 `declareAndPass` 的第二个参数是
 * **Trump（花色）**，不是座位。于是「庄家轮流坐」从来没有发生过：人类座位每局都第一个亮主、
 * 按抢庄规则坐庄，输出固定是「AI 坐庄 **0** 局」。也就是说 v1.3.43 用这个脚本「验证」扣底改动时，
 * `chooseBuryIds` 走的全是「人类庄家」分支，**AI 自动扣底一次都没执行**。
 *
 * 现在改成：让人类一路「继续发牌」不亮主，等 AI 按发牌位置自然抢主 —— 那时庄家是 AI，
 * `proceedAfterContract` 会真的调 `chooseBuryIds` 自动扣底。抢不到（或人类被迫定主）的局直接跳过。
 *
 * 顺带把 v1.3.43 用过的三个扣底画像一起量了（绝门率 / 垫分 / 主牌数），
 * 这样「改了有没有用」不必再靠另一个脚本。
 */
import { DEFAULT_RULE_CONFIG, cardsScore, suitSlotOf } from '@core'
import { aiPlayFor, chooseBuryIds, newGame, reduce, revealTick } from '@app/game'
import { ctxOf, seatToPlay } from '@app/state'
import type { GameState } from '@app/state'

const argv = process.argv.slice(2)
const ri = argv.indexOf('--rounds')
const ROUNDS = ri >= 0 ? Number(argv[ri + 1] ?? 80) : 80

/** 座位 0 是「人类」座位。座位 1/2/3 都是 AI —— 座位 2 是人类的**队友**，但它也是 AI，
 *  同样走 `chooseBuryIds`，所以同样算「AI 自动扣底」的样本。
 *  注意 `defenderScore` 是「非庄家方拿到的分」，与哪一队坐庄无关，可以直接平均。 */
const HUMAN_SEAT_INDEX = 0

/**
 * 发牌 → 等 AI 抢主。
 *
 * 人类被问到时一律「继续发牌」（`passDeal`），所以定主人只可能是 AI。
 * 一路没人亮（发完牌走强制定主面板）的局返回 null。
 */
function settleByAiGrab(seed: number): GameState | null {
  let s = newGame(DEFAULT_RULE_CONFIG, 3, 0, seed)
  for (let i = 0; i < 400 && s.phase === 'contract'; i++) {
    if (s.dealPrompt) {
      s = reduce(s, { type: 'passDeal' })
      continue
    }
    const next = revealTick(s)
    if (next === s) break
    s = next
  }
  if (s.phase !== 'bury' && s.phase !== 'play') return null
  return s
}

interface RoundResult {
  readonly dealer: number
  readonly defScore: number
  /** 扣底后庄家还剩几门副牌是空的（0~3） */
  readonly voids: number
  /** 垫进底牌的分 */
  readonly buriedPoints: number
  /** 扣底前庄家的主牌张数 */
  readonly trumps: number
}

const playRound = (seed: number): RoundResult | null => {
  const start = settleByAiGrab(seed)
  if (start === null) return null

  // 扣底前的画像：庄家 33 张里的主牌数
  const ctx = ctxOf(start)
  const before = start.hands[start.dealer] as readonly { value: number }[]
  const trumps = before.filter((c) => suitSlotOf(c.value, ctx.power) === 4).length

  // AI 庄家已经在 proceedAfterContract 里自动扣过底了；这里只补「人类庄家」的路径（不统计）
  let s = start
  if (s.phase === 'bury') {
    s = reduce(s, { type: 'bury', ids: chooseBuryIds(s, s.dealer) })
  }

  const after = s.hands[s.dealer] as readonly { value: number }[]
  const ctx2 = ctxOf(s)
  let voids = 0
  for (const suit of [0, 1, 2, 3] as const) {
    if (suit === ctx2.trump) continue // 主花色牌的槽号恒为 4，按副牌门数会误判「绝门」
    if (!after.some((c) => suitSlotOf(c.value, ctx2.power) === suit)) voids++
  }
  const buriedPoints = cardsScore(s.bottom)

  for (let i = 0; i < 600 && s.phase === 'play'; i++) {
    const seat = seatToPlay(s)
    if (seat === null) break
    const next = aiPlayFor(s, seat, 3)
    if (next === s) break
    s = next
  }
  if (s.phase !== 'settle' && s.phase !== 'over') return null
  return { dealer: s.dealer, defScore: s.defenderScore, voids, buriedPoints, trumps }
}

let aiN = 0
let aiScore = 0
let aiVoids = 0
let aiPoints = 0
let aiTrumps = 0
let skipped = 0
let humanN = 0

for (let seed = 1; seed <= ROUNDS; seed++) {
  const r = playRound(seed)
  if (r === null) {
    skipped++
    continue
  }
  if (r.dealer === HUMAN_SEAT_INDEX) {
    humanN++
    continue
  }
  aiN++
  aiScore += r.defScore
  aiVoids += r.voids
  aiPoints += r.buriedPoints
  aiTrumps += r.trumps
}

const avg = (sum: number, n: number, d = 1): string => (n ? (sum / n).toFixed(d) : '—')
console.log(`跑完 ${ROUNDS} 个种子 · 跳过 ${skipped} 局（没抢到主 / 没打完）`)
console.log(
  `  **AI 坐庄 ${aiN} 局 · 闲家平均 ${avg(aiScore, aiN)} 分**（越低越好）`,
)
console.log(
  `  扣底画像：形成绝门 ${avg((aiVoids / Math.max(1, aiN)) * 100, 1)}% · 平均垫分 ${avg(aiPoints, aiN)} · 扣底前主牌 ${avg(aiTrumps, aiN)} 张`,
)
if (humanN > 0) {
  console.log(
    `  人类座位 0 坐庄 ${humanN} 局（同样走 chooseBuryIds，未计入上面的均值）`,
  )
}
