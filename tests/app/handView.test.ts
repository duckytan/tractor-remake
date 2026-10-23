import { describe, it, expect } from 'vitest'
import { buildPowerTable } from '@core'
import type { Card, LevelRank, RuleContext, Suit, Trump } from '@core'
import { GROUP_TRUMP, GROUP_TRUMP_SUIT, gapCountOf, groupKeyOf, handView } from '@app/handView'

/**
 * 手牌分组视图测试（需求 1：不同花色之间 / 主牌段与主花色段之间留间隔）。
 *
 * 分组键：0..3 = 副牌花色，4 = 主牌段，5 = 主花色段。
 * 这里只测纯数据，间距的像素计算在 ui 层（fitHand）。
 */

const mk = (suit: Suit, rank: number, id: number): Card => ({ id, value: suit * 13 + rank })

function ctxOf(trump: Trump, levelRank: LevelRank): RuleContext {
  return {
    power: buildPowerTable({ mode: 0, levelRank, trump }),
    trump,
    levelRank,
    config: {
      allowSelfCounter: true,
      twoAsPermanent: false,
      allowPartnerGuard: false,
      allowCounterNT: false,
      guardScoreLevels: true,
      guardJack: false,
      guardAce: true,
      guardKingLevel: true,
    },
    forcedNT: levelRank === 18,
  }
}

describe('handView —— 手牌分组间隔', () => {
  it('groupKeyOf：副牌按花色、主牌段与主花色段分开', () => {
    const ctx = ctxOf(1, 3) // 主 ♥，级牌 3
    expect(groupKeyOf(mk(0, 12, 1), ctx)).toBe(0) // ♠A 副牌
    expect(groupKeyOf(mk(2, 12, 2), ctx)).toBe(2) // ♣A 副牌
    expect(groupKeyOf(mk(3, 12, 3), ctx)).toBe(3) // ♦A 副牌
    expect(groupKeyOf(mk(1, 12, 4), ctx)).toBe(GROUP_TRUMP_SUIT) // ♥A 主花色
    expect(groupKeyOf(mk(2, 1, 5), ctx)).toBe(GROUP_TRUMP) // ♣3 副级牌 → 主牌段
    expect(groupKeyOf({ id: 6, value: 53 }, ctx)).toBe(GROUP_TRUMP) // 大王 → 主牌段
  })

  it('无将时没有主花色段，主牌全落在主牌段', () => {
    const ctx = ctxOf('NT', 3)
    expect(groupKeyOf(mk(1, 1, 1), ctx)).toBe(GROUP_TRUMP) // ♥3 级牌
    expect(groupKeyOf({ id: 2, value: 52 }, ctx)).toBe(GROUP_TRUMP) // 小王
    expect(groupKeyOf(mk(1, 12, 3), ctx)).toBe(1) // ♥A 仍是副牌
  })

  it('gapBefore 只在分组交界处为 true，且与排序结果一致', () => {
    const ctx = ctxOf(1, 3) // 主 ♥，级牌 3
    const hand = [
      mk(0, 12, 1), // ♠A
      mk(1, 12, 2), // ♥A（主花色）
      mk(2, 1, 3), // ♣3（副级牌 → 主牌段）
      mk(0, 11, 4), // ♠K
      mk(1, 11, 5), // ♥K（主花色）
    ]
    const items = handView(hand, ctx)
    // 排序后：♣3（主牌段）→ ♥A ♥K（主花色段）→ ♠A ♠K
    expect(items.map((it) => it.card.id)).toEqual([3, 2, 5, 1, 4])
    expect(items.map((it) => it.gapBefore)).toEqual([false, true, false, true, false])
    expect(gapCountOf(items)).toBe(2)
  })

  it('单花色手牌没有间隔（gapCount = 0 ⇒ 视觉与旧版一致）', () => {
    const ctx = ctxOf(1, 3)
    const hand = [mk(0, 12, 1), mk(0, 11, 2), mk(0, 4, 3)]
    const items = handView(hand, ctx)
    expect(items.every((it) => it.gapBefore === false)).toBe(true)
    expect(gapCountOf(items)).toBe(0)
  })

  it('不改入参数组；同花色前缀没有间隔', () => {
    const ctx = ctxOf(1, 3)
    const hand = [mk(0, 12, 1), mk(0, 11, 2), mk(1, 12, 3)]
    const before = hand.map((c) => c.id)
    const prefix = handView(hand.slice(0, 2), ctx) // ♠A ♠K
    expect(hand.map((c) => c.id)).toEqual(before)
    expect(prefix.map((it) => it.card.id)).toEqual([1, 2])
    expect(prefix.every((it) => it.gapBefore === false)).toBe(true)
  })
})
