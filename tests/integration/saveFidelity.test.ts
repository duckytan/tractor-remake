/**
 * 存档往返保真：每步存档再读回，对局走向必须**完全不变**（v1.3.50）
 *
 * 为什么值得单独立一条：`persist.test.ts` 测的是「坏档不崩」，也就是**能不能恢复**；
 * 没有任何用例验证「恢复出来的状态和存进去的是不是同一个」。
 * 而存档里 40 多个字段只要漏一个（或读档时复位错一个），后果都是**静默改变对局**：
 * 不报错、不白屏，只是同一副牌打出来的结果不一样 —— 玩家完全无法察觉。
 *
 * 做法：同一 seed 打两遍，第二遍每走一步都 `saveState → loadState` 再继续。
 * 两遍的最终分数、墩数、级牌必须一致。
 *
 * **唯一允许的差异是 `revealed`**：它是发牌动画的播放进度（纯展示），
 * 读档时按「已发完」复位成人类手牌张数（`persist.ts` 的既有设计，见那里的注释）。
 * 这条差异单独断言，防止以后有人把它当成 bug「修」回去，也防止它被误当成新缺陷。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_RULE_CONFIG } from '@core'
import type { Card } from '@core'
import { aiCanAct, aiPlayFor, newGame, reduce } from '@app/game'
import { loadState, saveState } from '@app/persist'
import type { GameState } from '@app/state'
import { HUMAN_SEAT, seatToPlay } from '@app/state'
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

/** 读档必须原样保留的字段（`revealed` 除外，见文件头） */
const CORE_FIELDS: readonly (keyof GameState)[] = [
  'phase',
  'seed',
  'step',
  'round',
  'dealer',
  'levelRank',
  'trump',
  'trumpDeclarer',
  'trumpCount',
  'tricksDone',
  'defenderScore',
  'bottomScore',
  'guardBy',
  'forcedNT',
  'counterPending',
]

function step(st: GameState): GameState {
  if (st.phase === 'contract' && st.counterPending) return reduce(st, { type: 'passCounter' })
  if (st.phase === 'bury') {
    const hand = st.hands[st.dealer] as readonly Card[]
    return reduce(st, { type: 'bury', ids: hand.slice(0, 8).map((c) => c.id) })
  }
  if (st.phase !== 'play') return st
  const seat = seatToPlay(st)
  if (seat === null) return st
  return aiCanAct(st) ? reduce(st, { type: 'aiStep' }) : aiPlayFor(st, seat, 2)
}

const ids = (s: GameState): number[][] => s.hands.map((h) => h.map((c) => c.id))

/**
 * @param reload 是否每步都存档 + 读档
 * @returns 终局状态与「读档与原状态的差异清单」
 */
function run(seed: number, reload: boolean): { st: GameState; diffs: string[]; reloads: number } {
  let s = declareAndPass(newGame(DEFAULT_RULE_CONFIG, 2, 0, seed), 1)
  const diffs: string[] = []
  let reloads = 0
  for (let i = 0; i < 800; i++) {
    s = step(s)
    if (reload) {
      saveState(s)
      const back = loadState()
      if (back === null) {
        diffs.push(`第 ${i} 步读档失败（phase=${s.phase}）`)
        break
      }
      reloads++
      for (const k of CORE_FIELDS) {
        if (JSON.stringify(s[k]) !== JSON.stringify(back[k])) {
          diffs.push(`第 ${i} 步 ${String(k)}: ${JSON.stringify(s[k])} → ${JSON.stringify(back[k])}`)
        }
      }
      if (JSON.stringify(s.levels) !== JSON.stringify(back.levels)) diffs.push(`第 ${i} 步 levels`)
      if (JSON.stringify(ids(s)) !== JSON.stringify(ids(back))) diffs.push(`第 ${i} 步 hands`)
      if (JSON.stringify(s.bottom.map((c) => c.id)) !== JSON.stringify(back.bottom.map((c) => c.id))) {
        diffs.push(`第 ${i} 步 bottom`)
      }
      if (s.history.length !== back.history.length) diffs.push(`第 ${i} 步 history.length`)
      if (s.trick.plays.length !== back.trick.plays.length) diffs.push(`第 ${i} 步 trick.plays`)
      if (s.trick.leader !== back.trick.leader) diffs.push(`第 ${i} 步 trick.leader`)
      s = back
    }
    if (s.phase === 'settle' || s.phase === 'over') break
  }
  return { st: s, diffs, reloads }
}

let store: MemoryStorage
beforeEach(() => {
  store = new MemoryStorage()
  vi.stubGlobal('localStorage', store)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('存档往返保真', () => {
  it('每步存档再读回，最终分数 / 墩数 / 级牌与不中断的一局完全一致', () => {
    for (let seed = 1; seed <= 5; seed++) {
      const plain = run(seed, false)
      const bounced = run(seed, true)
      expect(bounced.diffs.slice(0, 5), `seed=${seed} 往返差异`).toEqual([])
      expect(bounced.reloads, `seed=${seed} 应当真的读档过`).toBeGreaterThan(10)
      expect(bounced.st.lastSettle?.defenderScore, `seed=${seed} 分数`).toBe(
        plain.st.lastSettle?.defenderScore,
      )
      expect(bounced.st.history.length, `seed=${seed} 墩数`).toBe(plain.st.history.length)
      expect(bounced.st.levels, `seed=${seed} 级牌`).toEqual(plain.st.levels)
      expect(bounced.st.phase, `seed=${seed} 阶段`).toBe(plain.st.phase)
    }
  })

  it('`revealed` 是唯一的差异：读档按「已发完」复位成人类手牌张数', () => {
    let s = declareAndPass(newGame(DEFAULT_RULE_CONFIG, 2, 0, 9), 1)
    s = step(s) // 进入 play
    saveState(s)
    const back = loadState()!
    // 存进去的是发牌进度（动画口径），读回来的是「满手牌」
    expect(back.revealed).toBe(back.hands[HUMAN_SEAT]!.length)
    expect(back.revealed).toBeGreaterThanOrEqual(back.hands[HUMAN_SEAT]!.length)
  })
})
