/**
 * 对手手牌概率推断（v1.3.29 · docs/15 KN-10）
 *
 * 这个模块的意义是「AI 不再明牌」：只用公开信息（我的手牌 + 已出的牌 + 每家张数）
 * 估计「我这手会不会被压」。用例锁两件事：
 *   ① `buildBelief` 的未知池大小必须严格等于「我看不到的牌」——
 *      非庄家不能把底牌剔掉（剔了就是偷看）；
 *   ② `beatChance` 的方向性：能压的牌越多概率越高、没有能压的牌就是 0、
 *      已经出过牌的座位不算威胁。
 */

import { describe, expect, it } from 'vitest'
import { DECK_SIZE, DEFAULT_RULE_CONFIG } from '@core'
import type { Card, Seat, SuitSlot } from '@core'
import { buildBelief, beatChance, BEAT_THRESHOLD } from '@ai/belief'
import { newGame, reduce } from '@app/game'
import { HUMAN_SEAT } from '@app/state'
import type { GameState } from '@app/state'
import { declareAndPass } from '../helpers/declare'
import { ctx as makeCtx, C } from '../core/helpers'

const c = makeCtx({ trump: 0, levelRank: 2 }) // 黑桃主

/** 推进到出牌阶段 */
function playState(seed: number): GameState {
  let s = newGame(DEFAULT_RULE_CONFIG, 1, 0, seed)
  s = declareAndPass(s, 0)
  if (s.phase === 'bury') {
    const hand = s.hands[s.dealer] as readonly Card[]
    s = reduce(s, { type: 'bury', ids: hand.slice(0, 8).map((x) => x.id) })
  }
  return s
}

describe('buildBelief · 未知池只能由公开信息推出', () => {
  it('庄家：未知池 = 108 − 我的手牌 − 已出的牌 − 底牌（他知道底牌）', () => {
    const s = playState(301)
    expect(s.dealer).toBe(HUMAN_SEAT) // 这个种子人类坐庄
    const b = buildBelief(s, HUMAN_SEAT)
    const myLen = (s.hands[HUMAN_SEAT] as readonly Card[]).length
    const played = s.history.reduce((n, r) => n + r.plays.reduce((m, p) => m + p.cards.length, 0), 0)
    expect(b.unseen.length).toBe(DECK_SIZE - myLen - played - s.bottom.length)
    // 庄家看到的未知池 = 三家手牌之和（底牌他自己知道，不在池里）
    expect(b.unseen.length).toBe(b.handSizes.reduce((n, h, i) => (i === HUMAN_SEAT ? n : n + h), 0))
  })

  it('非庄家：未知池 = 108 − 我的手牌 − 已出的牌（**不能**减底牌，否则等于偷看）', () => {
    const s = playState(302)
    const seat: Seat = s.dealer === HUMAN_SEAT ? 1 : HUMAN_SEAT
    const b = buildBelief(s, seat)
    const myLen = (s.hands[seat] as readonly Card[]).length
    const played = s.history.reduce((n, r) => n + r.plays.reduce((m, p) => m + p.cards.length, 0), 0)
    expect(b.unseen.length).toBe(DECK_SIZE - myLen - played)
    // 比「三家手牌之和」多出 8 张 —— 正是他不知道的底牌
    const oppSum = b.handSizes.reduce((n, h, i) => (i === seat ? n : n + h), 0)
    expect(b.unseen.length).toBe(oppSum + s.bottom.length)
  })

  it('未知池里不含自己手牌，也不含已出的牌', () => {
    const s = playState(303)
    const b = buildBelief(s, HUMAN_SEAT)
    const ids = new Set(b.unseen.map((x) => x.id))
    for (const card of s.hands[HUMAN_SEAT] as readonly Card[]) expect(ids.has(card.id)).toBe(false)
    for (const rec of s.history) {
      for (const p of rec.plays) for (const card of p.cards) expect(ids.has(card.id)).toBe(false)
    }
  })
})

/** 直接构造信念（不依赖对局），把「未知池」捏成想要的样子 */
function fakeBelief(unseen: readonly Card[], handSizes: number[], seat: Seat) {
  return { unseen, handSizes, seat } as const
}

const slotOf = (card: Card): SuitSlot | -1 => {
  const p = c.power.get(card.value)
  if (p >= 52) return 4
  return Math.floor(card.value / 13) as SuitSlot
}

describe('beatChance · 方向性', () => {
  it('混花色（slot = -1）必然守不住 ⇒ 1', () => {
    const b = fakeBelief([C(1, 3)], [1, 1, 1, 1], 0)
    expect(beatChance({ belief: b, ctx: c, mySlot: -1, pairs: 0, myPower: 0 })).toBe(1)
  })

  it('未知池里没有任何能压的牌 ⇒ 0', () => {
    // 我出 ♥A（红心最大），未知池只剩 ♥3 ♥4，没有主牌 ⇒ 谁也压不了
    const unseen = [C(1, 1), C(1, 2)]
    const b = fakeBelief(unseen, [0, 1, 1, 0], 0)
    const myPower = c.power.get(C(1, 12).value)
    expect(slotOf(C(1, 1))).toBe(1)
    expect(beatChance({ belief: b, ctx: c, mySlot: 1, pairs: 0, myPower })).toBe(0)
  })

  it('能压的牌越多，概率越高（单调）', () => {
    const myPower = c.power.get(C(1, 5).value)
    const few = fakeBelief([C(1, 12), C(2, 2), C(2, 3), C(2, 4)], [0, 2, 1, 1], 0)
    const many = fakeBelief(
      [C(1, 12), C(1, 11), C(1, 10), C(2, 2), C(2, 3), C(2, 4)],
      [0, 2, 1, 1],
      0,
    )
    const pFew = beatChance({ belief: few, ctx: c, mySlot: 1, pairs: 0, myPower })
    const pMany = beatChance({ belief: many, ctx: c, mySlot: 1, pairs: 0, myPower })
    expect(pMany).toBeGreaterThan(pFew)
  })

  it('主牌能毙副牌：未知池里的主牌都算「能压」', () => {
    const myPower = c.power.get(C(1, 12).value) // ♥A，副牌里最大
    const noTrump = fakeBelief([C(1, 1), C(1, 2), C(1, 3)], [0, 1, 1, 1], 0)
    const withTrump = fakeBelief([C(1, 1), C(0, 1), C(0, 2)], [0, 1, 1, 1], 0) // ♠ 是主
    const p0 = beatChance({ belief: noTrump, ctx: c, mySlot: 1, pairs: 0, myPower })
    const p1 = beatChance({ belief: withTrump, ctx: c, mySlot: 1, pairs: 0, myPower })
    expect(p0).toBe(0)
    expect(p1).toBeGreaterThan(0)
  })

  it('已经出过牌的座位不算威胁（remaining 过滤）', () => {
    const myPower = c.power.get(C(1, 5).value)
    const b = fakeBelief([C(1, 12), C(1, 11), C(1, 10)], [0, 1, 1, 1], 0)
    const all = beatChance({ belief: b, ctx: c, mySlot: 1, pairs: 0, myPower })
    const none = beatChance({ belief: b, ctx: c, mySlot: 1, pairs: 0, myPower, remaining: [] })
    expect(all).toBeGreaterThan(0)
    expect(none).toBe(0)
  })

  it('概率始终落在 [0, 1]，阈值常量可用', () => {
    const b = fakeBelief([C(1, 12), C(1, 11), C(0, 1), C(0, 2)], [0, 2, 2, 1], 0)
    const p = beatChance({ belief: b, ctx: c, mySlot: 1, pairs: 0, myPower: c.power.get(C(1, 3).value) })
    expect(p).toBeGreaterThanOrEqual(0)
    expect(p).toBeLessThanOrEqual(1)
    expect(BEAT_THRESHOLD).toBeGreaterThan(0)
    expect(BEAT_THRESHOLD).toBeLessThan(1)
  })
})

describe('aiPlayFor 的读牌开关', () => {
  it('aiPeekHands 默认 true（保持既有强度），可被 toggleAiPeek 关掉', () => {
    const s = playState(304)
    expect(s.aiPeekHands).toBe(true)
    const off = reduce(s, { type: 'toggleAiPeek' })
    expect(off.aiPeekHands).toBe(false)
    expect(reduce(off, { type: 'toggleAiPeek' }).aiPeekHands).toBe(true)
  })

  it('关掉读牌后 AI 仍能出合法牌、整局能打完', async () => {
    const { aiPlayFor } = await import('@app/game')
    const { seatToPlay } = await import('@app/state')
    let s = reduce(playState(305), { type: 'toggleAiPeek' })
    expect(s.aiPeekHands).toBe(false)
    let steps = 0
    while (s.phase === 'play' && steps < 400) {
      steps++
      const seat = seatToPlay(s)
      if (seat === null) break
      s = aiPlayFor(s, seat, 3)
    }
    expect(s.phase).toBe('settle')
    expect(s.hands.every((h) => h.length === 0)).toBe(true)
  })
})
