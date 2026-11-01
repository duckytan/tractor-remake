/**
 * 队友有 ♦A，该不该出？（用户 2026-11-01 报）
 *
 * 局面：**主 ♠**、打 7；南出 ♦10、西出 ♦9，北（队友）手里有 ♦A，东还没出。
 * 用户看到「北有 A 不出」，认为 AI 打错。
 *
 * 结论：**AI 是对的**（♦ 是副牌，♦A 压得住 ♦Q；东出过 ♦ 也毙不了）。
 * 另外锁一条「缺门时用主牌 A 毙」—— 这是同一局的另一种读法。
 *
 * 这两个用例锁住上面两条 —— 以后调权重不能把「A 能赢时不出 A」改出来。
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_RULE_CONFIG, analyze, buildPowerTable, cardsScore, mulberry32 } from '@core'
import type { Card, RuleContext, Seat } from '@core'
import { decide } from '@ai/policy'
import type { AiDecisionInput } from '@ai/policy'

const ctx: RuleContext = {
  // 主花色是**黑桃 ♠**（用户 2026-11-02 纠正：之前我误读成 ♦）
  power: buildPowerTable({ mode: 1, levelRank: 7, trump: 0, forcedNT: false }),
  trump: 0,
  levelRank: 7,
  forcedNT: false,
  config: DEFAULT_RULE_CONFIG,
}
const c = (v: number): Card => ({ id: v * 2, value: v })
const D = (rank: number): number => 39 + rank // ♦

/**
 * @param eastHasLevel7 东家手里有没有 7♦（级牌 = 主牌里比 A 大的那张）
 */
/** 北手里有 ♦A 与 ♦J，东只有 ♦Q ⇒ 必须出 ♦A 拿这 10 分 */
function pickWithDiamond(): number[] {
  const lead = [c(D(8))] // ♦10
  const west = [c(D(7))] // ♦9
  const myHand = [c(D(12)), c(D(9)), c(26 + 2), c(26 + 3)] // ♦A ♦J ♣4 ♣5
  const east = [c(D(10)), c(26 + 1)] // ♦Q ♣3（有 ♦，不能毙）
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

/** 北缺 ♦，但有主牌 ♠A 能毙、也有 ♣J 可垫 ⇒ 必须毙 */
function pickRuff(): number[] {
  const lead = [c(D(8))] // ♦10
  const west = [c(D(7))] // ♦9
  const myHand = [c(0 + 12), c(26 + 9), c(26 + 8)] // ♠A ♣J ♣10（无 ♦）
  const east = [c(D(10)), c(26 + 1)] // ♦Q ♣3
  const input: AiDecisionInput = {
    seat: 2 as Seat,
    hand: myHand,
    ctx,
    play: { kind: 'follow', leadCards: lead, leadAnalysis: analyze(lead, ctx) },
    currentWinner: { seat: 0 as Seat, analysis: analyze(lead, ctx) },
    partnerLeading: false,
    opponents: [[], west, east],
    remainingSeats: [2, 3] as Seat[],
    trickPoints: cardsScore(lead) + cardsScore(west),
  }
  return decide(input, 3, mulberry32(1)).cards.map((x) => x.value)
}

describe('队友有 A（主 ♠ · 打 7 · 南出 ♦10）', () => {
  it('有 ♦A 且东只有 ♦Q ⇒ 出 ♦A 拿这 10 分', () => {
    expect(pickWithDiamond()).toEqual([D(12)])
  })

  it('缺 ♦ 但手里有 ♠A ⇒ 用主牌 A 毙下这 10 分', () => {
    expect(pickRuff()).toEqual([0 + 12])
  })
})
