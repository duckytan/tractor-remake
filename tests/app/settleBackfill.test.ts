/**
 * 结算落库的**刷新路径**（回归 v1.3.50）
 *
 * 缺陷：战绩 / 复盘只在 `phase` **跳变**时记录，而刷新会直接落在结算页 ——
 * 没有任何跳变，于是这一局永远不会进战绩与复盘导出。
 * 这条路径最容易被「打 20~30 局再导出」（docs/44 §4）撞上：结算页正是最常见的离开时机。
 *
 * 这里锁三件事：
 *   ① 刷新落在结算页时，`stats` / `roundLog` 里确实**还没有**这一局（复现缺陷的前提）
 *   ② `backfillSettled` 能把它补上，且字段正确（分数 / 胜负 / 墩数）
 *   ③ 补记是幂等的（反复刷新、`over` 与 `settle` 各来一次都只记一条）
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_RULE_CONFIG } from '@core'
import type { Card } from '@core'
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

/** 四家全交给 AI 打完一局，停在 settle */
function playToSettle(seed: number): GameState {
  let s = declareAndPass(newGame(DEFAULT_RULE_CONFIG, 2, 0, seed), 1)
  for (let i = 0; i < 800; i++) {
    if (s.phase === 'settle' || s.phase === 'over') break
    if (s.phase === 'contract' && s.counterPending) {
      s = reduce(s, { type: 'passCounter' })
      continue
    }
    if (s.phase === 'bury') {
      const hand = s.hands[s.dealer] as readonly Card[]
      s = reduce(s, { type: 'bury', ids: hand.slice(0, 8).map((c) => c.id) })
      continue
    }
    const seat = seatToPlay(s)
    if (seat === null) break
    s = aiCanAct(s) ? reduce(s, { type: 'aiStep' }) : aiPlayFor(s, seat, 2)
  }
  return s
}

beforeEach(() => {
  store = new MemoryStorage()
  vi.stubGlobal('localStorage', store)
  clearStats()
  clearRoundLogs()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('结算落库 · 刷新路径', () => {
  it('刷新落在结算页：正常路径不会记，补记后才进战绩与复盘', () => {
    const settled = playToSettle(7)
    expect(settled.phase).toBe('settle')
    saveState(settled)

    // ---- 模拟刷新：模块缓存全部重建，只从 localStorage 恢复 ----
    clearStats()
    clearRoundLogs()
    initStats()
    initRoundLog()
    const restored = loadState()
    expect(restored, '结算页存档应当能恢复').not.toBeNull()
    expect(restored!.phase).toBe('settle')

    // 缺陷现场：恢复出来的这一局，战绩和复盘里都没有
    expect(getStats().rounds, '刷新前没有跳变 ⇒ 没人记过').toEqual([])
    expect(loggedRounds()).toEqual([])

    // ---- 补记 ----
    expect(backfillSettled(restored!)).toBe(true)
    const rounds = getStats().rounds
    expect(rounds).toHaveLength(1)
    expect(rounds[0]!.round).toBe(restored!.round)
    expect(rounds[0]!.defenderScore).toBe(restored!.lastSettle!.defenderScore)
    expect(rounds[0]!.key).toBe(`${restored!.seed}-${restored!.round}`)

    const logs = loggedRounds()
    expect(logs, '复盘也要补上').toHaveLength(1)
    expect(logs[0]!.settle.defenderScore).toBe(restored!.lastSettle!.defenderScore)
    // 墩数必须完整：刷新丢的是「开局快照」，不该连每墩出牌一起丢
    expect(logs[0]!.tricks.length).toBe(restored!.history.length)
    expect(logs[0]!.tricks.length).toBeGreaterThan(0)
    // 快照确实丢了（pending 是模块级状态）⇒ hands 为空是既定行为，记录在此防止误解
    expect(logs[0]!.hands).toEqual([])
  })

  it('反复刷新 / settle 与 over 都触发：只记一条', () => {
    const settled = playToSettle(11)
    saveState(settled)
    initStats()
    initRoundLog()

    const a = loadState()!
    backfillSettled(a)
    backfillSettled(a)
    const b = loadState()!
    backfillSettled(b)
    // over 阶段同样补记一次（幂等键相同）
    backfillSettled({ ...a, phase: 'over' })

    expect(getStats().rounds).toHaveLength(1)
    expect(loggedRounds()).toHaveLength(1)
  })

  it('不在结算页 / 没有结算数据时不动手', () => {
    const s = playToSettle(13)
    expect(backfillSettled({ ...s, phase: 'play' })).toBe(false)
    expect(backfillSettled({ ...s, lastSettle: null })).toBe(false)
    expect(getStats().rounds).toEqual([])
    expect(loggedRounds()).toEqual([])
  })

  it('正常路径与补记共用同一入口：recordSettled 幂等', () => {
    const s = playToSettle(17)
    recordSettled(s)
    recordSettled(s)
    expect(getStats().rounds).toHaveLength(1)
    expect(loggedRounds()).toHaveLength(1)
  })
})
