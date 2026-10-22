import { describe, it, expect } from 'vitest'
import { buildPowerTable, canCounter } from '@core'
import type { Card, LevelRank, RuleConfig, RuleContext, Trump } from '@core'

/**
 * 反主判定 `canCounter` —— 对齐原版 `FUN_004163A2`（规则书 §3.3）。
 * 核心规则：必须持有「新花色的级牌」。
 *
 * 牌值编码：suit*13 + rank，0=♠ 1=♥ 2=♣ 3=♦；rank 0..12 ↔ 2,3,…,K,A。
 * 级牌 LevelRank=3 ⇒ rank 下标 (3+11)%13 = 1。
 */

const mk = (value: number, id: number): Card => ({ id, value })

const cfg = (patch: Partial<RuleConfig> = {}): RuleConfig => ({
  allowSelfCounter: true,
  twoAsPermanent: false,
  allowPartnerGuard: false,
  allowCounterNT: false,
  guardScoreLevels: false,
  guardJack: true,
  guardAce: true,
  guardKingLevel: true,
  ...patch,
})

function ctxOf(trump: Trump, levelRank: LevelRank, patch: Partial<RuleConfig> = {}): RuleContext {
  return {
    power: buildPowerTable({ mode: 0, levelRank, trump, forcedNT: levelRank === 18 }),
    trump,
    levelRank,
    config: cfg(patch),
    forcedNT: levelRank === 18,
  }
}

const base = { sameTeamAsDeclarer: false, usedTrumps: [] as readonly Trump[] }

describe('canCounter —— 反主判定', () => {
  it('持有新花色级牌 → 可反', () => {
    const hand = [mk(1, 1), mk(40, 2)] // ♠3 + ♣A
    expect(canCounter({ ...base, hand, ctx: ctxOf(0, 3), currentTrump: 1, newTrump: 0 })).toBe(true)
  })

  it('不持有新花色级牌 → 不可反', () => {
    const hand = [mk(1, 1)] // 只有 ♠3，想反成 ♣
    expect(canCounter({ ...base, hand, ctx: ctxOf(0, 3), currentTrump: 1, newTrump: 2 })).toBe(
      false,
    )
  })

  it('级牌是 2 时，认的是 2 而不是 3', () => {
    // LevelRank=2 ⇒ rank 下标 (2+11)%13 = 0 ⇒ ♣2 = 2*13+0 = 26
    expect(
      canCounter({ ...base, hand: [mk(26, 1)], ctx: ctxOf(0, 2), currentTrump: 1, newTrump: 2 }),
    ).toBe(true)
    // 手里只有 ♣3 不够
    expect(
      canCounter({ ...base, hand: [mk(27, 1)], ctx: ctxOf(0, 2), currentTrump: 1, newTrump: 2 }),
    ).toBe(false)
  })

  it('不能反成当前同一个主', () => {
    expect(
      canCounter({ ...base, hand: [mk(1, 1)], ctx: ctxOf(0, 3), currentTrump: 0, newTrump: 0 }),
    ).toBe(false)
  })

  it('同一门已被反过 → 不可再反（保证终止）', () => {
    expect(
      canCounter({
        ...base,
        hand: [mk(1, 1)],
        ctx: ctxOf(0, 3),
        currentTrump: 2,
        newTrump: 0,
        usedTrumps: [0, 2],
      }),
    ).toBe(false)
  })

  it('同队反主：关「允许自反」时不可反，开时可反', () => {
    const hand = [mk(1, 1)]
    expect(
      canCounter({
        ...base,
        hand,
        ctx: ctxOf(0, 3, { allowSelfCounter: false }),
        currentTrump: 1,
        newTrump: 0,
        sameTeamAsDeclarer: true,
      }),
    ).toBe(false)
    expect(
      canCounter({
        ...base,
        hand,
        ctx: ctxOf(0, 3, { allowSelfCounter: true }),
        currentTrump: 1,
        newTrump: 0,
        sameTeamAsDeclarer: true,
      }),
    ).toBe(true)
  })

  it('普通级不能反成无将（无将没有级牌可依）', () => {
    expect(
      canCounter({ ...base, hand: [mk(52, 1), mk(53, 2)], ctx: ctxOf(0, 3), currentTrump: 0, newTrump: 'NT' }),
    ).toBe(false)
  })

  it('打王级（强制无将）：主牌固定，持王也不能反', () => {
    const hand = [mk(53, 1), mk(52, 2)]
    expect(
      canCounter({
        ...base,
        hand,
        ctx: ctxOf('NT', 18, { allowCounterNT: true }),
        currentTrump: 'NT',
        newTrump: 0,
      }),
    ).toBe(false)
  })
})
