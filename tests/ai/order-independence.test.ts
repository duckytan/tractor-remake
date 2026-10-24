import { describe, expect, it } from 'vitest'
import { DEFAULT_RULE_CONFIG } from '@core'
import type { Card } from '@core'
import { aiPlayFor, newGame, reduce } from '@app/game'
import type { AiLevel } from '@ai/policy'
import type { GameState } from '@app/state'
import { seatToPlay } from '@app/state'
import { declareAndPass } from '../helpers/declare'

/**
 * AI 决策不得依赖「手牌在数组里的顺序」。
 *
 * 背景（docs/15 / CHANGELOG v1.3.4）：`sortHand` 是**展示排序**，但它直接改写
 * `GameState.hands` 的数组顺序；而 AI 的候选生成与并列取舍按遍历顺序走 ——
 * 于是「换一种展示排序」会连带改变 AI 决策。v1.3.0 把展示序换成红黑相间时，
 * L2 vs L1 的配对测量被打到 50.0%，测试从绿变红且原因极难定位。
 *
 * 修法：`aiPlayFor` 把 `sortByPowerDesc`（全序：牌力↓ → 牌值↑ → 卡 id↑）的副本
 * 交给 `decide`。这里**逐局校验每一个 AI 决策**：同一局面下手牌怎么打乱，
 * 出的牌都必须一模一样。
 *
 * 这个测试在修复前是**真的会红**的：seed=1 / L1 / 西家跟牌那一手，
 * 原顺序出 40、倒序出 41（同一门的两张相邻牌）。
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

/** 把某一家的手牌换个顺序（牌集合不变） */
function withHand(s: GameState, seat: number, order: (h: readonly Card[]) => readonly Card[]): GameState {
  return {
    ...s,
    hands: s.hands.map((h, i) => (i === seat ? order(h as readonly Card[]) : h)),
  }
}

/** 这一手出的牌（牌 id 升序，便于比较） */
const playedIds = (s: GameState): number[] => {
  const last = s.trick.plays[s.trick.plays.length - 1]
  return last ? last.cards.map((c) => c.id).sort((a, b) => a - b) : []
}

const orders: ((h: readonly Card[]) => readonly Card[])[] = [
  (h) => [...h].reverse(),
  (h) => [...h.filter((_, i) => i % 2 === 0), ...h.filter((_, i) => i % 2 === 1)],
  (h) => [...h.slice(5), ...h.slice(0, 5)],
]

describe('AI 决策与手牌数组顺序无关', () => {
  for (const level of [1, 2, 3] as AiLevel[]) {
    it(`L${level}：整局每一个 AI 决策，打乱手牌顺序后出牌不变`, () => {
      let s = playPhase(1)
      let checked = 0
      let guard = 0
      while (s.phase === 'play' && guard++ < 400) {
        const seat = seatToPlay(s)
        if (seat === null) break
        if (seat !== 0) {
          const base = playedIds(aiPlayFor(s, seat, level))
          for (const order of orders) {
            const permuted = playedIds(aiPlayFor(withHand(s, seat, order), seat, level))
            expect(permuted, `L${level} 第 ${s.trick.plays.length + 1} 张、座位 ${seat}`).toEqual(base)
          }
          checked += 1
        }
        s = aiPlayFor(s, seat, level)
      }
      // 真的走过不少决策，别因为一局早早结束而「假通过」
      expect(checked).toBeGreaterThan(30)
    })
  }
})
