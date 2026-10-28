/**
 * 「赢下这一墩值不值」的定价必须按**整墩**的分算，不能只看「当前最大那一手」。
 *
 * v1.3.38 修：`trickPointsSoFar` 旧实现返回 `currentWinner.analysis.score` ——
 * 只算「当前最大那一手带的分」。队友/对手垫进来的分完全看不见，
 * 实测 30% 的跟牌局面被低估、平均少 9.4 分。
 * 典型后果：这墩已经堆了 10 分，但「当前最大的那张」是 0 分的 A，
 * AI 就不肯用主牌毙 —— 而人一眼就知道这墩值得抢。
 */

import { describe, expect, it } from 'vitest'
import { analyze, buildPowerTable, DEFAULT_RULE_CONFIG, mulberry32 } from '@core'
import type { Card, RuleContext } from '@core'
import { decide } from '@ai/policy'

/** 主 ♠、打 2 */
const ctx: RuleContext = {
  power: buildPowerTable({ mode: 1, levelRank: 2, trump: 0, forcedNT: false }),
  trump: 0,
  levelRank: 2,
  forcedNT: false,
  config: DEFAULT_RULE_CONFIG,
}
/** suit 0=♠(主) 1=♥ 2=♣ 3=♦；rank 0=2 … 12=A */
const card = (suit: number, rank: number): Card => ({ id: suit * 13 + rank, value: suit * 13 + rank })

/**
 * 局面：座位 1 首出 ♦5；座位 2（队友）垫 ♦10（10 分）；座位 3 出 ♦A（当前最大，0 分）。
 * 我（座位 0）手上**一张 ♦ 都没有**（缺门），所以可以用主牌 ♠6 毙。
 * 我最后一个出牌 ⇒ 只要毙就是稳赢这 10 分。
 */
const base = () => ({
  seat: 0 as const,
  // ♠6（主）+ ♥3 ♥5 ♣8 —— 缺 ♦，能毙
  hand: [card(0, 4), card(1, 1), card(1, 3), card(2, 6)],
  ctx,
  play: { kind: 'follow' as const, leadCards: [card(3, 3)], leadAnalysis: analyze([card(3, 3)], ctx) },
  currentWinner: { seat: 3 as const, analysis: analyze([card(3, 12)], ctx) },
  partnerLeading: false,
  opponents: [[card(3, 3)], [card(3, 8)], [card(3, 12)]],
  remainingSeats: [0 as const],
})

const pick = (extra: Record<string, unknown>): number[] =>
  decide({ ...base(), ...extra } as never, 3, mulberry32(7)).cards.map((c) => c.value)

describe('trickPoints · 按整墩定价', () => {
  it('本墩有 10 分（队友垫的）⇒ 肯用主牌毙', () => {
    // 10 分 = 队友垫的 ♦10，而「当前最大那一手」是 0 分的 ♦A
    expect(pick({ trickPoints: 10 })).toContain(card(0, 4).value) // ♠6：毙
  })

  it('本墩一分没有 ⇒ 不浪费主牌，跟小牌', () => {
    expect(pick({ trickPoints: 0 })).not.toContain(card(0, 4).value) // 不毙，垫废牌
  })

  it('不传 trickPoints（旧口径，看不到 10 分）⇒ 退化成「不毙」', () => {
    // 这条锁住的是「旧口径确实会漏看墩里的分」——它同时也是这个修复的存在理由
    expect(pick({})).not.toContain(card(0, 4).value)
  })
})
