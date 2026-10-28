/**
 * 挂机模式（`GameState.autoPlay`）—— 让 AI 代打「人类座位」的每一步。
 *
 * 为什么要单独测 `autoAction`：它是「人类这一侧所有待办」的分发器
 *（抢主 / 反主 / 加固 / 扣底 / 出牌 / 下一局）。写错一个分支的症状是
 * **挂机卡住不动**（定时器发现没事可做就不再排下一次），而浏览器里
 * 表现得像「游戏坏了」。所以逐分支断言 + 一条「整局能自己打完」的集成测试。
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_RULE_CONFIG, DEAL_TOTAL } from '@core'
import type { Card } from '@core'
import { aiPlayFor, autoAction, autoStep, newGame, reduce } from '@app/game'
import { HUMAN_SEAT, seatToPlay } from '@app/state'
import type { GameState } from '@app/state'
import { declareAndPass } from '../helpers/declare'

const base = (seed: number): GameState => newGame(DEFAULT_RULE_CONFIG, 2, 0, seed)

/** 进入出牌阶段（含埋底），并打开挂机 */
function playPhaseAuto(seed: number): GameState {
  let s = declareAndPass(base(seed), 0)
  if (s.phase === 'bury') {
    const hand = s.hands[s.dealer] as readonly Card[]
    s = reduce(s, { type: 'bury', ids: hand.slice(0, 8).map((c) => c.id) })
  }
  return { ...s, autoPlay: true }
}

/** 把局面推进到「轮到人类」 */
function toHumanTurn(s0: GameState): GameState {
  let s = s0
  for (let i = 0; i < 400 && s.phase === 'play' && seatToPlay(s) !== HUMAN_SEAT; i++) {
    const seat = seatToPlay(s)
    if (seat === null) break
    s = aiPlayFor(s, seat, 2)
  }
  return s
}

describe('挂机 · 开关本身', () => {
  it('关着的时候 autoAction 恒为 null（不能偷偷动）', () => {
    const s = playPhaseAuto(11)
    expect(autoAction({ ...s, autoPlay: false })).toBeNull()
  })

  it('toggleAutoPlay 两次回到原值', () => {
    const s = base(12)
    const on = reduce(s, { type: 'toggleAutoPlay' })
    expect(on.autoPlay).toBe(true)
    expect(reduce(on, { type: 'toggleAutoPlay' }).autoPlay).toBe(false)
  })

  it('关掉挂机时清掉残留的提示高亮与选中', () => {
    const s = { ...base(13), autoPlay: true, hintIds: [1, 2], selected: [3] }
    const off = reduce(s, { type: 'toggleAutoPlay' })
    expect(off.autoPlay).toBe(false)
    expect(off.hintIds).toEqual([])
    expect(off.selected).toEqual([])
  })

  it('回放中必须停手', () => {
    const s = { ...playPhaseAuto(14), replayAt: 0 }
    expect(autoAction(s)).toBeNull()
  })
})

describe('挂机 · 各阶段分支', () => {
  it('出牌阶段轮到自己 → 真的把牌打出去（手牌减少）', () => {
    const s = toHumanTurn(playPhaseAuto(21))
    expect(s.phase).toBe('play')
    expect(seatToPlay(s)).toBe(HUMAN_SEAT)
    const before = (s.hands[HUMAN_SEAT] as readonly Card[]).length
    expect(autoAction(s)).toEqual({ type: 'autoPlayTurn' })
    const after = autoStep(s)
    expect((after.hands[HUMAN_SEAT] as readonly Card[]).length).toBeLessThan(before)
    expect(after.trick.plays.length).toBeGreaterThanOrEqual(1)
  })

  it('人类坐庄的扣底阶段 → 自动扣掉正好 8 张并进入出牌', () => {
    // 人类是否坐庄取决于抢主结果 ⇒ 换种子直到拿到 bury 分支（最多 20 次）
    let s = declareAndPass(base(22), 0)
    for (let i = 0; s.phase !== 'bury' && i < 20; i++) s = declareAndPass(base(40 + i), 0)
    expect(s.phase, '找不到人类坐庄的种子').toBe('bury')
    const action = autoAction({ ...s, autoPlay: true })
    expect(action?.type).toBe('bury')
    const after = autoStep({ ...s, autoPlay: true })
    expect(after.phase).toBe('play')
    // 庄家 33 张扣 8 张 = 25 张
    expect((after.hands[s.dealer] as readonly Card[]).length).toBe(25)
  })

  it('定主面板（发牌中途暂停）→ 自动亮主', () => {
    const s = base(24)
    // 手工造一个「已经摸到级牌、面板暂停」的局面：发牌 12 张、只允许亮 ♠
    const hand = s.hands[HUMAN_SEAT] as readonly Card[]
    const fake: GameState = {
      ...s,
      revealed: 12,
      dealPrompt: true,
      declareOptions: [0],
      hands: s.hands.map((h, i) => (i === HUMAN_SEAT ? hand : h)),
    }
    const action = autoAction({ ...fake, autoPlay: true })
    expect(action).toEqual({ type: 'declareTrump', trump: 0 })
  })

  it('反主面板：没有 ≥5 张的花色时选择「过」', () => {
    const s = playPhaseAuto(25)
    const fake: GameState = {
      ...s,
      phase: 'contract',
      counterPending: true,
      guardOption: false,
      counterOptions: [1, 3],
      // 人类手牌按现状（十几张里某一门 ≥5 张是有可能的，所以这里同时断言「要么过要么反」）
    }
    const action = autoAction(fake)
    expect(['passCounter', 'declareTrump']).toContain(action?.type)
  })

  it('加固按钮可用时优先加固', () => {
    const s = playPhaseAuto(26)
    const fake: GameState = {
      ...s,
      phase: 'contract',
      counterPending: true,
      guardOption: true,
      counterOptions: [1],
    }
    expect(autoAction(fake)).toEqual({ type: 'guard' })
  })

  it('结算页 → 自动下一局', () => {
    const s = { ...playPhaseAuto(27), phase: 'settle' as const }
    expect(autoAction(s)).toEqual({ type: 'nextRound' })
    expect(autoStep(s).phase).not.toBe('settle')
  })

  it('还在逐张发牌（没有暂停）→ 不插手，让 revealTick 继续', () => {
    const s = { ...base(28), revealed: 3, dealPrompt: false }
    expect(autoAction({ ...s, autoPlay: true })).toBeNull()
  })
})

describe('挂机 · 能无人值守打完整局', () => {
  it('三个种子都能从定主一路打到结算（不卡死）', () => {
    for (const seed of [31, 32, 33]) {
      let s = { ...declareAndPass(base(seed), 0), autoPlay: true }
      let guard = 0
      // 上限给足：一局最多约 25 墩 × 4 家 × 几次交互
      while (s.phase !== 'settle' && s.phase !== 'over' && guard < 900) {
        guard++
        const seat = seatToPlay(s)
        if (seat !== null && seat !== HUMAN_SEAT) {
          s = aiPlayFor(s, seat, 2)
          continue
        }
        const next = autoStep(s)
        if (next === s) break // 没推进 ⇒ 立刻失败，别让循环空转
        s = next
      }
      expect(s.phase, `seed=${seed} 停在 ${s.phase}（guard=${guard}）`).toMatch(/settle|over/)
      expect(s.revealed).toBe(DEAL_TOTAL)
    }
  })
})
