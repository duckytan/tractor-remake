/**
 * 游戏状态与动作定义
 *
 * 状态必须可 JSON 序列化：不存 PowerTable、不存函数、不存 Map/Set。
 * 牌力表由 (trump, levelRank, forcedNT, config) 现算 —— 见 ctxOf()。
 */

import type { AiLevel } from '@ai/policy'
import type {
  Card,
  LevelRank,
  Play,
  PlayRejectReason,
  RuleConfig,
  RuleContext,
  Seat,
  SettleResult,
  Trump,
} from '@core'
import { DEFAULT_RULE_CONFIG, buildPowerTable } from '@core'

export const STATE_VERSION = 1
export const HUMAN_SEAT: Seat = 0

export type Phase = 'contract' | 'bury' | 'play' | 'settle' | 'over'

export interface TrickRecord {
  readonly leader: Seat
  readonly plays: readonly { readonly seat: Seat; readonly cards: readonly Card[] }[]
  readonly winner: Seat
  readonly score: number
}

export interface GameState {
  readonly version: number
  readonly phase: Phase
  readonly config: RuleConfig
  readonly seed: number
  readonly step: number
  readonly round: number
  /** 队 0（座位 0/2）与队 1（座位 1/3）的级牌 */
  readonly levels: { readonly a: LevelRank; readonly b: LevelRank }
  readonly dealer: Seat
  readonly trump: Trump
  readonly forcedNT: boolean
  /** 本局打的级别（= 庄家队的级牌） */
  readonly levelRank: LevelRank
  /** 四家手牌。埋底前庄家 33 张，埋底后都是 25 张 */
  readonly hands: readonly (readonly Card[])[]
  /** 底牌 8 张 */
  readonly bottom: readonly Card[]
  readonly bottomScore: number
  readonly trick: {
    readonly leader: Seat
    readonly plays: readonly Play[]
    readonly winner: Seat | null
  }
  readonly tricksDone: number
  readonly defenderScore: number
  readonly history: readonly TrickRecord[]
  /** 已选中但未出的牌 id */
  readonly selected: readonly number[]
  readonly lastReject: { readonly reason: PlayRejectReason; readonly detail: string } | null
  readonly notice: string | null
  readonly lastSettle: SettleResult | null
  readonly aiLevel: AiLevel
  readonly aiSpeedMs: number
  readonly fourColor: boolean
}

export type Action =
  | { readonly type: 'newGame'; readonly seed?: number }
  | { readonly type: 'declareTrump'; readonly trump: Trump }
  | { readonly type: 'bury'; readonly ids: readonly number[] }
  | { readonly type: 'toggleSelect'; readonly id: number }
  | { readonly type: 'setSelection'; readonly ids: readonly number[] }
  | { readonly type: 'clearSelect' }
  | { readonly type: 'playSelected' }
  | { readonly type: 'aiStep' }
  | { readonly type: 'nextRound' }
  | { readonly type: 'updateConfig'; readonly patch: Partial<RuleConfig> }
  | { readonly type: 'setAiLevel'; readonly level: AiLevel }
  | { readonly type: 'setAiSpeed'; readonly ms: number }
  | { readonly type: 'toggleFourColor' }
  | { readonly type: 'dismissNotice' }

/** 由状态推导规则上下文（牌力表现算） */
export function ctxOf(state: GameState): RuleContext {
  return {
    power: buildPowerTable({
      mode: state.config.twoAsPermanent ? 1 : 0,
      levelRank: state.levelRank,
      trump: state.trump,
      forcedNT: state.forcedNT,
    }),
    trump: state.trump,
    levelRank: state.levelRank,
    forcedNT: state.forcedNT,
    config: state.config,
  }
}

/** 该谁出牌 */
export function seatToPlay(state: GameState): Seat | null {
  if (state.phase !== 'play') return null
  const { plays, leader } = state.trick
  if (plays.length === 0) return leader
  const last = plays[plays.length - 1] as Play
  return ((last.seat + 1) % 4) as Seat
}

export const isHumanTurn = (state: GameState): boolean => seatToPlay(state) === HUMAN_SEAT

export const dealerTeam = (state: GameState): 0 | 1 => (state.dealer % 2) as 0 | 1

export const emptyState = (): GameState => ({
  version: STATE_VERSION,
  phase: 'contract',
  config: DEFAULT_RULE_CONFIG,
  seed: 1,
  step: 0,
  round: 1,
  levels: { a: 2, b: 2 },
  dealer: 0,
  trump: 'NT',
  forcedNT: false,
  levelRank: 2,
  hands: [[], [], [], []],
  bottom: [],
  bottomScore: 0,
  trick: { leader: 0, plays: [], winner: null },
  tricksDone: 0,
  defenderScore: 0,
  history: [],
  selected: [],
  lastReject: null,
  notice: null,
  lastSettle: null,
  aiLevel: 1,
  aiSpeedMs: 420,
  fourColor: false,
})
