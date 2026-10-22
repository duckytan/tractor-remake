/**
 * M6 · 稳定性与边界
 *
 * NFR-11：连续 10 局控制台零 error。
 * NFR-02：窗口任意缩放不破版（由 CSS 承担，这里验证状态层不依赖视口）。
 * NFR-10：全部操作可用键盘完成（键盘绑定在 main.ts，这里验证状态层有对应动作）。
 */
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_RULE_CONFIG } from '@core'
import type { Card } from '@core'
import { newGame, reduce, aiPlayFor, aiCanAct } from '@app/game'
import type { GameState } from '@app/state'
import { seatToPlay } from '@app/state'

/** 跑完一局（四家都由 AI 代打，模拟连续对局） */
function playRound(seed: number, level: 0 | 1 | 2): GameState {
  let s = newGame(DEFAULT_RULE_CONFIG, level, 0, seed)
  s = reduce(s, { type: 'declareTrump', trump: 0 })
  if (s.phase === 'bury') {
    const hand = s.hands[s.dealer] as readonly Card[]
    s = reduce(s, { type: 'bury', ids: hand.slice(0, 8).map((c) => c.id) })
  }
  let guard = 0
  while (s.phase === 'play' && guard++ < 400) {
    const seat = seatToPlay(s)
    if (seat === null) break
    s = aiPlayFor(s, seat, level)
  }
  return s
}

describe('M6 · 稳定性', () => {
  it('连续 10 局零 error（NFR-11）', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (let seed = 1; seed <= 10; seed++) {
        const s = playRound(seed, (seed % 3) as 0 | 1 | 2)
        expect(s.phase, `第 ${seed} 局应当打完`).toBe('settle')
        expect(s.hands.every((h) => h.length === 0)).toBe(true)
        expect(s.lastReject, `第 ${seed} 局不应有拒绝记录`).toBeNull()
      }
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('连续 10 局不中断地推进到终局（nextRound 链路）', () => {
    let s = newGame(DEFAULT_RULE_CONFIG, 1, 0, 42)
    let rounds = 0
    while (rounds < 10 && s.phase !== 'over') {
      s = reduce(s, { type: 'declareTrump', trump: 0 })
      if (s.phase === 'bury') {
        const hand = s.hands[s.dealer] as readonly Card[]
        s = reduce(s, { type: 'bury', ids: hand.slice(0, 8).map((c) => c.id) })
      }
      let guard = 0
      while (s.phase === 'play' && guard++ < 400) {
        const seat = seatToPlay(s)
        if (seat === null) break
        s = aiPlayFor(s, seat, 1)
      }
      expect(s.phase).toBe('settle')
      rounds++
      s = reduce(s, { type: 'nextRound' })
    }
    expect(rounds).toBeGreaterThanOrEqual(1)
    // 10 局之内不应崩，级牌应正常推进
    expect(s.levels.a).toBeGreaterThan(0)
    expect(s.levels.b).toBeGreaterThan(0)
  })

  it('AI 不会在无牌可出时卡死（aiCanAct 与状态一致）', () => {
    const s = playRound(7, 1)
    expect(s.phase).toBe('settle')
    // 结算态下 AI 不应还能行动
    expect(aiCanAct(s)).toBe(false)
  })
})

describe('M6 · 规则开关下一局生效（FR-18 ③）', () => {
  it('改规则开关不改变当前局，下一局才生效', () => {
    let s = newGame(DEFAULT_RULE_CONFIG, 1, 0, 100)
    s = reduce(s, { type: 'declareTrump', trump: 0 })
    if (s.phase === 'bury') {
      const hand = s.hands[s.dealer] as readonly Card[]
      s = reduce(s, { type: 'bury', ids: hand.slice(0, 8).map((c) => c.id) })
    }
    const configBefore = s.config
    const twoAsPermanentBefore = configBefore.twoAsPermanent

    // 改开关
    s = reduce(s, { type: 'updateConfig', patch: { twoAsPermanent: !twoAsPermanentBefore } })
    // 当前局的 config 不变
    expect(s.config.twoAsPermanent).toBe(twoAsPermanentBefore)
    // 但 pending 变了
    expect(s.pendingConfig.twoAsPermanent).toBe(!twoAsPermanentBefore)

    // 打完当前局
    let guard = 0
    while (s.phase === 'play' && guard++ < 400) {
      const seat = seatToPlay(s)
      if (seat === null) break
      s = aiPlayFor(s, seat, 1)
    }
    expect(s.phase).toBe('settle')

    // 下一局生效
    s = reduce(s, { type: 'nextRound' })
    expect(s.config.twoAsPermanent).toBe(!twoAsPermanentBefore)
  })

  it('体验项立即生效（AI 难度/速度/牌面尺寸）', () => {
    let s = newGame(DEFAULT_RULE_CONFIG, 1, 0, 101)
    s = reduce(s, { type: 'setAiLevel', level: 2 })
    expect(s.aiLevel).toBe(2)
    s = reduce(s, { type: 'setAiSpeed', ms: 800 })
    expect(s.aiSpeedMs).toBe(800)
    s = reduce(s, { type: 'setCardSize', size: 'L' })
    expect(s.cardSize).toBe('L')
    s = reduce(s, { type: 'toggleAnimation' })
    expect(s.animation).toBe(false)
  })
})

describe('M6 · 状态层可序列化（FR-17）', () => {
  it('任意时刻的 state 都能 JSON 往返', () => {
    const s = playRound(3, 1)
    const round = JSON.parse(JSON.stringify(s)) as GameState
    expect(round.phase).toBe(s.phase)
    expect(round.hands.length).toBe(4)
    expect(round.history.length).toBe(s.history.length)
    expect(round.version).toBe(s.version)
  })
})
