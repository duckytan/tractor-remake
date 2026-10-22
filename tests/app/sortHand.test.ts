import { describe, it, expect } from 'vitest'
import { buildPowerTable } from '@core'
import type { Card, LevelRank, RuleContext, Suit, Trump } from '@core'
import { sortHand } from '@app/game'

/**
 * 手牌展示排序测试 —— 基准是 smallnest/Tractor `CurrentPoker.Sort()`
 * （用户确认「规则可信，甚至比原版还好」）。
 *
 * 期望顺序：
 *   大王 → 小王 → 主级牌 → 副级牌 → [主2 → 副2] → 主花色(点数降序)
 *   → 其余三门按 ♥ ♠ ♦ ♣(点数降序)；无将时四门全按 ♥ ♠ ♦ ♣。
 */

/** 重制版花色编码：0=♠ 1=♥ 2=♣ 3=♦；点数下标 0..12 ↔ 2,3,…,K,A */
const SUIT_NAME = ['♠', '♥', '♣', '♦']
const RANK_NAME = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']

const mk = (suit: Suit, rank: number, id: number): Card => ({ id, value: suit * 13 + rank })

/** 便于失败时阅读的牌面文本，如 "♥A" */
const txt = (c: Card): string => {
  if (c.value === 53) return '大王'
  if (c.value === 52) return '小王'
  return `${SUIT_NAME[Math.floor(c.value / 13)]}${RANK_NAME[c.value % 13]}`
}

function ctxOf(trump: Trump, levelRank: LevelRank, twoAsPermanent = false): RuleContext {
  return {
    power: buildPowerTable({ mode: twoAsPermanent ? 1 : 0, levelRank, trump }),
    trump,
    levelRank,
    config: {
      allowSelfCounter: true,
      twoAsPermanent,
      allowPartnerGuard: false,
      allowCounterNT: false,
      guardScoreLevels: false,
      guardJack: true,
      guardAce: true,
      guardKingLevel: true,
    },
    forcedNT: levelRank === 18,
  }
}

describe('sortHand —— 对齐 smallnest CurrentPoker.Sort()', () => {
  it('主牌段整段在前，副牌段按花色优先', () => {
    const ctx = ctxOf(1, 3) // 主 ♥，级牌 3
    // 故意给一个「同点数跨花色」的牌，旧实现（按牌力）会把四张 A 排到一起
    const hand = [
      mk(0, 12, 1), // ♠A
      mk(2, 12, 2), // ♣A
      mk(3, 12, 3), // ♦A
      mk(1, 12, 4), // ♥A（主花色）
      mk(1, 11, 5), // ♥K
      mk(0, 11, 6), // ♠K
      mk(3, 4, 7), // ♦6
    ]
    const out = sortHand(hand, ctx).map(txt)
    // 主花色降序 → 然后副牌按 ♠ ♦ ♣（♥ 已是主花色被跳过）
    expect(out).toEqual(['♥A', '♥K', '♠A', '♠K', '♦A', '♦6', '♣A'])
  })

  it('王 → 主级牌 → 副级牌 → 主花色，全部在主牌段', () => {
    const ctx = ctxOf(1, 3) // 主 ♥，级牌 3
    const hand = [
      mk(2, 1, 1), // ♣3（副级牌）
      mk(1, 1, 2), // ♥3（主级牌）
      mk(0, 1, 3), // ♠3（副级牌）
      mk(3, 1, 4), // ♦3（副级牌）
      mk(1, 5, 5), // ♥7（主花色普通）
      { id: 6, value: 52 }, // 小王
      { id: 7, value: 53 }, // 大王
    ]
    expect(sortHand(hand, ctx).map(txt)).toEqual([
      '大王',
      '小王',
      '♥3', // 主级牌
      '♠3', // 副级牌（三门并列，按 ♠ ♦ ♣）
      '♦3',
      '♣3',
      '♥7',
    ])
  })

  it('2 为常主时：主2 高于副2，且都高于主花色 A', () => {
    const ctx = ctxOf(1, 3, true)
    const hand = [
      mk(1, 12, 1), // ♥A
      mk(2, 0, 2), // ♣2（副2）
      mk(1, 0, 3), // ♥2（主2）
      mk(0, 0, 4), // ♠2（副2）
    ]
    expect(sortHand(hand, ctx).map(txt)).toEqual(['♥2', '♠2', '♣2', '♥A'])
  })

  it('无将：四门全按 ♥ ♠ ♦ ♣，级牌并列在王之后', () => {
    const ctx = ctxOf('NT', 3)
    const hand = [
      mk(0, 12, 1), // ♠A
      mk(1, 12, 2), // ♥A
      mk(2, 12, 3), // ♣A
      mk(3, 12, 4), // ♦A
      mk(2, 1, 5), // ♣3（级牌）
      mk(0, 1, 6), // ♠3（级牌）
    ]
    expect(sortHand(hand, ctx).map(txt)).toEqual(['♠3', '♣3', '♥A', '♠A', '♦A', '♣A'])
  })

  it('原版截图那一手：主 ♥ / 级 3 / 2 为常主', () => {
    // 截图手牌：♦6,6,8,J ♣4,6,7,7,8,9,Q,A ♠7,J,A ♥6,7,8,9,10,K,A,2 ♣2,3
    const ctx = ctxOf(1, 3, true)
    const hand: Card[] = [
      mk(3, 4, 1), mk(3, 4, 2), mk(3, 6, 3), mk(3, 9, 4), // ♦6 ♦6 ♦8 ♦J
      mk(2, 2, 5), mk(2, 4, 6), mk(2, 5, 7), mk(2, 5, 8), // ♣4 ♣6 ♣7 ♣7
      mk(2, 6, 9), mk(2, 7, 10), mk(2, 10, 11), mk(2, 12, 12), // ♣8 ♣9 ♣Q ♣A
      mk(0, 5, 13), mk(0, 9, 14), mk(0, 12, 15), // ♠7 ♠J ♠A
      mk(1, 4, 16), mk(1, 5, 17), mk(1, 6, 18), mk(1, 7, 19), // ♥6 ♥7 ♥8 ♥9
      mk(1, 8, 20), mk(1, 11, 21), mk(1, 12, 22), mk(1, 0, 23), // ♥10 ♥K ♥A ♥2
      mk(2, 0, 24), mk(2, 1, 25), // ♣2 ♣3
    ]
    expect(sortHand(hand, ctx).map(txt)).toEqual([
      '♣3', // 副级牌
      '♥2', // 主2
      '♣2', // 副2
      '♥A', '♥K', '♥10', '♥9', '♥8', '♥7', '♥6', // 主花色降序
      '♠A', '♠J', '♠7', // ♠ 降序
      '♦J', '♦8', '♦6', '♦6', // ♦ 降序
      '♣A', '♣Q', '♣9', '♣8', '♣7', '♣7', '♣6', '♣4', // ♣ 降序
    ])
  })

  it('同花色内点数降序，且对子的两张相邻', () => {
    const ctx = ctxOf(0, 5) // 主 ♠，级牌 5
    const hand = [mk(3, 4, 1), mk(3, 4, 2), mk(3, 6, 3), mk(3, 9, 4), mk(3, 2, 5)]
    expect(sortHand(hand, ctx).map(txt)).toEqual(['♦J', '♦8', '♦6', '♦6', '♦4'])
  })

  it('不改入参数组', () => {
    const ctx = ctxOf(1, 3)
    const hand = [mk(0, 12, 1), mk(1, 12, 2), mk(2, 12, 3)]
    const before = hand.map((c) => c.id)
    sortHand(hand, ctx)
    expect(hand.map((c) => c.id)).toEqual(before)
  })
})
