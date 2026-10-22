/**
 * 分组与牌型识别
 * 规则依据：规则书 §5.1 §5.2
 *
 * 与反汇编的差异：原版用「5 个组槽 + hint 限流」那套技巧做跟牌校验，
 * 这里改成更直接的语义模型（对子数 / 单张数 / 组列表），行为等价。
 */

import { cardsScore } from './cards'
import { suitSlotOf } from './deal'
import type { Card as C, CardValue, RuleContext, SuitSlot, TypeCode } from './types'

export type GroupKind = 'single' | 'pair' | 'tractor'

export interface Group {
  readonly kind: GroupKind
  readonly cards: readonly C[]
  /** 组内牌力最大的那张 */
  readonly keyCard: C
  /** 对子数：single/pair 为 1，tractor 为连续对子的个数 */
  readonly length: number
}

export interface PlayAnalysis {
  /** 全部牌同属一个槽时为该槽（0..3 花色 / 4 主牌），混槽为 -1 */
  readonly suitSlot: SuitSlot | -1
  /** 0..4 = 纯牌型（等于槽号），10 = 不纯（混槽） */
  readonly typeCode: TypeCode
  /** 组列表，按牌力降序 */
  readonly groups: readonly Group[]
  /** 对子总数（含连对拆出的对子） */
  readonly pairCount: number
  /** 单张总数 */
  readonly singleCount: number
  /** 全副牌里牌力最大的那张；空牌组为 null */
  readonly keyCard: C | null
  /** 分数合计 */
  readonly score: number
  /** 是否多组混出（= 甩牌） */
  readonly isMultiGroup: boolean
}

/** 一手牌里某个槽的统计 */
export interface SlotAnalysis {
  readonly slot: SuitSlot
  /** 按牌力降序 */
  readonly cards: readonly C[]
  /** 该槽内对子数（含连对拆出的对子） */
  readonly pairCount: number
}

export interface HandAnalysis {
  /** 下标即槽号 0..4 */
  readonly slots: readonly SlotAnalysis[]
  /** 某牌值在这手牌里有几张 */
  readonly countOf: (v: CardValue) => number
}

const EMPTY_ANALYSIS: PlayAnalysis = {
  suitSlot: -1,
  typeCode: 10,
  groups: [],
  pairCount: 0,
  singleCount: 0,
  keyCard: null,
  score: 0,
  isMultiGroup: false,
}

/**
 * 解析一副出牌。
 *
 * 牌型判定（对应原版 FUN_00418F64）：
 *   - 没有对子且只有 1 张单牌 → 单张，不是甩牌
 *   - 只有对子（任意多个） → 对子/连对，不是甩牌
 *   - 其余 → 甩牌
 *
 * keyCard 取**全副牌里牌力最大的一张**。对合法甩牌来说这不会出错：
 * 甩牌合法的前提是每一组都是全场最大，所以同花色内没人能压过它，
 * 只有主牌能压，而主牌牌力必然 ≥52 > 任何副牌。
 */
export function analyze(cards: readonly C[], ctx: RuleContext): PlayAnalysis {
  if (cards.length === 0) return EMPTY_ANALYSIS

  const { power } = ctx
  const slots = new Set<SuitSlot>()
  for (const c of cards) slots.add(suitSlotOf(c.value, power))
  const suitSlot: SuitSlot | -1 = slots.size === 1 ? ([...slots][0] as SuitSlot) : -1

  // 按牌值聚合（两副牌同一牌值最多 2 张）
  const byValue = new Map<CardValue, C[]>()
  for (const c of cards) {
    const arr = byValue.get(c.value)
    if (arr) arr.push(c)
    else byValue.set(c.value, [c])
  }

  const pairSeeds: { power: number; cards: C[] }[] = []
  const singles: C[] = []
  for (const [v, cs] of byValue) {
    if (cs.length >= 2) {
      pairSeeds.push({ power: power.get(v), cards: [cs[0] as C, cs[1] as C] })
      for (let i = 2; i < cs.length; i++) singles.push(cs[i] as C)
    } else {
      singles.push(cs[0] as C)
    }
  }
  pairSeeds.sort((a, b) => b.power - a.power)

  // 连对：牌力连续的对子合并成一个 tractor
  const groups: Group[] = []
  let i = 0
  while (i < pairSeeds.length) {
    let j = i
    while (j + 1 < pairSeeds.length && (pairSeeds[j] as { power: number }).power - (pairSeeds[j + 1] as { power: number }).power === 1) j++
    const run = pairSeeds.slice(i, j + 1)
    const runCards = run.flatMap((s) => s.cards)
    const top = (run[0] as { cards: C[] }).cards[0] as C
    groups.push({
      kind: run.length >= 2 ? 'tractor' : 'pair',
      cards: runCards,
      keyCard: top,
      length: run.length,
    })
    i = j + 1
  }

  singles.sort((a, b) => power.get(b.value) - power.get(a.value))
  for (const c of singles) groups.push({ kind: 'single', cards: [c], keyCard: c, length: 1 })

  const pairCount = pairSeeds.length
  const singleCount = singles.length
  // 甩牌 = 多组混出。上面已把连续对子合成 tractor、不连续对子各成 pair、
  // 单张各成 single，所以「多组」恰好等价于 groups.length > 1。
  // 不能只按 pairCount/singleCount 判 —— 那会把「2 个不连续对子」当成单一牌型，
  // 从而在 legality 里被当成合法首出直接放行（白甩两对）。
  const isMultiGroup = groups.length > 1

  let keyCard: C = cards[0] as C
  for (const c of cards) if (power.get(c.value) > power.get(keyCard.value)) keyCard = c

  return {
    suitSlot,
    typeCode: (suitSlot === -1 ? 10 : suitSlot) as TypeCode,
    groups,
    pairCount,
    singleCount,
    keyCard,
    score: cardsScore(cards),
    isMultiGroup,
  }
}

/** 解析整手牌（按槽分组） */
export function analyzeHand(hand: readonly C[], ctx: RuleContext): HandAnalysis {
  const { power } = ctx
  const buckets: C[][] = [[], [], [], [], []]
  const counts = new Map<CardValue, number>()

  for (const c of hand) {
    ;(buckets[suitSlotOf(c.value, power)] as C[]).push(c)
    counts.set(c.value, (counts.get(c.value) ?? 0) + 1)
  }

  const slots: SlotAnalysis[] = buckets.map((cards, slot) => {
    const sorted = [...cards].sort((a, b) => power.get(b.value) - power.get(a.value))
    let pairs = 0
    const seen = new Map<CardValue, number>()
    for (const c of sorted) {
      const n = (seen.get(c.value) ?? 0) + 1
      seen.set(c.value, n)
      if (n === 2) pairs += 1
    }
    return { slot: slot as SuitSlot, cards: sorted, pairCount: pairs }
  })

  return { slots, countOf: (v) => counts.get(v) ?? 0 }
}

/** 该槽的牌数（便捷方法） */
export function slotSize(h: HandAnalysis, slot: SuitSlot): number {
  return (h.slots[slot] as SlotAnalysis).cards.length
}

/** 该槽的对子数（便捷方法） */
export function slotPairs(h: HandAnalysis, slot: SuitSlot): number {
  return (h.slots[slot] as SlotAnalysis).pairCount
}

/** 某手牌在指定槽里最大的单张牌力 / 最大的对子牌力（无则 -1） */
export function bestInSlot(
  hand: readonly C[],
  slot: SuitSlot,
  ctx: RuleContext,
): { maxCardPower: number; maxPairPower: number } {
  const { power } = ctx
  const counts = new Map<CardValue, number>()
  let maxCardPower = -1
  for (const c of hand) {
    if (suitSlotOf(c.value, power) !== slot) continue
    const p = power.get(c.value)
    if (p > maxCardPower) maxCardPower = p
    counts.set(c.value, (counts.get(c.value) ?? 0) + 1)
  }
  let maxPairPower = -1
  for (const [v, n] of counts) {
    if (n < 2) continue
    const p = power.get(v)
    if (p > maxPairPower) maxPairPower = p
  }
  return { maxCardPower, maxPairPower }
}
