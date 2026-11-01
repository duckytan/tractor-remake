/**
 * 跟单张时的**候选覆盖**（v1.3.55）
 *
 * 背景：`enumerateFollows` 对「跟单张」原本只给 4 个候选
 * （最小 / 最大 / 非分牌优先的第一张 / 分牌优先的第一张），
 * 该花色**中间那些牌全被漏掉** —— 尤其是「刚好能压过当前最大」的那张。
 *
 * 实测（60 副 AI 自对打、只看「有分单张跟牌」共 196 次）：
 *   - 最小能赢的那张不在候选里：**18.9% → 0%**
 *   - 压过时「刚好用最小能赢的」：68.7% → **78.0%**
 *   - 平均多花牌力：0.84 → **0.65**
 * 决策耗时 0.12ms → 0.14ms/次（AI 每手间隔 420ms，可忽略）。
 *
 * 三条用例分别锁：宽集覆盖该槽每个牌值、窄集保持「看得少」、AI 真的会挑「刚好能赢」的那张。
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_RULE_CONFIG, analyze, buildPowerTable, cardsScore, mulberry32 } from '@core'
import type { Card, RuleContext, Seat } from '@core'
import { enumeratePlays } from '@ai/enumerate'
import type { PlayContext } from '@ai/enumerate'
import { decide } from '@ai/policy'
import type { AiDecisionInput } from '@ai/policy'

const ctx: RuleContext = {
  power: buildPowerTable({ mode: 1, levelRank: 7, trump: 0, forcedNT: false }),
  trump: 0,
  levelRank: 7,
  forcedNT: false,
  config: DEFAULT_RULE_CONFIG,
}
const c = (v: number): Card => ({ id: v * 2, value: v })
/** ♦ 的牌值偏移（♠=0 ♥=13 ♣=26 ♦=39），rank 下标 0=2 … 12=A */
const D = (rank: number): number => 39 + rank
const DIAMOND_9 = D(7)
const DIAMOND_10 = D(8)
const DIAMOND_J = D(9)
const DIAMOND_Q = D(10)
const DIAMOND_K = D(11)
const DIAMOND_A = D(12)

/** 南出 ♦10；北（座位 2）手里 ♦9 ♦J ♦Q ♦K ♦A + 两张废牌 */
const lead = [c(DIAMOND_10)]
const myHand = [c(DIAMOND_9), c(DIAMOND_J), c(DIAMOND_Q), c(DIAMOND_K), c(DIAMOND_A), c(26 + 2), c(26 + 3)]
const pc: PlayContext = { kind: 'follow', leadCards: lead, leadAnalysis: analyze(lead, ctx) }

/** 候选里「单张」的牌值集合 */
function singleValues(wide: boolean): Set<number> {
  const out = new Set<number>()
  for (const cs of enumeratePlays(myHand, ctx, pc, 60, wide)) {
    if (cs.length === 1) out.add((cs[0] as Card).value)
  }
  return out
}

describe('跟单张的候选覆盖', () => {
  it('宽集：该花色每个牌值都有一个单张候选', () => {
    const vals = singleValues(true)
    for (const v of [DIAMOND_9, DIAMOND_J, DIAMOND_Q, DIAMOND_K, DIAMOND_A]) expect(vals.has(v)).toBe(true)
  })

  it('窄集（L0/L1）仍然只给「最小 + 最大」两个 —— 「低档看得少」的语义不能被顺手改掉', () => {
    const vals = singleValues(false)
    expect([...vals].sort((a, b) => a - b)).toEqual([DIAMOND_9, DIAMOND_A])
    expect(vals.has(DIAMOND_J)).toBe(false)
  })

  it('有分墩：用「刚好能赢」的 ♦J，而不是 ♦A（过度）或 ♦9（陪跑）', () => {
    // 这张手里没有 ♦K/♦Q ⇒ 旧候选只有 {♦9, ♦A}：要么陪跑、要么烧掉 ♦A
    const hand = [c(DIAMOND_9), c(DIAMOND_J), c(DIAMOND_A), c(26 + 2), c(26 + 3)]
    const input: AiDecisionInput = {
      seat: 2 as Seat,
      hand,
      ctx,
      play: pc,
      currentWinner: { seat: 0 as Seat, analysis: analyze(lead, ctx) },
      partnerLeading: false,
      // 顺序与 seatsOpponentOf(2) = [0,1,3] 一致，且只给 3 家；东家手里没有 ♦，压不住
      opponents: [[], [c(26 + 5)], [c(26 + 6)]],
      remainingSeats: [2, 3] as Seat[],
      trickPoints: cardsScore(lead),
    }
    const picked = decide(input, 3, mulberry32(1)).cards.map((x) => x.value)
    expect(picked).toEqual([DIAMOND_J])
  })
})
