/**
 * 测试辅助：构造牌与规则上下文
 */
import {
  DEFAULT_RULE_CONFIG,
  buildPowerTable,
  cardValueOf,
} from '@core'
import type { Card, LevelRank, Rank, RuleConfig, RuleContext, Suit, Trump } from '@core'

/** 按花色+点数造一张牌。copy 区分两副牌里的同一张 */
export function C(suit: Suit, rank: Rank, copy: 0 | 1 = 0): Card {
  const value = cardValueOf(suit, rank)
  return { id: value * 2 + copy, value }
}

/** 造王。big=true 大王 */
export function J(big: boolean, copy: 0 | 1 = 0): Card {
  const value = big ? 53 : 52
  return { id: value * 2 + copy, value }
}

/** 造一对 */
export function P(suit: Suit, rank: Rank): [Card, Card] {
  return [C(suit, rank, 0), C(suit, rank, 1)]
}

export interface CtxOptions {
  mode?: 0 | 1
  levelRank?: LevelRank
  trump?: Trump
  forcedNT?: boolean
  config?: Partial<RuleConfig>
}

export function ctx(o: CtxOptions = {}): RuleContext {
  const mode = o.mode ?? 0
  const levelRank = o.levelRank ?? 2
  const trump = o.trump ?? 0
  const forcedNT = o.forcedNT ?? false
  return {
    power: buildPowerTable({ mode, levelRank, trump, forcedNT }),
    trump,
    levelRank,
    forcedNT,
    config: { ...DEFAULT_RULE_CONFIG, ...o.config },
  }
}

/** 方便打印：把牌转成 'S2' / 'H10' / 'BJ' 这样的短名 */
export function name(c: Card): string {
  const v = c.value
  if (v === 52) return 'SJ'
  if (v === 53) return 'BJ'
  const suits = ['S', 'H', 'C', 'D']
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']
  return `${suits[Math.floor(v / 13)]}${ranks[v % 13]}`
}

export const names = (cs: readonly Card[]): string => cs.map(name).join(' ')
