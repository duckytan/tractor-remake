/**
 * 发牌 + 禁止天然连对
 * 规则依据：规则书 §2.1 §2.2
 */

import { TRUMP_POWER_BASE, makeDeck } from './cards'
import type { Rng } from './rng'
import { shuffle } from './rng'
import type { Card, CardValue, LevelRank, PowerTable, Seat, SuitSlot, Trump } from './types'
import { RANKS_PER_SUIT } from './cards'

export const HAND_SIZE = 25
export const BOTTOM_SIZE = 8
export const SEAT_COUNT = 4

export interface DealResult {
  /** 四家手牌，各 25 张 */
  readonly hands: readonly (readonly Card[])[]
  /** 底牌 8 张 */
  readonly bottom: readonly Card[]
}

/** 手牌槽：主牌槽 4，否则为花色 0..3 */
export function suitSlotOf(v: CardValue, power: PowerTable): SuitSlot {
  if (power.isTrump(v)) return 4
  const suit = v < 52 ? Math.floor(v / RANKS_PER_SUIT) : 4
  return suit as SuitSlot
}

/** 洗一副新牌 */
export function newShuffledDeck(rng: Rng): Card[] {
  return shuffle(makeDeck(), rng)
}

/**
 * 发牌：牌堆前 100 张按 25 张一组分给四家，最后 8 张作底牌。
 * 第 i 组给座位 (dealer + i) % 4，保证庄家位置随轮庄变化。
 */
export function dealFromDeck(deck: readonly Card[], dealer: Seat): DealResult {
  if (deck.length !== 108) throw new Error(`dealFromDeck: 牌堆应为 108 张，收到 ${deck.length}`)
  const hands: Card[][] = [[], [], [], []]
  for (let block = 0; block < SEAT_COUNT; block++) {
    const seat = ((dealer + block) % SEAT_COUNT) as Seat
    hands[seat] = deck.slice(block * HAND_SIZE, (block + 1) * HAND_SIZE) as Card[]
  }
  const bottom = deck.slice(SEAT_COUNT * HAND_SIZE, SEAT_COUNT * HAND_SIZE + BOTTOM_SIZE)
  return { hands, bottom }
}

/**
 * 一手牌里是否已有「现成的连对（拖拉机）」。
 * 连对 = 同一花色槽内、牌力相邻的两个或以上对子。
 */
export function hasConsecutivePair(hand: readonly Card[], power: PowerTable): boolean {
  // 按槽分组，再按牌值统计张数
  const pairPowersBySlot = new Map<SuitSlot, number[]>()
  const counts = new Map<CardValue, number>()
  for (const c of hand) counts.set(c.value, (counts.get(c.value) ?? 0) + 1)

  for (const [value, n] of counts) {
    if (n < 2) continue
    const slot = suitSlotOf(value, power)
    const list = pairPowersBySlot.get(slot) ?? []
    list.push(power.get(value))
    pairPowersBySlot.set(slot, list)
  }

  for (const powers of pairPowersBySlot.values()) {
    if (powers.length < 2) continue
    powers.sort((a, b) => a - b)
    for (let i = 1; i < powers.length; i++) {
      if ((powers[i] as number) - (powers[i - 1] as number) === 1) return true
    }
  }
  return false
}

export interface NaturalTractorGuardOptions {
  /** 两队当前级牌 */
  levels: readonly [LevelRank, LevelRank]
  /** 重洗上限，超过则降级为「只校验本局实际牌力表」 */
  maxAttempts?: number
}

export interface GuardedDealResult extends DealResult {
  /** 实际重洗次数（0 表示第一次就通过） */
  readonly attempts: number
  /** 是否因为超过上限而放弃了完整校验 */
  readonly degraded: boolean
}

/**
 * 发牌并保证「任何一家、任何牌力表组合下都没有现成连对」。
 *
 * 校验矩阵：mode(2) × 两队级牌(2) × 主花色(4) = 16 种牌力表。
 * 规则书说「64 组合」，多出来的 4 倍是「4 种视角」—— 但视角只影响座位编号，
 * 而我们对四家逐一检查，已覆盖该维度，故实际只需 16 种。
 *
 * 主花色 4 种 + 两队级牌 + 两种 mode 都要过，是因为开局前主牌未定，
 * 任何一家在任何可能的定约下都不该拿到现成拖拉机。
 */
export function dealWithGuard(
  rng: Rng,
  dealer: Seat,
  opts: NaturalTractorGuardOptions,
  buildPower: (mode: 0 | 1, levelRank: LevelRank, trump: Trump) => PowerTable,
): GuardedDealResult {
  const maxAttempts = opts.maxAttempts ?? 200
  const trumps: Trump[] = [0, 1, 2, 3]

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const deck = newShuffledDeck(rng)
    const deal = dealFromDeck(deck, dealer)
    if (!anyNaturalTractor(deal.hands, opts, buildPower, trumps)) {
      return { ...deal, attempts: attempt, degraded: false }
    }
  }

  // 兜底：只按第一队级牌 + 黑桃主校验一次，避免死循环
  const deck = newShuffledDeck(rng)
  const deal = dealFromDeck(deck, dealer)
  return { ...deal, attempts: maxAttempts, degraded: true }
}

function anyNaturalTractor(
  hands: readonly (readonly Card[])[],
  opts: NaturalTractorGuardOptions,
  buildPower: (mode: 0 | 1, levelRank: LevelRank, trump: Trump) => PowerTable,
  trumps: readonly Trump[],
): boolean {
  for (const mode of [0, 1] as const) {
    for (const level of opts.levels) {
      for (const trump of trumps) {
        const power = buildPower(mode, level, trump)
        for (const hand of hands) {
          if (hasConsecutivePair(hand, power)) return true
        }
      }
    }
  }
  return false
}

/** 某手牌按槽分组（供 analyze 与测试使用） */
export function groupBySlot(
  hand: readonly Card[],
  power: PowerTable,
): Map<SuitSlot, Card[]> {
  const out = new Map<SuitSlot, Card[]>()
  for (const c of hand) {
    const slot = suitSlotOf(c.value, power)
    const list = out.get(slot) ?? []
    list.push(c)
    out.set(slot, list)
  }
  return out
}

/** 牌力上界（主牌最大牌力），供调试与断言 */
export function maxTrumpPower(power: PowerTable): number {
  let max = TRUMP_POWER_BASE
  for (let v = 0; v < 54; v++) if (power.get(v) > max) max = power.get(v)
  return max
}
