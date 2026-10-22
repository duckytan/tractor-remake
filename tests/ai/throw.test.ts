import { describe, expect, it } from 'vitest'
import { checkPlay, mulberry32 } from '@core'
import type { Card, RuleContext } from '@core'
import { decide } from '@ai/policy'
import { P, ctx } from '../core/helpers'

/**
 * AI 首出必须按真实三家手牌校验（甩牌尤其）。
 *
 * 背景：`policy.ts` 的 `legalOnly()` 原先给 `checkPlay` 传 `opponents: []`，
 * 于是 `bestInSlot` 全返回 -1、`maxCard = -1`，**任何甩牌都「合法」**。
 *
 * 现状说明：`enumerateLeads()` 只生成单张 / 对子 / 连对（**不生成混合甩牌**），
 * 所以这条路径目前走不到，属于**潜伏缺陷**。修 `opponents` 是让它「本来正确」——
 * 一旦以后给 AI 加上甩牌生成，校验就已经在位。
 *
 * 这个用例守的是不变量：**AI 首出的任何一手，拿真实三家再校验一遍都不能被裁剪**。
 */

function assertLeadNeverAdjusted(c: RuleContext, hand: readonly Card[], opp: Card[][]): void {
  for (const level of [0, 1, 2] as const) {
    const d = decide(
      {
        hand,
        seat: 1,
        ctx: c,
        play: { kind: 'lead' },
        currentWinner: null,
        partnerLeading: false,
        opponents: opp,
      },
      level,
      mulberry32(level + 1),
    )
    const r = checkPlay({ hand, cards: d.cards, ctx: c, opponents: opp })
    expect(r.ok, `L${level}: 首出必须合法`).toBe(true)
    if (r.ok) expect(r.adjusted, `L${level}: 首出不该是需要裁剪的甩牌`).toBeUndefined()
  }
}

describe('AI 首出按真实对手校验', () => {
  it('对手有更大的对子时，不会打出会被裁剪的甩牌', () => {
    const c = ctx({ trump: 1, levelRank: 2 }) // 主 ♥，级 2
    // AI 手里只有 4 张：♠8♠8 + ♠Q♠Q（不连续 ⇒ 只能当甩牌甩）
    const hand: Card[] = [...P(0, 6), ...P(0, 10)]
    // 对手有 ♠A♠A ⇒ ♠Q 那组不是最大 ⇒ 这手甩牌必失败
    const opp: Card[][] = [[...P(0, 12)], [], []]
    assertLeadNeverAdjusted(c, hand, opp)
  })

  it('随机手牌 × 随机对手，AI 首出一律不需要裁剪', () => {
    const c = ctx({ trump: 0, levelRank: 3 })
    // 用固定牌面拼几组「多组混出」的诱饵手牌
    const hands: Card[][] = [
      [...P(0, 2), ...P(0, 8), ...P(1, 5)], // 两个不连续 ♠ 对子 + ♥ 对子
      [...P(0, 4), ...P(0, 4), ...P(0, 9)], // 同点重复（两副牌）+ 另一对
      [...P(2, 6), ...P(2, 10), ...P(3, 12)], // ♣ 两对 + ♦ 一对
    ]
    const opp: Card[][] = [
      [...P(0, 12), ...P(1, 12)],
      [...P(2, 12)],
      [...P(3, 12)],
    ]
    for (const hand of hands) assertLeadNeverAdjusted(c, hand, opp)
  })
})
