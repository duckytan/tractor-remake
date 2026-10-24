import { describe, expect, it } from 'vitest'
import { DEFAULT_RULE_CONFIG } from '@core'
import { newGame, reduce } from '@app/game'
import { ANIM_SPEED_SCALE } from '@app/state'
import type { GameState } from '@app/state'

/**
 * 体验项 / UI 状态类动作的 reducer 行为。
 *
 * 这些动作不改规则，但会被 UI 直接依赖，回归成本低、值得钉住：
 * ① 「重新开局」二次确认（v1.3.9）：出牌途中误点新游戏不能直接清档；
 * ② 动画速度三挡（v1.3.8）：倍率表与动作必须一致。
 */

const fresh = (): GameState => newGame(DEFAULT_RULE_CONFIG, 1, 420, 7)

describe('重新开局确认（confirmNew）', () => {
  it('askNewGame 只打开确认，不动局面', () => {
    const s = fresh()
    const asked = reduce(s, { type: 'askNewGame' })
    expect(asked.confirmNew).toBe(true)
    expect(asked.phase).toBe(s.phase)
    expect(asked.seed).toBe(s.seed)
  })

  it('cancelNewGame 关掉确认，局面原样', () => {
    const asked = reduce(fresh(), { type: 'askNewGame' })
    const cancelled = reduce(asked, { type: 'cancelNewGame' })
    expect(cancelled.confirmNew).toBe(false)
    expect(cancelled.hands.map((h) => h.length)).toEqual(asked.hands.map((h) => h.length))
  })

  it('newGame 之后确认框一定是关的（新局不该一上来就弹框）', () => {
    const asked = reduce(fresh(), { type: 'askNewGame' })
    const restarted = reduce(asked, { type: 'newGame', seed: 99 })
    expect(restarted.confirmNew).toBe(false)
  })
})

describe('动画速度（animSpeed）', () => {
  it('setAnimSpeed 改档位，其余字段不动', () => {
    const s = fresh()
    const slow = reduce(s, { type: 'setAnimSpeed', speed: 'slow' })
    expect(slow.animSpeed).toBe('slow')
    expect(slow.seed).toBe(s.seed)
    expect(slow.phase).toBe(s.phase)
  })

  it('倍率表：慢 > 中 > 快，且中速为 1（不改基准时长）', () => {
    expect(ANIM_SPEED_SCALE.slow).toBeGreaterThan(ANIM_SPEED_SCALE.normal)
    expect(ANIM_SPEED_SCALE.normal).toBe(1)
    expect(ANIM_SPEED_SCALE.fast).toBeLessThan(ANIM_SPEED_SCALE.normal)
    expect(ANIM_SPEED_SCALE.fast).toBeGreaterThan(0)
  })
})
