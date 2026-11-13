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

import { analyze, beatsPlay, checkPlayBatch, preComputeHand, suitSlotOf } from '@core'
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

/**
 * 预计算每个槽的张数，供排序闭包查表替代逐次遍历手牌。
 */
function slotCountsOf(hand: readonly Card[], ctx: RuleContext): number[] {
  const counts = [0, 0, 0, 0, 0]
  for (const c of hand) {
    const slot = suitSlotOf(c.value, ctx.power)
    counts[slot] = (counts[slot] ?? 0) + 1
  }
  return counts
}

/** 只保留真正合法的候选（**规则判定只走 checkPlay**） */
function legalCandidates(input: SafeHintInput): Card[][] {
  const pre = preComputeHand(input.hand, input.ctx)
  const batchOpts = {
    ctx: input.ctx,
    ...(input.play.kind === 'follow'
      ? { lead: { cards: input.play.leadCards, analysis: input.play.leadAnalysis } }
      : {}),
    opponents: input.opponents,
    pre,
  }
  const out: Card[][] = []
  for (const cards of enumeratePlays(input.hand, input.ctx, input.play, 60, true)) {
    const r = checkPlayBatch(cards, batchOpts)
    if (r.ok) out.push(r.cards.slice())
  }
  return out
}

/**
 * 选一手「稳妥」的牌。返回空数组表示没有合法候选（调用方退回 `choosePlay`）。
 */
export function safeHint(input: SafeHintInput): Card[] {
  const candidates = legalCandidates(input)
  if (candidates.length === 0) return []
  const { ctx, hand } = input

  // 预计算每个候选的分数、平均牌力、suitSlot，避免在排序闭包里反复调 analyze + cardsScore
  //（旧实现每次比较都 reduce 遍历候选 / analyze 分配 Map，O(n log n) 次 × 每次遍历整组牌）
  // suitSlot 内联计算：取第一张牌的 slot，再验所有牌同槽（与 analyze 里的单槽判定一致）
  interface CandInfo { cards: Card[]; score: number; avgPower: number; suitSlot: number; keyCardValue: number; slotCount: number }
  const infos: CandInfo[] = candidates.map((cards) => {
    let powerSum = 0
    let score = 0
    let keyCardValue = cards[0]!.value
    let keyPower = ctx.power.get(keyCardValue)
    const firstSlot = suitSlotOf(cards[0]!.value, ctx.power)
    let sameSlot = true
    for (const c of cards) {
      const v = c.value
      const p = ctx.power.get(v)
      powerSum += p
      if (p > keyPower) { keyCardValue = v; keyPower = p }
      // 内联 cardScore
      if (v < 52) {
        const r = v % 13
        if (r === 3) score += 5
        else if (r === 8 || r === 11) score += 10
      }
      if (sameSlot && suitSlotOf(v, ctx.power) !== firstSlot) sameSlot = false
    }
    return { cards, score, avgPower: powerSum / cards.length, suitSlot: sameSlot ? firstSlot : -1, keyCardValue, slotCount: 0 }
  })

  // 预计算每个槽的张数，排序闭包查表替代逐次遍历手牌
  const handSlotCounts = slotCountsOf(hand, ctx)
  for (const info of infos) {
    info.slotCount = info.suitSlot === -1 ? 0 : handSlotCounts[info.suitSlot] ?? 0
  }

  // 排序：先比「带多少分」（越少越好），再比牌力（越低越好）
  const byCheapInfo = (a: CandInfo, b: CandInfo): number => {
    if (a.score !== b.score) return a.score - b.score
    return a.avgPower - b.avgPower
  }
  const sorted = [...infos].sort(byCheapInfo)

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
        const withPoints = infos.filter((i) => i.score > 0)
        if (withPoints.length > 0) {
          // O(n) 找最大 score 的候选，替代 [...withPoints].sort()[0]
          let best = withPoints[0]!
          for (let i = 1; i < withPoints.length; i++) {
            if (withPoints[i]!.score > best.score) best = withPoints[i]!
          }
          return best.cards.slice()
        }
      }
      // 队友这手可能被反压 ⇒ 收着打，垫最小的牌（这时候把 10 甩上去就是白送）
      return (sorted[0] as CandInfo).cards.slice()
    }

    const winner = input.currentWinner
    const winners =
      winner === null
        ? infos
        // **必须用 `beatsPlay`**（结构一致 **且** 牌力更大）。
        // 原来用的是 `canFollowShape` —— 它不比牌力，于是任何同型牌都被当成"能赢"，
        // 接下来又按"最省"排序 ⇒ 挑一张更小的牌去陪跑（用户 2026-10-31 报）。
        //
        // 两级过滤：先用 CandInfo 里已有的 suitSlot / keyCardValue 做廉价预筛，
        // 排除掉「槽不同」或「牌力不够」的候选，只有可能的才进 analyze。
        : infos.filter((i) => {
          // 槽判定：首出是主牌 → 跟的也必须是主牌；首出是副牌 → 同花色或主牌毙
          const leadSlot = winner.suitSlot
          if (leadSlot === -1) return false
          if (i.suitSlot === -1) return false // 混花色不可能赢
          if (leadSlot === 4) {
            if (i.suitSlot !== 4) return false
          } else {
            // 副牌首出：同花色或主牌能压
            if (i.suitSlot !== leadSlot && i.suitSlot !== 4) return false
          }
          // 牌力预筛：keyCard 牌力必须 > winner 的 keyCard 牌力（beatsPlay 要求严格大于）
          const winnerKeyPower = ctx.power.get(winner.keyCard!.value)
          if (ctx.power.get(i.keyCardValue) <= winnerKeyPower) return false
          // 结构判定仍需完整 analyze（对子数 / 拖拉机长度）
          return beatsPlay(analyze(i.cards, ctx), winner, ctx)
        })
    // ② 能压住、且这墩有分 → 抢，但用能赢的最小一手
    if (winners.length > 0 && input.trickPoints > 0) {
      // O(n) 找最小 avgPower 的候选，替代 [...winners].sort()[0]
      let best = winners[0]!
      for (let i = 1; i < winners.length; i++) {
        if (winners[i]!.avgPower < best.avgPower) best = winners[i]!
      }
      return best.cards.slice()
    }
    // ③ 能压住但没分 / 压不住 → 出最小的一手（0 分优先）
    return (sorted[0] as CandInfo).cards.slice()
  }

  /* ---------------- 首出 ---------------- */
  const sure = infos.filter((i) =>
    isSureToHold(i.cards, ctx, input.opponents, input.remainingSeats, input.seat),
  )
  // ④ 有稳赢的：优先兑现「不带分」的、牌力最低的那一手（省大牌、不甩分）
  if (sure.length > 0) {
    // O(n) 找 byCheapInfo 最优的候选，替代 [...sure].sort(byCheapInfo)[0]
    let best = sure[0]!
    for (let i = 1; i < sure.length; i++) {
      if (byCheapInfo(sure[i]!, best) < 0) best = sure[i]!
    }
    return best.cards.slice()
  }
  // ⑤ 没有稳赢的：先跑长套里最小的 0 分牌
  // O(n) 找 (byCheapInfo 最优, slotCount 最大) 的候选，替代 [...sorted].sort(...)[0]
  {
    let best = sorted[0] as CandInfo
    for (let i = 1; i < sorted.length; i++) {
      const cand = sorted[i] as CandInfo
      const cmp = byCheapInfo(cand, best)
      if (cmp < 0) best = cand
      else if (cmp === 0 && cand.slotCount > best.slotCount) best = cand
    }
    return best.cards.slice()
  }
}
