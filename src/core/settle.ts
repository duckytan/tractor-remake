/**
 * 升级结算 / 必打截断 / 终局
 * 规则依据：规则书 §9.1 §9.2 §9.3 §10.3，ADR-010 ADR-011
 */

import type { LevelRank, RuleConfig, Seat, Team } from './types'

/** 级牌推进序列：2→3→…→K→A→打王→2(或 3) */
export function nextLevel(cur: LevelRank, mode: 0 | 1): LevelRank {
  if (cur === 13) return 1 // K → A
  if (cur === 1) return 18 // A → 打王
  if (cur === 18) return mode === 1 ? 3 : 2 // 打王 → 2（2 为常主时回到 3）
  return (cur + 1) as LevelRank
}

/**
 * 「打王」是终点级（ADR-011）：某队到打王后**只能靠坐庄赢下本局通关**，
 * 级牌不会再往前推。`nextLevel` 里 18 → 2/3 那条只是原版的循环口径
 * （原版没有终局判定），**结算路径必须夹住**，否则已到打王的队当闲家赢一局
 * 会被打回 3 级 —— 实测 200 副连打里发生 134 次（每局约 0.67 次），
 * 玩家攒到打王的进度会被一局抹掉，且永远等不到「打王坐庄」那一局。
 */
export const TERMINAL_LEVEL: LevelRank = 18

/**
 * 该级牌是否受「必打」保护。
 *
 * 注意：**与出牌无关**。它约束的是升级时不能跳过这些级牌（ADR-010）。
 */
export function isGuardedLevel(lr: LevelRank, config: RuleConfig): boolean {
  if (config.guardScoreLevels && (lr === 5 || lr === 10 || lr === 13)) return true
  if (config.guardJack && lr === 11) return true
  if (config.guardAce && lr === 1) return true
  if (config.guardKingLevel && lr === 18) return true
  return false
}

export interface AdvanceResult {
  readonly to: LevelRank
  /** 是否因为遇到受保护的级牌而提前停下 */
  readonly stopped: boolean
  /** 停在哪个受保护的级牌上 */
  readonly guardLevel?: LevelRank
  /** 实际升了几级 */
  readonly actualLevels: number
}

/**
 * 从 from 升 levels 级。
 *
 * 「必打」语义：**升到受保护的级牌就停在那里**（必须打这一级），剩余级数作废。
 * 例：9 升 3 级，J 受保护 → 9→10→J，停在 J，实际升 2 级。
 */
export function advanceLevel(from: LevelRank, levels: number, config: RuleConfig, mode: 0 | 1 = 0): AdvanceResult {
  if (!Number.isFinite(levels)) throw new Error(`advanceLevel: levels 非有限值 ${levels}`)
  // **循环次数必须夹紧**（docs/33 C6-08）：`levels` 来自 `floor((score-80)/40)`，
  // 正常上限约 38（200 分 × 8 倍抠底）；但存档里的 defenderScore 一旦异常，
  // 循环次数就跟着失控 —— 实测「必打全关 + defenderScore=1e9」会跑 2500 万次 / 78ms。
  // 从 2 升到打王级最多 14 级，给 20 已经足够宽松。
  const n = Math.max(0, Math.min(Math.trunc(levels), 20))
  // 已在打王：没有任何「再升一级」的余地，直接原地不动（不是截断，所以 stopped=false）
  if (from === TERMINAL_LEVEL) return { to: TERMINAL_LEVEL, stopped: false, actualLevels: 0 }
  let cur = from
  let done = 0
  for (let i = 0; i < n; i++) {
    const next = nextLevel(cur, mode)
    cur = next
    done += 1
    if (isGuardedLevel(cur, config)) {
      return { to: cur, stopped: true, guardLevel: cur, actualLevels: done }
    }
    // 「打王必打」开关关掉时也要停在打王上（见 TERMINAL_LEVEL 注释）：
    // 否则 A 升 3 级会 1→18→3→4 直接跨过终点级，那一队永远赢不了。
    if (cur === TERMINAL_LEVEL) {
      return { to: TERMINAL_LEVEL, stopped: true, guardLevel: TERMINAL_LEVEL, actualLevels: done }
    }
  }
  return { to: cur, stopped: false, actualLevels: done }
}

/* ---------- 升级级数 ---------- */

export interface LevelGain {
  /** 哪一队升级 */
  readonly team: 'dealer' | 'defender'
  /** 应升几级 */
  readonly levels: number
}

/**
 * 按防守方（闲家）得分决定升级队与级数。
 *
 *   0        → 庄家方升 3 级（大光）
 *   1–39     → 庄家方升 2 级（小光）
 *   40–79    → 庄家方升 1 级
 *   ≥80      → 闲家上台，升 floor((score-80)/40) 级
 *              （80–119 只上台不升级；120–159 升 1 级；…）
 */
export function levelsFor(score: number): LevelGain {
  // `NaN` 会让下面三个分支**全部为 false**，静默落到「40–79 → 庄家方升 1 级」
  // （docs/33 C6-04）。core 是纯函数，遇到非法入参应该抛错而不是猜一个结果；
  // app 层的入口校验（loadState / playCards）负责保证不会传进来。
  if (!Number.isFinite(score) || score < 0) {
    throw new Error(`levelsFor: defenderScore 非法 ${score}`)
  }
  if (score >= 80) return { team: 'defender', levels: Math.floor((score - 80) / 40) }
  if (score === 0) return { team: 'dealer', levels: 3 }
  return { team: 'dealer', levels: score < 40 ? 2 : 1 }
}

/* ---------- 队伍 / 座位 ---------- */

export const teamOf = (seat: Seat): Team => (seat % 2) as Team
export const partnerOf = (seat: Seat): Seat => ((seat + 2) % 4) as Seat
export const nextSeat = (seat: Seat): Seat => ((seat + 1) % 4) as Seat
export const isSameTeam = (a: Seat, b: Seat): boolean => teamOf(a) === teamOf(b)

/* ---------- 结算 ---------- */

export interface SettleInput {
  readonly defenderScore: number
  readonly dealerSeat: Seat
  /** 队 0（座位 0/2）与队 1（座位 1/3）的当前级牌 */
  readonly levels: { readonly a: LevelRank; readonly b: LevelRank }
  readonly config: RuleConfig
  readonly mode: 0 | 1
}

export interface SettleResult {
  readonly defenderScore: number
  readonly levelUpTeam: Team
  /** 应升级数 */
  readonly levels: number
  /** 经必打截断后实际升级数 */
  readonly actualLevels: number
  readonly newLevels: { readonly a: LevelRank; readonly b: LevelRank }
  /** 是否换庄（闲家上台） */
  readonly dealerChanged: boolean
  readonly newDealer: Seat
  readonly gameOver: boolean
  readonly winnerTeam?: Team
  /** 因必打停在哪个级牌（用于界面说明） */
  readonly guardLevel?: LevelRank
}

/**
 * 结算一局。
 *
 * 轮庄规则（【标准】，原版未确证）：
 *   - 庄家方赢 → 下一局由**庄家的对家**坐庄（同队延续）
 *   - 闲家上台 → 下一局由**庄家的下家**坐庄（换队）
 */
export function settleRound(input: SettleInput): SettleResult {
  const { defenderScore, dealerSeat, levels, config, mode } = input
  const dealerTeam = teamOf(dealerSeat)
  const gain = levelsFor(defenderScore)
  const levelUpTeam: Team = gain.team === 'dealer' ? dealerTeam : ((dealerTeam + 1) % 2 as Team)

  // 终局：打王级坐庄并赢下本局即获胜（ADR-011）
  const dealerLevel = dealerTeam === 0 ? levels.a : levels.b
  if (gain.team === 'dealer' && dealerLevel === 18) {
    return {
      defenderScore,
      levelUpTeam,
      levels: gain.levels,
      actualLevels: 0,
      newLevels: levels,
      dealerChanged: false,
      newDealer: dealerSeat,
      gameOver: true,
      winnerTeam: dealerTeam,
    }
  }

  const cur = levelUpTeam === 0 ? levels.a : levels.b
  const adv = advanceLevel(cur, gain.levels, config, mode)
  const newLevels = {
    a: levelUpTeam === 0 ? adv.to : levels.a,
    b: levelUpTeam === 1 ? adv.to : levels.b,
  }

  const dealerChanged = gain.team === 'defender'
  const newDealer: Seat = dealerChanged
    ? nextSeat(dealerSeat)
    : partnerOf(dealerSeat)

  return {
    defenderScore,
    levelUpTeam,
    levels: gain.levels,
    actualLevels: adv.actualLevels,
    newLevels,
    dealerChanged,
    newDealer,
    gameOver: false,
    ...(adv.guardLevel !== undefined ? { guardLevel: adv.guardLevel } : {}),
  }
}
