import { describe, it, expect } from 'vitest'
import { buildPowerTable, TRUMP_POWER_BASE } from '@core'
import type { Suit } from '@core'

/** 牌值 = suit*13 + rank，rank 0 就是 2 */
const v = (s: Suit, rank: number): number => s * 13 + rank
const D2 = v(3, 0)
const S2 = v(0, 0)

describe('buildPowerTable · 2 为常主', () => {
  it('有主花色：2 提升为主牌（≥52）', () => {
    const t = buildPowerTable({ mode: 1, levelRank: 11, trump: 3 })
    expect(t.get(D2)).toBeGreaterThanOrEqual(TRUMP_POWER_BASE)
    expect(t.get(S2)).toBeGreaterThanOrEqual(TRUMP_POWER_BASE)
  })

  it('主动无将：2 也提升为主牌', () => {
    const t = buildPowerTable({ mode: 1, levelRank: 11, trump: 'NT' })
    expect(t.get(D2)).toBeGreaterThanOrEqual(TRUMP_POWER_BASE)
  })

  it('mode=0 时 2 是普通副牌', () => {
    const t = buildPowerTable({ mode: 0, levelRank: 11, trump: 'NT' })
    expect(t.get(D2)).toBeLessThan(TRUMP_POWER_BASE)
  })

  it('级牌本身就是 2 时不重复提升（只有级牌那一档）', () => {
    const on = buildPowerTable({ mode: 1, levelRank: 2, trump: 'NT' })
    const off = buildPowerTable({ mode: 0, levelRank: 2, trump: 'NT' })
    expect(on.get(D2)).toBe(off.get(D2))
  })

  it('打王级（levelRank 18）：级牌不提升，但「2 为常主」仍生效', () => {
    // 逆向报告 §755：`0x12` + mode=1 ⇒ 四门 rank0 = 0x40、小王 0x41、大王 0x42。
    // **「级牌不提升」和「2 不提升」是两件事** —— v1.3.19 混为一谈修反了，v1.3.28 改回。
    const on = buildPowerTable({ mode: 1, levelRank: 18, trump: 'NT' })
    expect(on.get(D2)).toBeGreaterThanOrEqual(TRUMP_POWER_BASE)
    expect(on.get(S2)).toBeGreaterThanOrEqual(TRUMP_POWER_BASE)

    // mode=0（不开 2 为常主）时，打王级只剩王是主牌（逆向报告 §745）
    const off = buildPowerTable({ mode: 0, levelRank: 18, trump: 'NT' })
    expect(off.get(D2)).toBeLessThan(TRUMP_POWER_BASE)
    expect(off.get(S2)).toBeLessThan(TRUMP_POWER_BASE)

    // 顺序：四门2 < 小王 < 大王
    const small = on.get(52)
    const big = on.get(53)
    expect(on.get(D2)).toBeLessThan(small)
    expect(small).toBeLessThan(big)
  })
})
