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

import { analyze, beatsPlay, cardsScore, checkPlay } from '@core'
import type { Card, PlayAnalysis, RuleContext, Seat } from '@core'
import { enumeratePlays } from './enumerate'
import type { PlayContext } from './enumerate'
import { isSureToHold, rivalIsSafe } from './policy'

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
    // ① 队友已经赢着
    if (input.partnerLeading) {
      // 判据不是「对手都出完了没有」，而是**「队友这一手还会不会被对手抢走」**。
      //
      // v1.3.50 修：这里原来写的是 `!enemyLeft`（对手都出完才敢垫），
      // 于是「队友用 ♦A 拿下这墩、对手还没出」这种**明明锁定**的局面，
      // 提示也会让你垫最小的一张 —— 玩家当场就问「这不是该出 K 走分吗」。
      // L3 早在 v1.3.38 就把这条改成了 `rivalIsSafe`（看队友这手压不压得住），
      // 但 `safeHint` 漏改了 —— 同一 bug 的第四份拷贝（见 docs/15 的教训）。
      const partnerSeat = ((input.seat + 2) % 4) as Seat
      const safe =
        input.currentWinner === null ||
        rivalIsSafe(
          { seat: partnerSeat, analysis: input.currentWinner },
          ctx,
          input.opponents,
          input.remainingSeats,
          input.seat,
        )
      if (safe) {
        // 这一墩已经是我方的 ⇒ 有分就往里垫（人类最标准的打法）
        const withPoints = candidates.filter((c) => cardsScore(c) > 0)
        if (withPoints.length > 0) {
          return [...withPoints].sort((a, b) => cardsScore(b) - cardsScore(a))[0]!.slice()
        }
      }
      // 队友这手可能被反压 ⇒ 收着打，垫最小的牌（这时候把 10 甩上去就是白送）
      return (sorted[0] as Card[]).slice()
    }

    const winner = input.currentWinner
    const winners =
      winner === null
        ? candidates
        // **必须用 `beatsPlay`**（结构一致 **且** 牌力更大）。
        // 原来用的是 `canFollowShape` —— 它不比牌力，于是任何同型牌都被当成"能赢"，
        // 接下来又按"最省"排序 ⇒ 挑一张更小的牌去陪跑（用户 2026-10-31 报）。
        : candidates.filter((cards) => beatsPlay(analyze(cards, ctx), winner, ctx))
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
