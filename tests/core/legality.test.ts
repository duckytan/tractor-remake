import { describe, it, expect } from 'vitest'
import { analyze, checkPlay } from '@core'
import type { Card } from '@core'
import { C, P, ctx, names } from './helpers'

const c = ctx({ trump: 0, levelRank: 2 })
const leadOf = (cards: readonly Card[]) => ({ cards, analysis: analyze(cards, c) })

/** 牌力速查（红心：rank 1..12 → 牌力 0..11） */
const H = {
  r2: C(1, 0), // 级牌，是主牌
  r3: C(1, 1),
  r4: C(1, 2),
  r5: C(1, 3),
  r6: C(1, 4),
  r7: C(1, 5),
  r8: C(1, 6),
  r9: C(1, 7),
  r10: C(1, 8),
  rJ: C(1, 9),
  rQ: C(1, 10),
  rK: C(1, 11),
  rA: C(1, 12),
}

describe('TC-501/502 基础拒绝', () => {
  it('没选牌', () => {
    const r = checkPlay({ hand: [H.r5], cards: [], ctx: c, opponents: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('empty')
  })

  it('出的牌不在手里', () => {
    const r = checkPlay({ hand: [H.r5], cards: [H.r9], ctx: c, opponents: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('cards-not-in-hand')
  })
})

describe('TC-503 首出混花色', () => {
  it('拒绝', () => {
    const hand = [C(1, 5), C(2, 5)]
    const r = checkPlay({ hand, cards: hand, ctx: c, opponents: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('mixed-suit-lead')
  })
})

describe('TC-504/505/506 首出单一牌型', () => {
  it('单张合法', () => {
    const r = checkPlay({ hand: [H.r5], cards: [H.r5], ctx: c, opponents: [] })
    expect(r.ok).toBe(true)
  })

  it('对子合法', () => {
    const hand = P(1, 6)
    const r = checkPlay({ hand, cards: hand, ctx: c, opponents: [] })
    expect(r.ok).toBe(true)
  })

  it('连对合法（不触发甩牌校验）', () => {
    const hand = [...P(1, 2), ...P(1, 3)]
    const r = checkPlay({ hand, cards: hand, ctx: c, opponents: [[H.rA], [], []] })
    expect(r.ok).toBe(true)
    expect(r.ok && r.adjusted).toBeFalsy()
  })
})

describe('TC-507 甩牌成功', () => {
  it('三家都压不住 → 合法', () => {
    const hand = [H.r9, ...P(1, 6), ...P(1, 2)] // 9 + 一对 8 + 一对 4
    const weak = [H.r3, C(2, 5), C(3, 6)]
    const r = checkPlay({ hand, cards: hand, ctx: c, opponents: [weak, [], []] })
    expect(r.ok).toBe(true)
    expect(r.ok && r.adjusted).toBeFalsy()
  })
})

describe('TC-508 甩牌失败（单张组）', () => {
  it('对手有更大的单张 → 裁剪为最小的那张', () => {
    const hand = [H.r9, ...P(1, 6), ...P(1, 2)]
    const r = checkPlay({ hand, cards: hand, ctx: c, opponents: [[H.r10], [], []] })
    expect(r.ok).toBe(true)
    if (r.ok && r.adjusted) {
      expect(names(r.cards)).toBe('H9')
      expect(r.reason).toBe('throw-failed')
    } else {
      throw new Error('应当被裁剪')
    }
  })
})

describe('TC-509 甩牌失败（对子组）', () => {
  it('对手有更大的对子 → 裁剪为最小的那一对', () => {
    const hand = [H.r9, ...P(1, 6), ...P(1, 2)]
    const r = checkPlay({ hand, cards: hand, ctx: c, opponents: [[...P(1, 10)], [], []] })
    expect(r.ok).toBe(true)
    if (r.ok && r.adjusted) {
      expect(names(r.cards)).toBe('H8 H8')
    } else {
      throw new Error('应当被裁剪')
    }
  })

  it('只有最小的那对不够大 → 裁剪到那一对', () => {
    const hand = [H.r9, ...P(1, 6), ...P(1, 2)] // 一对 8 + 一对 4
    const r = checkPlay({ hand, cards: hand, ctx: c, opponents: [[...P(1, 3)], [], []] }) // 一对 5
    expect(r.ok).toBe(true)
    if (r.ok && r.adjusted) expect(names(r.cards)).toBe('H4 H4')
    else throw new Error('应当被裁剪')
  })
})

describe('TC-509b 甩牌对子组逐对比较（原版缺陷修正）', () => {
  it('甩 9+88+44，对手只有一对 5 → 判失败并出 44', () => {
    const hand = [H.r9, ...P(1, 6), ...P(1, 2)]
    const r = checkPlay({ hand, cards: hand, ctx: c, opponents: [[...P(1, 3)], [], []] })
    expect(r.ok).toBe(true)
    expect(r.ok && r.adjusted).toBe(true)
    if (r.ok && r.adjusted) expect(names(r.cards)).toBe('H4 H4')
  })

  it('三组都最大时通过', () => {
    const hand = [H.r9, ...P(1, 6), ...P(1, 2)]
    const r = checkPlay({ hand, cards: hand, ctx: c, opponents: [[H.r3], [C(2, 5)], [C(3, 6)]] })
    expect(r.ok && r.adjusted).toBeFalsy()
  })
})

describe('TC-510 跟牌张数', () => {
  it('张数不符 → 拒绝', () => {
    const lead = leadOf(P(1, 3))
    const hand = [...P(1, 4), H.r9]
    const r = checkPlay({ hand, cards: [H.r9], ctx: c, lead })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('count-mismatch')
  })
})

describe('TC-511 有该花色却垫牌', () => {
  it('拒绝', () => {
    const lead = leadOf(P(1, 3)) // 一对 5♥
    const hand = [H.r9, H.r8, C(2, 5)] // 手里有 2 张红心
    const r = checkPlay({ hand, cards: [H.r9, C(2, 5)], ctx: c, lead })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('must-follow-suit')
  })
})

describe('TC-512 该花色不够时垫牌自由', () => {
  it('只有 1 张红心，出 1 红心 + 1 任意牌 → 合法', () => {
    const lead = leadOf(P(1, 3))
    const hand = [H.r9, C(2, 5), C(3, 6)]
    const r = checkPlay({ hand, cards: [H.r9, C(2, 5)], ctx: c, lead })
    expect(r.ok).toBe(true)
  })

  it('一张红心都没有 → 任意两张都合法', () => {
    const lead = leadOf(P(1, 3))
    const hand = [C(2, 5), C(3, 6)]
    const r = checkPlay({ hand, cards: hand, ctx: c, lead })
    expect(r.ok).toBe(true)
  })
})

describe('TC-513/514/515 对子跟随', () => {
  it('有对子却只出两张散牌 → 拒绝', () => {
    const lead = leadOf(P(1, 3)) // 一对 5
    const hand = [C(1, 6), C(1, 6, 1), H.r7, C(2, 5)] // 手里有一对 8
    const r = checkPlay({ hand, cards: [C(1, 6), H.r7], ctx: c, lead })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('must-follow-pairs')
  })

  it('有对子且跟了对子 → 合法', () => {
    const lead = leadOf(P(1, 3))
    const hand = [...P(1, 4), C(2, 5)]
    const r = checkPlay({ hand, cards: P(1, 4), ctx: c, lead })
    expect(r.ok).toBe(true)
  })

  it('首出 2 对，手里只有 1 对 → 只需跟 1 对', () => {
    const lead = leadOf([...P(1, 3), ...P(1, 4)]) // 2 对（♥4、♥5）
    // 手里：♥9 一对 + ♥10 + ♥J（4 张，只有 1 对）
    // 注意别写成 `[...P(1,7), H.r9, ...]` —— `P(1,7)` 已经是两张 ♥9，
    // 再加一张 `H.r9`（copy 0）就变成「同一张物理牌出现两次」，
    // v1.3.29 起 `checkPlay` 会以 id 重复为由拒绝（docs/33 C6-07）。
    const hand = [...P(1, 7), H.r10, H.rJ]
    const r = checkPlay({ hand, cards: [...hand], ctx: c, lead })
    expect(r.ok).toBe(true)
  })
})

describe('TC-516 不要求跟连对（宽松结构跟随）', () => {
  it('首出连对，用两对不相邻的对子跟上 → 合法', () => {
    const lead = leadOf([...P(1, 2), ...P(1, 3)]) // 4、5 连对
    const hand = [...P(1, 7), ...P(1, 10), C(2, 5)] // 9 对 + Q 对（不相邻）
    const r = checkPlay({ hand, cards: [...P(1, 7), ...P(1, 10)], ctx: c, lead })
    expect(r.ok).toBe(true)
  })
})

describe('TC-517 主牌花色跟牌', () => {
  it('首出主牌对子，跟主牌对子 → 合法', () => {
    const lead = leadOf(P(0, 5)) // 主花色一对
    const hand = [...P(0, 7), C(1, 5)]
    const r = checkPlay({ hand, cards: P(0, 7), ctx: c, lead })
    expect(r.ok).toBe(true)
  })

  it('首出主牌，用副牌跟 → 拒绝（有主牌必须跟主牌）', () => {
    const lead = leadOf(P(0, 5))
    const hand = [...P(1, 7), ...P(0, 3)]
    const r = checkPlay({ hand, cards: P(1, 7), ctx: c, lead })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('must-follow-suit')
  })
})

describe('TC-518 有主牌不垫主牌', () => {
  it('首出副牌、该花色不足时，垫副牌也合法（垫牌自由）', () => {
    const lead = leadOf(P(1, 3)) // 一对 5♥
    const hand = [H.r9, ...P(0, 8), C(2, 5)] // 1 张红心 + 一对主牌
    const r = checkPlay({ hand, cards: [H.r9, C(2, 5)], ctx: c, lead })
    expect(r.ok).toBe(true)
  })
})

describe('TC-519 两个不连续对子也算甩牌（原判定漏洞修正）', () => {
  // ♦ 为主 ⇒ ♠ 是副牌，便于观察「同门多组」
  const side = ctx({ trump: 3, levelRank: 2 })

  it('analyze 判 isMultiGroup = true（不连续对子各成一组）', () => {
    const cards = [...P(0, 6), ...P(0, 10)] // ♠8♠8 + ♠Q♠Q
    const a = analyze(cards, side)
    expect(a.pairCount).toBe(2)
    expect(a.groups.length).toBe(2)
    expect(a.isMultiGroup).toBe(true)
  })

  it('对手有更大的同门对子时判甩牌失败并裁剪', () => {
    const cards = [...P(0, 6), ...P(0, 10)]
    const hand = [...cards, C(2, 5)]
    const r = checkPlay({ hand, cards, ctx: side, opponents: [[...P(0, 11)], [], []] }) // ♠K 一对
    expect(r.ok).toBe(true)
    if (r.ok && r.adjusted) {
      expect(r.reason).toBe('throw-failed')
      expect(names(r.cards)).toBe('SQ SQ') // 裁剪为最小的失败组（♠Q♠Q）
    } else {
      throw new Error('应当被裁剪')
    }
  })

  it('两组都是全场最大时合法通过', () => {
    const cards = [...P(0, 10), ...P(0, 6)]
    const hand = [...cards]
    const r = checkPlay({ hand, cards, ctx: side, opponents: [[C(0, 3)], [], []] })
    expect(r.ok).toBe(true)
    expect(r.ok && r.adjusted).toBeFalsy()
  })

  it('连对仍是单一牌型，不触发甩牌校验', () => {
    const cards = [...P(0, 6), ...P(0, 7)] // ♠8♠8 + ♠9♠9（连续）
    const a = analyze(cards, side)
    expect(a.groups.length).toBe(1)
    expect(a.isMultiGroup).toBe(false)
  })
})
