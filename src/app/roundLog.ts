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

import { CARD_VALUE_COUNT, RULE_CONFIG_KEYS } from '@core'
import type { LevelRank, RuleConfig, Seat, Team, Trump } from '@core'
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

/**
 * 局后复盘用：**AI 每一手出牌的理由**（一句话）。
 *
 * 只在结算后才写进日志 —— 牌局进行中显示等于剧透对手手牌。
 */
export interface LoggedAiNote {
  /** 第几墩（0 基） */
  readonly trick: number
  readonly seat: Seat
  /** 一句话理由（`explainCards().text`） */
  readonly text: string
  /** 更详细的说明（`explainCards().detail`） */
  readonly detail: string
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
  /**
   * **提示实际选中了哪几张**（牌值）。
   *
   * 与 `ai` 的区别：`ai` 是「同局面 L3 会出什么」（影子决策，恒为最强档）；
   * 这里记的是**玩家真的点了提示、界面上高亮的那一手** —— 默认是「稳妥」风格，
   * 与 L3 往往不同。想分析「提示准不准」必须看这一项。
   *
   * 老日志没有这个字段（undefined），分析脚本要能容错。
   */
  readonly hintCards?: readonly number[]
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
  /** AI 出牌理由（复盘用；老日志没有这个字段） */
  readonly aiNotes?: readonly LoggedAiNote[]
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

/* ============================================================
   日志档的字段级校验（KN-29）
   ------------------------------------------------------------
   与 `persist.ts`（对局存档）、`stats.ts`（战绩）同属防篡改 / 防损坏档这条防线。
   `initRoundLog` 此前只做 `Array.isArray(o.rounds)`，数组元素一个字段都没验 ——
   而 `render.ts :: logPanel` 直接读 `prev.tricks.length` / `prev.settle.defenderScore`，
   `view.ts :: loggedTrickView` 直接 `r.tricks.map(...)`：一条被篡改的日志档
   就能让「对局记录」面板白屏。

   口径照 KN-28（`isSettleResult`）：**逐层递归 + 单一可信校验表 + 编译期护栏**。
   每个对象类型的校验表用 `keyof T` 完备映射标注 —— 给类型加字段却忘了加校验器
   ⇒ `tsc` 直接红（缺属性），不会再出现「清单和类型各自手写、再次分叉」。
   坏条目整条丢弃（同 stats.ts），不让一条脏记录拖垮整个面板。
   ============================================================ */

type OptionalKeysOf<T> = {
  [K in keyof T]-?: undefined extends T[K] ? K : never
}[keyof T]
type RequiredKeysOf<T> = Exclude<keyof T, OptionalKeysOf<T>>

/** 泛型校验器工厂：两个校验表都必须是 `keyof T` 的完备映射（缺字段 ⇒ tsc 红） */
function objectCheck<T extends object>(
  required: { readonly [K in RequiredKeysOf<T>]: (v: unknown) => boolean },
  optional: { readonly [K in OptionalKeysOf<T>]: (v: unknown) => boolean },
): (v: unknown) => v is T {
  return (v: unknown): v is T =>
    isObj(v) &&
    (Object.keys(required) as unknown as readonly (keyof T)[]).every((k) =>
      required[k as RequiredKeysOf<T>]((v as Record<string, unknown>)[k as string]),
    ) &&
    (Object.keys(optional) as unknown as readonly (keyof T)[]).every((k) => {
      const val = (v as Record<string, unknown>)[k as string]
      return val === undefined || optional[k as OptionalKeysOf<T>](val)
    })
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isInt = (v: unknown): v is number => isNum(v) && Number.isInteger(v)
const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const isStr = (v: unknown): v is string => typeof v === 'string'
const isSeat = (v: unknown): v is Seat => v === 0 || v === 1 || v === 2 || v === 3
const isTeam = (v: unknown): v is Team => v === 0 || v === 1
/** `LevelRank` 只有 1..13 与 18（打王级） */
const isLevelRank = (v: unknown): v is LevelRank => isInt(v) && ((v >= 1 && v <= 13) || v === 18)
const isTrump = (v: unknown): v is Trump => v === 0 || v === 1 || v === 2 || v === 3 || v === 'NT'
const isCardValue = (v: unknown): v is number => isInt(v) && v >= 0 && v < CARD_VALUE_COUNT
const isCardValueArray = (v: unknown): v is readonly number[] =>
  Array.isArray(v) && v.every(isCardValue)
/** `config` 与对局存档共用 `RULE_CONFIG_KEYS` 单一清单（KN-27） */
const isRuleConfig = (v: unknown): v is RuleConfig =>
  isObj(v) && RULE_CONFIG_KEYS.every((k) => isBool((v as Record<string, unknown>)[k]))

/** `[座位, 牌值数组]` —— 每墩 plays 的一个出牌项 */
const isLoggedPlay = (v: unknown): v is readonly [Seat, readonly number[]] =>
  Array.isArray(v) && v.length === 2 && isSeat(v[0]) && isCardValueArray(v[1])

const isLoggedTrick = objectCheck<LoggedTrick>(
  {
    leader: isSeat,
    plays: (v) => Array.isArray(v) && v.every(isLoggedPlay),
    winner: isSeat,
    score: isNum,
  },
  {},
)
const isLoggedHumanPlay = objectCheck<LoggedHumanPlay>(
  {
    trick: isInt,
    cards: isCardValueArray,
    ai: isCardValueArray,
    hint: isBool,
  },
  { hintCards: isCardValueArray },
)
const isLoggedAiNote = objectCheck<LoggedAiNote>(
  { trick: isInt, seat: isSeat, text: isStr, detail: isStr },
  {},
)

/**
 * 单条日志的字段级校验（递归到 5 层嵌套）。
 * 只要求日志**实际会用到**的字段合法：可选字段（hintCards / aiNotes）允许缺席，
 * 但一旦出现就必须合法。
 */
const isRoundLog = objectCheck<RoundLog>(
  {
    v: (x) => x === 1,
    app: isStr,
    ts: isNum,
    seed: isNum,
    round: (x) => isInt(x) && x >= 0,
    config: isRuleConfig,
    levelRank: isLevelRank,
    trump: isTrump,
    forcedNT: isBool,
    dealer: isSeat,
    ai: objectCheck<RoundLog['ai']>(
      { partner: isNum, opponent: isNum, auto: isNum, peek: isBool, hintStyle: isStr },
      {},
    ),
    hands: (v) => Array.isArray(v) && v.every(isCardValueArray),
    bottom: isCardValueArray,
    tricks: (v) => Array.isArray(v) && v.every(isLoggedTrick),
    human: (v) => Array.isArray(v) && v.every(isLoggedHumanPlay),
    settle: objectCheck<RoundLog['settle']>(
      {
        defenderScore: isNum,
        levels: isInt,
        actualLevels: isInt,
        dealerChanged: isBool,
        newDealer: isSeat,
        gameOver: isBool,
        levelUpTeam: isTeam,
      },
      {},
    ),
  },
  { aiNotes: (v) => Array.isArray(v) && v.every(isLoggedAiNote) },
)

let cache: Store = { rounds: [] }
/** 当前这一局的开局快照（进入 play/bury 时抓，结算时合并） */
let pending: {
  seed: number
  round: number
  hands: readonly (readonly number[])[]
  human: LoggedHumanPlay[]
  aiNotes: LoggedAiNote[]
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
    // 逐条校验：坏条目整条丢弃（同 stats.ts），不让一条脏记录拖垮「记录」面板（KN-29）
    cache = {
      rounds: Array.isArray(o.rounds) ? o.rounds.filter((r: unknown): r is RoundLog => isRoundLog(r)) : [],
    }
  } catch {
    cache = { rounds: [] }
  }
}

/**
 * 有没有正在记录的「开局快照」？
 *
 * 调用方（`main.ts`）用它**提前**跳过影子决策：`noteHumanPlay` 在 `pending`
 * 为 null 时本来就丢弃记录，但从存档恢复的对局整局都没有快照
 * （`beginRound` 只在 `phase` 从 contract 跳变到 bury/play 时抓，
 * 读档是「直接落在 play 阶段」）—— 参数先求值的话每手人类出牌都要
 * 白跑一次完整 L3 决策（含残局搜索）然后扔掉。
 */
export function hasPendingSnapshot(): boolean {
  return pending !== null
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
    aiNotes: [],
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
  /** 提示当时高亮的那几张（牌值）；没看提示传 `[]` */
  hintCards: readonly number[] = [],
): void {
  if (pending === null) return
  pending.human.push({
    trick: before.history.length,
    cards: values(cards),
    ai: values(ai),
    hint: hintUsed,
    hintCards: [...hintCards],
  })
}

/**
 * 记一条 AI 出牌理由（**结算后复盘用**；局中不显示，避免剧透对手手牌）。
 *
 * 同一个（墩, 座位）只留最后一条：悔牌会让同一手被记多次。
 */
export function noteAiPlay(trick: number, seat: Seat, text: string, detail: string): void {
  if (pending === null) return
  const last = pending.aiNotes[pending.aiNotes.length - 1]
  if (last !== undefined && last.trick === trick && last.seat === seat) {
    pending.aiNotes[pending.aiNotes.length - 1] = { trick, seat, text, detail }
    return
  }
  pending.aiNotes.push({ trick, seat, text, detail })
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
    aiNotes: sameRound ? snap.aiNotes : [],
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
