import { describe, it, expect } from 'vitest'
import { analyze, resolveTrick, trickStanding } from '@core'
import type { Card, Seat } from '@core'
import { C, P, ctx, names } from './helpers'

const c = ctx({ trump: 0, levelRank: 2 })
const play = (seat: number, cards: readonly Card[]) => ({
  seat: seat as Seat,
  cards,
  analysis: analyze(cards, c),
})

describe('TC-601 同花色比大小', () => {
  it('大者赢', () => {
    const r = resolveTrick([play(0, [C(1, 3)]), play(1, [C(1, 7)]), play(2, [C(1, 5)]), play(3, [C(1, 4)])], c)
    expect(r.winner).toBe(1)
  })

  it('赢家收走本墩全部分数', () => {
    const r = resolveTrick([play(0, [C(1, 3)]), play(1, [C(1, 11)]), play(2, [C(1, 8)]), play(3, [C(1, 4)])], c)
    // 5分 + K(10) + 10(10) = 25
    expect(r.score).toBe(25)
  })
})

describe('TC-602 主牌压副牌', () => {
  it('主牌单张压任意副牌', () => {
    const r = resolveTrick([play(0, [C(1, 12)]), play(1, [C(0, 1)])], c) // 副 A vs 主 3
    expect(r.winner).toBe(1)
  })

  it('王压一切', () => {
    const r = resolveTrick([play(0, [C(1, 12)]), play(1, [C(0, 12)]), play(2, [C(1, 0)])], c)
    expect(r.winner).toBe(2) // 副级牌（主牌里最大）
  })
})

describe('TC-603 不同花色不能压', () => {
  it('首出红心，出梅花不赢', () => {
    const r = resolveTrick([play(0, [C(1, 3)]), play(1, [C(2, 12)])], c)
    expect(r.winner).toBe(0)
  })
})

describe('TC-604 垫牌不赢', () => {
  it('混合花色永远不能赢', () => {
    const r = resolveTrick([play(0, [C(1, 3)]), play(1, [C(1, 12), C(2, 12)])], c)
    // 张数不同本不该出现，但判定上混合牌不参与竞争
    expect(r.winner).toBe(0)
  })

  it('结构不符的对子不算压过', () => {
    const lead = play(0, P(1, 3)) // 一对 5
    const follow = play(1, [C(1, 9), C(1, 10)]) // 两张不同点数的红心
    const r = resolveTrick([lead, follow], c)
    expect(r.winner).toBe(0)
  })
})

describe('TC-605 全员垫牌 → 首出方赢', () => {
  it('三家都压不住', () => {
    const r = resolveTrick([play(0, [C(1, 12)]), play(1, [C(2, 5)]), play(2, [C(3, 5)]), play(3, [C(2, 6)])], c)
    expect(r.winner).toBe(0)
  })
})

describe('TC-607 主牌互比', () => {
  it('主牌之间比牌力，不看花色槽', () => {
    const r = resolveTrick([play(0, [C(0, 12)]), play(1, [C(0, 5)])], c) // 主A vs 主6
    expect(r.winner).toBe(0)
  })

  it('首出是主牌时，副牌不能参与', () => {
    const r = resolveTrick([play(0, [C(0, 1)]), play(1, [C(1, 12)])], c) // 主3 vs 副A
    expect(r.winner).toBe(0)
  })
})

describe('同牌力先出者赢', () => {
  it('两人出同一张牌的两个副本', () => {
    const a = C(1, 9, 0)
    const b = C(1, 9, 1)
    const r = resolveTrick([play(0, [a]), play(1, [b])], c)
    expect(r.winner).toBe(0)
  })
})

describe('对子对子', () => {
  it('大对子赢', () => {
    const r = resolveTrick([play(0, P(1, 3)), play(1, P(1, 9))], c)
    expect(r.winner).toBe(1)
  })

  it('主牌对子毙副牌对子', () => {
    const r = resolveTrick([play(0, P(1, 9)), play(1, P(0, 2))], c)
    expect(r.winner).toBe(1)
  })

  it('contenders 只含具备资格的牌', () => {
    const r = resolveTrick([play(0, [C(1, 3)]), play(1, [C(2, 9)]), play(2, [C(1, 5)])], c)
    expect([...r.contenders].sort()).toEqual([0, 2])
  })
})

describe('获胜牌的代表牌', () => {
  it('winnerAnalysis 与赢家一致', () => {
    const plays = [play(0, [C(1, 3)]), play(1, [C(1, 7)])]
    const r = resolveTrick(plays, c)
    expect(names([r.winnerAnalysis.keyCard!])).toBe('H9')
  })

  it('空牌组抛错', () => {
    expect(() => resolveTrick([], c)).toThrow()
  })
})

describe('TC-608 散对不能压连对（结构必须一致）', () => {
  // ♦ 为主 ⇒ ♠ 是副牌
  const side = ctx({ trump: 3, levelRank: 2 })
  const mk = (seat: number, cards: readonly Card[]) => ({
    seat: seat as Seat,
    cards,
    analysis: analyze(cards, side),
  })

  it('首出 2 连对，跟出 2 个不连续对子 → 首出方仍赢', () => {
    const lead = mk(0, [...P(0, 7), ...P(0, 6)]) // ♠9♠9 ♠8♠8（连对）
    const follow = mk(1, [...P(0, 10), ...P(0, 2)]) // ♠Q♠Q + ♠4♠4（不连续）
    const r = resolveTrick([lead, follow], side)
    expect(follow.analysis.pairCount).toBe(lead.analysis.pairCount) // 对数相同
    expect(r.winner).toBe(0)
  })

  it('更大的 2 连对可以压 2 连对', () => {
    const lead = mk(0, [...P(0, 7), ...P(0, 6)]) // ♠9♠9 ♠8♠8
    const follow = mk(1, [...P(0, 11), ...P(0, 10)]) // ♠K♠K ♠Q♠Q
    const r = resolveTrick([lead, follow], side)
    expect(r.winner).toBe(1)
  })

  it('单对仍可压单对（不误伤普通对子）', () => {
    const lead = mk(0, P(0, 6)) // ♠8♠8
    const follow = mk(1, P(0, 9)) // ♠J♠J
    const r = resolveTrick([lead, follow], side)
    expect(r.winner).toBe(1)
  })
})

describe('TC-610 trickStanding —— 一墩判定的唯一入口', () => {
  it('垫牌的大牌不参与竞争（currentWinnerOf 的回归）', () => {
    // 主 ♠，级牌 2。首出 ♥3，西家无 ♥ 也无主，垫 ♣A。
    // 修复前 currentWinnerOf 只比 keyCard，会把西家的 ♣A 当成「当前最大」，
    // AI 据此误判「我赢不了」而白垫小牌。
    // （注意：♠A 在主♠ 局里是主牌、能合法压副牌，不算垫牌，别拿它当例子）
    const lead = play(0, [C(1, 0)]) // ♥3
    const discard = play(1, [C(2, 12)]) // ♣A（异花色、非主 ⇒ 纯垫牌）
    const s = trickStanding([lead, discard], c)
    expect(s).not.toBeNull()
    expect(s?.winner.seat).toBe(0) // 首出方仍然是当前最大
    expect(s?.contenders).toEqual([0]) // 垫牌者不在竞争池里
  })

  it('竞争池只含能压过首出的牌', () => {
    const lead = play(0, [C(1, 3)]) // ♥5
    const same = play(1, [C(1, 7)]) // ♥9（同花色，压过）
    const off = play(2, [C(2, 12)]) // ♣A（垫牌）
    const s = trickStanding([lead, same, off], c)
    expect(s?.winner.seat).toBe(1)
    expect(s?.contenders).toEqual([0, 1])
  })

  it('空列表返回 null', () => {
    expect(trickStanding([], c)).toBeNull()
  })

  it('与 resolveTrick 的赢家一致（两者共用同一函数）', () => {
    const plays = [play(0, [C(1, 0)]), play(1, [C(0, 12)]), play(2, [C(1, 7)])]
    const r = resolveTrick(plays, c)
    const s = trickStanding(plays, c)
    expect(s?.winner.seat).toBe(r.winner)
    expect(s?.contenders).toEqual(r.contenders)
  })
})
