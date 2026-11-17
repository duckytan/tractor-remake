/**
 * 对局存档：`lastSettle` 的字段级校验（KN-28）
 *
 * 背景：`loadStateDetailed` 文件头宣称「声明式字段校验 + 不合法整份丢弃」，
 * 数字字段要求 Number.isFinite、牌 id 全局唯一、config/pendingConfig 逐字段 boolean
 * （KN-27）—— 但 `lastSettle`（SettleResult | null）却经 `...o` 原样进入运行时，
 * 一个字段都没验。
 *
 * 这不是「类型不整洁」而是**崩溃 / 静默错局**：
 *   - `ui/render.ts :: settlePanel` 直接读 `r.newLevels.a` / `r.newLevels.b`：
 *     存档里 newLevels 是 null / 字符串 ⇒ TypeError ⇒ 结算页白屏；
 *   - `app/game.ts :: nextRound` 用 `settle.newLevels` / `settle.newDealer`
 *     作为下一局的级牌与庄家：newDealer=9 或 newLevels.a=99 ⇒ 下一局状态被污染；
 *   - `app/stats.ts` / `roundLog.ts` / `settleRecord.ts` 也读它的字段落库。
 *
 * 正常人写的存档不会产生坏值，但「声明式字段校验」的意义正是防篡改 / 防损坏档
 * （docs/33 C4-01、docs/38 G-1/G-3）—— 与 KN-27 同一条防线，这里漏了一格。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadStateDetailed } from '@app/persist'
import type { GameState } from '@app/state'
import { settlePanel } from '@ui/render'
import { newGame, reduce } from '@app/game'
import { DEFAULT_RULE_CONFIG } from '@core'
import type { Card, SettleResult } from '@core'
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

/** 一个已经进入结算阶段、其余字段全部合法的可恢复对局 */
const settleState = (seed: number): GameState => {
  let s = newGame(DEFAULT_RULE_CONFIG, 1, 420, seed)
  s = declareAndPass(s, 0)
  if (s.phase === 'bury') {
    const hand = s.hands[s.dealer] as readonly Card[]
    s = reduce(s, { type: 'bury', ids: hand.slice(0, 8).map((c) => c.id) })
  }
  return { ...s, phase: 'settle' }
}

/** 合法 SettleResult（各字段取值都在类型域内） */
const VALID_SETTLE: SettleResult = {
  defenderScore: 60,
  levelUpTeam: 0,
  levels: 2,
  actualLevels: 2,
  newLevels: { a: 4, b: 2 },
  dealerChanged: false,
  newDealer: 2,
  gameOver: false,
}

/** 写入一份带指定 lastSettle 的结算存档并读回 */
function withSettle(lastSettle: unknown): ReturnType<typeof loadStateDetailed> {
  const s = settleState(41)
  store.setItem(KEY_STATE, JSON.stringify({ ...s, lastSettle }))
  return loadStateDetailed()
}

describe('对局存档：lastSettle 必须逐字段合法', () => {
  it('危害证据：坏 newLevels 一旦进运行时，结算页渲染直接抛异常', () => {
    // 证明「为什么必须拒」：把坏 lastSettle 塞进一个合法状态后，settlePanel 解引用
    // newLevels.a 会 TypeError（白屏）。修复后这类档在 loadStateDetailed 就被拦下。
    const good = withSettle(VALID_SETTLE).state!
    const poisoned = { ...good, lastSettle: { ...VALID_SETTLE, newLevels: null } } as unknown as GameState
    expect(() => settlePanel(poisoned)).toThrow()
    expect(withSettle({ ...VALID_SETTLE, newLevels: null }).state).toBeNull()
  })

  it('合法 lastSettle 往返：读回逐字段不变', () => {
    const r = withSettle(VALID_SETTLE)
    expect(r.state).not.toBeNull()
    expect(r.issue).toBeNull()
    expect(r.state!.lastSettle).toEqual(VALID_SETTLE)
  })

  it('play 阶段 lastSettle = null 合法', () => {
    const s = newGame(DEFAULT_RULE_CONFIG, 1, 420, 41)
    let p = declareAndPass(s, 0)
    if (p.phase === 'bury') {
      const hand = p.hands[p.dealer] as readonly Card[]
      p = reduce(p, { type: 'bury', ids: hand.slice(0, 8).map((c) => c.id) })
    }
    store.setItem(KEY_STATE, JSON.stringify(p))
    expect(loadStateDetailed().state).not.toBeNull()
  })

  const REQUIRED_BAD: readonly [string, unknown][] = [
    ['整体字符串', 'garbage'],
    ['整体 null（结算页无结算结果）', null],
    ['defenderScore 字符串', { ...VALID_SETTLE, defenderScore: '60' }],
    ['levels NaN（JSON 里 null）', { ...VALID_SETTLE, levels: null }],
    ['actualLevels 负数', { ...VALID_SETTLE, actualLevels: -1 }],
    ['levelUpTeam = 2', { ...VALID_SETTLE, levelUpTeam: 2 }],
    ['newLevels 缺字段', { ...VALID_SETTLE, newLevels: { a: 4 } }],
    ['newLevels.a = 99（非法级牌）', { ...VALID_SETTLE, newLevels: { a: 99, b: 2 } }],
    ['newDealer = 9（非法座位）', { ...VALID_SETTLE, newDealer: 9 }],
    ['dealerChanged 字符串', { ...VALID_SETTLE, dealerChanged: 'false' }],
    ['gameOver 数字', { ...VALID_SETTLE, gameOver: 1 }],
  ]
  for (const [label, val] of REQUIRED_BAD) {
    it(`${label} ⇒ 整份丢弃`, () => {
      const r = withSettle(val)
      expect(r.state, label).toBeNull()
      expect(r.issue).toBe('corrupt')
    })
  }

  it('可选字段 winnerTeam / guardLevel：缺省合法，出现时也必须合法', () => {
    expect(withSettle({ ...VALID_SETTLE }).state).not.toBeNull()
    expect(withSettle({ ...VALID_SETTLE, winnerTeam: 1, guardLevel: 5 }).state).not.toBeNull()
    expect(withSettle({ ...VALID_SETTLE, winnerTeam: 9 }).state).toBeNull()
    expect(withSettle({ ...VALID_SETTLE, guardLevel: 99 }).state).toBeNull()
  })
})
