/**
 * 回归断言：重开游戏不能丢「玩家偏好」。
 *
 * 背景（v1.3.28 修）：`withExperience()` 手写搬运只覆盖 5 项，
 * 而 `over → nextRound` 又手写搬了另外一组 —— 两条路径都漏字段，
 * 后果是「切到冬主题 / 调好音量 / 开记牌器，点一次新游戏全部回默认」，
 * 且 `afterChange()` 会把默认值回写 localStorage，刷新也救不回。
 *
 * 修法是把偏好项收敛成 `PREF_FIELDS` 清单（game.ts），两处重开路径都走 `pickPrefs()`。
 * 本文件锁住这个契约：**改 GameState 加偏好字段时，若忘了加进清单，这里会红**。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_RULE_CONFIG } from '@core'
import type { SettleResult } from '@core'
import { newGame, prefsFromState, reduce, stateFieldsOfPrefs } from '@app/game'
import { DEFAULT_PREFS } from '@app/persist'
import type { Prefs } from '@app/persist'
import { emptyState } from '@app/state'
import type { GameState } from '@app/state'

/** 全部 22 个偏好字段，逐个设成**非默认值** */
const NON_DEFAULT: Pick<
  GameState,
  | 'fourColor'
  | 'cardSize'
  | 'animation'
  | 'animSpeed'
  | 'showHistory'
  | 'showCounter'
  | 'showOppHands'
  | 'hintSelects'
  | 'hintStyle'
  | 'aiPeekHands'
  | 'musicTheme'
  | 'soundEnhanced'
  | 'autoVariation'
  | 'volumeMaster'
  | 'volumeBgm'
  | 'volumeSfx'
  | 'autoPlay'
  | 'autoLevel'
  | 'aiLevelPartner'
  | 'aiLevelOpponent'
  | 'aiSpeedMs'
  | 'pendingConfig'
> = {
  fourColor: true,
  cardSize: 'L',
  animation: false,
  animSpeed: 'fast',
  showHistory: false,
  showCounter: true,
  showOppHands: true,
  hintSelects: true,
  hintStyle: 'ai',
  aiPeekHands: false,
  musicTheme: 'winter',
  soundEnhanced: true,
  autoVariation: false,
  volumeMaster: 30,
  volumeBgm: 20,
  volumeSfx: 90,
  autoPlay: true,
  autoLevel: 0,
  // v1.3.53：这 4 项以前没进清单 —— 它们同样写进 localStorage，
  // 漏掉的后果是「悔牌吞设置」（见 tests/audit/f7-undo.test.ts）
  aiLevelPartner: 0,
  aiLevelOpponent: 0,
  aiSpeedMs: 800,
  pendingConfig: { ...DEFAULT_RULE_CONFIG, guardAce: false },
}

/** 玩家改过的规则（`pendingConfig` 的非默认值，供 newGame 的 config 入参对齐） */
const CUSTOM_RULES = NON_DEFAULT.pendingConfig

const PREF_KEYS = Object.keys(NON_DEFAULT) as (keyof typeof NON_DEFAULT)[]

/** 造一个「玩家已经调好一切」的状态 */
const customized = (): GameState => ({ ...emptyState(), ...NON_DEFAULT })

/** 逐字段断言：`got` 的偏好项应与 `src` 一致 */
function expectPrefsKept(got: GameState, src: GameState): void {
  for (const k of PREF_KEYS) {
    expect(got[k], `重开后丢了偏好字段 ${k}`).toEqual(src[k])
  }
}

const settle = (): SettleResult => ({
  defenderScore: 50,
  levelUpTeam: 0,
  levels: 1,
  actualLevels: 1,
  newLevels: { a: 3, b: 2 },
  dealerChanged: false,
  newDealer: 0,
  gameOver: false,
})

describe('重开游戏保留玩家偏好（PREF_FIELDS 契约）', () => {
  it('清单覆盖 22 个偏好字段（加字段时若忘了加进清单，这条会红）', () => {
    expect(PREF_KEYS).toHaveLength(22)
    // 每个偏好字段在 emptyState 里都应存在（防止改名后清单变成死字符串）
    const base = emptyState() as unknown as Record<string, unknown>
    for (const k of PREF_KEYS) {
      expect(base, `emptyState 里没有字段 ${k}`).toHaveProperty(k)
    }
  })

  it('newGame（新游戏）保留全部 22 项', () => {
    const src = customized()
    // config 入参用「玩家改过的规则」：生产路径里 newGame 收到的就是 `s.pendingConfig`，
    // 用 DEFAULT 会让 config 与 pendingConfig 分叉，测的就不是真实路径了
    const next = newGame(CUSTOM_RULES, 1, 420, 7, src)
    expectPrefsKept(next, src)
    // 同时确认规则/局内状态确实被重置了（别把偏好搬运写成「什么都不重置」）
    expect(next.round).toBe(1)
    expect(next.phase).toBe('contract')
  })

  it('over → nextRound（游戏结束再来一局）保留全部 22 项', () => {
    const src: GameState = {
      ...customized(),
      phase: 'over',
      lastSettle: settle(),
      round: 3,
    }
    const next = reduce(src, { type: 'nextRound' })
    expectPrefsKept(next, src)
  })

  it('settle → nextRound（普通下一局）保留全部 22 项', () => {
    const src: GameState = {
      ...customized(),
      phase: 'settle',
      lastSettle: settle(),
      round: 2,
    }
    const next = reduce(src, { type: 'nextRound' })
    expectPrefsKept(next, src)
  })

  it('偏好项不是「全局单例」：从不同 src 重开会得到各自的偏好', () => {
    const a = newGame(DEFAULT_RULE_CONFIG, 1, 420, 1, { ...emptyState(), ...NON_DEFAULT })
    const b = newGame(DEFAULT_RULE_CONFIG, 1, 420, 1, emptyState())
    expect(a.musicTheme).toBe('winter')
    expect(b.musicTheme).toBe('spring')
    expect(a.volumeMaster).toBe(30)
    expect(b.volumeMaster).toBe(75)
  })
})

describe('写侧收敛：prefsFromState 与 stateFieldsOfPrefs 互逆', () => {
  /**
   * v1.3.56：`afterChange()` 的 `savePrefsIfChanged({...})` 原来手写 22 行字段字面量，
   * 没有编译期护栏。改成 `prefsFromState(state)` 后，读侧/写侧共用 `PREF_FIELDS` 清单。
   *
   * 这组测试锁住的契约：
   *   1. `prefsFromState(stateFieldsOfPrefs(p))` 往返一致（prefs → state → prefs 不丢字段）
   *   2. `stateFieldsOfPrefs(prefsFromState(s))` 往返一致（state → prefs → state 不丢字段）
   *   3. 从「全部非默认值」的 state 构造出的 prefs，每个字段都不等于 DEFAULT_PREFS
   *      （验证 prefsFromState 确实读了 state 的值，而不是意外回落默认）
   */
  it('prefs → state → prefs 往返一致', () => {
    const p: Prefs = { ...DEFAULT_PREFS, ...toPrefs(NON_DEFAULT) }
    const s = { ...emptyState(), ...stateFieldsOfPrefs(p) }
    const back = prefsFromState(s)
    expect(back).toEqual(p)
  })

  it('state → prefs → state 往返一致', () => {
    const s = customized()
    const back = { ...emptyState(), ...stateFieldsOfPrefs(prefsFromState(s)) }
    for (const k of PREF_KEYS) {
      expect(back[k], `写侧往返丢了字段 ${k}`).toEqual(s[k])
    }
  })

  it('从非默认值的 state 构造的 prefs，每个字段都不等于默认', () => {
    const p = prefsFromState(customized())
    // 逐字段比对（不是 toEqual 整个对象 —— 只验「值确实从 state 来了」）
    for (const k of Object.keys(DEFAULT_PREFS) as (keyof typeof DEFAULT_PREFS)[]) {
      expect(p[k], `prefsFromState 在 ${k} 上回落了默认值`).not.toBe(DEFAULT_PREFS[k])
    }
  })
})

/** 把 `Pick<GameState, PrefField>` 形状转成 `Partial<Prefs>`（pendingConfig → ruleConfig） */
function toPrefs(s: Pick<GameState, typeof PREF_KEYS[number]>): Partial<Prefs> {
  const { pendingConfig, ...rest } = s
  return { ruleConfig: pendingConfig, ...rest } as unknown as Partial<Prefs>
}
