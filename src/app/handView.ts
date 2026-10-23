/**
 * 手牌展示视图
 *
 * 把「手牌 → 展示序列 + 分组边界」算成纯数据，UI 只负责按 `gapBefore` 加间距。
 * 分组键涉及「主牌 / 主花色」这类规则概念，**必须在 app 层算** ——
 * ui 层不许出现 power / 主牌判定（分层铁律，见 docs/07-编码规范.md）。
 */

import type { Card, RuleContext } from '@core'
import { suitOfValue } from '@core'
import { sortHand } from './game'

/** 分组键：0..3 = 副牌花色，4 = 主牌段，5 = 主花色段 */
export const GROUP_TRUMP = 4
export const GROUP_TRUMP_SUIT = 5

export interface HandViewItem {
  readonly card: Card
  /** 分组键，见 GROUP_* */
  readonly group: number
  /** 是否在这一张之前留分组间隔（同组相邻为 false） */
  readonly gapBefore: boolean
}

/** 主花色；无将 / 打王级时为 null（此时主牌只有「主牌段」一组） */
function trumpSuitOf(ctx: RuleContext): number | null {
  if (ctx.forcedNT || ctx.trump === 'NT') return null
  return ctx.trump
}

/**
 * 一张牌属于哪一组。
 *
 * - 非主牌 → 花色编号 0..3
 * - 主牌 → 主花色段（5）或主牌段（4，含王 / 级牌 / 副 2 等）
 */
export function groupKeyOf(card: Card, ctx: RuleContext): number {
  if (!ctx.power.isTrump(card.value)) return suitOfValue(card.value) as number
  const trumpSuit = trumpSuitOf(ctx)
  return trumpSuit !== null && suitOfValue(card.value) === trumpSuit ? GROUP_TRUMP_SUIT : GROUP_TRUMP
}

/**
 * 手牌 → 展示序列。
 *
 * 内部先按展示序排序（`sortHand`），所以调用方不必保证输入已排序；
 * 逐张发牌时请只传「已经发到手上」的前缀，`gapBefore` 才不会跳变。
 */
export function handView(hand: readonly Card[], ctx: RuleContext): HandViewItem[] {
  const sorted = sortHand(hand, ctx)
  const out: HandViewItem[] = []
  let prevGroup: number | null = null
  for (const card of sorted) {
    const group = groupKeyOf(card, ctx)
    out.push({ card, group, gapBefore: prevGroup !== null && group !== prevGroup })
    prevGroup = group
  }
  return out
}

/** 需要留间隔的位置数量（= gapBefore 为 true 的张数） */
export function gapCountOf(items: readonly HandViewItem[]): number {
  let n = 0
  for (const it of items) if (it.gapBefore) n++
  return n
}
