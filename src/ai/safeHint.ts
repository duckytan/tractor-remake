/**
 * 「稳妥提示」—— 一套**像人**的保守打法，专门给提示用（v1.3.33）。
 *
 * 为什么需要第二套策略（docs/15 KN-14）：
 * 提示原来直接用 AI 的 `choosePlay`（L3）。L3 走的是「先跑小副牌、主牌留到最后控场」
 * 这类**期望值不差但人类不会这么打**的线路，玩家看不到对手的牌、也看不出它在赌什么，
 * 只能判断成「弱智」。实测（400 局面推演）提示确实略强于「凭直觉出大牌」（73:48），
 * 但**没有强到让人信服**。所以再给一套「一眼就懂」的：
 *
 * 规则（刻意写得又短又笨，方便玩家预测 —— 这是它的卖点，不是缺点）：
 *
 * **跟牌**
 *   1. 队友已经赢着 → 出最小的一手（0 分优先），别抢队友的墩
 *   2. 能压过当前最大、且本墩有分 → 用**能赢的最小一手**（省大牌）
 *   3. 能压过、但本墩没分 → 出最小的一手（不为空墩浪费大牌）
 *   4. 压不过 → 出最小的 0 分牌（别送分）
 *
 * **首出**
 *   5. 有「稳赢」的牌（对手压不过）→ 优先兑现**不带分**的、牌力最低的那一手
 *   6. 没有稳赢的 → 先跑长套里最小的 0 分牌（人类最标准的开局）
 *
 * 与 L3 的区别只在「选哪一手」，合法性仍然由 `checkPlay` 保证 ——
 * 这里**绝不自己判规则**（分层铁律，见 docs/07）。
 */

import { analyze, canBeat, cardsScore, checkPlay } from '@core'
import type { Card, PlayAnalysis, RuleContext, Seat } from '@core'
import { enumeratePlays } from './enumerate'
import type { PlayContext } from './enumerate'
import { isSureToHold } from './policy'

export interface SafeHintInput {
  readonly hand: readonly Card[]
  readonly ctx: RuleContext
  readonly play: PlayContext
  /** 本墩当前最大牌的分析；首出时为 null */
  readonly currentWinner: PlayAnalysis | null
  readonly partnerLeading: boolean
  readonly opponents: readonly (readonly Card[])[]
  readonly seat: Seat
  /** 本墩还没出牌的座位（判断「稳赢」时要排除已出过的人） */
  readonly remainingSeats: readonly Seat[]
  /** 本墩**已经落在桌面上的分**（首出 + 已跟过的牌），由调用方从 `s.trick.plays` 算 */
  readonly trickPoints: number
}

/** 牌力（越小越省） */
const powerOf = (cards: readonly Card[], ctx: RuleContext): number =>
  cards.reduce((sum, c) => sum + ctx.power.get(c.value), 0) / cards.length

/** 该槽在手牌里还有几张（长套优先） */
function slotCountOf(hand: readonly Card[], slot: number, ctx: RuleContext): number {
  if (slot === 4) return hand.filter((c) => ctx.power.isTrump(c.value)).length
  return hand.filter((c) => c.value < 52 && Math.floor(c.value / 13) === slot).length
}

/** 只保留真正合法的候选（**规则判定只走 checkPlay**） */
function legalCandidates(input: SafeHintInput): Card[][] {
  const out: Card[][] = []
  for (const cards of enumeratePlays(input.hand, input.ctx, input.play, 60, true)) {
    const r = checkPlay({
      hand: input.hand,
      cards,
      ctx: input.ctx,
      ...(input.play.kind === 'follow'
        ? { lead: { cards: input.play.leadCards, analysis: input.play.leadAnalysis } }
        : {}),
      opponents: input.opponents,
    })
    if (r.ok) out.push(r.cards.slice())
  }
  return out
}

/** 排序：先比「带多少分」（越少越好），再比牌力（越低越好） */
function byCheap(a: readonly Card[], b: readonly Card[], ctx: RuleContext): number {
  const pa = cardsScore(a)
  const pb = cardsScore(b)
  if (pa !== pb) return pa - pb
  return powerOf(a, ctx) - powerOf(b, ctx)
}

/**
 * 选一手「稳妥」的牌。返回空数组表示没有合法候选（调用方退回 `choosePlay`）。
 */
export function safeHint(input: SafeHintInput): Card[] {
  const candidates = legalCandidates(input)
  if (candidates.length === 0) return []
  const { ctx, hand } = input
  const sorted = [...candidates].sort((a, b) => byCheap(a, b, ctx))

  /* ---------------- 跟牌 ---------------- */
  if (input.play.kind === 'follow') {
    // ① 队友已经赢着：别抢，出最小的一手（0 分优先 —— 抢队友的墩没有意义）
    if (input.partnerLeading) return (sorted[0] as Card[]).slice()

    const winner = input.currentWinner
    const winners =
      winner === null
        ? candidates
        : candidates.filter((cards) => canBeat(analyze(cards, ctx), winner))
    // ② 能压住、且这墩有分 → 抢，但用能赢的最小一手
    if (winners.length > 0 && input.trickPoints > 0) {
      return [...winners].sort((a, b) => powerOf(a, ctx) - powerOf(b, ctx))[0]!.slice()
    }
    // ③ 能压住但没分 / 压不住 → 出最小的一手（0 分优先）
    return (sorted[0] as Card[]).slice()
  }

  /* ---------------- 首出 ---------------- */
  const sure = candidates.filter((cards) =>
    isSureToHold(cards, ctx, input.opponents, input.remainingSeats, input.seat),
  )
  // ④ 有稳赢的：优先兑现「不带分」的、牌力最低的那一手（省大牌、不甩分）
  if (sure.length > 0) {
    return [...sure].sort((a, b) => byCheap(a, b, ctx))[0]!.slice()
  }
  // ⑤ 没有稳赢的：先跑长套里最小的 0 分牌
  const slotOf = (cards: readonly Card[]): number => analyze(cards, ctx).suitSlot
  return [...sorted].sort((a, b) => {
    const base = byCheap(a, b, ctx)
    if (base !== 0) return base
    const sa = slotOf(a)
    const sb = slotOf(b)
    const ca = sa === -1 ? 0 : slotCountOf(hand, sa, ctx)
    const cb = sb === -1 ? 0 : slotCountOf(hand, sb, ctx)
    return cb - ca
  })[0]!.slice()
}
