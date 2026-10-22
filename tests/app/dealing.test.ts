import { describe, expect, it } from 'vitest'
import { DEFAULT_RULE_CONFIG, makeDeck } from '@core'
import type { Card } from '@core'
import { reduce, startRound } from '@app/game'
import { emptyState } from '@app/state'
import type { GameState } from '@app/state'

/**
 * 逐张发牌 + 摸到级牌时暂停抢亮。
 *
 * 设计要点：`hands` 里始终是完整手牌，`revealed` 只是**展示进度**，
 * 所以规则判定与已有测试完全不受影响。
 * 中途提示有 10 张的门槛（少于 10 张信息不足，先不打断）。
 */

const LV = 3 // 级牌 3 ⇒ rank 下标 1
const LV_RANK = 1
const HEART3 = 1 * 13 + LV_RANK // ♥3 的牌值

/** 造一副人类 25 张、按发牌顺序排列的手牌；`heart3At` 指定 ♥3 落在第几张（1 基），null = 没有级牌 */
function handWith(heart3At: number | null): Card[] {
  const all = makeDeck()
  const nonLevel = all.filter((c) => c.value % 13 !== LV_RANK)
  if (heart3At === null) return nonLevel.slice(0, 25)
  const heart3 = all.find((c) => c.value === HEART3) as Card
  const i = heart3At - 1
  return [...nonLevel.slice(0, i), heart3, ...nonLevel.slice(i, 24)]
}

function base(heart3At: number | null = 13): GameState {
  return {
    ...emptyState(),
    phase: 'contract',
    dealer: 1,
    levelRank: LV,
    levels: { a: LV, b: LV },
    config: DEFAULT_RULE_CONFIG,
    hands: [handWith(heart3At), [], [], []],
    bottom: [],
    revealed: 0,
    declarePrompted: false,
    dealPrompt: false,
    declareOptions: [],
  }
}

const tick = (s: GameState): GameState => reduce(s, { type: 'revealTick' })

describe('逐张发牌', () => {
  it('发到 ♥3 之前不暂停', () => {
    let s = base(13)
    for (let i = 0; i < 12; i++) s = tick(s)
    expect(s.revealed).toBe(12)
    expect(s.dealPrompt).toBe(false)
    expect(s.declareOptions).toEqual([])
  })

  it('摸到级牌那一张时暂停，并给出可亮的花色', () => {
    let s = base(13)
    for (let i = 0; i < 13; i++) s = tick(s)
    expect(s.revealed).toBe(13)
    expect(s.dealPrompt).toBe(true)
    expect(s.declareOptions).toEqual([1]) // 只有 ♥
  })

  it('级牌很早就摸到时，也要等发够 10 张才问（信息不足不打断）', () => {
    let s = base(2) // 第 2 张就是 ♥3
    for (let i = 0; i < 9; i++) s = tick(s)
    expect(s.revealed).toBe(9)
    expect(s.dealPrompt).toBe(false) // 还没到 10 张
    s = tick(s) // 第 10 张
    expect(s.revealed).toBe(10)
    expect(s.dealPrompt).toBe(true)
  })

  it('暂停期间继续 tick 不会推进发牌', () => {
    let s = base(13)
    for (let i = 0; i < 13; i++) s = tick(s)
    const after = tick(s)
    expect(after.revealed).toBe(13)
    expect(after.dealPrompt).toBe(true)
  })

  it('「继续发牌」后恢复，发完自动给出完整选项（含无将）', () => {
    let s = base(13)
    for (let i = 0; i < 13; i++) s = tick(s)
    s = reduce(s, { type: 'passDeal' })
    expect(s.dealPrompt).toBe(false)
    expect(s.declareOptions).toEqual([])

    while (s.revealed < 25) s = tick(s)
    expect(s.revealed).toBe(25)
    expect(s.declareOptions).toContain('NT')
  })

  it('发牌中途亮主 ⇒ 立即补满手牌并进入定约', () => {
    let s = base(13)
    for (let i = 0; i < 13; i++) s = tick(s)
    const after = reduce(s, { type: 'declareTrump', trump: 1 })
    expect(after.trump).toBe(1)
    expect(after.revealed).toBeGreaterThanOrEqual(25) // 补满，不再逐张
    expect(after.dealPrompt).toBe(false)
  })

  it('一直没摸到级牌 ⇒ 发完后只剩无将可选', () => {
    let s = base(null)
    while (s.revealed < 25) s = tick(s)
    expect(s.dealPrompt).toBe(false)
    expect(s.declareOptions).toEqual(['NT'])
  })

  it('关闭动画开关 ⇒ 直接发满，不做逐张', () => {
    const s = startRound({ ...emptyState(), animation: false }, 42)
    expect(s.phase).toBe('contract')
    expect(s.revealed).toBe(25)
    expect(s.dealPrompt).toBe(false)
  })

  it('开启动画 ⇒ 从 0 张开始，且 hands 仍是完整的 25 张', () => {
    const s = startRound({ ...emptyState(), animation: true }, 42)
    expect(s.revealed).toBe(0)
    expect((s.hands[0] as readonly Card[]).length).toBe(25)
  })
})
