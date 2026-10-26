/**
 * 对局展示视图（app 层）
 *
 * 记录面板 / 各家出牌区需要「花色、是否主牌、队伍、赢家」这些**规则概念**，
 * 全部在这里算成纯数据，ui 层只做 DOM 与样式（分层铁律）。
 */

import type { Card, Seat, Team } from '@core'
import { HAND_SIZE } from '@core'
import {
  BIG_JOKER,
  SMALL_JOKER,
  cardScore,
  levelRankToRankIndex,
  makeDeck,
  rankOfValue,
  suitOfValue,
  teamOf,
} from '@core'
import { trickStanding } from '@core'
import type { GameState, TrickRecord } from './state'
import { ctxOf } from './state'

const SHORT_SEAT = ['南', '西', '北', '东'] as const
const SUIT_CHAR = ['♠', '♥', '♣', '♦'] as const
const RANK_TEXT = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'] as const

export function seatShortLabel(seat: Seat): string {
  return SHORT_SEAT[seat]
}

export interface LogCard {
  /** 牌面文字，如 ♠A / 大王 */
  readonly text: string
  /** 花色 0..3；王牌为 null */
  readonly suit: number | null
  /** 是否主牌（决定是否加主牌色描边） */
  readonly isTrump: boolean
}

export interface LogPlay {
  readonly seat: Seat
  readonly label: string
  readonly team: Team
  readonly cards: readonly LogCard[]
  readonly isWinner: boolean
}

export interface LogTrick {
  /** 墩号（1 起） */
  readonly no: number
  readonly winner: Seat
  readonly winnerLabel: string
  readonly winnerTeam: Team
  readonly score: number
  readonly isDealerWin: boolean
  readonly plays: readonly LogPlay[]
}

/** 一张牌的展示信息 */
export function logCard(c: Card, isTrump: boolean): LogCard {
  const v = c.value
  if (v >= 52) {
    return { text: v === 53 ? '大王' : '小王', suit: null, isTrump }
  }
  const suit = Math.floor(v / 13)
  return { text: `${SUIT_CHAR[suit] as string}${RANK_TEXT[v % 13] as string}`, suit, isTrump }
}

/**
 * 对局记录视图。**已倒序**（最新一墩在最上面）。
 *
 * 现算牌力表只为判断「是否主牌」（配色用），不参与任何规则判定。
 */
export function trickLogView(s: GameState): LogTrick[] {
  const { power } = ctxOf(s)
  const dealerTeam = teamOf(s.dealer)

  return s.history
    .map((t, i) => ({
      // 墩号按 history 的时间顺序编号（i=0 是第 1 墩），再整体倒序展示
      no: i + 1,
      winner: t.winner,
      winnerLabel: seatShortLabel(t.winner),
      winnerTeam: teamOf(t.winner),
      score: t.score,
      isDealerWin: teamOf(t.winner) === dealerTeam,
      plays: t.plays.map((p) => ({
        seat: p.seat,
        label: seatShortLabel(p.seat),
        team: teamOf(p.seat),
        cards: p.cards.map((c) => logCard(c, power.isTrump(c.value))),
        isWinner: p.seat === t.winner,
      })),
    }))
    .reverse()
}

export interface PastPlays {
  /** 墩号（1 起），与 tricks 一一对应 */
  readonly nos: readonly number[]
  /** 每一墩该座位出的牌（按时间正序，最新一墩在最后） */
  readonly tricks: readonly (readonly Card[])[]
}

/**
 * 某个座位在最近 `depth` 墩里出的牌。
 *
 * 现实里打完的牌就摆在自己面前，所以历史小牌**按座位分开**，
 * 不再把四家的牌堆在同一个玩家前面（那既不真实，也会让人误读成"谁的牌多"）。
 */
export function pastPlaysView(s: GameState, seat: Seat, depth: number): PastPlays {
  const total = s.history.length
  const from = Math.max(0, total - depth)
  const nos: number[] = []
  const tricks: (readonly Card[])[] = []
  for (let i = from; i < total; i++) {
    const t = s.history[i] as TrickRecord
    const p = t.plays.find((x) => x.seat === seat)
    nos.push(i + 1)
    tricks.push(p ? p.cards : [])
  }
  return { nos, tricks }
}

/* ---------- 逐墩回放（v1.3.16） ---------- */

/**
 * 出牌区这一帧该显示哪些牌：回放时是「那一墩的历史出牌」，否则是当前墩。
 * 抽成纯函数是为了让 `ui/render.ts` 的 `fillPlays` 只剩 DOM 操作，且这条分支可单测。
 */
export function displayPlays(s: GameState): readonly { readonly seat: Seat; readonly cards: readonly Card[] }[] {
  if (s.replayAt === null) return s.trick.plays
  return s.history[s.replayAt]?.plays ?? []
}

export interface ReplaySummary {
  /** 0 基下标 */
  readonly index: number
  readonly total: number
  readonly winnerLabel: string
  readonly score: number
  readonly isFirst: boolean
  readonly isLast: boolean
}

/** 回放状态栏要显示的东西；不在回放时返回 null */
export function replaySummary(s: GameState): ReplaySummary | null {
  if (s.replayAt === null) return null
  const rec = s.history[s.replayAt]
  return {
    index: s.replayAt,
    total: s.history.length,
    winnerLabel: rec ? seatShortLabel(rec.winner) : '',
    score: rec ? rec.score : 0,
    isFirst: s.replayAt === 0,
    isLast: s.replayAt >= s.history.length - 1,
  }
}

/* ---------- 发牌进度（v1.3.15） ---------- */

/**
 * 某一家在发牌进度 `revealed` 时「应该已经看到几张牌」。
 *
 * 纯展示口径，规则零影响：`GameState.hands` 从开局就是完整的，
 * 只有 `revealed`（0..DEAL_TOTAL）在推进。逐张发牌是「每 tick 四家各得 1 张」，
 * 第 26 tick 起只有庄家再得 1 张（庄家 33 张）。
 *
 * 人类的手牌由 `render` 按 `revealed` 截断；AI 家的牌背也用它逐张长出来 ——
 * 之前三家的牌背是「啪」一下全出现，与人类手牌的逐张飞行不一致。
 */
export function dealtCardsFor(s: GameState, seat: Seat): number {
  return dealtCardsAt(s, seat, s.revealed)
}

/**
 * 这一帧某一家「新长出来的那张牌背」的下标（没有则 -1）。
 *
 * 三种情况都不该飞：
 * ① 张数没增加（同一 tick 只发一张）；
 * ② 牌背数量被布局上限截断（侧家最多 10 张）—— 否则会把已经显示的那张
 *    **反复重飞**（v1.3.15 踩过）；
 * ③ 一家都没有（domCount = 0）。
 */
export function newBackIndex(
  s: GameState,
  seat: Seat,
  prevRevealed: number,
  domCount: number,
): number {
  const before = dealtCardsAt(s, seat, prevRevealed)
  const after = dealtCardsAt(s, seat, s.revealed)
  if (after <= before) return -1
  if (after > domCount) return -1
  return after - 1
}

/** 同上，但显式给发牌进度（动画要算「上一帧该有几张」） */
export function dealtCardsAt(s: GameState, seat: Seat, revealed: number): number {
  const hand = s.hands[seat] as readonly Card[]
  if (s.phase !== 'contract') return hand.length
  const base = Math.min(HAND_SIZE, revealed)
  const extra = seat === s.dealer ? Math.max(0, revealed - HAND_SIZE) : 0
  return Math.min(hand.length, base + extra)
}

/* ---------- 记牌器（v1.3.14） ----------
 *
 * 只统计**已经打出来的牌**：底牌 8 张谁也不知道，所以这里的「未出」=
 * 总数 − 已出（含仍在手里 + 还在底里的）。界面上要按这个口径措辞。
 *
 * 全部在 app 层算成纯数据（ui 不许碰 power / 规则概念，分层铁律）。
 */

export interface CounterSlot {
  /** 未出的张数（总数 − 已出） */
  readonly left: number
  readonly total: number
}

export interface CounterView {
  readonly bigJoker: CounterSlot
  readonly smallJoker: CounterSlot
  /** 主花色级牌 */
  readonly levelTrump: CounterSlot
  /** 其他三门的级牌（无将时 = 全部级牌） */
  readonly levelOff: CounterSlot
  /** 主牌总数（含王、级牌、以及「2 为常主」时的 2） */
  readonly trumps: CounterSlot
  /** 已打出的分数 / 全场总分 */
  readonly pointsPlayed: number
  readonly pointsTotal: number
}

/** 完整牌堆只建一次（108 张，记牌器的「总数」全靠它） */
let fullDeckCache: readonly Card[] | null = null
function fullDeck(): readonly Card[] {
  fullDeckCache ??= makeDeck()
  return fullDeckCache
}

/** 本局已经打出来的牌：历史每一墩 + 当前墩 */
function playedCards(s: GameState): Card[] {
  const out: Card[] = []
  for (const t of s.history) for (const p of t.plays) out.push(...p.cards)
  for (const p of s.trick.plays) out.push(...p.cards)
  return out
}

export function counterView(s: GameState): CounterView {
  const ctx = ctxOf(s)
  const deck = fullDeck()
  const played = playedCards(s)
  const countIn = (pool: readonly Card[], pred: (c: Card) => boolean): number => {
    let n = 0
    for (const c of pool) if (pred(c)) n += 1
    return n
  }
  const slot = (pred: (c: Card) => boolean): CounterSlot => {
    const total = countIn(deck, pred)
    return { total, left: total - countIn(played, pred) }
  }

  const levelIdx = levelRankToRankIndex(s.levelRank)
  const isLevel = (c: Card): boolean => levelIdx !== null && rankOfValue(c.value) === levelIdx
  const trumpSuit = s.forcedNT || s.trump === 'NT' ? null : s.trump
  const isLevelTrump = (c: Card): boolean =>
    isLevel(c) && trumpSuit !== null && suitOfValue(c.value) === trumpSuit

  return {
    bigJoker: slot((c) => c.value === BIG_JOKER),
    smallJoker: slot((c) => c.value === SMALL_JOKER),
    levelTrump: slot(isLevelTrump),
    levelOff: slot((c) => isLevel(c) && !isLevelTrump(c)),
    trumps: slot((c) => ctx.power.isTrump(c.value)),
    pointsPlayed: played.reduce((n, c) => n + cardScore(c.value), 0),
    pointsTotal: deck.reduce((n, c) => n + cardScore(c.value), 0),
  }
}

/**
 * 本墩「当前谁最大」—— 用于出牌区的领先光晕与座位标签的赢家高亮。
 *
 * **别用 `state.trick.winner`**：那个字段在出牌途中恒为 `null`（只有结算时
 * `resolveTrick` 算出的赢家才会写进 `history`）。v1.3.24 之前座位标签的
 * `.is-win` 高亮一直没生效，就是因为它比的是这个永远为 null 的字段。
 *
 * 判定必须走 `trickStanding()` —— 全项目唯一的一墩判定入口，
 * 能把「垫牌（混花色）」和「结构不符」正确排除掉，不是简单比 keyCard。
 */
export function leadingSeat(s: GameState): Seat | null {
  if (s.phase !== 'play' || s.replayAt !== null) return null
  if (s.trick.plays.length === 0) return null
  return trickStanding(s.trick.plays, ctxOf(s))?.winner.seat ?? null
}
