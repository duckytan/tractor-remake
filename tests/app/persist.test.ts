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
import { PREFS_VERSION, clearState, loadPrefs, loadState, loadStateDetailed, savePrefs, saveState } from '@app/persist'
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

/**
 * v1.3.29：AI 档位默认「中」→「超强」的一次性迁移。
 *
 * 背景：残局搜索、甩牌、L3 精确判定**全都只在「超强」档生效**，
 * 而老存档里存的档位是 1（旧默认）。不迁移的话老玩家永远碰不到新能力 ——
 * 这正是「AI 太弱智」反馈和「L3 已经很强」事实对不上的原因。
 *
 * 与 `twoAsPermanent` 同一类取舍：档位 1 无法区分「旧默认镜像」与「显式选择」，
 * 按旧默认处理，玩家想调回去只要点一下。
 *
 * **同时锁住「分段迁移」**：v1.2.2 的规则迁移门槛是 `version < 2`，
 * 不能因为版本号升到 3 就对 v2 存档重跑一遍（那会把玩家显式关掉的规则开关又打开）。
 */
describe('偏好设置迁移：AI 档位 中 → 超强（v1.3.29）', () => {
  it('v2 存档里的「中」(1) ⇒ 迁移到「超强」(3)', () => {
    store.setItem(KEY_PREFS, JSON.stringify({ prefsVersion: 2, aiLevelPartner: 1, aiLevelOpponent: 1 }))
    const p = loadPrefs()
    expect(p.aiLevelPartner).toBe(3)
    expect(p.aiLevelOpponent).toBe(3)
  })

  it('v2 存档里的「强」(2) 不动 —— 只迁移「中」这一档', () => {
    store.setItem(KEY_PREFS, JSON.stringify({ prefsVersion: 2, aiLevelPartner: 2, aiLevelOpponent: 0 }))
    const p = loadPrefs()
    expect(p.aiLevelPartner).toBe(2)
    expect(p.aiLevelOpponent).toBe(0)
  })

  it('当前版本存档里的「中」(1) 被尊重（玩家显式选的不许改）', () => {
    store.setItem(
      KEY_PREFS,
      JSON.stringify({ prefsVersion: PREFS_VERSION, aiLevelPartner: 1, aiLevelOpponent: 1 }),
    )
    const p = loadPrefs()
    expect(p.aiLevelPartner).toBe(1)
    expect(p.aiLevelOpponent).toBe(1)
  })

  it('缺字段 ⇒ 回落到**当前默认档**（不是硬编码的旧默认 1）', () => {
    store.setItem(KEY_PREFS, JSON.stringify({ prefsVersion: PREFS_VERSION }))
    const p = loadPrefs()
    expect(p.aiLevelPartner).toBe(3)
    expect(p.aiLevelOpponent).toBe(3)
  })

  it('分段迁移：v2 存档的规则开关不会被 v1.2.2 的迁移重跑', () => {
    store.setItem(
      KEY_PREFS,
      JSON.stringify({
        prefsVersion: 2,
        aiLevelOpponent: 1,
        ruleConfig: { ...legacyRuleConfig, twoAsPermanent: false },
      }),
    )
    const p = loadPrefs()
    // 规则迁移门槛是 version < 2 ⇒ v2 存档的 false 必须原样保留
    expect(p.ruleConfig.twoAsPermanent).toBe(false)
    // 而档位迁移门槛是 version < 3 ⇒ 这里仍然生效
    expect(p.aiLevelOpponent).toBe(3)
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

  it('prefs 存档损坏 ⇒ 回落默认值（不能让游戏起不来）', () => {
    store.setItem('tractor.prefs.v1', '{broken')
    const p = loadPrefs()
    expect(p.showCounter).toBe(false)
    expect(p.animSpeed).toBe('normal')
  })

  it('savePrefs 在只读存储下不抛异常（隐私模式）', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem() {
        throw new Error('quota')
      },
      removeItem() {},
    })
    expect(() => savePrefs(loadPrefs())).not.toThrow()
  })

  /**
   * **v1.3.29 改了契约**（docs/33 C4-01、docs/35 F1）。
   *
   * 旧实现遇到 `hands: [null, [], [], []]` 会**静默补一个 revealed = HAND_SIZE**
   * 然后把坏状态放行 —— 结果是在渲染路径上炸（白屏），比拒绝更糟。
   * 现在改成「字段级校验，不合法整份丢弃」，所以这里断言的是 **null**。
   */
  it('hands[0] 不是数组 ⇒ 整份丢弃（不再静默补 revealed）', () => {
    const s = playState(38)
    saveState({ ...s, hands: [null, [], [], []] as unknown as GameState['hands'] })
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

/**
 * 字段级校验（v1.3.29 · docs/35 F1）。
 *
 * 背景：旧 `loadState` 只校验 3 个条件，剩下 40 多个字段裸奔。实测后果（docs/33 C4、
 * docs/38 G-1/G-3）：
 *   - 字段不全 → 首帧崩、白屏且无法自愈
 *   - `phase` 非法 → 之后**所有 action 变空操作**，只有 newGame 能救
 *   - 数字字段被塞成 HTML → 拼进 `innerHTML` 后**执行脚本**
 *
 * 新契约：**任何一项不过就整份丢弃**（返回 null），绝不把半坏的状态放进运行时。
 */
describe('对局存档：字段级校验（v1.3.29）', () => {
  const playState = (seed: number) => {
    let s = newGame(DEFAULT_RULE_CONFIG, 1, 420, seed)
    s = declareAndPass(s, 0)
    if (s.phase === 'bury') {
      const hand = s.hands[s.dealer] as readonly Card[]
      s = reduce(s, { type: 'bury', ids: hand.slice(0, 8).map((c) => c.id) })
    }
    return s
  }
  /** 写一份「合法存档 + 局部篡改」 */
  const saveTampered = (seed: number, patch: Record<string, unknown>) => {
    const s = playState(seed)
    saveState({ ...s, ...patch } as GameState)
    return s
  }

  it('数字字段被塞成 HTML 字符串 ⇒ 整份丢弃（XSS 入口封死）', () => {
    const payload = '<img src=x onerror="window.__XSS__=1">'
    for (const k of ['round', 'tricksDone', 'defenderScore', 'bottomScore', 'levelRank']) {
      saveTampered(40, { [k]: payload })
      expect(loadState(), `${k} 应该被拒绝`).toBeNull()
    }
  })

  it('NaN / Infinity 一律拒绝（堵住 NaN 污染）', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      saveTampered(41, { defenderScore: bad })
      expect(loadState()).toBeNull()
      saveTampered(41, { step: bad })
      expect(loadState()).toBeNull()
    }
  })

  it('levelRank 越界 ⇒ 拒绝（LevelRank 只有 1..13 与 18，没有 14~17）', () => {
    for (const bad of [0, 14, 17, 19]) {
      saveTampered(42, { levelRank: bad })
      expect(loadState(), `levelRank=${bad}`).toBeNull()
    }
  })

  it('phase 非法 ⇒ 拒绝（否则载入后所有 action 变空操作）', () => {
    for (const bad of ['nonsense', '', null, 0]) {
      saveTampered(43, { phase: bad })
      expect(loadState(), `phase=${String(bad)}`).toBeNull()
    }
  })

  it('缺 pendingConfig ⇒ 拒绝（否则换局后 config 变 undefined、ctxOf 崩）', () => {
    const s = playState(44)
    const { pendingConfig: _drop, ...rest } = s
    void _drop
    saveState(rest as GameState)
    expect(loadState()).toBeNull()
  })

  it('牌值 / 牌 id 越界 ⇒ 拒绝', () => {
    const s = playState(45)
    const hand = (s.hands[0] as readonly Card[]).slice()
    saveState({
      ...s,
      hands: [[{ id: 0, value: 99 }, ...hand.slice(1)], s.hands[1], s.hands[2], s.hands[3]],
    } as GameState)
    expect(loadState()).toBeNull()

    saveState({
      ...s,
      hands: [[{ id: 999, value: 3 }, ...hand.slice(1)], s.hands[1], s.hands[2], s.hands[3]],
    } as GameState)
    expect(loadState()).toBeNull()
  })

  it('同一手牌里 id 重复 ⇒ 拒绝（重复牌会让合法性判定失真）', () => {
    const s = playState(46)
    const hand = s.hands[0] as readonly Card[]
    const dup = hand.slice()
    dup[1] = dup[0] as Card
    saveState({ ...s, hands: [dup, s.hands[1], s.hands[2], s.hands[3]] } as GameState)
    expect(loadState()).toBeNull()
  })

  it('缺 bottom / history / trick ⇒ 拒绝', () => {
    for (const k of ['bottom', 'history', 'trick', 'hands', 'levels']) {
      saveTampered(47, { [k]: undefined })
      expect(loadState(), `缺 ${k}`).toBeNull()
    }
  })

  it('trick.plays 的 analysis 不信存档，读档时重算', () => {
    const s = playState(48)
    const hand = s.hands[0] as readonly Card[]
    const played = hand[0] as Card
    // 造一个「已出一张牌」的当前墩，analysis 故意写错（谎称是 5 连对）
    saveState({
      ...s,
      hands: [hand.slice(1), s.hands[1], s.hands[2], s.hands[3]],
      trick: {
        leader: 0,
        winner: null,
        plays: [
          {
            seat: 0,
            cards: [played],
            analysis: { suitSlot: -1, typeCode: 10, groups: [], pairCount: 9, singleCount: 0, keyCard: null, score: 999, isMultiGroup: true },
          },
        ],
      },
    } as unknown as GameState)

    const back = loadState()
    expect(back).not.toBeNull()
    const p = back?.trick.plays[0]
    expect(p?.cards).toEqual([played])
    // 单张 ⇒ 1 组、0 对子、分数按牌面算（不是存档里的 999）
    expect(p?.analysis.groups.length).toBe(1)
    expect(p?.analysis.pairCount).toBe(0)
    expect(p?.analysis.score).toBeLessThan(999)
  })

  it('loadStateDetailed 能区分「版本不符 / 内容不合法 / 定主阶段 / 无存档」', () => {
    expect(loadStateDetailed()).toEqual({ state: null, issue: null })

    saveState({ ...playState(49), version: STATE_VERSION - 1 })
    expect(loadStateDetailed().issue).toBe('version')

    saveState(newGame(DEFAULT_RULE_CONFIG, 1, 420, 50))
    expect(loadStateDetailed().issue).toBe('contract-phase')

    saveTampered(51, { hands: 'nope' })
    expect(loadStateDetailed().issue).toBe('corrupt')

    saveState(playState(52))
    const ok = loadStateDetailed()
    expect(ok.issue).toBeNull()
    expect(ok.state).not.toBeNull()
  })
})
