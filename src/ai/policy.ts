/**
 * AI 策略：三档难度
 *
 * L0 随机合法出牌
 * L1 启发式（省大牌、保分、跟牌优先出最小）
 * L2 L1 + 一层「这手能不能吃到分」的评估
 *
 * 全部确定性：同 state + 同 rng 序列 → 同出牌（ADR-012）
 */

import { analyze, cardsScore, checkPlay, suitSlotOf } from '@core'
import type { Card, PlayAnalysis, RuleContext, Seat } from '@core'
import { enumeratePlays } from './enumerate'
import type { PlayContext } from './enumerate'
import type { Rng } from '@core'

export type AiLevel = 0 | 1 | 2

/**
 * L2 附加项的权重。
 *
 * 标定方法见 docs/08 ADR-014：用「座位互换配对测量」对比 L2 与 L1 的净胜率，
 * 消掉座位偏差后再取较优值。改动必须重跑标定。
 */
export const L2_WEIGHTS = {
  /** 跟牌：这一手会被对手反压时扣分（避免白打大牌） */
  over: 0.9,
  /** 首出：这一手会被对手压时扣分 */
  overLead: 0.5,
  /** 跟牌：这一墩已有的分越多，赢墩的溢价越高 */
  trick: 0.06,
  /** 首出：有连对的长套加分（把拖拉机先兑现） */
  tractor: 0.4,
}

export interface AiDecisionInput {
  readonly seat: Seat
  readonly hand: readonly Card[]
  readonly ctx: RuleContext
  readonly play: PlayContext
  /** 本墩当前最大牌（用于判断「我跟了能不能赢」）；首出时为 null */
  readonly currentWinner: { readonly seat: Seat; readonly analysis: PlayAnalysis } | null
  /** 该座位是否与当前最大牌同队 */
  readonly partnerLeading: boolean
  /**
   * 三家对手的手牌。
   *
   * L2 用它做「这一手能不能守住」的前瞻判断：
   * 对手手里有没有更大的牌能压过我。L1 不用这个信息。
   */
  readonly opponents: readonly (readonly Card[])[]
}

export interface AiDecision {
  readonly cards: readonly Card[]
  readonly reason: string
}

/** 过滤出真正合法的候选 */
function legalOnly(
  hand: readonly Card[],
  ctx: RuleContext,
  play: PlayContext,
  limit: number,
): Card[][] {
  const raw = enumeratePlays(hand, ctx, play, limit)
  const out: Card[][] = []
  for (const cards of raw) {
    const r = checkPlay({
      hand,
      cards,
      ctx,
      ...(play.kind === 'follow'
        ? { lead: { cards: play.leadCards, analysis: play.leadAnalysis } }
        : {}),
      opponents: [],
    })
    if (r.ok) out.push(r.cards.slice())
  }
  return out
}

/** 手牌总牌力（用于评估「这手值不值得留」） */
function handStrength(hand: readonly Card[], ctx: RuleContext): number {
  let s = 0
  for (const c of hand) s += ctx.power.get(c.value)
  return s
}

/** 手牌里某个槽（花色或主牌）的张数 */
function slotCount(hand: readonly Card[], slot: number, ctx: RuleContext): number {
  let n = 0
  for (const c of hand) if (suitSlotOf(c.value, ctx.power) === slot) n++
  return n
}

/** 这一墩里已经出现的分数（不含分牌） */
function trickPointsSoFar(
  currentWinner: { readonly analysis: PlayAnalysis } | null,
  play: PlayContext,
): number {
  if (currentWinner) return currentWinner.analysis.score
  return play.kind === 'follow' ? play.leadAnalysis.score : 0
}

/**
 * 对手能不能压过我这一手。
 *
 * L2 的前瞻：AI 知道另外三家的手牌（游戏状态里就有），
 * 所以能判断「我这手出了以后，对手是不是还有更大的牌能反压」。
 *
 * 这是 L2 比 L1 强的核心：L1 只看当前墩，L2 会想「出完之后会不会被抢」。
 */
function canBeOverturned(
  cards: readonly Card[],
  ctx: RuleContext,
  opponents: readonly (readonly Card[])[],
): boolean {
  if (cards.length === 0) return false
  const mine = analyze(cards, ctx)
  if (mine.suitSlot === -1) return true // 混花色，不可能守住
  if (!mine.keyCard) return false

  const myPower = ctx.power.get(mine.keyCard.value)
  const mySlot = mine.suitSlot

  for (const hand of opponents) {
    // 对手能出的最大牌：主牌槽里最大的，或同花色槽里最大的
    let best = -1
    for (const c of hand) {
      const slot = suitSlotOf(c.value, ctx.power)
      // 主牌能压一切；副牌只能压同花色
      const canBeat =
        slot === 4 ? mySlot !== 4 : slot === mySlot
      if (canBeat) {
        const p = ctx.power.get(c.value)
        if (p > best) best = p
      }
    }
    if (best > myPower) return true
  }
  return false
}

/** 该槽里有没有连对（拖拉机） */
function hasTractor(hand: readonly Card[], slot: number, ctx: RuleContext): boolean {
  const cards = hand.filter((c) => suitSlotOf(c.value, ctx.power) === slot)
  if (cards.length < 4) return false
  return analyze(cards, ctx).groups.some((g) => g.kind === 'tractor')
}

export function decide(input: AiDecisionInput, level: AiLevel, rng: Rng): AiDecision {
  const { hand, ctx, play } = input
  const candidates = legalOnly(hand, ctx, play, 60)
  if (candidates.length === 0) {
    // 兜底：优先出首出花色的牌，再按牌力从小到大
    const slot = play.kind === 'follow' ? play.leadAnalysis.suitSlot : -1
    const count = play.kind === 'follow' ? play.leadCards.length : 1
    const sorted = [...hand].sort((a, b) => {
      const sa = slot !== -1 && ctx.power.isTrump(a.value) === (slot === 4) ? 0 : 1
      const sb = slot !== -1 && ctx.power.isTrump(b.value) === (slot === 4) ? 0 : 1
      if (sa !== sb) return sa - sb
      return ctx.power.get(a.value) - ctx.power.get(b.value)
    })
    return { cards: sorted.slice(0, count), reason: '兜底' }
  }

  if (level === 0) {
    const pick = candidates[rng.int(candidates.length)] as Card[]
    return { cards: pick, reason: '随机' }
  }

  const scored = candidates.map((cards) => ({ cards, score: scoreCandidate(cards, input, level) }))
  scored.sort((a, b) => b.score - a.score)

  // L1 在并列最优里随机挑一个，避免每局一模一样
  const top = scored[0]!.score
  const best = scored.filter((s) => s.score >= top - 0.001)
  const chosen = best[rng.int(best.length)]!
  return { cards: chosen.cards, reason: level === 2 ? '评估' : '启发式' }
}

/**
 * 给候选打分（越高越好）。
 *
 * L1（启发式）：
 *   - 出牌消耗的牌力越低越好（省大牌）
 *   - 能吃到分就加分；压不过时别送分
 *   - 队友领先时不抢
 *   - 首出优先长套
 *
 * L2（评估）在 L1 之上把「省牌」换成**位置评估**：
 *   出一手之后，剩下手牌的位置价值掉多少。
 *   位置价值考虑了冗余（成对的牌丢一张不心疼）、主牌控制权、
 *   对子/连对结构、以及分数牌资源 —— 比单纯的牌力总和更贴近真实牌力。
 */
function scoreCandidate(cards: readonly Card[], input: AiDecisionInput, level: AiLevel): number {
  const { ctx, play, currentWinner, partnerLeading, hand, opponents } = input
  const a = analyze(cards, ctx)
  const powerCost = cards.reduce((s, c) => s + ctx.power.get(c.value), 0)
  const points = cardsScore(cards)

  let score = 0
  // ---- 基础：省牌（牌力越低越好）----
  score -= powerCost / (cards.length * 80)

  if (play.kind === 'follow') {
    // 比较对象必须是**本墩当前最大牌**，不是首出牌。
    // 首出之后可能已被别人压过；拿首出牌当基准会误判「我能赢」，
    // 导致 AI 以为自己能压过而白白打大牌。
    const rival = currentWinner ? currentWinner.analysis : play.leadAnalysis
    const iAmWinning = canIWin(a, rival, ctx)
    if (partnerLeading) {
      // 队友已经赢着：尽量出小牌、别抢
      score += iAmWinning ? -0.5 : 0.4
    } else if (iAmWinning) {
      // 我能压过当前最大：吃分是好事
      score += 0.6 + points * 0.08
    } else {
      // 压不过：垫牌时别送分
      score -= points * 0.15
    }

    if (level === 2) {
      // ① 前瞻：这一手能不能守住？
      //    对手手里有更大的牌 → 我赢不住，大牌就白花了。
      if (canBeOverturned(cards, ctx, opponents)) score -= L2_WEIGHTS.over
      // ② 赢墩价值：这一墩已有的分越多，越值得花代价去赢
      if (iAmWinning && !partnerLeading) {
        score += trickPointsSoFar(currentWinner, play) * L2_WEIGHTS.trick
      }
    }
  } else {
    // 首出：长套优先（同一槽牌多），大牌留手
    const slot = a.suitSlot
    if (slot !== -1) {
      // 同槽张数 —— 必须按花色槽统计。
      // 早先用「同为主/副」的粗略计数，把四种副牌混在一起，
      // 结果 AI 永远选不出真正的长套（黑桃 3 张 vs 红桃 6 张被算成一样）。
      score += Math.min(slotCount(hand, slot, ctx), 10) * 0.05
    }
    score -= points * 0.02 // 首出别急着甩分

    if (level === 2) {
      // ③ 前瞻：首出这手，对手能不能压？
      if (canBeOverturned(cards, ctx, opponents)) score -= L2_WEIGHTS.overLead
      // ④ 有连对的长套优先 —— 把拖拉机先兑现
      if (slot !== -1 && hasTractor(hand, slot, ctx)) score += L2_WEIGHTS.tractor
    }
  }

  return score
}

/**
 * 我这一手能不能压过对方。
 *
 * `rival` 传的是**本墩当前最大牌**的分析（首出方首出时才是 lead）。
 */
function canIWin(mine: PlayAnalysis, rival: PlayAnalysis, ctx: RuleContext): boolean {
  if (mine.suitSlot === -1) return false
  const rivalTrump = rival.suitSlot === 4
  const myTrump = mine.suitSlot === 4
  // 主牌压副牌；副牌只能压同花色
  if (rivalTrump) {
    if (!myTrump) return false
  } else if (mine.suitSlot !== rival.suitSlot) {
    return false
  }
  if (mine.pairCount !== rival.pairCount) return false
  if (!mine.keyCard || !rival.keyCard) return false
  return ctx.power.get(mine.keyCard.value) > ctx.power.get(rival.keyCard.value)
}

export { handStrength }
