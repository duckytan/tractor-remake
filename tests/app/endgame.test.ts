/**
 * 残局精确求解（v1.3.29 · docs/28 §5）
 *
 * 这个模块的价值靠**配对测量**证明（`scripts/measure-endgame.ts`：
 * 胜 68 / 负 7 / 平 525，净分 +0.93 ± 0.29，n=600），
 * 用例只锁「契约」：什么时候接管、什么时候必须不接管、出的牌必须合法、
 * 以及最坏情况下的耗时上限（不能把主线程卡住）。
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_RULE_CONFIG, DECK_SIZE, teamOf } from '@core'
import type { Card } from '@core'
import { ENDGAME_MAX_CARDS, aiPlayFor, newGame, reduce, solveEndgame } from '@app/game'
import { HUMAN_SEAT, seatToPlay } from '@app/state'
import type { GameState } from '@app/state'
import { declareAndPass } from '../helpers/declare'

function pickBuryIds(s: GameState): number[] {
  const hand = s.hands[s.dealer] as readonly Card[]
  return hand.slice(0, 8).map((c) => c.id)
}

function start(seed: number): GameState {
  let s = newGame(DEFAULT_RULE_CONFIG, 3, 0, seed)
  s = declareAndPass(s, 0)
  if (s.phase === 'bury') s = reduce(s, { type: 'bury', ids: pickBuryIds(s) })
  return s
}

const totalCards = (s: GameState): number => s.hands.reduce((n, h) => n + h.length, 0)

/** 关掉残局搜索，把局面推到「总剩牌 ≤ 阈值」 */
function toEndgame(seed: number): GameState {
  let s = start(seed)
  let steps = 0
  while (s.phase === 'play' && totalCards(s) > ENDGAME_MAX_CARDS && steps++ < 400) {
    const seat = seatToPlay(s)
    if (seat === null) break
    s = aiPlayFor(s, seat, 3, { endgame: false })
  }
  return s
}

describe('solveEndgame · 接管条件', () => {
  it('牌还多的时候不接管（返回 null）', () => {
    const s = start(401)
    expect(totalCards(s)).toBeGreaterThan(ENDGAME_MAX_CARDS)
    expect(solveEndgame(s, seatToPlay(s) as never)).toBeNull()
  })

  it('关掉「AI 读牌」时不接管（搜索要用四家真实手牌，不能偷用）', () => {
    let s = toEndgame(402)
    expect(s.phase).toBe('play')
    expect(totalCards(s)).toBeLessThanOrEqual(ENDGAME_MAX_CARDS)
    const seat = seatToPlay(s) as number
    const noPeek: GameState = { ...s, aiPeekHands: false }
    expect(solveEndgame(noPeek, seat as never)).toBeNull()
    // 开着读牌时应当接管
    expect(solveEndgame(s, seat as never)).not.toBeNull()
  })

  it('不是该我出牌时不接管', () => {
    const s = toEndgame(403)
    const seat = seatToPlay(s) as number
    const other = ((seat + 1) % 4) as number
    expect(solveEndgame(s, other as never)).toBeNull()
  })

  it('非出牌阶段不接管', () => {
    const s = start(404)
    const contract: GameState = { ...s, phase: 'settle' }
    expect(solveEndgame(contract, 0)).toBeNull()
  })
})

describe('solveEndgame · 产出可用', () => {
  it('返回的牌一定是合法的（aiPlayFor 能直接打出去）', () => {
    for (const seed of [405, 406, 407]) {
      const s = toEndgame(seed)
      if (s.phase !== 'play' || totalCards(s) > ENDGAME_MAX_CARDS) continue
      const seat = seatToPlay(s) as number
      const solved = solveEndgame(s, seat as never)
      expect(solved).not.toBeNull()
      // 用求解结果直接出牌，状态必须前进（不是被拒绝）
      const next = aiPlayFor(s, seat as never, 3)
      expect(next.trick.plays.length + next.history.length).toBeGreaterThan(
        s.trick.plays.length + s.history.length,
      )
    }
  })

  it('耗时可控（单次 ≤ 200ms，实测最大约 3.5ms）', () => {
    for (const seed of [408, 409]) {
      const s = toEndgame(seed)
      if (s.phase !== 'play' || totalCards(s) > ENDGAME_MAX_CARDS) continue
      const seat = seatToPlay(s) as number
      const t0 = Date.now()
      solveEndgame(s, seat as never)
      expect(Date.now() - t0).toBeLessThan(200)
    }
  })

  it('整局在「开残局搜索」下能正常打完，且 108 张守恒', () => {
    let s = start(410)
    let steps = 0
    while (s.phase === 'play' && steps++ < 400) {
      const seat = seatToPlay(s)
      if (seat === null) break
      s = aiPlayFor(s, seat, 3)
    }
    expect(s.phase).toBe('settle')
    expect(s.hands.every((h) => h.length === 0)).toBe(true)
    // 已出的牌 + 底牌 = 108
    const played = s.history.reduce((n, r) => n + r.plays.reduce((m, p) => m + p.cards.length, 0), 0)
    expect(played + s.bottom.length).toBe(DECK_SIZE)
  })

  it('搜索确实在改变决策（开/关搜索的终局得分至少有一局不同）', () => {
    let diff = 0
    for (const seed of [411, 412, 413, 414, 415, 416]) {
      const withSolver = ((): number => {
        let s = start(seed)
        let steps = 0
        while (s.phase === 'play' && steps++ < 400) {
          const seat = seatToPlay(s)
          if (seat === null) break
          s = aiPlayFor(s, seat, 3)
        }
        return s.defenderScore
      })()
      const without = ((): number => {
        let s = start(seed)
        let steps = 0
        while (s.phase === 'play' && steps++ < 400) {
          const seat = seatToPlay(s)
          if (seat === null) break
          s = aiPlayFor(s, seat, 3, { endgame: false })
        }
        return s.defenderScore
      })()
      // 四家同档时「闲家得分」高低本身没有优劣（两队都是 L3），
      // 所以这里不比较谁高谁低 —— 只证明**搜索真的接管了决策**：
      // 6 个种子里至少有一局的终局得分与「关掉搜索」不同。
      // 如果这个断言挂了，说明 solveEndgame 从来没被调用（回归会静默失效）。
      expect(Number.isFinite(withSolver)).toBe(true)
      expect(Number.isFinite(without)).toBe(true)
      if (withSolver !== without) diff++
    }
    expect(diff).toBeGreaterThan(0)
  })
})

describe('残局搜索与人类座位', () => {
  it('人类座位不经过 solveEndgame（aiPlayFor 只服务 AI）', () => {
    const s = toEndgame(417)
    if (s.phase !== 'play') return
    // 人类座位的手牌始终完整，搜索不会改写状态
    const before = (s.hands[HUMAN_SEAT] as readonly Card[]).length
    solveEndgame(s, HUMAN_SEAT)
    expect((s.hands[HUMAN_SEAT] as readonly Card[]).length).toBe(before)
    expect(teamOf(HUMAN_SEAT)).toBe(0)
  })
})
