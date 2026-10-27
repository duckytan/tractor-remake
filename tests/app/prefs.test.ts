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
import { newGame, reduce } from '@app/game'
import { emptyState } from '@app/state'
import type { GameState } from '@app/state'

/** 全部 15 个偏好字段，逐个设成**非默认值** */
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
  | 'aiPeekHands'
  | 'musicTheme'
  | 'soundEnhanced'
  | 'autoVariation'
  | 'volumeMaster'
  | 'volumeBgm'
  | 'volumeSfx'
> = {
  fourColor: true,
  cardSize: 'L',
  animation: false,
  animSpeed: 'fast',
  showHistory: false,
  showCounter: true,
  showOppHands: true,
  hintSelects: true,
  aiPeekHands: false,
  musicTheme: 'winter',
  soundEnhanced: true,
  autoVariation: false,
  volumeMaster: 30,
  volumeBgm: 20,
  volumeSfx: 90,
}

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
  it('清单覆盖 15 个偏好字段（加字段时若忘了加进清单，这条会红）', () => {
    expect(PREF_KEYS).toHaveLength(15)
    // 每个偏好字段在 emptyState 里都应存在（防止改名后清单变成死字符串）
    const base = emptyState() as unknown as Record<string, unknown>
    for (const k of PREF_KEYS) {
      expect(base, `emptyState 里没有字段 ${k}`).toHaveProperty(k)
    }
  })

  it('newGame（新游戏）保留全部 15 项', () => {
    const src = customized()
    const next = newGame(DEFAULT_RULE_CONFIG, 1, 420, 7, src)
    expectPrefsKept(next, src)
    // 同时确认规则/局内状态确实被重置了（别把偏好搬运写成「什么都不重置」）
    expect(next.round).toBe(1)
    expect(next.phase).toBe('contract')
  })

  it('over → nextRound（游戏结束再来一局）保留全部 15 项', () => {
    const src: GameState = {
      ...customized(),
      phase: 'over',
      lastSettle: settle(),
      round: 3,
    }
    const next = reduce(src, { type: 'nextRound' })
    expectPrefsKept(next, src)
  })

  it('settle → nextRound（普通下一局）保留全部 15 项', () => {
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
