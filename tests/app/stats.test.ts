/**
 * 战绩累计（`app/stats.ts`）
 *
 * 它是本项目**唯一的外部锚**：内部标定的分母只有我们自己，要判断"AI 打不打得过真人"
 * 只能靠真人对局累计。所以这里锁三件事：
 *   ① 一局只记一次（重进结算页不许重复记）
 *   ② 「我方赢」的判据（庄家队守住 / 闲家队上台）
 *   ③ 坏存档不能让面板崩
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettleResult } from '@core'
import { clearStats, getStats, initStats, recordRound, statsSummary } from '@app/stats'
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
  clearStats()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const settle = (o: Partial<SettleResult> = {}): SettleResult => ({
  defenderScore: 60,
  levelUpTeam: 0,
  levels: 1,
  actualLevels: 1,
  newLevels: { a: 3, b: 2 },
  dealerChanged: false,
  newDealer: 0,
  gameOver: false,
  ...o,
})

/** 造一个"刚结算"的状态（只填 stats.ts 会读的字段） */
const settled = (o: {
  dealer: 0 | 1 | 2 | 3
  round: number
  seed: number
  result: SettleResult
}): GameState =>
  ({
    ...emptyState(),
    dealer: o.dealer,
    round: o.round,
    seed: o.seed,
    phase: 'settle',
    lastSettle: o.result,
  }) as GameState

describe('stats · 记录', () => {
  it('我方是庄家队、守住 ⇒ 赢，且记下升级数', () => {
    recordRound(settled({ dealer: 0, round: 1, seed: 7, result: settle({ dealerChanged: false, actualLevels: 2 }) }))
    const r = getStats().rounds[0]!
    expect(r.win).toBe(true)
    expect(r.levelDelta).toBe(2)
  })

  it('我方是庄家队、被上台 ⇒ 输', () => {
    recordRound(settled({ dealer: 2, round: 1, seed: 7, result: settle({ dealerChanged: true }) }))
    expect(getStats().rounds[0]!.win).toBe(false)
  })

  it('我方是闲家队、上台 ⇒ 赢（不问升级数）', () => {
    recordRound(settled({ dealer: 1, round: 1, seed: 7, result: settle({ dealerChanged: true, actualLevels: 0 }) }))
    const r = getStats().rounds[0]!
    expect(r.win).toBe(true)
    expect(r.levelDelta).toBe(0)
  })

  it('我方是闲家队、没上台 ⇒ 输', () => {
    recordRound(settled({ dealer: 1, round: 1, seed: 7, result: settle({ dealerChanged: false }) }))
    expect(getStats().rounds[0]!.win).toBe(false)
  })

  it('同一局记两次只算一次（重进结算页不重复记）', () => {
    const s = settled({ dealer: 0, round: 3, seed: 99, result: settle() })
    recordRound(s)
    recordRound(s)
    recordRound(s)
    expect(getStats().rounds).toHaveLength(1)
  })

  it('不同局各记一条', () => {
    recordRound(settled({ dealer: 0, round: 1, seed: 99, result: settle() }))
    recordRound(settled({ dealer: 0, round: 2, seed: 100, result: settle() }))
    expect(getStats().rounds).toHaveLength(2)
  })

  it('没有 lastSettle 不记（比如读档进结算页）', () => {
    recordRound({ ...emptyState(), phase: 'settle', lastSettle: null } as GameState)
    expect(getStats().rounds).toHaveLength(0)
  })
})

describe('stats · 汇总', () => {
  it('没有记录时返回 null（面板据此不显示那一行）', () => {
    expect(statsSummary()).toBeNull()
  })

  it('胜率 / 场均 / 近 N 局都算对', () => {
    // 3 胜 2 负，闲家得分 40/120/60/80/100
    const rows: [boolean, number][] = [
      [true, 40],
      [false, 120],
      [true, 60],
      [false, 80],
      [true, 100],
    ]
    rows.forEach(([win, score], i) => {
      recordRound(
        settled({
          // 我方恒为庄家队（座位 0）：守住 = 胜，被上台 = 负
          dealer: 0,
          round: i + 1,
          seed: 500 + i,
          result: settle({ dealerChanged: !win, defenderScore: score }),
        }),
      )
    })
    const s = statsSummary(2)!
    expect(s.total).toBe(5)
    expect(s.wins).toBe(3)
    expect(s.losses).toBe(2)
    expect(s.rate).toBeCloseTo(0.6)
    expect(s.avgScore).toBe(80)
    expect(s.recent).toEqual({ n: 2, wins: 1 })
  })
})

describe('stats · 存档健壮性', () => {
  it('坏 JSON 不崩，当成空', () => {
    store.setItem('tractor.stats.v1', '{不是 json')
    initStats()
    expect(getStats().rounds).toHaveLength(0)
  })

  it('混入脏记录时丢弃脏条目、保留好的', () => {
    store.setItem(
      'tractor.stats.v1',
      JSON.stringify({
        rounds: [
          { key: '1-1', ts: 1, defenderScore: 50, win: true, round: 1, dealer: 0, myTeam: 0, levelDelta: 1 },
          { key: 2, ts: 'x', win: 'yes' },
        ],
      }),
    )
    initStats()
    expect(getStats().rounds).toHaveLength(1)
  })

  it('写入能落到 storage（下次启动能读回来）', () => {
    recordRound(settled({ dealer: 0, round: 1, seed: 3, result: settle() }))
    initStats() // 模拟重启
    expect(getStats().rounds).toHaveLength(1)
  })
})
