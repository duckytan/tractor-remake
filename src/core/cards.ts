/**
 * 牌与牌力表
 * 规则依据：docs/tractor-游戏规则规格书.md §1.1 §1.2 §4.1
 *
 * 与反汇编的差异：数值不逐位对齐原版，但**次序与相邻关系完全一致**。
 * 这一点是刻意的 —— 连对（拖拉机）判定依赖「牌力差 1」，
 * 所以主牌序列必须稠密（52,53,54… 无空洞），副牌序列同理。
 */

import type { Card, CardValue, LevelRank, Power, PowerTable, Rank, Suit, Trump } from './types'

export const DECK_SIZE = 108
export const CARD_VALUE_COUNT = 54
export const RANKS_PER_SUIT = 13
export const SMALL_JOKER: CardValue = 52
export const BIG_JOKER: CardValue = 53
/** 主牌牌力下界。副牌全部 < 52，主牌全部 ≥ 52 */
export const TRUMP_POWER_BASE = 52

/* ---------- 牌值编解码 ---------- */

/** 物理牌位 → 牌值（两副牌折叠：0/1 → 0，2/3 → 1 …） */
export function valueOfCardId(id: number): CardValue {
  if (!Number.isInteger(id) || id < 0 || id >= DECK_SIZE) {
    throw new Error(`valueOfCardId: id 越界 ${id}`)
  }
  return id >> 1
}

/** 108 张物理牌 */
export function makeDeck(): Card[] {
  const out: Card[] = new Array(DECK_SIZE)
  for (let id = 0; id < DECK_SIZE; id++) out[id] = { id, value: id >> 1 }
  return out
}

export function isJokerValue(v: CardValue): boolean {
  return v >= SMALL_JOKER
}

/** 牌值 → 花色；王牌返回 null */
export function suitOfValue(v: CardValue): Suit | null {
  return isJokerValue(v) ? null : (Math.floor(v / RANKS_PER_SUIT) as Suit)
}

/** 牌值 → 点数下标；王牌返回 null */
export function rankOfValue(v: CardValue): Rank | null {
  return isJokerValue(v) ? null : ((v % RANKS_PER_SUIT) as Rank)
}

/** 花色 + 点数 → 牌值 */
export function cardValueOf(suit: Suit, rank: Rank): CardValue {
  return suit * RANKS_PER_SUIT + rank
}

/**
 * 级牌（1..13 = A,2,3,…,K）→ 点数下标（0..12 = 2,3,…,A）。
 * 打王级（18）没有对应点数，返回 null。
 *
 * 例：A(1) → 12，2(2) → 0，K(13) → 11
 */
export function levelRankToRankIndex(lr: LevelRank): Rank | null {
  if (lr === 18) return null
  return ((lr + 11) % RANKS_PER_SUIT) as Rank
}

/* ---------- 分数牌 ---------- */

/**
 * 单张牌的分值。5 → 5 分，10 → 10 分，K → 10 分，其余 0。
 * 两副牌 108 张合计 200 分。
 */
export function cardScore(v: CardValue): number {
  const r = rankOfValue(v)
  if (r === null) return 0 // 王不计分
  if (r === 3) return 5 // 点数 5
  if (r === 8) return 10 // 点数 10
  if (r === 11) return 10 // 点数 K
  return 0
}

/** 一组牌的分数合计 */
export function cardsScore(cards: readonly Card[]): number {
  let sum = 0
  for (const c of cards) sum += cardScore(c.value)
  return sum
}

/* ---------- 牌力表 ---------- */

export interface BuildPowerOptions {
  /** 1 = 2 为常主 */
  mode: 0 | 1
  /** 本局打的级别 */
  levelRank: LevelRank
  /** 主牌标识 */
  trump: Trump
  /** 打王级强制无将：无主花色，且级牌不提升 */
  forcedNT?: boolean
}

/**
 * 构建牌力表。
 *
 * 排列规则（从大到小）：
 *   有主花色：大王 > 小王 > 主级牌 > 副级牌 > [主2 > 副2] > 主花色普通牌
 *   主动无将：大王 > 小王 > 四门级牌（并列） > [四门2（并列）] > 普通牌
 *   打王级  ：大王 > 小王 > 普通牌（级牌不提升）
 *
 * 方括号内仅在 mode=1（2 为常主）时存在，且级牌本身是 2 时不重复提升。
 *
 * 保证的不变量：
 *   ① 主牌 power 全部 ≥ 52，副牌全部 < 52
 *   ② 主牌序列稠密（去重后是 52,53,54,… 连续整数）
 *   ③ 副牌序列稠密（0,1,2,… 连续整数）
 *   —— ②③ 是连对判定的基础（相邻 ⇔ 牌力差 1）
 */
export function buildPowerTable(o: BuildPowerOptions): PowerTable {
  const { mode, trump } = o
  const forcedNT = o.forcedNT === true
  const power = new Array<number>(CARD_VALUE_COUNT).fill(0)

  const lvRank = forcedNT ? null : levelRankToRankIndex(o.levelRank)
  const promoteTwo = !forcedNT && mode === 1 && lvRank !== 0
  const trumpSuit: Suit | null = forcedNT || trump === 'NT' ? null : trump

  // 被提升为「主」的点数
  const promoted = new Set<Rank>()
  if (lvRank !== null) promoted.add(lvRank)
  if (promoteTwo) promoted.add(0)

  // 普通点数（升序）。主花色与副牌共用同一套相对次序
  const ordinary: Rank[] = []
  for (let r = 0; r < RANKS_PER_SUIT; r++) {
    if (!promoted.has(r as Rank)) ordinary.push(r as Rank)
  }

  /* ---- 副牌：0,1,2,… 稠密编号 ---- */
  for (let s = 0; s < 4; s++) {
    if (s === trumpSuit) continue
    ordinary.forEach((r, i) => {
      power[s * RANKS_PER_SUIT + r] = i
    })
  }

  /* ---- 主牌：从 52 起，按「低 → 高」依次编号 ---- */
  let next = TRUMP_POWER_BASE

  if (trumpSuit !== null) {
    // 主花色普通牌
    for (const r of ordinary) power[trumpSuit * RANKS_PER_SUIT + r] = next++
    // 副 2（三门外花色并列）→ 主 2
    if (promoteTwo) {
      for (let s = 0; s < 4; s++) if (s !== trumpSuit) power[s * RANKS_PER_SUIT] = next
      next++
      power[trumpSuit * RANKS_PER_SUIT] = next++
    }
    // 副级牌（三门外花色并列）→ 主级牌
    if (lvRank !== null) {
      for (let s = 0; s < 4; s++) {
        if (s !== trumpSuit) power[s * RANKS_PER_SUIT + lvRank] = next
      }
      next++
      power[trumpSuit * RANKS_PER_SUIT + lvRank] = next++
    }
  } else if (lvRank !== null) {
    // 主动无将：没有主花色，四门级牌并列
    if (promoteTwo) {
      for (let s = 0; s < 4; s++) power[s * RANKS_PER_SUIT] = next
      next++
    }
    for (let s = 0; s < 4; s++) power[s * RANKS_PER_SUIT + lvRank] = next
    next++
  }
  // forcedNT 走不到这里：lvRank 为 null、promoteTwo 为 false，主牌只剩王

  power[SMALL_JOKER] = next++
  power[BIG_JOKER] = next++

  const get = (v: CardValue): Power => {
    if (!Number.isInteger(v) || v < 0 || v >= CARD_VALUE_COUNT) {
      throw new Error(`PowerTable.get: 牌值越界 ${v}`)
    }
    return power[v] as Power
  }

  return {
    get,
    of: (c: Card) => get(c.value),
    isTrump: (v: CardValue) => get(v) >= TRUMP_POWER_BASE,
  }
}
