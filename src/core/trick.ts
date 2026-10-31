/**
 * 一墩判定
 * 规则依据：规则书 §7.1
 */

import type { PlayAnalysis } from './analyze'
import type { Card, RuleContext, Seat } from './types'

export interface Play {
  readonly seat: Seat
  readonly cards: readonly Card[]
  readonly analysis: PlayAnalysis
}

export interface TrickResult {
  readonly winner: Seat
  readonly score: number
  readonly winnerAnalysis: PlayAnalysis
  /** 参与竞争的手牌座位（调试用） */
  readonly contenders: readonly Seat[]
}

/**
 * 该手牌是否具备「压过首出」的**资格**（花色 + 结构一致）。
 *
 * ⚠️ **这个函数不比牌力**！`canBeat(♦5, ♦7)` 也返回 true —— 它回答的是
 * 「有没有资格参与比大小」，最终谁大由 `trickStanding` 比 `keyCard` 牌力决定。
 *
 * 想要「**真的压过**」请用 `beatsPlay`（本文件下方）。
 * v1.3.51 之前有两处把它当成"能赢"用了：`safeHint` 的「有分就抢」和 `hintView`
 * 的「压住这墩」文案 —— 于是提示会挑一张结构一致但**更小**的牌去陪跑
 *（用户报：「我的主牌和上家一样，根本赢不了，还提示我这样出」）。
 */
export function canBeat(play: PlayAnalysis, lead: PlayAnalysis): boolean {
  if (play.suitSlot === -1) return false
  const leadIsTrump = lead.suitSlot === 4
  const playIsTrump = play.suitSlot === 4
  if (leadIsTrump) {
    if (!playIsTrump) return false
  } else if (play.suitSlot !== lead.suitSlot && !playIsTrump) {
    return false
  }
  // 结构必须一致：张数相同的前提下，对子数相同即结构相同
  if (play.pairCount !== lead.pairCount) return false
  // 拖拉机长度也要一致：2 个不连续对子不能压 2 连对
  // （两者 pairCount 都是 2，只比对数会把「散对」误判成能压「连对」）
  const runLen = (a: PlayAnalysis): number =>
    a.groups.length === 1 && a.groups[0]?.kind === 'tractor' ? a.groups[0].length : 0
  if (runLen(play) !== runLen(lead)) return false
  return true
}

/** 一墩里「当前谁最大」的完整结论 */
export interface TrickStanding {
  /** 当前赢家 */
  readonly winner: Play
  /** 参与竞争的座位（含赢家） */
  readonly contenders: readonly Seat[]
}

/**
 * 一墩已出的牌里，谁现在最大。
 *
 * **这是全项目唯一的一墩判定入口** —— 结算走 `resolveTrick`，AI 判断「我能不能赢」
 * 走 `currentWinnerOf`，两者都必须用这个函数。之前它们各写一份，AI 侧那份只比
 * `keyCard`、不比花色与结构，于是**任何人垫牌（非同花色）的大牌都会被当成「当前最大」**，
 * AI 据此误判「我赢不了」而白垫小牌（详见 docs/15 KN-7）。
 *
 * 垫牌（混花色）的 `suitSlot === -1`，在 `canBeat` 里就被排除，进不了竞争池。
 */
/**
 * 这一手是否**真的压过** `lead`：既有资格（`canBeat`），牌力又更大。
 *
 * 牌力相等**不算压过**（先出者赢，规则如此）—— 这正是 `canBeat` 单独用会出错的地方。
 */
export function beatsPlay(play: PlayAnalysis, lead: PlayAnalysis, ctx: RuleContext): boolean {
  if (!canBeat(play, lead)) return false
  const a = play.keyCard
  const b = lead.keyCard
  if (!a || !b) return false
  return ctx.power.get(a.value) > ctx.power.get(b.value)
}

export function trickStanding(plays: readonly Play[], ctx: RuleContext): TrickStanding | null {
  if (plays.length === 0) return null
  const lead = (plays[0] as Play).analysis

  const qualified = plays.filter((p) => canBeat(p.analysis, lead))
  const trumpPlays = qualified.filter((p) => p.analysis.suitSlot === 4)
  const pool = lead.suitSlot === 4 || trumpPlays.length > 0 ? trumpPlays : qualified

  let best = pool[0]
  if (best === undefined) return null
  for (const p of pool) {
    const a = p.analysis.keyCard
    const b = best.analysis.keyCard
    if (a && b && ctx.power.get(a.value) > ctx.power.get(b.value)) best = p
  }
  return { winner: best, contenders: pool.map((p) => p.seat) }
}

/**
 * 判定一墩的赢家。
 *
 * 规则：
 *   ① 混合花色（suitSlot = -1）的牌永远不能赢 —— 那就是垫牌
 *   ② 结构不符（对子数不同）的牌不能赢 —— 同样是垫牌
 *   ③ 首出是副牌时，主牌可以压（毙牌）；首出是主牌时只有主牌能比
 *   ④ 同类型比 keyCard 牌力，最大者赢；牌力相同则先出者赢
 */
export function resolveTrick(plays: readonly Play[], ctx: RuleContext): TrickResult {
  if (plays.length === 0) throw new Error('resolveTrick: 没有出牌')
  // 首出是混花色时 `trickStanding` 也返回 null（`canBeat` 对 suitSlot === -1 恒 false，
  // 竞争池为空），旧实现于是报「没有出牌」—— 明明有牌，只是首出牌型非法（docs/33 C6-05）。
  const lead = plays[0] as Play
  if (lead.analysis.suitSlot === -1) {
    throw new Error('resolveTrick: 首出牌型非法（混花色不能首出）')
  }
  const standing = trickStanding(plays, ctx)
  if (standing === null) throw new Error('resolveTrick: 没有可比较的牌')
  const best = standing.winner

  let score = 0
  for (const p of plays) score += p.analysis.score

  return {
    winner: best.seat,
    score,
    winnerAnalysis: best.analysis,
    contenders: standing.contenders,
  }
}
