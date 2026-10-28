/**
 * 对局数据记录（v1.3.42）
 *
 * 目的：让玩家多打几局之后，能用**真实对局**做分析，而不是只看内部标定数字。
 * 记的是"复盘够用、体积很小"的那一层：开局四家手牌 + 每墩出牌 + 结算 + 你的每个出牌决策。
 *
 * 三条设计约束：
 *   ① **体积**：一局约 2KB（牌只存 `value` 整数），30 局 ~60KB，localStorage 完全放得下。
 *      所以不存每张牌的 SVG/文本，也不存 AI 的候选与打分（那是调试用的，另开开关）。
 *   ② **可分角色复盘**：`human[]` 里同时记「你实际出的牌」和「同局面 L3 会出的牌」（影子决策），
 *      这是分析"你和 AI 差在哪"的唯一依据 —— 也是将来扩充标注题库的素材来源。
 *   ③ **可重放**：`seed + config` 一起存。同版本下 `newGame(seed, config)` 能重现同一副牌，
 *      将来规则改了也能判断"这局是按哪套规则打的"。
 *
 * 与 `stats.ts` 分开：那个只统计胜负（几行数字），这个是完整复盘数据。
 */

import type { LevelRank, RuleConfig, Seat, Trump } from '@core'
import type { GameState } from './state'
import { HUMAN_SEAT } from './state'

const KEY = 'tractor.logs.v1'
/** 保留最近多少局（约 2KB/局） */
const KEEP = 30

export interface LoggedTrick {
  readonly leader: Seat
  /** 按出牌顺序：[座位, 牌值数组] */
  readonly plays: readonly (readonly [Seat, readonly number[]])[]
  readonly winner: Seat
  readonly score: number
}

/** 你的一个出牌决策 */
export interface LoggedHumanPlay {
  /** 第几墩（0 基，对应 `tricks` 下标） */
  readonly trick: number
  /** 你实际出的牌（牌值） */
  readonly cards: readonly number[]
  /** 同一局面、L3 会出的牌（影子决策，用于算"分歧率"） */
  readonly ai: readonly number[]
  /** 出这一手之前有没有看提示 */
  readonly hint: boolean
}

export interface RoundLog {
  readonly v: 1
  readonly app: string
  readonly ts: number
  readonly seed: number
  readonly round: number
  readonly config: RuleConfig
  readonly levelRank: LevelRank
  readonly trump: Trump
  readonly forcedNT: boolean
  readonly dealer: Seat
  readonly ai: {
    readonly partner: number
    readonly opponent: number
    readonly auto: number
    readonly peek: boolean
    readonly hintStyle: string
  }
  /** 开局四家手牌（牌值；庄家含底牌那 8 张） */
  readonly hands: readonly (readonly number[])[]
  readonly bottom: readonly number[]
  readonly tricks: readonly LoggedTrick[]
  readonly human: readonly LoggedHumanPlay[]
  readonly settle: {
    readonly defenderScore: number
    readonly levels: number
    readonly actualLevels: number
    readonly dealerChanged: boolean
    readonly newDealer: Seat
    readonly gameOver: boolean
    readonly levelUpTeam: number
  }
}

interface Store {
  readonly rounds: readonly RoundLog[]
}

let cache: Store = { rounds: [] }
/** 当前这一局的开局快照（进入 play/bury 时抓，结算时合并） */
let pending: {
  seed: number
  round: number
  hands: readonly (readonly number[])[]
  human: LoggedHumanPlay[]
} | null = null

const values = (cards: readonly { value: number }[]): number[] => cards.map((c) => c.value)

export function initRoundLog(): void {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) {
      cache = { rounds: [] }
      return
    }
    const o = JSON.parse(raw) as { rounds?: unknown }
    cache = { rounds: Array.isArray(o.rounds) ? (o.rounds as RoundLog[]) : [] }
  } catch {
    cache = { rounds: [] }
  }
}

export const loggedRounds = (): readonly RoundLog[] => cache.rounds

/**
 * 抓开局快照。调用点：`phase` 刚从 `contract` 进入 `bury` / `play` 时。
 *
 * 此时四家手牌是完整的（人类坐庄是 33 张，AI 坐庄已埋底但 `bottom` 有 8 张），
 * 再晚就出过牌了、复盘时看不到原始手牌。
 */
export function beginRound(s: GameState): void {
  pending = {
    seed: s.seed,
    round: s.round,
    hands: s.hands.map((h) => values(h as readonly { value: number }[])),
    human: [],
  }
}

/**
 * 记一个人类出牌决策。
 *
 * @param before  出牌**之前**的状态（影子决策要用它算）
 * @param cards   实际出的牌
 * @param ai      同局面 L3 会出的牌（调用方算好传进来，避免本模块依赖 AI 层）
 */
export function noteHumanPlay(
  before: GameState,
  cards: readonly { value: number }[],
  ai: readonly { value: number }[],
  /** 这一手之前有没有点过提示 —— **必须由调用方显式给**：
   *  点牌会 `setSelection` 清掉 `hintIds`，等到出牌时再读它永远是空的（实测踩到） */
  hintUsed: boolean,
): void {
  if (pending === null) return
  pending.human.push({
    trick: before.history.length,
    cards: values(cards),
    ai: values(ai),
    hint: hintUsed,
  })
}

/**
 * 结算时落库（幂等：同一 `seed-round` 只记一次）。
 *
 * **没有开局快照也照记**（`hands`/`human` 留空）：`pending` 是模块级状态，
 * 中途刷新页面就会丢 —— 如果这时整局都不记，玩家一刷新就白打一局。
 * 缺手牌只影响"复盘开局手牌"，每墩出牌与结算仍然完整，分析价值保留大半。
 */
export function finishRound(s: GameState): void {
  const r = s.lastSettle
  if (!r) return
  // 幂等：同一局只落一条（悔牌回到结算、重进面板都会再次触发）
  if (cache.rounds.some((x) => x.seed === s.seed && x.round === s.round)) return
  const snap = pending
  pending = null
  // 快照与结算对不上（中途重开过）⇒ 只丢快照，不丢这一局
  const sameRound = snap !== null && snap.seed === s.seed && snap.round === s.round

  const log: RoundLog = {
    v: 1,
    app: __APP_VERSION__,
    ts: Date.now(),
    seed: s.seed,
    round: s.round,
    config: s.config,
    levelRank: s.levelRank,
    trump: s.trump,
    forcedNT: s.forcedNT,
    dealer: s.dealer,
    ai: {
      partner: s.aiLevelPartner,
      opponent: s.aiLevelOpponent,
      auto: s.autoLevel,
      peek: s.aiPeekHands,
      hintStyle: s.hintStyle,
    },
    hands: sameRound ? snap.hands : [],
    bottom: values(s.bottom as readonly { value: number }[]),
    tricks: s.history.map((t) => ({
      leader: t.leader,
      plays: t.plays.map((p) => [p.seat, values(p.cards)] as const),
      winner: t.winner,
      score: t.score,
    })),
    human: sameRound ? snap.human : [],
    settle: {
      defenderScore: r.defenderScore,
      levels: r.levels,
      actualLevels: r.actualLevels,
      dealerChanged: r.dealerChanged,
      newDealer: r.newDealer,
      gameOver: r.gameOver,
      levelUpTeam: r.levelUpTeam,
    },
  }

  cache = { rounds: [...cache.rounds, log].slice(-KEEP) }
  try {
    localStorage.setItem(KEY, JSON.stringify(cache))
  } catch {
    /* 隐私模式写不进去：内存里仍然有效 */
  }
}

/** 导出为可读 JSON（玩家点一下下载，之后拖进对话给我分析） */
export function exportRounds(): string {
  return JSON.stringify(
    {
      app: 'tractor-remake',
      version: __APP_VERSION__,
      exportedAt: new Date().toISOString(),
      note: '牌用牌值整数表示：0-12♠ 13-25♥ 26-38♣ 39-51♦ 52小王 53大王（rank 0=2 … 12=A）',
      rounds: cache.rounds,
    },
    null,
    1,
  )
}

export function clearRoundLogs(): void {
  cache = { rounds: [] }
  pending = null
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* 忽略 */
  }
}

/** 供 UI 提示"已记录几局" */
export const logSummary = (): { rounds: number } => ({ rounds: cache.rounds.length })

export { HUMAN_SEAT }
