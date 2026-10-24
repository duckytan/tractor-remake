import { describe, expect, it } from 'vitest'
import { DEFAULT_RULE_CONFIG } from '@core'
import { newGame } from '@app/game'
import type { GameState } from '@app/state'
import { dealtCardsAt, dealtCardsFor, newBackIndex } from '@app/view'

/**
 * 发牌进度的展示口径（v1.3.15）。
 *
 * `GameState.hands` 从开局就是完整的，只有 `revealed` 在推进：
 * 每 tick 四家各得 1 张（前 25 tick），第 26 tick 起只有庄家再得 1 张（庄家 33 张）。
 * 人类手牌按它截断，AI 家的牌背也按它逐张长出来。
 */

const contract = (seed = 7): GameState => newGame(DEFAULT_RULE_CONFIG, 2, 0, seed)
const at = (s: GameState, revealed: number): GameState => ({ ...s, revealed })

describe('dealtCardsAt', () => {
  it('开局 0 tick ⇒ 谁都没牌背', () => {
    const s = contract()
    for (const seat of [0, 1, 2, 3] as const) expect(dealtCardsAt(s, seat, 0)).toBe(0)
  })

  it('第 10 tick ⇒ 四家各 10 张', () => {
    const s = contract()
    for (const seat of [0, 1, 2, 3] as const) expect(dealtCardsAt(s, seat, 10)).toBe(10)
  })

  it('第 25 tick ⇒ 四家各 25 张', () => {
    const s = contract()
    for (const seat of [0, 1, 2, 3] as const) expect(dealtCardsAt(s, seat, 25)).toBe(25)
  })

  it('第 26 tick 起只有庄家继续得牌（庄家 33 张）', () => {
    const s = contract()
    const dealer = s.dealer
    const other = ([0, 1, 2, 3] as const).find((x) => x !== dealer) as 0 | 1 | 2 | 3
    expect(dealtCardsAt(s, dealer, 30)).toBe(30)
    expect(dealtCardsAt(s, other, 30)).toBe(25)
    expect(dealtCardsAt(s, dealer, 33)).toBe(33)
    // 非庄家永远停在 25
    expect(dealtCardsAt(s, other, 33)).toBe(25)
  })

  it('出牌阶段 ⇒ 直接返回手牌张数（不再按进度截断）', () => {
    const s = contract()
    const played: GameState = { ...s, phase: 'play', revealed: 3 }
    for (const seat of [0, 1, 2, 3] as const) {
      expect(dealtCardsAt(played, seat, 3)).toBe((s.hands[seat] as readonly unknown[]).length)
    }
  })

  it('dealtCardsFor 等价于「用当前 revealed」', () => {
    const s = at(contract(), 12)
    for (const seat of [0, 1, 2, 3] as const) {
      expect(dealtCardsFor(s, seat)).toBe(dealtCardsAt(s, seat, 12))
    }
  })
})

describe('newBackIndex', () => {
  it('张数没增加 ⇒ -1（同一 tick 只发一张，不能重复飞）', () => {
    const s = at(contract(), 10)
    expect(newBackIndex(s, 1, 10, 10)).toBe(-1)
  })

  it('新增一张且 DOM 里确实多了 ⇒ 返回新那张的下标', () => {
    const s = at(contract(), 11)
    expect(newBackIndex(s, 1, 10, 11)).toBe(10)
  })

  it('牌背被布局上限截断（侧家最多 10 张）⇒ -1，不能把已显示的那张反复重飞', () => {
    const s = at(contract(), 12)
    // DOM 里只有 10 张（SIDE_SHOW 上限），实际应显示 12 张
    expect(newBackIndex(s, 1, 11, 10)).toBe(-1)
  })

  it('一张牌背都没有 ⇒ -1', () => {
    const s = at(contract(), 1)
    expect(newBackIndex(s, 2, 0, 0)).toBe(-1)
  })
})
