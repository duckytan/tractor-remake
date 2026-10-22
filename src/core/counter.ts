/**
 * 反主（亮主之后用另一门花色的级牌把主改掉）判定。
 *
 * 对齐原版 `FUN_004163A2`（规则书 §3.3）：
 *   ① 必须持有「新花色的级牌」
 *   ② 打王级（强制无将）时主牌固定，不可被花色覆盖（§3.5）
 *   ③ 不能反成当前同一个主
 *   ④ 同队反主需开「允许自反」
 *
 * 另外用 `usedTrumps` 记录本局已用过的定主，保证同一门花色不会被反复来回反（必然终止）。
 */

import { RANKS_PER_SUIT, levelRankToRankIndex } from './cards'
import type { Card, RuleContext, Trump } from './types'

export interface CanCounterOptions {
  /** 反主者的手牌 */
  readonly hand: readonly Card[]
  readonly ctx: RuleContext
  /** 当前主 */
  readonly currentTrump: Trump
  /** 想反成的主 */
  readonly newTrump: Trump
  /** 反主者与当前定主人是否同队（决定「允许自反」是否生效） */
  readonly sameTeamAsDeclarer: boolean
  /** 本局已用过的定主（含首次亮主） */
  readonly usedTrumps: readonly Trump[]
}

/** 反主能力判定。纯函数，不读写任何全局状态。 */
export function canCounter(o: CanCounterOptions): boolean {
  const { hand, ctx, currentTrump, newTrump, sameTeamAsDeclarer, usedTrumps } = o

  // ② 打王级强制无将：主牌固定，任何花色都覆盖不了它（§3.5「不可被花色覆盖」）
  if (ctx.forcedNT) return false

  // ③ 不能反成同一个主；同一门花色也不能被反第二次（保证终止）
  if (newTrump === currentTrump) return false
  if (usedTrumps.includes(newTrump)) return false

  // ④ 同队反主需开「允许自反」
  if (sameTeamAsDeclarer && !ctx.config.allowSelfCounter) return false

  // 反成无将：无将没有「级牌」可依（原版算式 `0x10 * 13 + lv` 永不命中）⇒ 不允许
  if (newTrump === 'NT') return false

  // ① 必须持有新花色的级牌
  const lvRank = levelRankToRankIndex(ctx.levelRank)
  if (lvRank === null) return false
  return hand.some((c) => c.value === newTrump * RANKS_PER_SUIT + lvRank)
}
