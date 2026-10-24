/**
 * 偏好设置存档的**迁移**测试（v1.2.2）。
 *
 * 背景：v1.2.2 把 `twoAsPermanent` 的默认值从 `false` 改成 `true`（对齐原版）。
 * 但 `main.ts` 的 `afterChange()` 每次状态变更都会把 `state.pendingConfig`
 * 整体写回 `tractor.prefs.v1`，而 `pendingConfig` 的初值又来自 `loadPrefs().ruleConfig`。
 * 所以老玩家浏览器里必然存着一份 `twoAsPermanent: false` —— 那是**旧默认值的镜像**，
 * 不是玩家的显式选择。不做迁移的话，升级后读到的仍是 `false`，看起来「默认值根本没改」。
 *
 * 迁移口径（见 `src/app/persist.ts` 的 `PREFS_VERSION` 注释）：
 *   - 旧档（无 `prefsVersion`）：`twoAsPermanent` 改用当前默认值，**其余字段照旧认存档**
 *   - 新档（带 `prefsVersion`）：完全尊重存档，玩家显式关掉的不许给他打开
 *
 * 这里用 `vi.stubGlobal` 注入一个内存版 localStorage —— vitest 默认跑 node 环境，
 * 没有 DOM，直接访问 `localStorage` 会 ReferenceError。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PREFS_VERSION, clearState, loadPrefs, loadState, savePrefs, saveState } from '@app/persist'
import { STATE_VERSION } from '@app/state'
import type { GameState } from '@app/state'
import { DEFAULT_RULE_CONFIG } from '@core'
import type { Card, RuleConfig } from '@core'
import { newGame, reduce } from '@app/game'
import { declareAndPass } from '../helpers/declare'

/** 存档 key，与 persist.ts 里的 `KEY_PREFS` 保持一致 */
const KEY_PREFS = 'tractor.prefs.v1'

/** 只实现 persist.ts 用到的那几个方法（getItem / setItem / removeItem） */
class MemoryStorage {
  private readonly map = new Map<string, string>()

  getItem(key: string): string | null {
    return this.map.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value)
  }

  removeItem(key: string): void {
    this.map.delete(key)
  }

  clear(): void {
    this.map.clear()
  }
}

let store: MemoryStorage

beforeEach(() => {
  store = new MemoryStorage()
  vi.stubGlobal('localStorage', store)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * 「v1.2.2 之前的存档」长什么样：没有 `prefsVersion`，`twoAsPermanent` 是旧默认 `false`。
 *
 * 刻意把 `allowCounterNT` 设成 `true`（与默认值相反）—— 用来证明迁移**只动
 * `twoAsPermanent` 一个字段**，玩家真正调过的开关不会被顺手覆盖。
 */
const legacyRuleConfig: RuleConfig = {
  allowSelfCounter: true,
  twoAsPermanent: false,
  allowPartnerGuard: true,
  allowCounterNT: true,
  guardScoreLevels: true,
  guardJack: false,
  guardAce: true,
  guardKingLevel: true,
}

describe('偏好设置迁移：twoAsPermanent 默认值 false → true', () => {
  it('旧档（无 prefsVersion）⇒ 一次性改用新默认 true，其余开关原样保留', () => {
    store.setItem(KEY_PREFS, JSON.stringify({ ruleConfig: legacyRuleConfig }))

    const p = loadPrefs()
    expect(p.ruleConfig.twoAsPermanent).toBe(true)
    // 只迁移一个字段：玩家把「允许反无将」开着，就必须还是开着
    expect(p.ruleConfig.allowCounterNT).toBe(true)
    expect(p.ruleConfig.allowSelfCounter).toBe(true)
    expect(p.ruleConfig.allowPartnerGuard).toBe(true)
    // 最强的一条：guardJack 的存档值是 false，而**默认值是 true**。
    // 若迁移顺手把整个 ruleConfig 换成默认值，这条就会变 true —— 它是「其余字段照旧认存档」的唯一硬证据
    // （上面三个恰好都等于默认值 true，单独看证明不了什么）。
    expect(p.ruleConfig.guardJack).toBe(false)
  })

  it('新档（prefsVersion = 当前版本）⇒ 尊重玩家显式关掉的 false', () => {
    store.setItem(
      KEY_PREFS,
      JSON.stringify({ prefsVersion: PREFS_VERSION, ruleConfig: legacyRuleConfig }),
    )

    expect(loadPrefs().ruleConfig.twoAsPermanent).toBe(false)
  })

  it('迁移只发生一次：savePrefs 会打上版本号，玩家之后再关掉就一直是关的', () => {
    store.setItem(KEY_PREFS, JSON.stringify({ ruleConfig: legacyRuleConfig }))

    // ① 旧档读出来 ⇒ 迁移成 true
    const migrated = loadPrefs()
    expect(migrated.ruleConfig.twoAsPermanent).toBe(true)

    // ② 写回（模拟 main.ts 的 afterChange）—— 必须带上版本号，
    //    否则下次读档又会被当成旧档再迁移一次，玩家永远关不掉这个开关
    savePrefs(migrated)
    expect(loadPrefs().ruleConfig.twoAsPermanent).toBe(true)

    // ③ 玩家在设置里显式关掉 ⇒ 之后再读必须还是 false
    savePrefs({ ...migrated, ruleConfig: { ...migrated.ruleConfig, twoAsPermanent: false } })
    expect(loadPrefs().ruleConfig.twoAsPermanent).toBe(false)
  })
})

describe('偏好设置：动画速度档位（v1.3.8）', () => {
  it('老档没有 animSpeed 字段 ⇒ 默认「中」', () => {
    store.setItem(KEY_PREFS, JSON.stringify({ ruleConfig: legacyRuleConfig }))
    expect(loadPrefs().animSpeed).toBe('normal')
  })

  it('存档里的 slow / fast 会被尊重，非法值回落「中」', () => {
    savePrefs({ ...loadPrefs(), animSpeed: 'slow' })
    expect(loadPrefs().animSpeed).toBe('slow')
    savePrefs({ ...loadPrefs(), animSpeed: 'fast' })
    expect(loadPrefs().animSpeed).toBe('fast')
    store.setItem(KEY_PREFS, JSON.stringify({ prefsVersion: PREFS_VERSION, animSpeed: 'turbo' }))
    expect(loadPrefs().animSpeed).toBe('normal')
  })
})

describe('对局存档：loadState / saveState / clearState', () => {
  /** 造一个可恢复的对局（contract 阶段故意不恢复，所以必须打到 play） */
  const playState = (seed: number) => {
    let s = newGame(DEFAULT_RULE_CONFIG, 1, 420, seed)
    s = declareAndPass(s, 0)
    if (s.phase === 'bury') {
      const hand = s.hands[s.dealer] as readonly Card[]
      s = reduce(s, { type: 'bury', ids: hand.slice(0, 8).map((c) => c.id) })
    }
    return s
  }

  it('存 → 读：手牌 / 阶段 / 墩数原样回来', () => {
    const s = playState(31)
    saveState(s)
    const back = loadState()
    expect(back).not.toBeNull()
    expect(back?.phase).toBe(s.phase)
    expect(back?.hands.map((h) => h.length)).toEqual(s.hands.map((h) => h.length))
    expect(back?.seed).toBe(s.seed)
  })

  it('定主阶段不恢复（否则亮主按钮全灰、把玩家锁死在定主界面）', () => {
    const s = newGame(DEFAULT_RULE_CONFIG, 1, 420, 32)
    expect(s.phase).toBe('contract')
    saveState(s)
    expect(loadState()).toBeNull()
  })

  it('版本号不匹配 ⇒ null', () => {
    const s = playState(33)
    saveState({ ...s, version: STATE_VERSION - 1 })
    expect(loadState()).toBeNull()
  })

  it('hands 形状不对 ⇒ null', () => {
    const s = playState(34)
    saveState({ ...s, hands: [] })
    expect(loadState()).toBeNull()
    saveState({ ...s, hands: 'nope' as unknown as GameState['hands'] })
    expect(loadState()).toBeNull()
  })

  it('JSON 损坏 ⇒ null（不能让游戏起不来）', () => {
    store.setItem('tractor.state.v1', '{oops')
    expect(loadState()).toBeNull()
  })

  it('瞬时字段不跨会话恢复：hintIds 清空、revealed 补满、发牌提示复位', () => {
    const s = playState(35)
    saveState({
      ...s,
      hintIds: [1, 2],
      revealed: 3,
      declarePrompted: false,
      dealPrompt: true,
    })
    const back = loadState()
    expect(back?.hintIds).toEqual([])
    expect(back?.revealed).toBe((s.hands[0] as readonly Card[]).length)
    expect(back?.declarePrompted).toBe(true)
    expect(back?.dealPrompt).toBe(false)
  })

  it('clearState 清掉存档', () => {
    saveState(playState(36))
    clearState()
    expect(loadState()).toBeNull()
  })

  it('存储抛异常时读写都不崩（隐私模式）', () => {
    const boom = {
      getItem() {
        throw new Error('denied')
      },
      setItem() {
        throw new Error('denied')
      },
      removeItem() {
        throw new Error('denied')
      },
    }
    vi.stubGlobal('localStorage', boom)
    expect(() => saveState(playState(37))).not.toThrow()
    expect(loadState()).toBeNull()
    expect(() => clearState()).not.toThrow()
  })
})
