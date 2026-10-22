/**
 * 轮庄（修复 1）
 *
 * 规则：第 1 局随机定庄，之后每局庄家 = 上一局结算的 `settle.newDealer`。
 * 曾经的 bug：`startRound` 开头无条件 `rng.int(4)` 重随机，把
 * `nextRound` 刚写进去的 `s.dealer` 覆盖掉 —— 轮庄完全失效，
 * 且 `levelRank`（= 庄家队的级牌）也跟着取错队。
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_RULE_CONFIG } from '@core'
import type { Card, Seat } from '@core'
import { aiPlayFor, newGame, reduce, startRound } from '@app/game'
import type { GameState } from '@app/state'
import { seatToPlay } from '@app/state'
import { declareAndPass } from '../helpers/declare'

/** 四家全 AI 跑完一局 */
function playRound(seed: number): GameState {
  let s = newGame(DEFAULT_RULE_CONFIG, 1, 0, seed)
  s = declareAndPass(s, 0)
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
  return s
}

describe('轮庄', () => {
  it('round > 1 时 startRound 必须沿用 s.dealer（不再随机）', () => {
    const base = newGame(DEFAULT_RULE_CONFIG, 1, 0, 123)
    for (const seat of [0, 1, 2, 3] as Seat[]) {
      const s: GameState = { ...base, round: 2, dealer: seat }
      const next = startRound(s, 999)
      expect(next.dealer, `庄家应保持为 ${seat}`).toBe(seat)
      // 级别跟着庄家那一队走（原来随机覆盖时这里会取错队）
      expect(next.levelRank).toBe(seat % 2 === 0 ? next.levels.a : next.levels.b)
    }
  })

  it('第 1 局随机定庄（不同种子能落到不同座位）', () => {
    const dealers = new Set<number>()
    for (let seed = 1; seed <= 20; seed++) {
      dealers.add(newGame(DEFAULT_RULE_CONFIG, 1, 0, seed).dealer)
    }
    expect(dealers.size).toBeGreaterThan(1)
  })

  it('第 2 局庄家 = 上一局 settle.newDealer（不再随机）', () => {
    const s = playRound(4242)
    expect(s.phase).toBe('settle')
    const settle = s.lastSettle
    if (!settle) throw new Error('结算结果缺失')

    const next = reduce(s, { type: 'nextRound' })
    expect(next.round).toBe(s.round + 1)
    expect(next.dealer).toBe(settle.newDealer)
    // 轮庄必然换人：庄家方赢 → 对家坐庄；闲家上台 → 下家坐庄
    expect(next.dealer).not.toBe(s.dealer)
  })

  it('新一局的级别取自新庄家那一队', () => {
    const s = playRound(777)
    const settle = s.lastSettle
    if (!settle) throw new Error('结算结果缺失')

    const next = reduce(s, { type: 'nextRound' })
    const expected = next.dealer % 2 === 0 ? next.levels.a : next.levels.b
    expect(next.levelRank).toBe(expected)
    expect(next.levels).toEqual(settle.newLevels)
  })

  it('连续多局庄家链条不丢（每局都按上一局结算轮转）', () => {
    let s = playRound(31337)
    const chain: number[] = [s.dealer]
    for (let i = 0; i < 2; i++) {
      const settle = s.lastSettle
      if (!settle) throw new Error('结算结果缺失')
      const next = reduce(s, { type: 'nextRound' })
      expect(next.dealer).toBe(settle.newDealer)
      chain.push(next.dealer)

      // 继续把这一局打完，供下一轮比较
      let cur = declareAndPass(next, 0)
      if (cur.phase === 'bury') {
        const hand = cur.hands[cur.dealer] as readonly Card[]
        cur = reduce(cur, { type: 'bury', ids: hand.slice(0, 8).map((c) => c.id) })
      }
      let guard = 0
      while (cur.phase === 'play' && guard++ < 400) {
        const seat = seatToPlay(cur)
        if (seat === null) break
        cur = aiPlayFor(cur, seat, 1)
      }
      s = cur
      if (s.phase !== 'settle') break // 打到 over（某一队打完 A）就停
    }
    expect(chain.length).toBeGreaterThanOrEqual(2)
  })
})
