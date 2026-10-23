import { describe, it, expect } from 'vitest'
import {
  BOTTOM_SIZE,
  HAND_SIZE,
  buildPowerTable,
  dealFromDeck,
  dealWithGuard,
  dealtCount,
  groupBySlot,
  hasConsecutivePair,
  maxTrumpPower,
  mulberry32,
  newShuffledDeck,
  suitSlotOf,
} from '@core'
import type { Card, LevelRank, Seat, Trump } from '@core'
import { C, J, P, ctx } from './helpers'

const buildPower = (mode: 0 | 1, levelRank: LevelRank, trump: Trump) =>
  buildPowerTable({ mode, levelRank, trump })

describe('TC-101 发牌张数与完整性', () => {
  it('108 张全派完：庄家 33 张，旁家各 25 张（无独立底牌堆）', () => {
    const deck = newShuffledDeck(mulberry32(1))
    const { hands } = dealFromDeck(deck, 0)
    expect(hands).toHaveLength(4)
    expect(hands[0]).toHaveLength(HAND_SIZE + BOTTOM_SIZE) // 庄家
    for (const seat of [1, 2, 3] as Seat[]) {
      expect(hands[seat]).toHaveLength(HAND_SIZE)
    }
  })

  it('庄家位置随 dealer 变（33 张永远是 dealer 的）', () => {
    const deck = newShuffledDeck(mulberry32(6))
    for (const dealer of [0, 1, 2, 3] as Seat[]) {
      const { hands } = dealFromDeck(deck, dealer)
      for (const seat of [0, 1, 2, 3] as Seat[]) {
        expect(hands[seat]).toHaveLength(seat === dealer ? HAND_SIZE + BOTTOM_SIZE : HAND_SIZE)
      }
    }
  })

  it('108 张牌不重不漏', () => {
    const deck = newShuffledDeck(mulberry32(2))
    const { hands } = dealFromDeck(deck, 0)
    const ids = hands.flat().map((c) => c.id)
    expect(ids).toHaveLength(108)
    expect(new Set(ids).size).toBe(108)
    expect([...ids].sort((a, b) => a - b)).toEqual(Array.from({ length: 108 }, (_, i) => i))
  })

  it('庄家多拿的 8 张是牌堆的最后 8 张（发牌顺序上最后到庄家）', () => {
    const deck = newShuffledDeck(mulberry32(8))
    const { hands } = dealFromDeck(deck, 2)
    const extra = (hands[2] as readonly Card[]).slice(HAND_SIZE)
    expect(extra.map((c) => c.id)).toEqual(deck.slice(100).map((c) => c.id))
  })

  it('牌堆长度不对时抛错', () => {
    expect(() => dealFromDeck([], 0)).toThrow()
  })
})

describe('dealtCount 逐张发牌进度', () => {
  it('前 25 轮每家各得 1 张（4 × 轮次）', () => {
    expect(dealtCount(0)).toBe(0)
    expect(dealtCount(1)).toBe(4)
    expect(dealtCount(25)).toBe(100)
  })

  it('第 26 轮起每轮只有庄家得 1 张', () => {
    expect(dealtCount(26)).toBe(101)
    expect(dealtCount(30)).toBe(105)
    expect(dealtCount(33)).toBe(108) // 108 张全派完
  })

  it('超过 33 轮 clamp 在 108（revealed 补满后不会再涨）', () => {
    expect(dealtCount(40)).toBe(108)
    expect(dealtCount(100)).toBe(108)
  })

  it('与手牌张数口径一致：dealtCount(33) - dealtCount(25) = 庄家多拿的 8 张', () => {
    expect(dealtCount(HAND_SIZE + BOTTOM_SIZE) - dealtCount(HAND_SIZE)).toBe(BOTTOM_SIZE)
  })
})

describe('TC-108 庄家发牌偏移', () => {
  it('第 i 组 25 张给座位 (dealer + i) % 4', () => {
    const deck = newShuffledDeck(mulberry32(3))
    for (const dealer of [0, 1, 2, 3] as Seat[]) {
      const { hands } = dealFromDeck(deck, dealer)
      for (let block = 0; block < 4; block++) {
        const seat = ((dealer + block) % 4) as Seat
        expect(hands[seat]![0]!.id).toBe(deck[block * HAND_SIZE]!.id)
      }
    }
  })
})

describe('TC-104 连对识别', () => {
  const c = ctx({ trump: 0, levelRank: 2 })
  const power = c.power

  it('两张同值不算连对（只有一对）', () => {
    expect(hasConsecutivePair(P(1, 6), power)).toBe(false)
  })

  it('牌力相邻的两对是连对', () => {
    expect(hasConsecutivePair([...P(1, 6), ...P(1, 7)], power)).toBe(true)
  })

  it('牌力不相邻的两对不是连对', () => {
    expect(hasConsecutivePair([...P(1, 6), ...P(1, 9)], power)).toBe(false)
  })

  it('不同花色的两对不是连对', () => {
    expect(hasConsecutivePair([...P(1, 6), ...P(2, 7)], power)).toBe(false)
  })

  it('主牌里的相邻对算连对（主 A 对 + 副 2 对）', () => {
    // 打 2：副 2 是副级牌（主牌），主 A 是主花色普通牌，二者牌力相邻
    const hand = [...P(0, 12), ...P(1, 0)]
    expect(suitSlotOf(hand[0]!.value, power)).toBe(4)
    expect(suitSlotOf(hand[2]!.value, power)).toBe(4)
    expect(hasConsecutivePair(hand, power)).toBe(true)
  })

  it('三连对也算', () => {
    expect(hasConsecutivePair([...P(1, 4), ...P(1, 5), ...P(1, 6)], power)).toBe(true)
  })
})

describe('TC-105/106 发牌约束（禁止天然连对）', () => {
  it('产出的牌局在 16 种牌力表下都没有现成连对', () => {
    const rng = mulberry32(2026)
    const levels: [LevelRank, LevelRank] = [2, 2]
    const { hands } = dealWithGuard(rng, 0, { levels }, buildPower)
    for (const mode of [0, 1] as const) {
      for (const level of levels) {
        for (const trump of [0, 1, 2, 3] as Trump[]) {
          const power = buildPower(mode, level, trump)
          for (const hand of hands) {
            expect(hasConsecutivePair(hand, power)).toBe(false)
          }
        }
      }
    }
  })

  it('重洗次数被记录，且通常很快通过', () => {
    const rng = mulberry32(7)
    const r = dealWithGuard(rng, 0, { levels: [2, 3] }, buildPower)
    expect(r.attempts).toBeGreaterThanOrEqual(0)
    expect(r.degraded).toBe(false)
    expect(r.attempts).toBeLessThan(50)
  })

  it('同种子可复现', () => {
    const a = dealWithGuard(mulberry32(99), 1, { levels: [2, 2] }, buildPower)
    const b = dealWithGuard(mulberry32(99), 1, { levels: [2, 2] }, buildPower)
    expect(a.hands.map((h) => h.map((c) => c.id))).toEqual(b.hands.map((h) => h.map((c) => c.id)))
    expect(a.attempts).toBe(b.attempts)
  })
})

describe('TC-003 补充：主牌槽判定', () => {
  it('主花色牌、级牌、王都落在槽 4', () => {
    const c = ctx({ trump: 0, levelRank: 5 })
    expect(suitSlotOf(C(0, 0).value, c.power)).toBe(4) // 主花色 2
    expect(suitSlotOf(C(1, 3).value, c.power)).toBe(4) // 副级牌：级牌 5 ↔ rank 3
    expect(suitSlotOf(J(true).value, c.power)).toBe(4)
    expect(suitSlotOf(C(1, 12).value, c.power)).toBe(1) // 副 A 仍是副牌
  })

  it('副牌按花色落槽 0..3', () => {
    const c = ctx({ trump: 2, levelRank: 2 })
    for (const s of [0, 1, 3] as const) {
      expect(suitSlotOf(C(s, 12).value, c.power)).toBe(s)
    }
  })
})

describe('dealFromDeck 不修改输入', () => {
  it('牌堆只读', () => {
    const deck = newShuffledDeck(mulberry32(5))
    const snapshot = deck.map((c: Card) => c.id)
    dealFromDeck(deck, 0)
    expect(deck.map((c) => c.id)).toEqual(snapshot)
  })
})

describe('TC-105 重洗上限兜底', () => {
  it('maxAttempts=0 时走降级分支，仍返回完整牌局', () => {
    const r = dealWithGuard(mulberry32(11), 0, { levels: [2, 2], maxAttempts: 0 }, buildPower)
    expect(r.degraded).toBe(true)
    expect(r.attempts).toBe(0)
    expect(r.hands.flat()).toHaveLength(108)
  })
})

describe('辅助函数', () => {
  it('groupBySlot 按槽分组', () => {
    const hand = [C(0, 5), C(1, 3), C(2, 6), C(0, 12)]
    const g = groupBySlot(hand, ctx({ trump: 0, levelRank: 2 }).power)
    expect(g.get(4)).toHaveLength(2) // 两张主牌
    expect(g.get(1)).toHaveLength(1)
    expect(g.get(2)).toHaveLength(1)
    expect(g.get(0)).toBeUndefined()
  })

  it('maxTrumpPower 等于最大牌力', () => {
    const c = ctx({ trump: 0, levelRank: 2 })
    expect(maxTrumpPower(c.power)).toBe(c.power.get(53))
  })
})

describe('TC-107 庄家 33 张全程受守卫约束', () => {
  it('庄家发牌即 33 张，且无现成连对', () => {
    // 修复前（KN-8）只校验四家 25 张手牌，底牌 8 张不在校验范围内 ⇒
    // 庄家是全场唯一可能拿到现成连对的人。现在庄家发牌时就拿 33 张，
    // 守卫直接按 33 张校验（core/deal.ts 的 dealWithGuard）。
    const rng = mulberry32(2026)
    const levels: [LevelRank, LevelRank] = [2, 2]
    const dealer = 1
    const r = dealWithGuard(rng, dealer, { levels }, buildPower)
    const dealerHand = r.hands[dealer] ?? []
    expect(dealerHand).toHaveLength(33)
    for (const mode of [0, 1] as const) {
      for (const level of levels) {
        for (const trump of [0, 1, 2, 3] as Trump[]) {
          const power = buildPower(mode, level, trump)
          expect(hasConsecutivePair(dealerHand, power), `mode=${mode} level=${level} trump=${trump}`).toBe(
            false,
          )
        }
      }
    }
  })

  it('多种子下庄家 33 张都不含连对', () => {
    const levels: [LevelRank, LevelRank] = [2, 3]
    for (const seed of [1, 7, 42, 99, 2026, 31337]) {
      const r = dealWithGuard(mulberry32(seed), 2, { levels }, buildPower)
      const dealerHand = r.hands[2] ?? []
      for (const mode of [0, 1] as const) {
        for (const level of levels) {
          for (const trump of [0, 1, 2, 3] as Trump[]) {
            const power = buildPower(mode, level, trump)
            expect(hasConsecutivePair(dealerHand, power)).toBe(false)
          }
        }
      }
    }
  })
})
