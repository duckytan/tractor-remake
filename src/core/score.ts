/**
 * 计分与扣底
 * 规则依据：规则书 §8.1 §8.2，ADR-006
 */

import type { PlayAnalysis } from './analyze'
import { cardsScore } from './cards'
import type { Card } from './types'

/** 扣底倍数：单张 2 / 对子 4 / 拖拉机 8（ADR-006） */
export const BOTTOM_MULTIPLIER = { single: 2, pair: 4, tractor: 8 } as const

export interface BottomBonusResult {
  readonly applies: boolean
  readonly multiplier: number
  readonly extra: number
}

/**
 * 扣底：最后一墩由**闲家**赢时，底分按赢家牌型翻倍计入闲家得分。
 * 庄家方赢下最后一墩则底分作废（不加不减）。
 */
export function calcBottomBonus(
  winnerAnalysis: PlayAnalysis,
  bottomScore: number,
  winnerIsDealerSide: boolean,
): BottomBonusResult {
  if (winnerIsDealerSide) return { applies: false, multiplier: 1, extra: 0 }
  // 空牌型（没有任何组）不该拿到 ×2：旧实现倍数停在初始值 `single`，
  // 于是「赢家的牌型是空的」这种畸形数据会让底分白给（docs/33 C6-06）。
  if (winnerAnalysis.groups.length === 0) return { applies: false, multiplier: 1, extra: 0 }

  let multiplier: number = BOTTOM_MULTIPLIER.single
  for (const g of winnerAnalysis.groups) {
    const m = BOTTOM_MULTIPLIER[g.kind]
    if (m > multiplier) multiplier = m
  }
  return { applies: true, multiplier, extra: bottomScore * multiplier }
}

/** 一墩里分数牌的张数（用于「本墩有几分」提示） */
export function countScoreCards(cards: readonly Card[]): number {
  let n = 0
  for (const c of cards) if (cardsScore([c]) > 0) n += 1
  return n
}
