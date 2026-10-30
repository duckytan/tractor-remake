/**
 * 跨局一致性：战绩 / 复盘 / 级牌在**连打多局 + 中途刷新**下仍然自洽（v1.3.50）
 *
 * 为什么单测抓不到：`stats.test.ts` / `roundLog.test.ts` 都是「搭一个 `emptyState()` 手工塞
 * `lastSettle`」的单次口径 —— 它们验证的是**幂等键**，不是**跨局累积**。
 * 而 v1.3.48 的「打王回卷」、v1.3.50 的「结算页刷新丢一局」都是这类跨局缺陷：
 * 每一局单独看都对，连起来才错。
 *
 * 这里锁四条与实现无关的不变量：
 *   ① 打了几局，战绩与复盘就各有几条（不重不漏）
 *   ② 每条的 `(seed, round)` 唯一，且与当轮结算的分数一致
 *   ③ 中途刷新（存档 → 读档 → 补记）不改变上述两条
 *   ④ 级牌只进不退（跨局状态机的最基本保证）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_RULE_CONFIG } from '@core'
import type { Card, LevelRank } from '@core'
import { aiCanAct, aiPlayFor, newGame, reduce } from '@app/game'
import { loadState, saveState } from '@app/persist'
import { clearRoundLogs, initRoundLog, loggedRounds } from '@app/roundLog'
import { backfillSettled, recordSettled } from '@app/settleRecord'
import { clearStats, getStats, initStats } from '@app/stats'
import type { GameState } from '@app/state'
import { seatToPlay } from '@app/state'
import { declareAndPass } from '../helpers/declare'

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
  clearStats()
  clearRoundLogs()
  initStats()
  initRoundLog()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

/** 级牌的真实先后顺序：2..K(13) < A(1) < 打王(18) */
const order = (lr: LevelRank): number => (lr === 18 ? 14 : lr === 1 ? 13 : lr)

/** 四家全交给 AI 打完一局 */
function playOne(s: GameState): GameState {
  let st = declareAndPass(s, 1)
  for (let i = 0; i < 800; i++) {
    if (st.phase === 'settle' || st.phase === 'over') break
    if (st.phase === 'contract' && st.counterPending) {
      st = reduce(st, { type: 'passCounter' })
      continue
    }
    if (st.phase === 'bury') {
      const hand = st.hands[st.dealer] as readonly Card[]
      st = reduce(st, { type: 'bury', ids: hand.slice(0, 8).map((c) => c.id) })
      continue
    }
    const seat = seatToPlay(st)
    if (seat === null) break
    st = aiCanAct(st) ? reduce(st, { type: 'aiStep' }) : aiPlayFor(st, seat, 2)
  }
  return st
}

describe('跨局一致性 · 战绩 / 复盘 / 级牌', () => {
  it('连打 16 局（隔局模拟刷新）：条数不重不漏，分数与结算一致，级牌只进不退', () => {
    let s = newGame(DEFAULT_RULE_CONFIG, 2, 0, 101)
    let played = 0
    const seenKeys = new Set<string>()
    const prevLevels = { a: s.levels.a, b: s.levels.b }

    for (let i = 0; i < 16; i++) {
      s = playOne(s)
      expect(s.phase, `第 ${played + 1} 局没结算`).toMatch(/^(settle|over)$/)

      // 正常路径：phase 跳变时落库（与 main.ts 的 step 一致）
      recordSettled(s)
      played++
      saveState(s)

      // 隔局模拟一次「刷新」：模块缓存全部重建（**只从 localStorage 恢复**，不清库），
      // 再走启动补记 —— 幂等键相同，所以条数不该变化。
      if (played % 2 === 0) {
        initStats()
        initRoundLog()
        const back = loadState()
        expect(back, '结算页存档应当能恢复').not.toBeNull()
        expect(back!.phase).toBe(s.phase)
        backfillSettled(back!)
        s = back!
      }

      const rounds = getStats().rounds
      const logs = loggedRounds()
      expect(rounds.length, `第 ${played} 局后战绩条数`).toBe(played)
      expect(logs.length, `第 ${played} 局后复盘条数`).toBe(played)

      // 最后一条就是刚打完这局，分数必须与结算一致
      const last = rounds[rounds.length - 1]!
      expect(last.round).toBe(s.round)
      expect(last.defenderScore).toBe(s.lastSettle!.defenderScore)
      expect(logs[logs.length - 1]!.settle.defenderScore).toBe(s.lastSettle!.defenderScore)
      expect(seenKeys.has(last.key), `重复的幂等键 ${last.key}`).toBe(false)
      seenKeys.add(last.key)

      // 级牌只进不退
      expect(order(s.levels.a)).toBeGreaterThanOrEqual(order(prevLevels.a))
      expect(order(s.levels.b)).toBeGreaterThanOrEqual(order(prevLevels.b))
      prevLevels.a = s.levels.a
      prevLevels.b = s.levels.b

      if (s.phase === 'over') break
      s = reduce(s, { type: 'nextRound' })
      expect(s.phase, '下一局应当重新进入定主').toBe('contract')
      expect(s.round, '局数应当递增').toBe(played + 1)
    }

    expect(played, '至少打完 8 局').toBeGreaterThanOrEqual(8)
    // 每条战绩都能在复盘里找到对应的一局（两张表的口径必须一致）
    const keys = new Set(getStats().rounds.map((r) => r.key))
    for (const l of loggedRounds()) {
      expect(keys.has(`${l.seed}-${l.round}`), `复盘 ${l.seed}-${l.round} 在战绩里缺失`).toBe(true)
    }
  })
})
