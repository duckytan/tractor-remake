/**
 * 冒烟测试：验证「整个工程能跑起来」这条底线。
 *
 * 覆盖三层的最小闭环：core 规则 → app 装配 → ai 决策。
 * 不测具体规则细节（那是 tests/core/*），只测「接得上」。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_RULE_CONFIG,
  analyze,
  buildPowerTable,
  checkPlay,
  makeDeck,
  mulberry32,
} from '@core'
import type { Card, Seat } from '@core'
import { decide } from '@ai/policy'
import { enumeratePlays } from '@ai/enumerate'
import { newGame, reduce, aiCanAct } from '@app/game'
import { seatToPlay } from '@app/state'

describe('冒烟 · core 规则引擎可用', () => {
  it('能造出 108 张牌、54 个牌值各两张', () => {
    const deck = makeDeck()
    expect(deck.length).toBe(108)
    const values = new Set(deck.map((c) => c.value))
    expect(values.size).toBe(54)
  })

  it('能构建牌力表并识别主牌', () => {
    const power = buildPowerTable({ mode: 0, levelRank: 2, trump: 0 })
    expect(power.isTrump(52)).toBe(true) // 小王
    expect(power.isTrump(53)).toBe(true) // 大王
    expect(power.isTrump(0)).toBe(true) // ♠2 —— levelRank=2 时 2 是级牌，属主牌
    // ♥3：非主牌花色、非级牌 → 副牌
    expect(power.isTrump(14)).toBe(false)
    expect(power.get(53)).toBeGreaterThan(power.get(0))
  })

  it('checkPlay 能判首出合法性', () => {
    const power = buildPowerTable({ mode: 0, levelRank: 2, trump: 0 })
    const ctx = {
      power,
      trump: 0 as const,
      levelRank: 2 as const,
      forcedNT: false,
      config: DEFAULT_RULE_CONFIG,
    }
    const cards: Card[] = [{ id: 1, value: 5 }]
    expect(checkPlay({ hand: cards, cards, ctx, opponents: [] }).ok).toBe(true)
  })
})

describe('冒烟 · app 装配可用', () => {
  it('newGame 能发牌并进入定主阶段', () => {
    const s = newGame(DEFAULT_RULE_CONFIG, 1, 0, 42)
    expect(s.phase).toBe('contract')
    expect(s.hands).toHaveLength(4)
    expect(s.bottom).toHaveLength(8)
    expect(s.hands[s.dealer] as readonly Card[]).toHaveLength(25)
  })

  it('定主 → 埋底 → 出牌 能一路推进', () => {
    let s = newGame(DEFAULT_RULE_CONFIG, 1, 0, 7)
    s = reduce(s, { type: 'declareTrump', trump: 0 })
    expect(['play', 'bury']).toContain(s.phase)
    if (s.phase === 'bury') {
      const hand = s.hands[s.dealer] as readonly Card[]
      expect(hand).toHaveLength(33) // 收了 8 张底牌
      s = reduce(s, { type: 'bury', ids: hand.slice(0, 8).map((c) => c.id) })
    }
    expect(s.phase).toBe('play')
    expect(aiCanAct(s) || seatToPlay(s) === 0).toBe(true)
  })

  it('状态可 JSON 往返（FR-17）', () => {
    const s = newGame(DEFAULT_RULE_CONFIG, 1, 0, 3)
    const back = JSON.parse(JSON.stringify(s))
    expect(back.phase).toBe(s.phase)
    expect(back.hands).toHaveLength(4)
  })
})

describe('冒烟 · ai 决策可用', () => {
  it('三档 AI 都能给出合法出牌', () => {
    const s = newGame(DEFAULT_RULE_CONFIG, 1, 0, 99)
    const withTrump = reduce(s, { type: 'declareTrump', trump: 0 })
    const base = withTrump.phase === 'bury'
      ? reduce(withTrump, {
          type: 'bury',
          ids: (withTrump.hands[withTrump.dealer] as readonly Card[]).slice(0, 8).map((c) => c.id),
        })
      : withTrump

    const ctx = {
      power: buildPowerTable({
        mode: base.config.twoAsPermanent ? 1 : 0,
        levelRank: base.levelRank,
        trump: base.trump,
        forcedNT: base.forcedNT,
      }),
      trump: base.trump,
      levelRank: base.levelRank,
      forcedNT: base.forcedNT,
      config: base.config,
    }
    const seat = (seatToPlay(base) ?? 0) as Seat
    const hand = base.hands[seat] as readonly Card[]
    const cands = enumeratePlays(hand, ctx, { kind: 'lead' }, 10)
    expect(cands.length).toBeGreaterThan(0)

    for (const level of [0, 1, 2] as const) {
      const d = decide(
        {
          seat,
          hand,
          ctx,
          play: { kind: 'lead' },
          currentWinner: null,
          partnerLeading: false,
          opponents: [],
        },
        level,
        mulberry32(1),
      )
      expect(d.cards.length, `L${level} 必须有出牌`).toBeGreaterThan(0)
      const r = checkPlay({ hand, cards: d.cards, ctx, opponents: [] })
      expect(r.ok, `L${level} 出的牌必须合法`).toBe(true)
    }
  })

  it('analyze 能识别对子', () => {
    const power = buildPowerTable({ mode: 0, levelRank: 2, trump: 0 })
    const ctx = {
      power,
      trump: 0 as const,
      levelRank: 2 as const,
      forcedNT: false,
      config: DEFAULT_RULE_CONFIG,
    }
    const a = analyze([{ id: 1, value: 5 }, { id: 2, value: 5 }], ctx)
    expect(a.pairCount).toBe(1)
    expect(a.isMultiGroup).toBe(false)
  })
})
