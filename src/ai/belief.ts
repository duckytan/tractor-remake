/**
 * 对手手牌的**概率推断**（v1.3.29 · docs/15 KN-10）
 *
 * 背景：L2/L3 原来直接读 `opponents`（三家真实手牌）来判断「我这手会不会被压」。
 * 从玩家视角那是**明牌作弊**，而且让强度标定含信息优势（docs/32 B-8）。
 *
 * 这里改成只用**公开信息**推断：
 *   · 我自己的手牌
 *   · 已经出过的牌（`history` + 当前墩）
 *   · 底牌（**只有庄家知道**；非庄家不能把它从池子里剔掉，否则等于偷看）
 *   · 每家还剩几张（公开：牌背数量）
 *
 * 模型是「均匀随机分配」的一阶近似：在没有更多信息时，把「未知牌」看成
 * 随机分布到「三家手牌 + 未知底牌」这些槽位里，用超几何算概率。
 *
 * 已知的局限（诚实标注）：
 *   · 不考虑「对手之前为什么那样出牌」——真正的贝叶斯更新需要记录每个动作的似然，
 *     那是 `docs/28` 的 HQ/ΔHQ 范畴，本文件只做静态先验；
 *   · 连对（拖拉机）按「至少有一对能压」近似，会**高估**被压概率（偏保守）。
 *
 * 分层：只依赖 `core` 与 `app` 的类型，不碰 UI / 音频。
 */

import { DECK_SIZE, suitSlotOf } from '@core'
import type { Card, RuleContext, Seat, SuitSlot } from '@core'
import { SEAT_COUNT } from '@core'
import type { GameState } from '@app/state'

/** 推断所需的全部公开信息 */
export interface Belief {
  /**
   * 未知牌池：我看不到的牌。
   *
   * 非庄家时**包含底牌**（我不知道是哪 8 张），庄家时不含。
   */
  readonly unseen: readonly Card[]
  /** 每家（含我自己）当前手牌张数 —— 公开信息，牌背数量就写着 */
  readonly handSizes: readonly number[]
  /** 我的座位 */
  readonly seat: Seat
}

/** 一墩里所有已出的牌 */
function playedCards(s: GameState): Card[] {
  const out: Card[] = []
  for (const rec of s.history) for (const p of rec.plays) out.push(...p.cards)
  for (const p of s.trick.plays) out.push(...p.cards)
  return out
}

/**
 * 从公开信息构造信念。
 *
 * `unseen` 的计算：
 *   全牌 − 我的手牌 − 已出的牌 − （庄家才知道的）底牌
 *
 * 非庄家**不能**减底牌 —— 他不知道是哪 8 张，减掉就等于偷看。
 */
export function buildBelief(s: GameState, seat: Seat): Belief {
  const mine = s.hands[seat] as readonly Card[]
  const seen = new Set<number>(mine.map((c) => c.id))
  for (const c of playedCards(s)) seen.add(c.id)
  // 只有庄家知道底牌
  if (s.dealer === seat) for (const c of s.bottom) seen.add(c.id)

  const unseen: Card[] = []
  // 遍历整副牌的所有 id（0..107），把「我确实见过的」剔掉。
  // 直接按 id 枚举而不是拿 hands 拼，是因为 `hands` 里只有手牌，
  // 底牌/已出的牌分散在别的字段，容易漏。
  for (let id = 0; id < DECK_SIZE; id++) {
    if (seen.has(id)) continue
    unseen.push({ id, value: id >> 1 })
  }

  const handSizes: number[] = []
  for (let i = 0; i < SEAT_COUNT; i++) handSizes.push((s.hands[i] as readonly Card[]).length)

  return { unseen, handSizes, seat }
}

/**
 * 「未知池里的 K 张特定牌，一张都不在某个 h 张手牌里」的概率。
 *
 * 超几何：K 张牌随机落在 M 个槽位里，其中 h 个属于这家。
 * 逐张相乘（不放回）：
 *   P = Π_{j=0..K-1} (M − h − j) / (M − j)
 */
function probNoneInHand(m: number, h: number, k: number): number {
  if (k <= 0 || h <= 0) return 1
  if (h >= m) return 0
  let p = 1
  for (let j = 0; j < k; j++) {
    const denom = m - j
    if (denom <= 0) break
    p *= Math.max(0, (denom - h) / denom)
    if (p === 0) return 0
  }
  return p
}

/** 某槽里「单张能压过 myPower」的未知牌张数（主牌能压副牌） */
function countBeatingSingles(
  unseen: readonly Card[],
  ctx: RuleContext,
  mySlot: SuitSlot,
  myPower: number,
): number {
  let k = 0
  for (const c of unseen) {
    const slot = suitSlotOf(c.value, ctx.power)
    if (mySlot === 4) {
      // 我出主牌：只有更大的主牌能压
      if (slot === 4 && ctx.power.get(c.value) > myPower) k += 1
    } else {
      // 我出副牌：更大的同花色，或**任意**主牌（毙牌）
      if (slot === 4) k += 1
      else if (slot === mySlot && ctx.power.get(c.value) > myPower) k += 1
    }
  }
  return k
}

/** 某槽里「能凑成一对且压过我」的未知点数（每项代表一对） */
function countBeatingPairs(
  unseen: readonly Card[],
  ctx: RuleContext,
  mySlot: SuitSlot,
  myPower: number,
): number {
  const counts = new Map<number, number>()
  for (const c of unseen) counts.set(c.value, (counts.get(c.value) ?? 0) + 1)
  let n = 0
  for (const [value, cnt] of counts) {
    if (cnt < 2) continue
    const slot = suitSlotOf(value, ctx.power)
    if (mySlot === 4) {
      if (slot === 4 && ctx.power.get(value) > myPower) n += 1
    } else {
      // 副牌首出：主牌对子（任意大小）能毙；同花色的更大对子能压
      if (slot === 4) n += 1
      else if (slot === mySlot && ctx.power.get(value) > myPower) n += 1
    }
  }
  return n
}

export interface BeatChanceInput {
  readonly belief: Belief
  readonly ctx: RuleContext
  /** 我这手的槽（-1 = 混花色，必然守不住） */
  readonly mySlot: SuitSlot | -1
  /** 我这手需要的连对个数：0 = 单张，1 = 对子，n = n 连对 */
  readonly pairs: number
  /** 我这手的 keyCard 牌力 */
  readonly myPower: number
  /** 还没出牌的座位（已出过的压不了我）；不传 = 三家都算威胁 */
  readonly remaining?: readonly Seat[]
}

/**
 * 「至少有一个对手能压过我这手」的概率（0..1）。
 *
 * 只用公开信息。`pairs >= 1` 时按「至少有一对能压」近似 ——
 * 对拖拉机来说这是**高估**（要连着的 n 对，比一对难得多），偏保守。
 */
export function beatChance(input: BeatChanceInput): number {
  const { belief, ctx, mySlot, pairs, myPower, remaining } = input
  if (mySlot === -1) return 1
  const m = belief.unseen.length
  if (m === 0) return 0

  let pNoneAll = 1
  for (let i = 0; i < belief.handSizes.length; i++) {
    if (i === belief.seat) continue
    if (remaining !== undefined && !remaining.includes(i as Seat)) continue
    const h = belief.handSizes[i] as number
    if (h <= 0) continue

    let pNone: number
    if (pairs === 0) {
      const k = countBeatingSingles(belief.unseen, ctx, mySlot, myPower)
      pNone = probNoneInHand(m, h, k)
    } else {
      // 对子：对每个「能压的点数」算「两张都在他手里」的概率，再取「一个都没有」
      const beatingValues = countBeatingPairs(belief.unseen, ctx, mySlot, myPower)
      // 每个能压的点数在未知池里恰好 2 张（两副牌）⇒ 两张都进他手里的概率
      const pBoth = (h / m) * ((h - 1) / Math.max(1, m - 1))
      pNone = Math.pow(Math.max(0, 1 - pBoth), beatingValues)
    }
    pNoneAll *= pNone
  }
  return Math.max(0, Math.min(1, 1 - pNoneAll))
}

/** 「对手能压」的判定阈值：概率 ≥ 这个值就当成「会被压」 */
export const BEAT_THRESHOLD = 0.5
