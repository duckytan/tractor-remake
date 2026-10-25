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

  it('打王级（levelRank 18）强制无将，2 不提升 —— 即使调用方漏传 forcedNT', () => {
    // 这里刻意不传 forcedNT：`lvRank` 会是 null，旧实现 `null !== 0` 判成 true
    // 于是把 2 错误提升成主牌。函数必须自己兜住。
    const t = buildPowerTable({ mode: 1, levelRank: 18, trump: 'NT' })
    expect(t.get(D2)).toBeLessThan(TRUMP_POWER_BASE)
    expect(t.get(S2)).toBeLessThan(TRUMP_POWER_BASE)
  })
})
