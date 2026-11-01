/**
 * 队友有 ♦A，该不该出？（用户 2026-11-01 报）
 *
 * 局面：主 ♦、打 7；南出 ♦10、西出 ♦9，北（队友）手里有 ♦A 与 ♦J，东还没出。
 * 用户看到「北有 A 不出，出 J，被东的 Q 抢下」，认为 AI 打错。
 *
 * 结论：**AI 是对的** —— 关键在「东手里有没有比 A 更大的主」。
 *   ① 东只有 ♦Q ⇒ 出 A 稳赢 10 分（AI 确实出 A）
 *   ② 东有 ♦7（打 7 的级牌，比 A 大）⇒ A 也会被压，那就出 J 省 A（AI 确实出 J）
 *
 * 这两个用例锁住上面两条 —— 以后调权重不能把「A 能赢时不出 A」改出来。
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_RULE_CONFIG, analyze, buildPowerTable, cardsScore, mulberry32 } from '@core'
import type { Card, RuleContext, Seat } from '@core'
import { decide } from '@ai/policy'
import type { AiDecisionInput } from '@ai/policy'

const ctx: RuleContext = {
  power: buildPowerTable({ mode: 1, levelRank: 7, trump: 3, forcedNT: false }),
  trump: 3,
  levelRank: 7,
  forcedNT: false,
  config: DEFAULT_RULE_CONFIG,
}
const c = (v: number): Card => ({ id: v * 2, value: v })
const D = (rank: number): number => 39 + rank // ♦

/**
 * @param eastHasLevel7 东家手里有没有 7♦（级牌 = 主牌里比 A 大的那张）
 */
function pick(eastHasLevel7: boolean): number[] {
  const lead = [c(D(8))] // ♦10
  const west = [c(D(7))] // ♦9
  // 填充牌**不能用 7**（打 7 ⇒ 所有 7 都是级牌/主牌，会给东家一张比 A 大的主）
  const myHand = [c(D(12)), c(D(9)), c(26 + 2), c(26 + 3)] // ♦A ♦J ♣4 ♣5
  const east = eastHasLevel7 ? [c(D(5)), c(D(10))] : [c(D(10)), c(26 + 1)] // ♦7+♦Q ／ ♦Q+♣3
  const input: AiDecisionInput = {
    seat: 2 as Seat,
    hand: myHand,
    ctx,
    play: { kind: 'follow', leadCards: lead, leadAnalysis: analyze(lead, ctx) },
    currentWinner: { seat: 0 as Seat, analysis: analyze(lead, ctx) },
    partnerLeading: false,
    // 顺序必须与 seatsOpponentOf(2) = [0,1,3] 一致，且**只给 3 家**
    opponents: [[], west, east],
    remainingSeats: [2, 3] as Seat[],
    trickPoints: cardsScore(lead) + cardsScore(west),
  }
  return decide(input, 3, mulberry32(1)).cards.map((x) => x.value)
}

describe('队友有 ♦A（打 7 · 主 ♦）', () => {
  it('东家只有 ♦Q ⇒ 出 ♦A 稳赢这 10 分', () => {
    expect(pick(false)).toEqual([D(12)])
  })

  it('东家有 7♦（比 A 大的级牌）⇒ A 也会被压，出 ♦J 省 A', () => {
    expect(pick(true)).toEqual([D(9)])
  })
})
