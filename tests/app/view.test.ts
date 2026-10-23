import { describe, it, expect } from 'vitest'
import type { Card } from '@core'
import { emptyState } from '@app/state'
import { recentTricksView, trickLogView } from '@app/view'

/**
 * 对局记录 / 历史牌条视图测试。
 * 只测「纯数据」：墩号、赢家、得分、倒序、花色与主牌标记。
 */

const mk = (suit: number, rank: number, id: number): Card => ({ id, value: suit * 13 + rank })

const state = () => {
  const s = emptyState()
  return {
    ...s,
    dealer: 0 as const,
    trump: 1 as const, // 主 ♥
    levelRank: 3 as const,
    history: [
      {
        leader: 0 as const,
        plays: [
          { seat: 0 as const, cards: [mk(0, 12, 1)] }, // ♠A
          { seat: 1 as const, cards: [mk(1, 12, 2)] }, // ♥A（主花色）
        ],
        winner: 1 as const,
        score: 15,
      },
      {
        leader: 2 as const,
        plays: [
          { seat: 2 as const, cards: [mk(2, 4, 3)] }, // ♣6
          { seat: 3 as const, cards: [mk(3, 4, 4)] }, // ♦6
        ],
        winner: 2 as const,
        score: 0,
      },
    ],
  }
}

describe('trickLogView —— 对局记录', () => {
  it('最新一墩在最上面，墩号从 1 起', () => {
    const v = trickLogView(state())
    expect(v.map((t) => t.no)).toEqual([2, 1])
    expect(v[0]!.winnerLabel).toBe('北')
    expect(v[1]!.winnerLabel).toBe('西')
  })

  it('得分 / 赢家队伍 / 主牌标记', () => {
    const v = trickLogView(state())
    expect(v[0]!.score).toBe(0) // 第 2 墩 0 分（UI 不显示分数字段）
    expect(v[1]!.score).toBe(15)
    expect(v[0]!.winnerTeam).toBe(0) // 座位 2 → 队 0
    expect(v[1]!.winnerTeam).toBe(1) // 座位 1 → 队 1
    // ♥A 是主花色 ⇒ isTrump；♠A 是副牌
    const first = v[1]!.plays
    expect(first.find((p) => p.seat === 0)!.cards[0]!.isTrump).toBe(false)
    expect(first.find((p) => p.seat === 1)!.cards[0]!.isTrump).toBe(true)
    expect(first.find((p) => p.seat === 1)!.cards[0]!.text).toBe('♥A')
    expect(first.find((p) => p.seat === 1)!.isWinner).toBe(true)
  })
})

describe('recentTricksView —— 手牌前方历史牌条', () => {
  it('取最近 depth 墩，保持时间正序', () => {
    expect(recentTricksView(state(), 3).map((t) => t.no)).toEqual([1, 2])
    expect(recentTricksView(state(), 1).map((t) => t.no)).toEqual([2])
  })

  it('没有历史时返回空数组', () => {
    expect(recentTricksView({ ...emptyState(), history: [] }, 3)).toEqual([])
  })
})
