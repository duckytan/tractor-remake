import { describe, expect, it } from 'vitest'
import { DEFAULT_RULE_CONFIG } from '@core'
import type { Rank } from '@core'
import { newGame } from '@app/game'
import type { GameState, TrickRecord } from '@app/state'
import { displayPlays, replaySummary } from '@app/view'
import { C } from '../core/helpers'

/**
 * 逐墩回放的展示逻辑（v1.3.16）。
 *
 * 回放期间：出牌区显示那一墩的历史出牌、状态栏显示「第 N/M 墩 · 谁赢 · 多少分」。
 * 这两个判断抽成纯函数，render 只负责 DOM。
 */

/** 造一个「打完 n 墩」的对局（历史记录只需形状正确） */
function withHistory(n: number): GameState {
  const base = newGame(DEFAULT_RULE_CONFIG, 2, 0, 7)
  const history: TrickRecord[] = Array.from({ length: n }, (_, i) => ({
    leader: 0,
    plays: [{ seat: (i % 4) as 0 | 1 | 2 | 3, cards: [C(0, (12 - i) as Rank)] }],
    winner: (i % 4) as 0 | 1 | 2 | 3,
    score: i === 2 ? 20 : 0,
  }))
  return { ...base, phase: 'play', history }
}

describe('displayPlays', () => {
  it('正常对局 ⇒ 显示当前墩', () => {
    const s = withHistory(3)
    expect(displayPlays(s)).toBe(s.trick.plays)
  })

  it('回放 ⇒ 显示那一墩的历史出牌', () => {
    const s = withHistory(3)
    const r = displayPlays({ ...s, replayAt: 1 })
    expect(r).toBe(s.history[1]?.plays)
    expect(r).toHaveLength(1)
    expect(r[0]?.seat).toBe(1)
  })

  it('下标越界 ⇒ 空数组（不崩）', () => {
    const s = withHistory(2)
    expect(displayPlays({ ...s, replayAt: 9 })).toEqual([])
  })
})

describe('replaySummary', () => {
  it('不在回放 ⇒ null', () => {
    expect(replaySummary(withHistory(3))).toBeNull()
  })

  it('回放中间墩：第 N/M 墩 + 赢家 + 分数', () => {
    const s = withHistory(5)
    const r = replaySummary({ ...s, replayAt: 2 })
    expect(r).not.toBeNull()
    expect(r?.index).toBe(2)
    expect(r?.total).toBe(5)
    // 第 3 墩（下标 2）的赢家是座位 2 → 北
    expect(r?.winnerLabel).toBe('北')
    expect(r?.score).toBe(20)
    expect(r?.isFirst).toBe(false)
    expect(r?.isLast).toBe(false)
  })

  it('第一墩 / 最后一墩的边界标记（按钮置灰用）', () => {
    const s = withHistory(3)
    expect(replaySummary({ ...s, replayAt: 0 })?.isFirst).toBe(true)
    expect(replaySummary({ ...s, replayAt: 0 })?.isLast).toBe(false)
    expect(replaySummary({ ...s, replayAt: 2 })?.isLast).toBe(true)
    expect(replaySummary({ ...s, replayAt: 2 })?.isFirst).toBe(false)
  })
})
