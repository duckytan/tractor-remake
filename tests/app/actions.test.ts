import { describe, expect, it } from 'vitest'
import { DEFAULT_RULE_CONFIG } from '@core'
import { aiCanAct, newGame, reduce } from '@app/game'
import { ANIM_SPEED_SCALE, seatToPlay } from '@app/state'
import type { GameState, TrickRecord } from '@app/state'
import { C } from '../core/helpers'

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

describe('弹层开关类动作', () => {
  it('toggleLog 切换记录面板，并顺手关掉设置（两个弹层不共存）', () => {
    const opened = reduce({ ...fresh(), settingsOpen: true }, { type: 'toggleLog' })
    expect(opened.logOpen).toBe(true)
    expect(opened.settingsOpen).toBe(false)
    expect(reduce(opened, { type: 'toggleLog' }).logOpen).toBe(false)
  })

  it('dismissNotice 清掉提示', () => {
    expect(reduce({ ...fresh(), notice: '测试' }, { type: 'dismissNotice' }).notice).toBeNull()
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

describe('逐墩回放（v1.3.16）', () => {
  /** 造一个「已经打完 n 墩」的局面（历史记录只需要形状正确） */
  const withHistory = (n: number): GameState => {
    const base = fresh()
    const history: TrickRecord[] = Array.from({ length: n }, (_, i) => ({
      leader: 0,
      plays: [{ seat: 0, cards: [C(0, 12)] }],
      winner: (i % 4) as 0 | 1 | 2 | 3,
      score: 10,
    }))
    return { ...base, history }
  }

  it('replayStart 把下标夹进范围，并顺手收起记录面板', () => {
    const s = withHistory(5)
    const inRange = reduce({ ...s, logOpen: true }, { type: 'replayStart', index: 2 })
    expect(inRange.replayAt).toBe(2)
    expect(inRange.logOpen).toBe(false)

    // 越界夹紧
    expect(reduce(s, { type: 'replayStart', index: 99 }).replayAt).toBe(4)
    expect(reduce(s, { type: 'replayStart', index: -3 }).replayAt).toBe(0)
  })

  it('没有历史时 replayStart 是 no-op（回放无从谈起）', () => {
    const s = withHistory(0)
    expect(reduce(s, { type: 'replayStart', index: 0 }).replayAt).toBeNull()
  })

  it('replayStep 到两端不越界', () => {
    const s = { ...withHistory(3), replayAt: 0 }
    expect(reduce(s, { type: 'replayStep', delta: -1 }).replayAt).toBe(0)
    const last = { ...withHistory(3), replayAt: 2 }
    expect(reduce(last, { type: 'replayStep', delta: 1 }).replayAt).toBe(2)
    expect(reduce(s, { type: 'replayStep', delta: 1 }).replayAt).toBe(1)
  })

  it('replayStep 在非回放状态是 no-op', () => {
    expect(reduce(withHistory(3), { type: 'replayStep', delta: 1 }).replayAt).toBeNull()
  })

  it('replayExit 回到正常对局', () => {
    const s = { ...withHistory(3), replayAt: 1 }
    expect(reduce(s, { type: 'replayExit' }).replayAt).toBeNull()
  })

  it('回放期间 AI 必须停手（aiCanAct 为 false）', () => {
    const s = withHistory(2)
    const play: GameState = { ...s, phase: 'play' }
    // 先确认正常局面下 AI 确实可以动（否则这条测试是空的）
    const aiSeat = seatToPlay(play)
    if (aiSeat !== null && aiSeat !== 0) {
      expect(aiCanAct(play)).toBe(true)
      expect(aiCanAct({ ...play, replayAt: 0 })).toBe(false)
    } else {
      // 轮到人类时 AI 本来就不能动，构造一个「轮到 AI」的局面
      const aiTurn: GameState = { ...play, trick: { leader: 1, plays: [], winner: null } }
      expect(aiCanAct(aiTurn)).toBe(true)
      expect(aiCanAct({ ...aiTurn, replayAt: 0 })).toBe(false)
    }
  })
})
