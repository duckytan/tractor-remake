/**
 * 对局展示视图（app 层）
 *
 * 记录面板 / 各家出牌区需要「花色、是否主牌、队伍、赢家」这些**规则概念**，
 * 全部在这里算成纯数据，ui 层只做 DOM 与样式（分层铁律）。
 */

import type { Card, Seat, Team } from '@core'
import { teamOf } from '@core'
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
