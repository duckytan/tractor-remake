/**
 * 级牌推进的整局不变量（回归 v1.3.48 的「打王回卷」）
 *
 * 背景：`settleRound` 原先直接吃 `nextLevel` 的 18 → 2/3 循环口径，
 * 于是「已在打王的那队当闲家赢一局」会被打回 3 级 —— 攒到打王的进度被一局抹掉，
 * 而通关又要求「打王坐庄并赢下」，等于把终点级变成了负担。
 * 实测 200 副连打：修复前 134 次回卷 / 195 副能通关 / 平均 43.0 局；
 * 修复后 0 次 / 200 副 / 平均 32.2 局。
 *
 * 这里不测具体分数，只守住三条**与实现无关**的不变量：
 *   1. 任一队的级牌只进不退（打王不再回卷）
 *   2. 每局都能推进到 settle / over（不会卡在 play）
 *   3. 连打有限局数内一定通关（ADR-011 的终局条件可达）
 *
 * 局数刻意取小（12 副）：这套逻辑是纯函数，12 副已能覆盖 2→打王的全过程，
 * 再大只是重复采样，而全量测试要跑 40s 以上。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_RULE_CONFIG } from '@core'
import type { Card, LevelRank } from '@core'
import { aiCanAct, aiPlayFor, newGame, reduce } from '@app/game'
import type { GameState } from '@app/state'
import { seatToPlay } from '@app/state'
import { declareAndPass } from '../helpers/declare'

/** 级牌的真实先后顺序：2..K(13) < A(1) < 打王(18) */
const order = (lr: LevelRank): number => (lr === 18 ? 14 : lr === 1 ? 13 : lr)

/** 四家全由 AI 打完一局（人类座位也交给 AI，专测级牌机器） */
function playOne(s: GameState): GameState {
  let st = declareAndPass(s, 1)
  let guard = 0
  while (guard++ < 800) {
    if (st.phase === 'contract' && st.counterPending) {
      st = reduce(st, { type: 'passCounter' })
      continue
    }
    if (st.phase === 'bury') {
      const hand = st.hands[st.dealer] as readonly Card[]
      st = reduce(st, { type: 'bury', ids: hand.slice(0, 8).map((c) => c.id) })
      continue
    }
    if (st.phase !== 'play') break
    const seat = seatToPlay(st)
    if (seat === null) break
    st = aiCanAct(st) ? reduce(st, { type: 'aiStep' }) : aiPlayFor(st, seat, 2)
  }
  return st
}

describe('级牌推进 · 整局不变量', () => {
  it('12 副连打：级牌只进不退、每副都能结算、有限局数内通关', () => {
    for (let seed = 1; seed <= 12; seed++) {
      let s = newGame(DEFAULT_RULE_CONFIG, 2, 0, seed)
      let over = false
      for (let round = 0; round < 120; round++) {
        s = playOne(s)
        expect(s.phase, `seed=${seed} 第 ${round} 局卡在 ${s.phase}`).toMatch(/^(settle|over)$/)
        if (s.phase === 'over') {
          over = true
          break
        }
        const before = s.levels
        s = reduce(s, { type: 'nextRound' })
        const after = s.levels
        expect(order(after.a), `seed=${seed} 队A 级牌倒退 ${before.a}→${after.a}`).toBeGreaterThanOrEqual(
          order(before.a),
        )
        expect(order(after.b), `seed=${seed} 队B 级牌倒退 ${before.b}→${after.b}`).toBeGreaterThanOrEqual(
          order(before.b),
        )
      }
      expect(over, `seed=${seed} 120 局内没有通关`).toBe(true)
    }
  }, 120_000)
})
