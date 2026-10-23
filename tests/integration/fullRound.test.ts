import { describe, it, expect } from 'vitest'
import { enumeratePlays } from '@ai/enumerate'
import type { PlayContext } from '@ai/enumerate'
import { DEFAULT_RULE_CONFIG, checkPlay } from '@core'
import type { Card, Play } from '@core'
import { aiCanAct, newGame, reduce } from '@app/game'
import { HUMAN_SEAT, ctxOf, seatToPlay } from '@app/state'
import type { Action, GameState } from '@app/state'
import { declareAndPass } from '../helpers/declare'

/** 模拟「人类」：挑第一个合法出法 */
function humanMove(s: GameState): Action {
  const ctx = ctxOf(s)
  const hand = s.hands[HUMAN_SEAT] as readonly Card[]
  const leadPlay = s.trick.plays[0] as Play | undefined
  const pc: PlayContext = leadPlay
    ? { kind: 'follow', leadCards: leadPlay.cards, leadAnalysis: leadPlay.analysis }
    : { kind: 'lead' }

  for (const cards of enumeratePlays(hand, ctx, pc, 60)) {
    const r = checkPlay({
      hand,
      cards,
      ctx,
      ...(leadPlay ? { lead: { cards: leadPlay.cards, analysis: leadPlay.analysis } } : {}),
      opponents: [1, 2, 3].map((x) => s.hands[x] as readonly Card[]),
    })
    if (r.ok) {
      return { type: 'setSelection', ids: r.cards.map((c) => c.id) }
    }
  }
  throw new Error('人类找不到合法出法')
}

/** 把一局推到结束 */
function playRound(seed: number, maxSteps = 4000): GameState {
  let s = newGame(DEFAULT_RULE_CONFIG, 1, 0, seed)

  // 定主
  s = declareAndPass(s, 0)

  // 埋底（若我是庄家）
  if (s.phase === 'bury') {
    const hand = s.hands[HUMAN_SEAT] as readonly Card[]
    const ctx = ctxOf(s)
    const weakest = [...hand]
      .sort((a, b) => ctx.power.get(a.value) - ctx.power.get(b.value))
      .slice(0, 8)
    s = reduce(s, { type: 'bury', ids: weakest.map((c) => c.id) })
  }

  let steps = 0
  while (s.phase === 'play' && steps < maxSteps) {
    steps += 1
    if (seatToPlay(s) === HUMAN_SEAT) {
      s = reduce(s, humanMove(s))
      s = reduce(s, { type: 'playSelected' })
    } else {
      expect(aiCanAct(s)).toBe(true)
      s = reduce(s, { type: 'aiStep' })
    }
  }
  return s
}

describe('IT-01 完整一局', () => {
  it('能从头打到结算，四家手牌全部出完', () => {
    const s = playRound(1234)
    expect(s.phase).toBe('settle')
    // 墩数不固定：出对子/拖拉机时一墩消耗多张牌（实测 23~25 墩）
    expect(s.hands.every((h) => h.length === 0)).toBe(true)
    const played = s.history.reduce((n, t) => n + t.plays.reduce((m, p) => m + p.cards.length, 0), 0)
    expect(played).toBe(100) // 4 家 × 25 张，一张不差
    expect(s.defenderScore).toBeGreaterThanOrEqual(0)
    expect(s.defenderScore).toBeLessThanOrEqual(400) // 含扣底翻倍，允许超过 200
    expect(s.lastSettle).not.toBeNull()
    expect(s.hands.every((h) => h.length === 0)).toBe(true)
  })

  it('结算后能开下一局', () => {
    let s = playRound(99)
    const round = s.round
    s = reduce(s, { type: 'nextRound' })
    expect(s.round).toBe(round + 1)
    expect(s.phase).toBe('contract')
    expect(s.hands.reduce((n, h) => n + h.length, 0)).toBe(108) // 108 张全派（庄家 33、旁家各 25）
    expect(s.bottom).toHaveLength(0) // 底牌在埋底时才确定
  })

  it('三个种子都能打完（不同牌局）', () => {
    for (const seed of [7, 2024, 88888]) {
      const s = playRound(seed)
      expect(s.phase, `seed ${seed}`).toBe('settle')
      expect(s.hands.every((h) => h.length === 0), `seed ${seed}`).toBe(true)
      expect(s.tricksDone, `seed ${seed}`).toBeGreaterThanOrEqual(20)
    }
  })

  it('牌数守恒：手牌 + 底牌 + 已出的牌 = 108', () => {
    let s = newGame(DEFAULT_RULE_CONFIG, 1, 0, 555)
    s = declareAndPass(s, 1)
    if (s.phase === 'bury') {
      const hand = s.hands[HUMAN_SEAT] as readonly Card[]
      s = reduce(s, { type: 'bury', ids: hand.slice(0, 8).map((c) => c.id) })
    }
    for (let i = 0; i < 40 && s.phase === 'play'; i++) {
      if (seatToPlay(s) === HUMAN_SEAT) {
        s = reduce(s, humanMove(s))
        s = reduce(s, { type: 'playSelected' })
      } else {
        s = reduce(s, { type: 'aiStep' })
      }
      const inHands = s.hands.reduce((n, h) => n + h.length, 0)
      const played = s.trick.plays.reduce((n, p) => n + p.cards.length, 0)
      const history = s.history.reduce(
        (n, t) => n + t.plays.reduce((m, p) => m + p.cards.length, 0),
        0,
      )
      expect(inHands + s.bottom.length + played + history, `第 ${i} 步`).toBe(108)
    }
  })
})

describe('IT-02 AI 出牌始终合法', () => {
  it('AI 每手都能通过 checkPlay（由 reducer 保证，这里抽查状态）', () => {
    const s = playRound(4321)
    expect(s.phase).toBe('settle')
    // 若 AI 出了非法牌，playCards 会写 lastReject 而不是推进 trick
    expect(s.lastReject).toBeNull()
  })
})

describe('IT-03 确定性', () => {
  it('同种子两次对局结果一致', () => {
    const a = playRound(2026)
    const b = playRound(2026)
    expect(a.defenderScore).toBe(b.defenderScore)
    expect(a.dealer).toBe(b.dealer)
    expect(a.lastSettle?.newLevels).toEqual(b.lastSettle?.newLevels)
  })
})
