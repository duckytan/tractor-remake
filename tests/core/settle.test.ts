import { describe, it, expect } from 'vitest'
import {
  DEFAULT_RULE_CONFIG,
  advanceLevel,
  calcBottomBonus,
  countScoreCards,
  isGuardedLevel,
  levelsFor,
  nextLevel,
  partnerOf,
  settleRound,
  teamOf,
} from '@core'
import type { LevelRank, RuleConfig } from '@core'
import { analyze } from '@core'
import { C, P, ctx } from './helpers'

const cfg = (o: Partial<RuleConfig> = {}): RuleConfig => ({ ...DEFAULT_RULE_CONFIG, ...o })
const allGuards = cfg({ guardScoreLevels: true, guardJack: true, guardAce: true, guardKingLevel: true })
/** 只保护 J / A / 打王，5/10/K 不保护 */
const jaOnly = cfg({ guardScoreLevels: false, guardJack: true, guardAce: true, guardKingLevel: true })
const noGuards = cfg({ guardScoreLevels: false, guardJack: false, guardAce: false, guardKingLevel: false })

describe('TC-801~805 升级级数', () => {
  it('0 分 → 庄家方升 3 级（大光）', () => {
    expect(levelsFor(0)).toEqual({ team: 'dealer', levels: 3 })
  })

  it('1–39 → 庄家方升 2 级（小光）', () => {
    expect(levelsFor(1)).toEqual({ team: 'dealer', levels: 2 })
    expect(levelsFor(39)).toEqual({ team: 'dealer', levels: 2 })
  })

  it('40–79 → 庄家方升 1 级（40 是边界，归这一档）', () => {
    expect(levelsFor(40)).toEqual({ team: 'dealer', levels: 1 })
    expect(levelsFor(79)).toEqual({ team: 'dealer', levels: 1 })
  })

  it('80–119 → 闲家上台，升 0 级', () => {
    expect(levelsFor(80)).toEqual({ team: 'defender', levels: 0 })
    expect(levelsFor(119)).toEqual({ team: 'defender', levels: 0 })
  })

  it('120–159 → 闲家升 1 级；160–199 → 升 2 级；200 → 升 3 级', () => {
    expect(levelsFor(120)).toEqual({ team: 'defender', levels: 1 })
    expect(levelsFor(159)).toEqual({ team: 'defender', levels: 1 })
    expect(levelsFor(160)).toEqual({ team: 'defender', levels: 2 })
    expect(levelsFor(199)).toEqual({ team: 'defender', levels: 2 })
    expect(levelsFor(200)).toEqual({ team: 'defender', levels: 3 })
  })
})

describe('TC-806 级牌推进', () => {
  it('K → A → 打王 → 2', () => {
    expect(nextLevel(13, 0)).toBe(1)
    expect(nextLevel(1, 0)).toBe(18)
    expect(nextLevel(18, 0)).toBe(2)
  })

  it('2 为常主时打王之后回到 3', () => {
    expect(nextLevel(18, 1)).toBe(3)
  })

  it('普通级牌 +1', () => {
    expect(nextLevel(2, 0)).toBe(3)
    expect(nextLevel(12, 0)).toBe(13)
  })
})

describe('TC-807~810 必打截断', () => {
  it('9 升 3 级，J 受保护 → 停在 J，实际升 2 级', () => {
    const r = advanceLevel(9 as LevelRank, 3, jaOnly)
    expect(r.to).toBe(11)
    expect(r.stopped).toBe(true)
    expect(r.guardLevel).toBe(11)
    expect(r.actualLevels).toBe(2)
  })

  it('Q 升 3 级，A 受保护 → 停在 A，实际升 2 级', () => {
    const r = advanceLevel(12 as LevelRank, 3, jaOnly)
    expect(r.to).toBe(1)
    expect(r.stopped).toBe(true)
    expect(r.actualLevels).toBe(2)
  })

  it('Q 升 3 级，5/10/K 也受保护 → 停在 K，实际升 1 级', () => {
    const r = advanceLevel(12 as LevelRank, 3, allGuards)
    expect(r.to).toBe(13)
    expect(r.actualLevels).toBe(1)
  })

  it('A 升 1 级 → 到打王（正常，不额外截断）', () => {
    const r = advanceLevel(1 as LevelRank, 1, allGuards)
    expect(r.to).toBe(18)
    expect(r.actualLevels).toBe(1)
    expect(r.stopped).toBe(true) // 停在打王上
  })

  it('关闭全部必打后不截断', () => {
    const r = advanceLevel(9 as LevelRank, 3, noGuards)
    expect(r.to).toBe(12)
    expect(r.stopped).toBe(false)
    expect(r.actualLevels).toBe(3)
  })

  it('isGuardedLevel 与三个开关一致', () => {
    expect(isGuardedLevel(5, allGuards)).toBe(true)
    expect(isGuardedLevel(10, allGuards)).toBe(true)
    expect(isGuardedLevel(13, allGuards)).toBe(true)
    expect(isGuardedLevel(11, allGuards)).toBe(true)
    expect(isGuardedLevel(1, allGuards)).toBe(true)
    expect(isGuardedLevel(18, allGuards)).toBe(true)
    expect(isGuardedLevel(7, allGuards)).toBe(false)
    expect(isGuardedLevel(5, noGuards)).toBe(false)
  })
})

describe('TC-804/805 结算与轮庄', () => {
  it('庄家赢（50 分）→ 庄家队升 1 级，对家坐庄', () => {
    const r = settleRound({
      defenderScore: 50,
      dealerSeat: 0,
      levels: { a: 2, b: 2 },
      config: noGuards,
      mode: 0,
    })
    expect(r.levelUpTeam).toBe(0)
    expect(r.actualLevels).toBe(1)
    expect(r.newLevels).toEqual({ a: 3, b: 2 })
    expect(r.dealerChanged).toBe(false)
    expect(r.newDealer).toBe(partnerOf(0))
    expect(r.gameOver).toBe(false)
  })

  it('闲家上台（100 分）→ 换庄，庄家下家坐庄', () => {
    const r = settleRound({
      defenderScore: 100,
      dealerSeat: 1,
      levels: { a: 2, b: 2 },
      config: noGuards,
      mode: 0,
    })
    expect(r.levelUpTeam).toBe(0) // 庄家是座位 1（队 1），闲家是队 0
    expect(r.actualLevels).toBe(0)
    expect(r.dealerChanged).toBe(true)
    expect(r.newDealer).toBe(2)
  })

  it('大光（0 分）→ 升 3 级', () => {
    const r = settleRound({
      defenderScore: 0,
      dealerSeat: 0,
      levels: { a: 2, b: 2 },
      config: noGuards,
      mode: 0,
    })
    expect(r.actualLevels).toBe(3)
    expect(r.newLevels.a).toBe(5)
  })

  it('必打截断体现在结算里', () => {
    const r = settleRound({
      defenderScore: 0, // 升 3 级
      dealerSeat: 0,
      levels: { a: 9, b: 2 },
      config: jaOnly,
      mode: 0,
    })
    expect(r.levels).toBe(3)
    expect(r.actualLevels).toBe(2)
    expect(r.newLevels.a).toBe(11) // 停在 J
    expect(r.guardLevel).toBe(11)
  })
})

describe('TC-901 终局判定', () => {
  it('打王级坐庄并赢下 → 游戏结束', () => {
    const r = settleRound({
      defenderScore: 40,
      dealerSeat: 0,
      levels: { a: 18, b: 5 },
      config: noGuards,
      mode: 0,
    })
    expect(r.gameOver).toBe(true)
    expect(r.winnerTeam).toBe(0)
  })

  it('打王级但闲家上台 → 不结束', () => {
    const r = settleRound({
      defenderScore: 120,
      dealerSeat: 0,
      levels: { a: 18, b: 5 },
      config: noGuards,
      mode: 0,
    })
    expect(r.gameOver).toBe(false)
  })

  it('非打王级赢下 → 不结束', () => {
    const r = settleRound({
      defenderScore: 40,
      dealerSeat: 0,
      levels: { a: 12, b: 5 },
      config: noGuards,
      mode: 0,
    })
    expect(r.gameOver).toBe(false)
  })
})

/**
 * 打王是终点级（ADR-011）。回归：v1.3.48 前 `advanceLevel` 会照 `nextLevel` 的
 * 18 → 2/3 回卷，于是「已在打王的那队当闲家赢一局」会把 18 打回 3 级。
 * 实测 200 副连打里发生 **134 次**（每局约 0.67 次），玩家攒到打王的进度被一局抹掉。
 */
describe('TC-901b 打王级不回卷', () => {
  it('闲家已在打王、赢下本局 → 级牌保持打王，换庄而非倒退', () => {
    const r = settleRound({
      defenderScore: 120, // 闲家上台 +1 级
      dealerSeat: 1, // 队 1 坐庄 ⇒ 闲家是队 0
      levels: { a: 18, b: 5 },
      config: noGuards,
      mode: 1,
    })
    expect(r.levelUpTeam).toBe(0)
    expect(r.newLevels.a).toBe(18) // 不能变成 3
    expect(r.dealerChanged).toBe(true)
    expect(r.newDealer).toBe(2)
    expect(r.gameOver).toBe(false) // 上台而已，还要坐庄赢下才通关
  })

  it('打王队上台后再坐庄赢下 → 通关（回卷会让这条路径永远走不到）', () => {
    const up = settleRound({
      defenderScore: 120,
      dealerSeat: 1,
      levels: { a: 18, b: 5 },
      config: noGuards,
      mode: 1,
    })
    const win = settleRound({
      defenderScore: 40, // 庄家方（队 0，座位 2）升 1 级 ⇒ 已在打王 ⇒ 通关
      dealerSeat: up.newDealer,
      levels: up.newLevels,
      config: noGuards,
      mode: 1,
    })
    expect(win.gameOver).toBe(true)
    expect(win.winnerTeam).toBe(0)
  })

  it('advanceLevel(打王, n) 原地不动', () => {
    const r = advanceLevel(18 as LevelRank, 3, noGuards, 1)
    expect(r.to).toBe(18)
    expect(r.actualLevels).toBe(0)
    expect(r.stopped).toBe(false) // 没东西被截断，只是到顶了
  })

  it('关掉「打王必打」也不会跨过终点级（A 升 3 级停在打王）', () => {
    const r = advanceLevel(1 as LevelRank, 3, noGuards, 0)
    expect(r.to).toBe(18)
    expect(r.actualLevels).toBe(1)
    expect(r.stopped).toBe(true)
    expect(r.guardLevel).toBe(18)
  })
})

describe('TC-706~708 扣底', () => {
  const c = ctx({ trump: 0, levelRank: 2 })

  it('单张 ×2', () => {
    const r = calcBottomBonus(analyze([C(1, 3)], c), 20, false)
    expect(r).toEqual({ applies: true, multiplier: 2, extra: 40 })
  })

  it('对子 ×4', () => {
    const r = calcBottomBonus(analyze(P(1, 3), c), 20, false)
    expect(r).toEqual({ applies: true, multiplier: 4, extra: 80 })
  })

  it('拖拉机 ×8', () => {
    const r = calcBottomBonus(analyze([...P(1, 2), ...P(1, 3)], c), 20, false)
    expect(r).toEqual({ applies: true, multiplier: 8, extra: 160 })
  })

  it('庄家方赢 → 不计', () => {
    const r = calcBottomBonus(analyze(P(1, 3), c), 20, true)
    expect(r.applies).toBe(false)
    expect(r.extra).toBe(0)
  })

  it('底分 0 → extra 0', () => {
    const r = calcBottomBonus(analyze(P(1, 3), c), 0, false)
    expect(r.extra).toBe(0)
    expect(r.multiplier).toBe(4)
  })
})

describe('队伍与座位', () => {
  it('teamOf / partnerOf', () => {
    expect([0, 1, 2, 3].map((s) => teamOf(s as 0))).toEqual([0, 1, 0, 1])
    expect(partnerOf(0)).toBe(2)
    expect(partnerOf(1)).toBe(3)
  })
})

describe('countScoreCards', () => {
  it('数分数牌张数', () => {
    expect(countScoreCards([C(1, 3), C(1, 8), C(1, 11), C(1, 12)])).toBe(3)
    expect(countScoreCards([C(1, 12), C(1, 0)])).toBe(0)
  })
})
