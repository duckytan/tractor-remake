/**
 * 核心层与状态机的数值/入参守卫（v1.3.29 · docs/33 的 C6-04~08、C1-02、C1-04）
 *
 * 这些条目都是「畸形入参能静默通过」类问题 —— 正常对局走不到，
 * 但存档损坏、UI 侧 bug、或未来某个调用方传错就能触发。用例即「构造畸形 → 断言被挡住」。
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RULE_CONFIG,
  advanceLevel,
  analyze,
  calcBottomBonus,
  checkPlay,
  levelsFor,
  resolveTrick,
} from '@core'
import type { Card, Play } from '@core'
import { newGame, reduce } from '@app/game'
import { HUMAN_SEAT } from '@app/state'
import type { GameState } from '@app/state'
import { declareAndPass } from '../helpers/declare'
import { C, P, ctx as makeCtx } from '../core/helpers'

const c = makeCtx({ trump: 0, levelRank: 2 })

describe('C6-04 · levelsFor 拒绝非法分数', () => {
  it('NaN / Infinity / 负数都抛错，不再静默当成「40–79 → 庄家方升 1 级」', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() => levelsFor(bad), `levelsFor(${bad})`).toThrow(/defenderScore 非法/)
    }
  })

  it('正常区间不受影响（0 / 39 / 40 / 79 / 80 / 120）', () => {
    expect(levelsFor(0)).toEqual({ team: 'dealer', levels: 3 })
    expect(levelsFor(39)).toEqual({ team: 'dealer', levels: 2 })
    expect(levelsFor(40)).toEqual({ team: 'dealer', levels: 1 })
    expect(levelsFor(79)).toEqual({ team: 'dealer', levels: 1 })
    expect(levelsFor(80)).toEqual({ team: 'defender', levels: 0 })
    expect(levelsFor(120)).toEqual({ team: 'defender', levels: 1 })
  })
})

describe('C6-08 · advanceLevel 的循环次数被夹紧', () => {
  it('levels = 1e9 也能瞬间返回（最多升 20 级）', () => {
    const t0 = Date.now()
    const r = advanceLevel(2, 1e9, { ...DEFAULT_RULE_CONFIG, guardScoreLevels: false, guardAce: false, guardKingLevel: false }, 0)
    const ms = Date.now() - t0
    expect(ms).toBeLessThan(50)
    expect(r.actualLevels).toBeLessThanOrEqual(20)
  })

  it('levels 非有限值抛错', () => {
    expect(() => advanceLevel(2, Number.NaN, DEFAULT_RULE_CONFIG, 0)).toThrow(/非有限值/)
  })
})

describe('C6-05 · resolveTrick 区分「没有出牌」与「首出牌型非法」', () => {
  it('空数组 → 「没有出牌」', () => {
    expect(() => resolveTrick([], c)).toThrow(/没有出牌/)
  })

  it('首出混花色 → 「首出牌型非法」而不是「没有出牌」', () => {
    const mixed: Card[] = [C(1, 5), C(2, 5)]
    const play: Play = { seat: 0, cards: mixed, analysis: analyze(mixed, c) }
    expect(() => resolveTrick([play], c)).toThrow(/首出牌型非法/)
  })
})

describe('C6-06 · 空牌型不拿抠底倍数', () => {
  it('groups 为空时 applies=false、multiplier=1', () => {
    const r = calcBottomBonus(analyze([], c), 80, false)
    expect(r.applies).toBe(false)
    expect(r.multiplier).toBe(1)
    expect(r.extra).toBe(0)
  })

  it('正常单张仍是 ×2、对子 ×4、拖拉机 ×8', () => {
    expect(calcBottomBonus(analyze([C(1, 5)], c), 10, false).multiplier).toBe(2)
    expect(calcBottomBonus(analyze([...P(1, 5)], c), 10, false).multiplier).toBe(4)
    expect(
      calcBottomBonus(analyze([...P(1, 5), ...P(1, 6)], c), 10, false).multiplier,
    ).toBe(8)
  })
})

describe('C6-07 · 同一张物理牌不能出两次', () => {
  it('出牌里 id 重复 ⇒ 拒绝（哪怕手牌里也「有这么多张」）', () => {
    const card = C(1, 5)
    // 手牌里塞 3 张同 id（数据损坏的样子），出牌也出 3 张
    const hand: Card[] = [card, card, card]
    const r = checkPlay({ hand, cards: [card, card, card], ctx: c, opponents: [] })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('cards-not-in-hand')
  })
})

describe('C1-04 · 发牌期也要推进 step', () => {
  it('revealTick 每次都让 step +1（否则 aiGrabPick 的骰子是常量）', () => {
    let s = newGame(DEFAULT_RULE_CONFIG, 1, 0, 909)
    const steps: number[] = []
    for (let i = 0; i < 12 && s.phase === 'contract'; i++) {
      s = reduce(s, { type: 'revealTick' })
      steps.push(s.step)
    }
    expect(new Set(steps).size).toBeGreaterThan(1)
    // 单调不减（`revealTick` 在 dealPrompt / 已发完时会提前返回，那一次不加 step）
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i]).toBeGreaterThanOrEqual(steps[i - 1] as number)
    }
    // 关键：至少推进到「发牌张数」的量级，而不是全程 0
    expect(steps[steps.length - 1] as number).toBeGreaterThanOrEqual(9)
  })
})

describe('C1-02 · 选牌类 action 校验 id 与阶段', () => {
  function toPlay(seed = 80): GameState {
    let s = newGame(DEFAULT_RULE_CONFIG, 1, 0, seed)
    s = declareAndPass(s, 0)
    if (s.phase === 'bury') {
      const hand = s.hands[s.dealer] as readonly Card[]
      s = reduce(s, { type: 'bury', ids: hand.slice(0, 8).map((c) => c.id) })
    }
    return s
  }

  it('setSelection 只保留真实在手里的 id，且去重', () => {
    const s = toPlay()
    const hand = s.hands[HUMAN_SEAT] as readonly Card[]
    const real = (hand[0] as Card).id
    const after = reduce(s, { type: 'setSelection', ids: [real, real, 9999] })
    expect(after.selected).toEqual([real])
  })

  it('定主阶段写 selected 被忽略（避免被存档带出去）', () => {
    const s = newGame(DEFAULT_RULE_CONFIG, 1, 0, 81)
    expect(s.phase).toBe('contract')
    const after = reduce(s, { type: 'setSelection', ids: [0, 1] })
    expect(after.selected).toEqual([])
    expect(after).toBe(s)
  })

  it('showHint 不认外部 id', () => {
    const s = toPlay()
    const after = reduce(s, { type: 'showHint', ids: [9999] })
    expect(after.hintIds).toEqual([])
  })
})

describe('declareTrump 运行时守卫', () => {
  it('传入非法主牌标识（4）被拒绝，trump 不变', () => {
    const s = newGame(DEFAULT_RULE_CONFIG, 1, 0, 82)
    expect(s.phase).toBe('contract')
    const before = s.trump
    const after = reduce(s, { type: 'declareTrump', trump: 4 as never })
    expect(after.trump).toBe(before)
    expect(after.phase).toBe('contract')
    expect(after.lastReject?.detail).toContain('主牌标识非法')
  })
})
