import { describe, expect, it } from 'vitest'
import { DEFAULT_RULE_CONFIG, makeDeck } from '@core'
import type { Card } from '@core'
import { newGame, reduce } from '@app/game'
import { ctxOf } from '@app/state'
import type { GameState, TrickRecord } from '@app/state'
import { counterView } from '@app/view'
import { C, J } from '../core/helpers'
import { declareAndPass } from '../helpers/declare'

/**
 * 记牌器（v1.3.14）。
 *
 * 口径：只统计**已经打出来的牌**（历史每一墩 + 当前墩）。底牌 8 张谁也不知道，
 * 所以算在「未出」里 —— 界面上「未出」= 总数 − 已出。
 */

function playPhase(seed: number): GameState {
  let s = newGame(DEFAULT_RULE_CONFIG, 2, 0, seed)
  s = declareAndPass(s, 0)
  if (s.phase === 'bury') {
    const hand = s.hands[s.dealer] as readonly Card[]
    s = reduce(s, { type: 'bury', ids: hand.slice(0, 8).map((c) => c.id) })
  }
  return s
}

/** 把状态固定成「主花色 = ♠」的干净局面（记牌器只读 trump / levelRank / 出牌） */
function withSpadeTrump(s: GameState): GameState {
  return { ...s, trump: 0, forcedNT: false, history: [], trick: { leader: 0, plays: [], winner: null } }
}

/** 往历史里塞一墩（只关心出了哪些牌） */
function withTrick(s: GameState, cards: readonly Card[]): GameState {
  const rec: TrickRecord = {
    leader: 0,
    plays: [{ seat: 0, cards: [...cards] }],
    winner: 0,
    score: 0,
  }
  return { ...s, history: [rec] }
}

describe('记牌器 counterView', () => {
  it('开局一张没出：所有项都是「满」', () => {
    const c = counterView(withSpadeTrump(playPhase(7)))
    expect(c.bigJoker).toEqual({ left: 2, total: 2 })
    expect(c.smallJoker).toEqual({ left: 2, total: 2 })
    // 主花色（♠）级牌 2 张、其余三门各 2 张 = 6
    expect(c.levelTrump).toEqual({ left: 2, total: 2 })
    expect(c.levelOff).toEqual({ left: 6, total: 6 })
    expect(c.pointsPlayed).toBe(0)
    expect(c.pointsTotal).toBe(200)
  })

  it('主牌总数 = 牌堆里被判定为主牌的张数（含王、级牌、常主 2）', () => {
    const s = withSpadeTrump(playPhase(7))
    const ctx = ctxOf(s)
    const expected = makeDeck().filter((c) => ctx.power.isTrump(c.value)).length
    expect(counterView(s).trumps.total).toBe(expected)
    // 至少包含 4 张王 + 8 张级牌
    expect(counterView(s).trumps.total).toBeGreaterThanOrEqual(12)
  })

  it('出了一张大王 + 一张 5 分牌：大王 1/2、分 5', () => {
    const s = withTrick(withSpadeTrump(playPhase(7)), [J(true), C(0, 3)]) // ♠5 = rank 3
    const c = counterView(s)
    expect(c.bigJoker).toEqual({ left: 1, total: 2 })
    expect(c.smallJoker).toEqual({ left: 2, total: 2 })
    expect(c.pointsPlayed).toBe(5)
  })

  it('当前墩（还没结算）也算已出', () => {
    const base = withSpadeTrump(playPhase(7))
    const s: GameState = {
      ...base,
      trick: {
        leader: 0,
        plays: [{ seat: 0, cards: [J(false)], analysis: null as never }],
        winner: null,
      } as GameState['trick'],
    }
    expect(counterView(s).smallJoker).toEqual({ left: 1, total: 2 })
  })

  it('无将：主级 0/0，全部 8 张级牌算「副级」', () => {
    const s: GameState = { ...withSpadeTrump(playPhase(7)), trump: 'NT', forcedNT: false }
    const c = counterView(s)
    expect(c.levelTrump).toEqual({ left: 0, total: 0 })
    expect(c.levelOff).toEqual({ left: 8, total: 8 })
  })

  it('不变量：未出张数永远在 0..总数 之间', () => {
    const s = withTrick(withSpadeTrump(playPhase(7)), [J(true), J(true), C(0, 12)])
    const c = counterView(s)
    for (const slot of [c.bigJoker, c.smallJoker, c.levelTrump, c.levelOff, c.trumps]) {
      expect(slot.left).toBeGreaterThanOrEqual(0)
      expect(slot.left).toBeLessThanOrEqual(slot.total)
    }
    // 大王只有 2 张：出了 2 张 ⇒ 未出 0
    expect(c.bigJoker.left).toBe(0)
  })
})
