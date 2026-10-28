/**
 * 对局数据记录（`app/roundLog.ts`）
 *
 * 它记录的是「复盘 + 分析」用的完整数据：开局四家手牌、每墩出牌、结算、
 * 以及**你的每个出牌决策 vs 同局面 AI 会出的牌**（影子决策）。
 *
 * 这里锁四件事：
 *   ① 开局快照必须抓到**出牌前**的手牌（再晚就出过牌了，复盘看不到原始手牌）
 *   ② 影子决策与「有没有看提示」要记对（这是分析"你和 AI 差在哪"的唯一依据）
 *   ③ 一局只落一条（幂等），且快照与结算**对不上时宁可丢弃**也不写错位数据
 *   ④ 导出结构稳定（牌用 value 整数，附编码说明）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Card, SettleResult } from '@core'
import {
  beginRound,
  clearRoundLogs,
  exportRounds,
  finishRound,
  initRoundLog,
  loggedRounds,
  logSummary,
  noteHumanPlay,
} from '@app/roundLog'
import type { GameState } from '@app/state'
import { emptyState } from '@app/state'

class MemoryStorage {
  private readonly map = new Map<string, string>()
  getItem(k: string): string | null {
    return this.map.get(k) ?? null
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v)
  }
  removeItem(k: string): void {
    this.map.delete(k)
  }
}

let store: MemoryStorage
beforeEach(() => {
  store = new MemoryStorage()
  vi.stubGlobal('localStorage', store)
  clearRoundLogs()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const card = (v: number): Card => ({ id: v * 2, value: v })
const cards = (...vs: number[]): Card[] => vs.map(card)

const settle = (o: Partial<SettleResult> = {}): SettleResult => ({
  defenderScore: 75,
  levelUpTeam: 1,
  levels: 1,
  actualLevels: 1,
  newLevels: { a: 2, b: 3 },
  dealerChanged: true,
  newDealer: 1,
  gameOver: false,
  ...o,
})

/** 造一个「刚进 play」的状态：四家手牌各 3 张，便于断言 */
const atPlay = (o: { seed?: number; round?: number } = {}): GameState =>
  ({
    ...emptyState(),
    phase: 'play',
    seed: o.seed ?? 11,
    round: o.round ?? 1,
    dealer: 1,
    levelRank: 2,
    trump: 2,
    hands: [cards(0, 1, 2), cards(13, 14, 15), cards(26, 27, 28), cards(39, 40, 41)],
    bottom: cards(52, 53),
    aiLevelPartner: 3,
    aiLevelOpponent: 3,
    autoLevel: 2,
    aiPeekHands: true,
    hintStyle: 'safe',
  }) as GameState

const atSettle = (s: GameState, result: SettleResult = settle()): GameState =>
  ({
    ...s,
    phase: 'settle',
    lastSettle: result,
    history: [
      { leader: 1, plays: [{ seat: 1, cards: cards(13) }, { seat: 2, cards: cards(26) }], winner: 1, score: 0 },
    ],
  }) as GameState

describe('roundLog · 开局快照', () => {
  it('抓到出牌前的手牌与底牌', () => {
    const s = atPlay()
    beginRound(s)
    finishRound(atSettle(s))
    const r = loggedRounds()[0]!
    expect(r.hands[0]).toEqual([0, 1, 2])
    expect(r.hands[2]).toEqual([26, 27, 28])
    expect(r.bottom).toEqual([52, 53])
    expect(r.seed).toBe(11)
    expect(r.dealer).toBe(1)
    expect(r.trump).toBe(2)
  })

  it('记下当时的 AI 配置（将来复盘要知道"这局是按什么设置打的"）', () => {
    const s = atPlay()
    beginRound(s)
    finishRound(atSettle(s))
    const r = loggedRounds()[0]!
    expect(r.ai).toEqual({ partner: 3, opponent: 3, auto: 2, peek: true, hintStyle: 'safe' })
  })
})

describe('roundLog · 人类决策（影子对比）', () => {
  it('记下实际出的牌、AI 建议、是否看过提示', () => {
    const s = atPlay()
    beginRound(s)
    noteHumanPlay(s, cards(0), cards(1), true)
    finishRound(atSettle(s))
    const h = loggedRounds()[0]!.human
    expect(h).toHaveLength(1)
    expect(h[0]).toEqual({ trick: 0, cards: [0], ai: [1], hint: true })
  })

  it('没看提示时 hint = false', () => {
    const s = atPlay()
    beginRound(s)
    noteHumanPlay(s, cards(0), cards(1), false)
    finishRound(atSettle(s))
    expect(loggedRounds()[0]!.human[0]!.hint).toBe(false)
  })

  it('trick 记的是「出牌前已打完的墩数」', () => {
    const s = atPlay()
    beginRound(s)
    const before = { ...s, history: [{ leader: 0, plays: [], winner: 0, score: 0 }] } as GameState
    noteHumanPlay(before, cards(0), cards(0), false)
    finishRound(atSettle(s))
    expect(loggedRounds()[0]!.human[0]!.trick).toBe(1)
  })

  it('没有开局快照时不记人类决策（拿不到局面）', () => {
    noteHumanPlay(atPlay(), cards(0), cards(1), false)
    expect(loggedRounds()).toHaveLength(0)
  })
})

describe('roundLog · 落库与幂等', () => {
  it('一局只落一条', () => {
    const s = atPlay()
    beginRound(s)
    finishRound(atSettle(s))
    finishRound(atSettle(s))
    expect(loggedRounds()).toHaveLength(1)
  })

  it('快照与结算对不上（seed/round 变了）⇒ 丢掉快照，但这一局仍记（缺手牌）', () => {
    beginRound(atPlay({ seed: 11, round: 1 }))
    finishRound(atSettle(atPlay({ seed: 99, round: 2 })))
    const r = loggedRounds()[0]!
    expect(r.seed).toBe(99) // 记的是结算那一局
    expect(r.hands).toEqual([]) // 手牌来自旧快照 ⇒ 不能挂上去
  })

  it('中途刷新（没有快照）也能记下这一局：每墩 + 结算仍在', () => {
    finishRound(atSettle(atPlay()))
    const r = loggedRounds()[0]!
    expect(r.hands).toEqual([])
    expect(r.tricks).toHaveLength(1)
    expect(r.settle.defenderScore).toBe(75)
  })

  it('没有 lastSettle 不记', () => {
    const s = atPlay()
    beginRound(s)
    finishRound({ ...s, lastSettle: null } as GameState)
    expect(loggedRounds()).toHaveLength(0)
  })

  it('每墩出牌按顺序记下来（复盘要用）', () => {
    const s = atPlay()
    beginRound(s)
    finishRound(atSettle(s))
    const t = loggedRounds()[0]!.tricks[0]!
    expect(t.leader).toBe(1)
    expect(t.plays).toEqual([
      [1, [13]],
      [2, [26]],
    ])
    expect(t.winner).toBe(1)
  })

  it('只保留最近 30 局', () => {
    for (let i = 0; i < 35; i++) {
      const s = atPlay({ seed: 100 + i, round: i + 1 })
      beginRound(s)
      finishRound(atSettle(s))
    }
    expect(logSummary().rounds).toBe(30)
    // 留下的是最后 30 局：第一局的 seed 应为 105
    expect(loggedRounds()[0]!.seed).toBe(105)
  })

  it('落盘后能读回来（模拟重启）', () => {
    const s = atPlay()
    beginRound(s)
    finishRound(atSettle(s))
    initRoundLog()
    expect(loggedRounds()).toHaveLength(1)
  })

  it('坏 JSON 不崩，当成空', () => {
    store.setItem('tractor.logs.v1', '坏数据{')
    initRoundLog()
    expect(loggedRounds()).toHaveLength(0)
  })
})

describe('roundLog · 导出', () => {
  it('结构稳定、带编码说明', () => {
    const s = atPlay()
    beginRound(s)
    finishRound(atSettle(s))
    const o = JSON.parse(exportRounds()) as {
      app: string
      version: string
      note: string
      rounds: { hands: number[][] }[]
    }
    expect(o.app).toBe('tractor-remake')
    expect(o.version).toBeTruthy()
    expect(o.note).toContain('52小王')
    expect(o.rounds).toHaveLength(1)
    expect(o.rounds[0]!.hands).toHaveLength(4)
  })
})
