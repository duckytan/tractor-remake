/**
 * 对局存档：`phase` ⇄ `trick.plays` 的**关系不变量**（KN-30）
 *
 * 背景：KN-27/28/29 把 config / lastSettle / roundLog 的**字段级**校验全部收口，
 * docs/15 §18 据此宣称「这条防线闭环」。但字段合法 ≠ 组合合法：
 * `loadStateDetailed` 只验 `trick.plays.length <= 4` 且每手 `{seat,cards}` 形状合法，
 * 再验 108 张守恒 + id 全局唯一 —— 却从不验「当前墩」是不是一个**合法的部分墩**。
 *
 * 危害（探针实测，见下方「危害证据」用例）：
 *   - 把一墩完整的 4 手牌搬进 `trick.plays`、从 history 删掉该墩、phase='play'：
 *     总数仍 108、id 不重复、字段全合法 ⇒ 旧校验放行。
 *   - 但 4 手已占满四个座位，`seatToPlay` 取末手下家（必然是已出过牌的座位），
 *     `playCards` 的「本墩已出过」防御把每一次出牌（人类 / AI）都拒掉，
 *     而 `resolveCurrentTrick` 只在 `plays.length === 4` 的**落子之后**才触发 —— 时机已过，
 *     于是 phase 永远停在 play ⇒ **整局卡死，只能重开**。
 *   - 座位重复 / 跳序的畸形墩同样通过旧校验，让 `seatToPlay` 算出错误的人。
 *
 * 合法不变量（与实现无关）：`play` 阶段的当前墩必是「从 leader 起、顺时针连续、
 * 座位互异、长度 0..3」的部分墩（第 4 手一落就结算并清空）；非 play 阶段当前墩必为空。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadStateDetailed } from '@app/persist'
import { seatToPlay } from '@app/state'
import type { GameState, TrickRecord } from '@app/state'
import { aiCanAct, aiPlayFor, newGame, reduce } from '@app/game'
import { DEFAULT_RULE_CONFIG } from '@core'
import type { Card, Seat } from '@core'
import { declareAndPass } from '../helpers/declare'

const KEY_STATE = 'tractor.state.v1'

class MemoryStorage {
  private readonly map = new Map<string, string>()
  getItem(key: string): string | null { return this.map.get(key) ?? null }
  setItem(key: string, value: string): void { this.map.set(key, value) }
  removeItem(key: string): void { this.map.delete(key) }
  clear(): void { this.map.clear() }
}

let store: MemoryStorage
beforeEach(() => {
  store = new MemoryStorage()
  vi.stubGlobal('localStorage', store)
})
afterEach(() => { vi.unstubAllGlobals() })

/** 推进到 phase='play'、`history` 已有完整墩、且当前墩为空（刚结算完一墩）的合法状态 */
function playStateWithEmptyTrick(seed: number): GameState {
  let s = newGame(DEFAULT_RULE_CONFIG, 1, 420, seed)
  s = declareAndPass(s, 1)
  let guard = 0
  while (guard++ < 800) {
    if (s.phase === 'bury') {
      const hand = s.hands[s.dealer] as readonly Card[]
      s = reduce(s, { type: 'bury', ids: hand.slice(0, 8).map((c) => c.id) })
      continue
    }
    if (s.phase !== 'play') break
    if (s.trick.plays.length === 0 && s.history.length >= 1) return s
    const seat = seatToPlay(s)
    if (seat === null) break
    s = aiCanAct(s) ? reduce(s, { type: 'aiStep' }) : aiPlayFor(s, seat, 2)
  }
  throw new Error(`seed=${seed} 没找到合法的空墩状态`)
}

/** 写入指定状态存档并读回 */
function withState(s: GameState): ReturnType<typeof loadStateDetailed> {
  store.setItem(KEY_STATE, JSON.stringify(s))
  return loadStateDetailed()
}

/**
 * 把 history 最后一墩整墩搬进当前墩，从 history 删除该墩。
 * 牌只是在两个数组间转移 ⇒ 总数 108、id 唯一、字段全合法，只有「关系」变了。
 */
function moveLastHistoryTrickToPlay(s: GameState, remapSeat?: (i: number, seat: Seat) => Seat): GameState {
  const rec = s.history[s.history.length - 1] as TrickRecord
  const plays = remapSeat ? rec.plays.map((p, i) => ({ ...p, seat: remapSeat(i, p.seat) })) : rec.plays
  return {
    ...s,
    phase: 'play',
    // TrickRecord.plays 无 analysis；这里故意构造缺字段的畸形当前墩来验证读档防线
    trick: { leader: rec.leader, plays, winner: null } as unknown as GameState['trick'],
    history: s.history.slice(0, -1),
  }
}

describe('对局存档：当前墩必须是合法的部分墩', () => {
  it('合法空墩往返：读回逐字段不变', () => {
    const s = playStateWithEmptyTrick(7)
    const r = withState(s)
    expect(r.state, r.issue ?? '').not.toBeNull()
    expect(r.issue).toBeNull()
    expect(r.state!.trick.plays.length).toBe(0)
    expect(r.state!.history.length).toBe(s.history.length)
  })

  it('危害已堵：塞满 4 手的篡改档在读档时就被拒（修复前会卡死整局）', () => {
    // 修复前的实测危害：4 手占满四座位 ⇒ seatToPlay 指向已出过牌的座位 ⇒
    // playCards 的「本墩已出过」防御拒绝每次出牌（人类/AI），而 resolveCurrentTrick
    // 只在「落第 4 手之后」触发、时机已过 ⇒ 推进 20 步 phase 仍停在 play、整局卡死。
    // 修复后这类档在 loadStateDetailed 就整份丢弃，根本进不了运行时。
    const s = playStateWithEmptyTrick(7)
    const poison = moveLastHistoryTrickToPlay(s)
    expect(withState(poison).state).toBeNull()
  })

  // 下面这些用例在修复前都应失败（坏档被放行）；修复后必须整份丢弃。
  it('phase=play 但当前墩已有 4 手 ⇒ 整份丢弃', () => {
    expect(withState(moveLastHistoryTrickToPlay(playStateWithEmptyTrick(7))).state).toBeNull()
  })

  it('当前墩座位重复（0/0/1/2）⇒ 整份丢弃', () => {
    const s = playStateWithEmptyTrick(9)
    const poison = moveLastHistoryTrickToPlay(s, (i) => (i < 2 ? 0 : i - 1) as 0 | 1 | 2 | 3)
    expect(withState(poison).state).toBeNull()
  })

  it('当前墩座位跳序（leader=0, plays=0/2/1/3）⇒ 整份丢弃', () => {
    const s = playStateWithEmptyTrick(11)
    const order: (0 | 1 | 2 | 3)[] = [0, 2, 1, 3]
    const poison = moveLastHistoryTrickToPlay(s, (i) => order[i]!)
    expect(withState(poison).state).toBeNull()
  })

  it('plays[0] 座位不等于 leader ⇒ 整份丢弃', () => {
    const s = playStateWithEmptyTrick(13)
    // 把 4 手整体往后错一位：{1,2,3,0}，leader 仍是 rec.leader
    const poison = moveLastHistoryTrickToPlay(s, (_i, seat) => ((seat + 1) % 4) as Seat)
    expect(withState(poison).state).toBeNull()
  })

  it('非 play 阶段（settle）当前墩非空 ⇒ 整份丢弃', () => {
    const s = playStateWithEmptyTrick(7)
    const rec = s.history[s.history.length - 1] as TrickRecord
    const poison: GameState = {
      ...s,
      phase: 'settle',
      lastSettle: {
        defenderScore: 60, levelUpTeam: 0, levels: 2, actualLevels: 2,
        newLevels: { a: 4, b: 2 }, dealerChanged: false, newDealer: 2, gameOver: false,
      },
      trick: { leader: rec.leader, plays: rec.plays.slice(0, 3), winner: rec.winner } as unknown as GameState['trick'],
      history: [...s.history.slice(0, -1), { ...rec, plays: rec.plays.slice(3) }],
    }
    expect(withState(poison).state).toBeNull()
  })
})
