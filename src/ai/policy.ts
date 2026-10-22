/**
 * AI 策略：三档难度
 *
 * L0 随机合法出牌
 * L1 启发式（省大牌、保分、跟牌优先出最小）
 * L2 L1 + 一层「这手能不能吃到分」的评估
 *
 * 全部确定性：同 state + 同 rng 序列 → 同出牌（ADR-012）
 */

import { analyze, cardsScore, checkPlay } from '@core'
import type { Card, PlayAnalysis, RuleContext, Seat } from '@core'
import { enumeratePlays } from './enumerate'
import type { PlayContext } from './enumerate'
import type { Rng } from '@core'

export type AiLevel = 0 | 1 | 2

export interface AiDecisionInput {
  readonly seat: Seat
  readonly hand: readonly Card[]
  readonly ctx: RuleContext
  readonly play: PlayContext
  /** 本墩当前最大牌（用于判断「我跟了能不能赢」）；首出时为 null */
  readonly currentWinner: { readonly seat: Seat; readonly analysis: PlayAnalysis } | null
  /** 该座位是否与当前最大牌同队 */
  readonly partnerLeading: boolean
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
 * 通用原则：
 *   - 出牌消耗的牌力越低越好（省大牌）
 *   - 能吃到分就加分
 *   - 队友已经在赢就少出力
 *   - 首出时优先出小牌 / 长套
 */
function scoreCandidate(cards: readonly Card[], input: AiDecisionInput, level: AiLevel): number {
  const { ctx, play, currentWinner, partnerLeading } = input
  const a = analyze(cards, ctx)
  const powerCost = cards.reduce((s, c) => s + ctx.power.get(c.value), 0)
  const points = cardsScore(cards)

  let score = 0
  // 省牌：牌力越低越好（归一化到 0..1 区间再放大）
  score -= powerCost / (cards.length * 80)

  if (play.kind === 'follow') {
    const iAmWinning = canIWin(a, play.leadAnalysis, ctx)
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
    if (level === 2 && currentWinner) {
      const gap = (a.keyCard ? ctx.power.get(a.keyCard.value) : 0) - (currentWinner.analysis.keyCard ? ctx.power.get(currentWinner.analysis.keyCard.value) : 0)
      if (gap > 0 && gap < 4) score -= 0.3 // 险胜，浪费大牌
    }
  } else {
    // 首出：长套优先（同一槽牌多），大牌留手
    const slot = a.suitSlot
    if (slot !== -1) {
      const sameSlot = input.hand.filter((c) => ctx.power.isTrump(c.value) === (slot === 4)).length
      score += Math.min(sameSlot, 10) * 0.03
    }
    score -= points * 0.02 // 首出别急着甩分
  }

  return score
}

/** 我这一手能不能压过首出 */
function canIWin(mine: PlayAnalysis, lead: PlayAnalysis, ctx: RuleContext): boolean {
  if (mine.suitSlot === -1) return false
  const leadTrump = lead.suitSlot === 4
  const myTrump = mine.suitSlot === 4
  if (leadTrump ? !myTrump : mine.suitSlot !== lead.suitSlot && !myTrump) return false
  if (mine.pairCount !== lead.pairCount) return false
  if (!mine.keyCard || !lead.keyCard) return false
  return ctx.power.get(mine.keyCard.value) > ctx.power.get(lead.keyCard.value)
}

export { handStrength }
