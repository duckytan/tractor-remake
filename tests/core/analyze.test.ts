import { describe, it, expect } from 'vitest'
import { analyze, analyzeHand, bestInSlot, slotPairs, slotSize } from '@core'
import { C, P, ctx, names } from './helpers'

// 约定：主花色 = 黑桃(0)，级牌 = 打 2（rank 0）
// 红心普通牌 rank 1..12 → 牌力 0..11
const c = ctx({ trump: 0, levelRank: 2 })

describe('TC-401 单张', () => {
  const a = analyze([C(1, 3)], c)
  it('结构正确', () => {
    expect(a.suitSlot).toBe(1)
    expect(a.typeCode).toBe(1)
    expect(a.pairCount).toBe(0)
    expect(a.singleCount).toBe(1)
    expect(a.isMultiGroup).toBe(false)
    expect(a.groups).toHaveLength(1)
    expect(a.groups[0]!.kind).toBe('single')
  })
})

describe('TC-402 对子', () => {
  const a = analyze(P(1, 6), c)
  it('一对不是甩牌', () => {
    expect(a.pairCount).toBe(1)
    expect(a.singleCount).toBe(0)
    expect(a.isMultiGroup).toBe(false)
    expect(a.groups[0]!.kind).toBe('pair')
    expect(a.groups[0]!.length).toBe(1)
  })
})

describe('TC-403 连对（关键：连对不是甩牌）', () => {
  const a = analyze([...P(1, 2), ...P(1, 3)], c)
  it('两连对被识别为一个 tractor，且不触发甩牌', () => {
    expect(a.pairCount).toBe(2)
    expect(a.singleCount).toBe(0)
    expect(a.isMultiGroup).toBe(false)
    expect(a.groups).toHaveLength(1)
    expect(a.groups[0]!.kind).toBe('tractor')
    expect(a.groups[0]!.length).toBe(2)
    expect(a.groups[0]!.cards).toHaveLength(4)
  })

  it('三连对', () => {
    const b = analyze([...P(1, 2), ...P(1, 3), ...P(1, 4)], c)
    expect(b.groups[0]!.kind).toBe('tractor')
    expect(b.groups[0]!.length).toBe(3)
    expect(b.isMultiGroup).toBe(false)
  })

  it('不相邻的两对 → 两个 pair 组，仍不是甩牌', () => {
    const b = analyze([...P(1, 2), ...P(1, 7)], c)
    expect(b.groups).toHaveLength(2)
    expect(b.groups.every((g) => g.kind === 'pair')).toBe(true)
    expect(b.isMultiGroup).toBe(false)
  })
})

describe('TC-405 对子 + 单张 = 甩牌', () => {
  const a = analyze([...P(1, 6), C(1, 5)], c)
  it('是甩牌', () => {
    expect(a.pairCount).toBe(1)
    expect(a.singleCount).toBe(1)
    expect(a.isMultiGroup).toBe(true)
  })
})

describe('TC-406 两张不同单牌 = 甩牌', () => {
  const a = analyze([C(1, 5), C(1, 8)], c)
  it('是甩牌', () => {
    expect(a.singleCount).toBe(2)
    expect(a.isMultiGroup).toBe(true)
  })
})

describe('TC-407/408 混槽', () => {
  it('不同花色 → suitSlot -1、typeCode 10', () => {
    const a = analyze([C(1, 5), C(2, 5)], c)
    expect(a.suitSlot).toBe(-1)
    expect(a.typeCode).toBe(10)
  })

  it('主牌 + 副牌 → 混槽', () => {
    const a = analyze([C(0, 12), C(1, 12)], c)
    expect(a.suitSlot).toBe(-1)
  })
})

describe('TC-409 组覆盖完整', () => {
  it('groups 的卡片并集等于入参，无重复无遗漏', () => {
    const cards = [...P(1, 2), ...P(1, 3), C(1, 7), C(1, 9)]
    const a = analyze(cards, c)
    const out = a.groups.flatMap((g) => g.cards.map((x) => x.id))
    expect(out.sort()).toEqual(cards.map((x) => x.id).sort())
  })
})

describe('TC-410 手牌分槽', () => {
  it('槽 4 恰好是主牌', () => {
    const hand = [C(0, 5), C(1, 3), C(2, 6), C(3, 7), C(0, 12)]
    const h = analyzeHand(hand, c)
    const trumpCards = h.slots[4]!.cards.map((x) => x.id).sort()
    expect(trumpCards).toEqual([C(0, 5).id, C(0, 12).id].sort())
  })

  it('槽内按牌力降序', () => {
    const h = analyzeHand([C(1, 3), C(1, 12), C(1, 7)], c)
    const powers = h.slots[1]!.cards.map((x) => c.power.get(x.value))
    expect(powers).toEqual([...powers].sort((a, b) => b - a))
  })

  it('countOf / slotSize / slotPairs', () => {
    const h = analyzeHand([...P(1, 6), C(1, 9)], c)
    expect(h.countOf(C(1, 6).value)).toBe(2)
    expect(h.countOf(C(1, 7).value)).toBe(0)
    expect(slotSize(h, 1)).toBe(3)
    expect(slotPairs(h, 1)).toBe(1)
  })
})

describe('分数与代表牌', () => {
  it('5/10/K 计分', () => {
    expect(analyze([C(1, 3)], c).score).toBe(5) // 5
    expect(analyze([C(1, 8)], c).score).toBe(10) // 10
    expect(analyze([C(1, 11)], c).score).toBe(10) // K
    expect(analyze([C(1, 12)], c).score).toBe(0) // A
    expect(analyze([...P(1, 3), C(1, 8)], c).score).toBe(20)
  })

  it('keyCard 是牌力最大的那张', () => {
    const a = analyze([...P(1, 2), C(1, 7)], c) // 一对 4 + 一张 9
    expect(names([a.keyCard!])).toBe('H9')
  })

  it('空牌组', () => {
    const a = analyze([], c)
    expect(a.keyCard).toBeNull()
    expect(a.groups).toHaveLength(0)
  })
})

describe('bestInSlot', () => {
  it('返回该槽最大单张与最大对子', () => {
    const hand = [...P(1, 4), C(1, 9), C(2, 12)]
    const b = bestInSlot(hand, 1, c)
    expect(b.maxCardPower).toBe(c.power.get(C(1, 9).value))
    expect(b.maxPairPower).toBe(c.power.get(C(1, 4).value))
  })

  it('该槽没牌时返回 -1', () => {
    const b = bestInSlot([C(2, 5)], 1, c)
    expect(b).toEqual({ maxCardPower: -1, maxPairPower: -1 })
  })
})
