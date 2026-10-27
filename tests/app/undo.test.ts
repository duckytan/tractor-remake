import { describe, it, expect } from 'vitest'
import { DEFAULT_RULE_CONFIG } from '@core'
import type { Card } from '@core'
import { aiPlayFor, newGame, reduce } from '@app/game'
import type { GameState } from '@app/state'
import { seatToPlay } from '@app/state'
import { canUndo, emptyUndo, popUndo, pushUndo, shouldPush, UNDO_LIMIT } from '@app/undo'
import type { UndoStore } from '@app/undo'
import { declareAndPass } from '../helpers/declare'

/**
 * 悔牌（undo）测试。
 *
 * 栈放在 main.ts 的模块作用域（不进 GameState），所以这里用一个
 * 迷你 harness 复刻 main.ts 的三条约定：
 *   ① 每次状态转移后按 `shouldPush` 压栈
 *   ② 撤销 = 弹栈 + 清 selected / hintIds / lastReject
 *   ③ `canUndo` 只在出牌阶段且栈非空时为真
 */

interface Harness {
  state: GameState
  store: UndoStore
}

function playPhase(seed: number): GameState {
  let s = newGame(DEFAULT_RULE_CONFIG, 1, 0, seed)
  s = declareAndPass(s, 0)
  if (s.phase === 'bury') {
    const hand = s.hands[s.dealer] as readonly Card[]
    s = reduce(s, { type: 'bury', ids: hand.slice(0, 8).map((c) => c.id) })
  }
  return s
}

function harness(seed: number): Harness {
  return { state: playPhase(seed), store: emptyUndo() }
}

/** 走一步（与 main.ts 的 step 同构） */
function step(h: Harness, next: GameState): void {
  if (shouldPush(h.state, next)) h.store = pushUndo(h.store, h.state)
  h.state = next
}

/** 让当前该出牌的那家出一手（AI 代打，保证合法） */
function playOne(h: Harness): void {
  const seat = seatToPlay(h.state)
  if (seat === null) return
  step(h, aiPlayFor(h.state, seat, 1))
}

/** 撤销一步（与 main.ts 的 undoMove 同构） */
function undo(h: Harness): boolean {
  if (!canUndo(h.state, h.store)) return false
  const { store, target } = popUndo(h.store)
  if (!target) return false
  h.store = store
  h.state = { ...target, selected: [], hintIds: [], lastReject: null }
  return true
}

const handIds = (s: GameState): number[][] => s.hands.map((h) => h.map((c) => c.id))

/** 一直出到「打完 n 墩」为止（第 4 张牌会立刻结算，所以按 tricksDone 判定） */
function playTricks(h: Harness, n: number): void {
  for (let i = 0; i < 400 && h.state.phase === 'play' && h.state.tricksDone < n; i++) playOne(h)
}

describe('悔牌 undo', () => {
  it('出一手后撤销 ⇒ 回到本墩开始（四家手牌全部恢复）', () => {
    const h = harness(11)
    expect(h.state.phase).toBe('play')
    // 本墩开始时（还没人出牌）四家手牌
    const atTrickStart = handIds(h.state)
    playOne(h)
    expect(h.state.trick.plays.length).toBe(1)
    expect(handIds(h.state)).not.toEqual(atTrickStart)

    expect(undo(h)).toBe(true)
    expect(h.state.trick.plays.length).toBe(0)
    expect(handIds(h.state)).toEqual(atTrickStart)
    expect(h.state.selected).toEqual([])
    expect(h.state.hintIds).toEqual([])
    expect(h.state.lastReject).toBeNull()
  })

  it('连撤两次 ⇒ 回到上一墩开始', () => {
    const h = harness(12)
    // 打完第一墩（4 张），再出 1 张进入第二墩
    playTricks(h, 1)
    expect(h.state.trick.plays.length).toBe(0)
    expect(h.state.tricksDone).toBe(1)
    const trick2Start = handIds(h.state)
    playOne(h)
    expect(h.state.trick.plays.length).toBe(1)

    // 第一次撤销：回到第 2 墩开始
    expect(undo(h)).toBe(true)
    expect(h.state.tricksDone).toBe(1)
    expect(handIds(h.state)).toEqual(trick2Start)

    // 第二次撤销：第 2 墩还没出牌 ⇒ 退到第 1 墩开始
    expect(undo(h)).toBe(true)
    expect(h.state.tricksDone).toBe(0)
    expect(h.state.trick.plays.length).toBe(0)
    // 手牌变多（第 1 墩的牌全回来了）
    const total = h.state.hands.reduce((n, x) => n + x.length, 0)
    expect(total).toBe(100)
  })

  it('本墩已有 3 家出牌时撤销 ⇒ 三家 AI 的牌一起回退（用户反馈场景）', () => {
    const h = harness(15)
    // 推进到某一墩的第 3 家出完（人类是第 4 家）
    let guard = 0
    while (h.state.phase === 'play' && h.state.trick.plays.length !== 3 && guard++ < 400) playOne(h)
    expect(h.state.trick.plays.length).toBe(3)
    const totalBefore = h.state.hands.reduce((n, x) => n + x.length, 0)
    // **一手可能不止一张**（对子 / 拖拉机 / 甩牌），不能写死 +3。
    // v1.3.29 调了首出权重后 AI 出对子的比例上升，旧断言「+3 张」直接踩空。
    const cardsInTrick = h.state.trick.plays.reduce((n, p) => n + p.cards.length, 0)

    expect(undo(h)).toBe(true)
    // 本墩清空，且**三家 AI 已出的牌也回到各自手里**，不是只撤回人类那一手
    expect(h.state.trick.plays.length).toBe(0)
    const totalAfter = h.state.hands.reduce((n, x) => n + x.length, 0)
    expect(totalAfter).toBe(totalBefore + cardsInTrick)
  })

  it('栈空时撤销是 no-op', () => {
    const h = harness(13)
    expect(h.store.frames.length).toBe(0)
    expect(canUndo(h.state, h.store)).toBe(false)
    const before = h.state
    expect(undo(h)).toBe(false)
    expect(h.state).toBe(before)
  })

  it('埋底阶段不能悔牌（canUndo 为假）', () => {
    // 造一个 bury 阶段：让人类坐庄
    let s = newGame(DEFAULT_RULE_CONFIG, 1, 0, 21)
    s = declareAndPass(s, 0)
    if (s.phase !== 'bury') return // 该种子没轮到人类坐庄，跳过
    const store = pushUndo(emptyUndo(), s) // 即使栈里有东西也不该能悔
    expect(canUndo(s, store)).toBe(false)
    expect(undo({ state: s, store })).toBe(false)
  })

  it('栈深上限 20：超出后丢最旧的', () => {
    let store = emptyUndo()
    const s = playPhase(31)
    for (let i = 0; i < UNDO_LIMIT + 5; i++) store = pushUndo(store, s)
    expect(store.frames.length).toBe(UNDO_LIMIT)
  })

  it('只在一墩的第一张牌之前压栈（shouldPush）', () => {
    const h = harness(14)
    const start = h.state
    const afterFirst = aiPlayFor(start, seatToPlay(start) as 0 | 1 | 2 | 3, 1)
    expect(shouldPush(start, afterFirst)).toBe(true)
    // 同一墩的第 2 张不再压栈
    const afterSecond = aiPlayFor(afterFirst, seatToPlay(afterFirst) as 0 | 1 | 2 | 3, 1)
    expect(shouldPush(afterFirst, afterSecond)).toBe(false)
  })
})
