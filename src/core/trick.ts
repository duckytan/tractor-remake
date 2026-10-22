/**
 * 一墩判定
 * 规则依据：规则书 §7.1
 */

import type { PlayAnalysis } from './analyze'
import type { Card, RuleContext, Seat } from './types'

export interface Play {
  readonly seat: Seat
  readonly cards: readonly Card[]
  readonly analysis: PlayAnalysis
}

export interface TrickResult {
  readonly winner: Seat
  readonly score: number
  readonly winnerAnalysis: PlayAnalysis
  /** 参与竞争的手牌座位（调试用） */
  readonly contenders: readonly Seat[]
}

/** 该手牌是否具备「压过首出」的资格 */
function canBeat(play: PlayAnalysis, lead: PlayAnalysis): boolean {
  if (play.suitSlot === -1) return false
  const leadIsTrump = lead.suitSlot === 4
  const playIsTrump = play.suitSlot === 4
  if (leadIsTrump) {
    if (!playIsTrump) return false
  } else if (play.suitSlot !== lead.suitSlot && !playIsTrump) {
    return false
  }
  // 结构必须一致：张数相同的前提下，对子数相同即结构相同
  if (play.pairCount !== lead.pairCount) return false
  return true
}

/**
 * 判定一墩的赢家。
 *
 * 规则：
 *   ① 混合花色（suitSlot = -1）的牌永远不能赢 —— 那就是垫牌
 *   ② 结构不符（对子数不同）的牌不能赢 —— 同样是垫牌
 *   ③ 首出是副牌时，主牌可以压（毙牌）；首出是主牌时只有主牌能比
 *   ④ 同类型比 keyCard 牌力，最大者赢；牌力相同则先出者赢
 */
export function resolveTrick(plays: readonly Play[], ctx: RuleContext): TrickResult {
  if (plays.length === 0) throw new Error('resolveTrick: 没有出牌')
  const lead = (plays[0] as Play).analysis

  const qualified = plays.filter((p) => canBeat(p.analysis, lead))
  const trumpPlays = qualified.filter((p) => p.analysis.suitSlot === 4)
  const pool = lead.suitSlot === 4 || trumpPlays.length > 0 ? trumpPlays : qualified

  let best = pool[0] as Play
  for (const p of pool) {
    const a = p.analysis.keyCard
    const b = best.analysis.keyCard
    if (!a || !b) continue
    if (ctx.power.get(a.value) > ctx.power.get(b.value)) best = p
  }

  let score = 0
  for (const p of plays) score += p.analysis.score

  return {
    winner: best.seat,
    score,
    winnerAnalysis: best.analysis,
    contenders: pool.map((p) => p.seat),
  }
}
