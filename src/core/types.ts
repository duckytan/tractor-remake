/**
 * 领域类型 —— 全项目唯一类型来源
 * 对应 docs/04-领域模型与接口契约.md §1
 */

/** 花色。内部编号与规则书 §1.2 一致，具体对应哪种花色由 UI 决定（规则无关） */
export type Suit = 0 | 1 | 2 | 3

/** 点数下标。0..12 ↔ 2,3,4,5,6,7,8,9,10,J,Q,K,A */
export type Rank = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12

/** 牌值。suit*13 + rank；52 = 小王，53 = 大王 */
export type CardValue = number

/** 级牌。1..13 = A,2,3,...,K；18 = 打王级 */
export type LevelRank = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 18

/** 主牌标识。4 门花色，或 'NT' 主动无将 */
export type Trump = Suit | 'NT'

/** 座位。全链路 0 基 */
export type Seat = 0 | 1 | 2 | 3

/** 队伍。seat % 2 */
export type Team = 0 | 1

/** 手牌花色槽。0..3 = 四门花色，4 = 主牌槽 */
export type SuitSlot = 0 | 1 | 2 | 3 | 4

/** 牌型码。0..4 = 纯牌型（值等于花色槽），10 = 不纯（垫牌 / 结构不符） */
export type TypeCode = 0 | 1 | 2 | 3 | 4 | 10

/** 一张物理牌。两副牌中同牌值的两张靠 id 区分 */
export interface Card {
  readonly id: number
  readonly value: CardValue
}

/** 牌力。数值越大越强，主牌全部 ≥ 52，副牌全部 < 52 */
export type Power = number

/** 牌力表。运行期按「主牌 + 级牌」构建 */
export interface PowerTable {
  /** 按牌值取牌力 */
  readonly get: (v: CardValue) => Power
  /** 按物理牌取牌力 */
  readonly of: (c: Card) => Power
  /** 是否主牌（power >= 52） */
  readonly isTrump: (v: CardValue) => boolean
}

/** 规则开关（对应原版 6 个复选框，见规则书 §10） */
export interface RuleConfig {
  /** 允许自反（原版未实现，本项目实现为「同队可反」） */
  readonly allowSelfCounter: boolean
  /** 2 为常主 */
  readonly twoAsPermanent: boolean
  /** 允许队友用同花色加固（抬高反主门槛：张数 1 → 2 ⇒ 门槛 2 → 3） */
  readonly allowPartnerGuard: boolean
  /** 允许反无将 */
  readonly allowCounterNT: boolean
  /** 5,10,K 必打（升级禁跳级） */
  readonly guardScoreLevels: boolean
  /** J 必打（升级禁跳级） */
  readonly guardJack: boolean
  /** A 必打（升级禁跳级） */
  readonly guardAce: boolean
  /** 打王级必打 */
  readonly guardKingLevel: boolean
}

/**
 * 默认规则开关。
 * 必打集合对齐 smallnest `MainForm.cs:167` 的 `",3,8,11,12,13,"`
 * —— 该表用 rank 下标（0=2），所以 3→5、8→10、11→K、12→A、13→打王：
 * **5 / 10 / K / A / 打王**，不含 J。
 */
export const DEFAULT_RULE_CONFIG: RuleConfig = {
  allowSelfCounter: true,
  twoAsPermanent: false,
  allowPartnerGuard: true,
  allowCounterNT: false,
  guardScoreLevels: true,
  guardJack: false,
  guardAce: true,
  guardKingLevel: true,
}

/** 规则上下文：所有需要判断大小/归属的函数都接收它 */
export interface RuleContext {
  readonly power: PowerTable
  readonly trump: Trump
  readonly levelRank: LevelRank
  readonly config: RuleConfig
  /** 打王级强制无将 */
  readonly forcedNT: boolean
}
