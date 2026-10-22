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

/** 牌面尺寸档位（FR-18） */
export type CardSize = 'S' | 'M' | 'L'

/** 牌面像素宽度 → CSS 变量 --card-w */
export const CARD_SIZE_PX: Record<CardSize, number> = { S: 120, M: 150, L: 190 }

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
  /** 牌面尺寸档位 */
  readonly cardSize: CardSize
  /** 动画开关（关闭后 CSS 过渡全部禁用） */
  readonly animation: boolean
  /** 设置弹层是否打开 */
  readonly settingsOpen: boolean
  /** 对局记录弹层是否打开 */
  readonly logOpen: boolean
  /**
   * 提示高亮的牌 id。
   *
   * **纯视觉状态，不参与任何规则判定**（FR-19 ③：提示不改变游戏状态）。
   * 与 `selected` 分开：selected 是「我要出的牌」，hintIds 只是「看，这手能出」。
   * 任何会改变局面的动作都应顺手清掉它。
   */
  readonly hintIds: readonly number[]
  /**
   * 待生效的规则配置。
   * FR-18 ③：规则开关改动在下一局生效，当前局不生效。
   * 所以 UI 改的是这份 pending 值，startRound 时才合并进 config。
   */
  readonly pendingConfig: RuleConfig
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
  | { readonly type: 'openSettings' }
  | { readonly type: 'closeSettings' }
  | { readonly type: 'setCardSize'; readonly size: CardSize }
  | { readonly type: 'toggleAnimation' }
  | { readonly type: 'toggleLog' }
  | { readonly type: 'showHint'; readonly ids: readonly number[] }
  | { readonly type: 'clearHint' }

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
  cardSize: 'M',
  animation: true,
  settingsOpen: false,
  logOpen: false,
  hintIds: [],
  pendingConfig: DEFAULT_RULE_CONFIG,
})
