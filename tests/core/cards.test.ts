import { describe, it, expect } from 'vitest'
import {
  BIG_JOKER,
  CARD_VALUE_COUNT,
  DECK_SIZE,
  SMALL_JOKER,
  TRUMP_POWER_BASE,
  buildPowerTable,
  cardValueOf,
  isJokerValue,
  levelRankToRankIndex,
  makeDeck,
  rankOfValue,
  suitOfValue,
  valueOfCardId,
} from '@core/cards'
import type { CardValue, LevelRank, PowerTable, Trump } from '@core/types'

const ALL_VALUES: CardValue[] = Array.from({ length: CARD_VALUE_COUNT }, (_, i) => i)

/** 该配置下所有主牌牌值，按牌力降序 */
function trumpsDesc(t: PowerTable): CardValue[] {
  return ALL_VALUES.filter((v) => t.isTrump(v)).sort((a, b) => t.get(b) - t.get(a))
}

/** 该配置下所有副牌牌值，按牌力降序 */
function plainsDesc(t: PowerTable): CardValue[] {
  return ALL_VALUES.filter((v) => !t.isTrump(v)).sort((a, b) => t.get(b) - t.get(a))
}

function distinctSorted(vals: CardValue[], t: PowerTable): number[] {
  return [...new Set(vals.map((v) => t.get(v)))].sort((a, b) => a - b)
}

/* ============ TC-001 牌组完整性 ============ */
describe('TC-001 牌组完整性', () => {
  it('108 张，id 连续 0..107', () => {
    const deck = makeDeck()
    expect(deck).toHaveLength(DECK_SIZE)
    expect(deck.map((c) => c.id)).toEqual(Array.from({ length: DECK_SIZE }, (_, i) => i))
  })

  it('每个牌值恰好出现 2 次', () => {
    const counts = new Map<CardValue, number>()
    for (const c of makeDeck()) counts.set(c.value, (counts.get(c.value) ?? 0) + 1)
    expect(counts.size).toBe(CARD_VALUE_COUNT)
    for (const [v, n] of counts) expect(n, `牌值 ${v}`).toBe(2)
  })

  it('物理牌位折叠正确（0/1→0，106/107→53）', () => {
    expect(valueOfCardId(0)).toBe(0)
    expect(valueOfCardId(1)).toBe(0)
    expect(valueOfCardId(106)).toBe(53)
    expect(valueOfCardId(107)).toBe(53)
    expect(() => valueOfCardId(108)).toThrow()
    expect(() => valueOfCardId(-1)).toThrow()
  })
})

/* ============ TC-002 牌值编解码 ============ */
describe('TC-002 牌值编解码', () => {
  it('suit*13+rank 双向换算', () => {
    for (let s = 0 as 0 | 1 | 2 | 3; s < 4; s++) {
      for (let r = 0 as 0; r < 13; r++) {
        const v = cardValueOf(s, r as 0)
        expect(suitOfValue(v)).toBe(s)
        expect(rankOfValue(v)).toBe(r)
      }
    }
  })

  it('52/53 是王，没有花色和点数', () => {
    expect(isJokerValue(SMALL_JOKER)).toBe(true)
    expect(isJokerValue(BIG_JOKER)).toBe(true)
    expect(suitOfValue(SMALL_JOKER)).toBeNull()
    expect(rankOfValue(BIG_JOKER)).toBeNull()
    expect(isJokerValue(51)).toBe(false)
  })

  it('级牌 → 点数下标（A=12, 2=0, K=11, 打王级=null）', () => {
    expect(levelRankToRankIndex(1)).toBe(12) // A
    expect(levelRankToRankIndex(2)).toBe(0) // 2
    expect(levelRankToRankIndex(13)).toBe(11) // K
    expect(levelRankToRankIndex(18)).toBeNull() // 打王级
  })
})

/* ============ TC-003 主牌全大于副牌 ============ */
describe('TC-003 主牌全大于副牌', () => {
  const cases: Array<{ mode: 0 | 1; levelRank: LevelRank; trump: Trump; forcedNT?: boolean }> = []
  for (const mode of [0, 1] as const) {
    for (const levelRank of [1, 2, 5, 10, 13] as LevelRank[]) {
      for (const trump of [0, 1, 2, 3, 'NT'] as Trump[]) {
        cases.push({ mode, levelRank, trump })
      }
    }
    cases.push({ mode, levelRank: 18, trump: 'NT', forcedNT: true })
  }

  it(`${cases.length} 种配置下 min(主牌) > max(副牌)`, () => {
    for (const c of cases) {
      const t = buildPowerTable(c)
      const trumps = ALL_VALUES.filter((v) => t.isTrump(v))
      const plains = ALL_VALUES.filter((v) => !t.isTrump(v))
      expect(trumps.length, JSON.stringify(c)).toBeGreaterThan(0)
      const minTrump = Math.min(...trumps.map((v) => t.get(v)))
      const maxPlain = Math.max(...plains.map((v) => t.get(v)))
      expect(minTrump, JSON.stringify(c)).toBe(TRUMP_POWER_BASE)
      expect(minTrump, JSON.stringify(c)).toBeGreaterThan(maxPlain)
    }
  })
})

/* ============ TC-004 牌力值域稠密（连对判定的基础） ============ */
describe('TC-004 牌力序列稠密', () => {
  const configs = [
    { mode: 0, levelRank: 2, trump: 0 },
    { mode: 0, levelRank: 1, trump: 3 },
    { mode: 1, levelRank: 3, trump: 0 },
    { mode: 1, levelRank: 10, trump: 2 },
    { mode: 0, levelRank: 2, trump: 'NT' },
    { mode: 1, levelRank: 5, trump: 'NT' },
    { mode: 0, levelRank: 18, trump: 'NT', forcedNT: true },
  ] as const

  it('主牌去重后是 52,53,54… 连续整数', () => {
    for (const c of configs) {
      const t = buildPowerTable(c)
      const ds = distinctSorted(trumpsDesc(t), t)
      expect(ds, JSON.stringify(c)).toEqual(
        Array.from({ length: ds.length }, (_, i) => TRUMP_POWER_BASE + i),
      )
    }
  })

  it('副牌去重后是 0,1,2… 连续整数', () => {
    for (const c of configs) {
      const t = buildPowerTable(c)
      const ds = distinctSorted(plainsDesc(t), t)
      expect(ds, JSON.stringify(c)).toEqual(Array.from({ length: ds.length }, (_, i) => i))
    }
  })
})

/* ============ TC-005 级牌顺序 ============ */
describe('TC-005 级牌顺序（mode=0，打 2，主花色 0）', () => {
  const t = buildPowerTable({ mode: 0, levelRank: 2, trump: 0 })
  const p = (v: CardValue) => t.get(v)

  it('大王 > 小王 > 主级牌 > 副级牌 > 主花色普通牌', () => {
    expect(p(BIG_JOKER)).toBeGreaterThan(p(SMALL_JOKER))
    expect(p(SMALL_JOKER)).toBeGreaterThan(p(cardValueOf(0, 0))) // 主 2（级牌）
    expect(p(cardValueOf(0, 0))).toBeGreaterThan(p(cardValueOf(1, 0))) // 副 2
    expect(p(cardValueOf(1, 0))).toBeGreaterThan(p(cardValueOf(0, 12))) // 主 A
  })

  it('三门外花色级牌并列', () => {
    expect(p(cardValueOf(1, 0))).toBe(p(cardValueOf(2, 0)))
    expect(p(cardValueOf(2, 0))).toBe(p(cardValueOf(3, 0)))
  })

  it('副牌 A 最大、3 最小（2 被抽走当级牌）', () => {
    expect(p(cardValueOf(1, 12))).toBeGreaterThan(p(cardValueOf(1, 11)))
    expect(p(cardValueOf(1, 1))).toBe(0) // 副 3 最小
  })
})

/* ============ TC-006 2 为常主 ============ */
describe('TC-006 2 为常主（mode=1，打 3，主花色 0）', () => {
  const t = buildPowerTable({ mode: 1, levelRank: 3, trump: 0 })
  const p = (v: CardValue) => t.get(v)

  it('大王 > 小王 > 主3 > 副3 > 主2 > 副2 > 主A', () => {
    expect(p(BIG_JOKER)).toBeGreaterThan(p(SMALL_JOKER))
    expect(p(SMALL_JOKER)).toBeGreaterThan(p(cardValueOf(0, 1))) // 主 3
    expect(p(cardValueOf(0, 1))).toBeGreaterThan(p(cardValueOf(1, 1))) // 副 3
    expect(p(cardValueOf(1, 1))).toBeGreaterThan(p(cardValueOf(0, 0))) // 主 2
    expect(p(cardValueOf(0, 0))).toBeGreaterThan(p(cardValueOf(1, 0))) // 副 2
    expect(p(cardValueOf(1, 0))).toBeGreaterThan(p(cardValueOf(0, 12))) // 主 A
  })

  it('四门 2 都是主牌', () => {
    for (const s of [0, 1, 2, 3] as const) expect(t.isTrump(cardValueOf(s, 0))).toBe(true)
  })

  it('级牌本身就是 2 时不会重复提升（打 2 + mode=1）', () => {
    const t2 = buildPowerTable({ mode: 1, levelRank: 2, trump: 0 })
    const ds = distinctSorted(trumpsDesc(t2), t2)
    expect(ds).toEqual(Array.from({ length: ds.length }, (_, i) => TRUMP_POWER_BASE + i))
    expect(t2.get(cardValueOf(0, 0))).toBeGreaterThan(t2.get(cardValueOf(1, 0)))
  })
})

/* ============ TC-007 主动无将 ============ */
describe('TC-007 主动无将（trump=NT，打 2）', () => {
  const t = buildPowerTable({ mode: 0, levelRank: 2, trump: 'NT' })
  const p = (v: CardValue) => t.get(v)

  it('大王 > 小王 > 四门级牌（并列） > A', () => {
    expect(p(BIG_JOKER)).toBeGreaterThan(p(SMALL_JOKER))
    expect(p(SMALL_JOKER)).toBeGreaterThan(p(cardValueOf(0, 0)))
    expect(p(cardValueOf(0, 0))).toBeGreaterThan(p(cardValueOf(0, 12)))
  })

  it('级牌仍是主牌，且四门并列', () => {
    for (const s of [0, 1, 2, 3] as const) {
      expect(t.isTrump(cardValueOf(s, 0))).toBe(true)
      expect(p(cardValueOf(s, 0))).toBe(p(cardValueOf(0, 0)))
    }
  })

  it('普通牌只有王是主牌', () => {
    expect(t.isTrump(cardValueOf(0, 12))).toBe(false)
    expect(trumpsDesc(t)).toHaveLength(4 + 2) // 4 张级牌 + 2 张王
  })
})

/* ============ TC-008 打王级强制无将 ============ */
describe('TC-008 打王级（forcedNT）', () => {
  const t = buildPowerTable({ mode: 0, levelRank: 18, trump: 'NT', forcedNT: true })
  const p = (v: CardValue) => t.get(v)

  it('级牌不提升：只有王是主牌', () => {
    expect(trumpsDesc(t)).toEqual([BIG_JOKER, SMALL_JOKER])
  })

  it('大王 > 小王 > A > K > … > 2', () => {
    expect(p(BIG_JOKER)).toBeGreaterThan(p(SMALL_JOKER))
    expect(p(SMALL_JOKER)).toBeGreaterThan(p(cardValueOf(0, 12)))
    expect(p(cardValueOf(0, 12))).toBeGreaterThan(p(cardValueOf(0, 11)))
    expect(p(cardValueOf(0, 1))).toBeGreaterThan(p(cardValueOf(0, 0)))
  })
})

/* ============ TC-009 越界与防御 ============ */
describe('TC-009 越界与防御', () => {
  it('牌值越界抛错', () => {
    const t = buildPowerTable({ mode: 0, levelRank: 2, trump: 0 })
    expect(() => t.get(54)).toThrow()
    expect(() => t.get(-1)).toThrow()
  })

  it('of() 与 get() 一致', () => {
    const t = buildPowerTable({ mode: 0, levelRank: 2, trump: 0 })
    for (const c of makeDeck()) expect(t.of(c)).toBe(t.get(c.value))
  })
})
