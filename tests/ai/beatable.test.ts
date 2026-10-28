/**
 * 「这一手甩出去会不会被压」—— `bestUnitPower` 的毙牌判定。
 *
 * 回归的是 v1.3.36 修的一个**让 L3 白掉二十个百分点**的 bug：
 * 旧实现给副牌判「能不能被压」时，把对手手里的主牌无条件算成威胁，
 * 却没检查对手**是不是真的缺这门**。于是只要对手手里有任意一张主（几乎永远成立），
 * 任何副牌首出都被判成「可能被压」—— 包括 ♦A。
 * 连锁后果：`exactOverLead` 每手都扣分 ⇒ AI 从不敢兑现副牌大牌，
 * 首出恒选最小的一张（用户反馈「有 A 居然不先出 A，反而出小牌」）。
 *
 * 规则上「有该花色就必须跟该花色」，不可能一边跟牌一边毙牌 —— 所以判据只能是
 * **这门跟不出牌（same.length === 0）** 时才把主牌算进来。
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_RULE_CONFIG } from '@core'
import type { Card, RuleContext } from '@core'
import { buildPowerTable } from '@core'
import { isSureToHold } from '@ai/policy'

/** 造牌：suit 0=♠ 1=♥ 2=♣ 3=♦；rank 0=2 … 12=A */
const card = (suit: number, rank: number): Card => ({ id: suit * 13 + rank, value: suit * 13 + rank })

/** 主 ♠、打 2 的规则上下文 */
const ctx: RuleContext = {
  power: buildPowerTable({ mode: 1, levelRank: 2, trump: 0, forcedNT: false }),
  trump: 0,
  levelRank: 2,
  forcedNT: false,
  config: DEFAULT_RULE_CONFIG,
}

/** 我在座位 0 首出；对手是 1/2/3 */
const opponents = (h1: readonly Card[], h2: readonly Card[] = [], h3: readonly Card[] = []) => [
  h1,
  h2,
  h3,
]
const ALL: [1, 2, 3] = [1, 2, 3]

describe('isSureToHold · 毙牌判定', () => {
  it('对手有这门就必须跟，不能毙：♦A 是稳赢', () => {
    const dA = card(3, 12) // ♦A
    // 三个对手都持有主牌（♠），但**手里都有 ♦** ⇒ 只能跟 ♦，不能毙
    const opp = opponents(
      [card(0, 5), card(3, 1)], // ♠6 + ♦3
      [card(0, 7), card(3, 2)], // ♠8 + ♦4
      // 注意：♦2 在「2 为常主」下是**主牌**，不能拿来当「有这门」的证据
      [card(0, 9), card(3, 3)], // ♠10 + ♦5
    )
    expect(isSureToHold([dA], ctx, opp, ALL, 0)).toBe(true)
  })

  it('对手缺这门且手里有主牌 ⇒ 可以毙，♦A 不再是稳赢', () => {
    const dA = card(3, 12)
    // 座位 1 一张 ♦ 都没有、但有主牌 ♠K
    const opp = opponents(
      [card(0, 11)], // ♠K（主）
      [card(3, 2)],
      [card(3, 3)],
    )
    expect(isSureToHold([dA], ctx, opp, ALL, 0)).toBe(false)
  })

  it('缺门但没主牌 ⇒ 还是稳赢（垫牌压不了）', () => {
    const dA = card(3, 12)
    const opp = opponents(
      [card(2, 5)], // ♣6，既没 ♦ 也没主
      [card(3, 2)],
      [card(3, 3)],
    )
    expect(isSureToHold([dA], ctx, opp, ALL, 0)).toBe(true)
  })

  it('对手有更大的同门牌 ⇒ 压得住', () => {
    // 我出 ♦10（rank 8），对手有 ♦A
    const d10 = card(3, 8)
    const opp = opponents([card(3, 12)], [card(3, 2)], [card(3, 3)])
    expect(isSureToHold([d10], ctx, opp, ALL, 0)).toBe(false)
  })

  it('本墩已经出过牌的座位不再算威胁', () => {
    const dA = card(3, 12)
    // 唯一缺门带主牌的是座位 1，但它已经出过牌了
    const opp = opponents([card(0, 11)], [card(3, 2)], [card(3, 3)])
    expect(isSureToHold([dA], ctx, opp, [2, 3], 0)).toBe(true)
  })
})
