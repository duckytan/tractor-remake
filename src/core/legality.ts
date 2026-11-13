/**
 * 出牌合法性
 * 规则依据：规则书 §6.3 §6.4，ADR-007（宽松结构跟随）、ADR-008（甩牌失败裁剪）
 */

import { analyze, analyzeHand, bestInSlot } from './analyze'
import type { Group, HandAnalysis, PlayAnalysis } from './analyze'
import { suitSlotOf } from './deal'
import type { Card, RuleContext, SuitSlot } from './types'

export type PlayRejectReason =
  | 'empty'
  | 'cards-not-in-hand'
  | 'count-mismatch'
  | 'mixed-suit-lead'
  | 'must-follow-suit'
  | 'must-follow-pairs'
  | 'throw-failed'
  | 'cannot-counter'

export type PlayResult =
  /** 合法 */
  | { readonly ok: true; readonly cards: readonly Card[]; readonly analysis: PlayAnalysis; readonly adjusted?: undefined }
  /** 甩牌失败，已被裁剪成合法的一手；上层应出 cards 并提示 reason */
  | {
      readonly ok: true
      readonly cards: readonly Card[]
      readonly analysis: PlayAnalysis
      readonly adjusted: true
      readonly reason: PlayRejectReason
      readonly detail: string
    }
  | { readonly ok: false; readonly reason: PlayRejectReason; readonly detail: string }

const reject = (reason: PlayRejectReason, detail: string): PlayResult => ({
  ok: false,
  reason,
  detail,
})

/**
 * cards 是否全部来自 hand。
 *
 * **先要求 cards 内部 id 互不相同**（docs/33 C6-07）：下面用的是「多重集池」计数，
 * 手牌里同一 id 出现 3 次、出牌也出 3 张时会校验通过并全部打出 —— 物理上不可能，
 * 但数据损坏（或篡改存档）时真会发生。id 重复直接判不合法。
 */
function allFromHand(hand: readonly Card[], cards: readonly Card[]): boolean {
  if (new Set(cards.map((c) => c.id)).size !== cards.length) return false
  const pool = new Map<number, number>()
  for (const c of hand) pool.set(c.id, (pool.get(c.id) ?? 0) + 1)
  for (const c of cards) {
    const n = pool.get(c.id) ?? 0
    if (n === 0) return false
    pool.set(c.id, n - 1)
  }
  return true
}

/**
 * 手牌的「多重集池」：id → 张数。
 *
 * 给 `allFromHand` 和 `checkFollow` 共用：在 `legalOnly` 一次调用里，
 * 60 个候选都对着**同一份手牌**，旧实现每个候选都 `new Map(hand...)` + `analyzeHand(hand...)`。
 * 预算一次后传给 `checkPlayBatch`，每候选只遍历自己的几张牌。
 */
export interface HandPreComputed {
  /** id → 在手牌里的张数（多重集池） */
  readonly pool: ReadonlyMap<number, number>
  /** `analyzeHand(hand, ctx)` 的结果 */
  readonly handAnalysis: HandAnalysis
}

/** 从手牌预算共享结构（池 + 槽分析） */
export function preComputeHand(hand: readonly Card[], ctx: RuleContext): HandPreComputed {
  const pool = new Map<number, number>()
  for (const c of hand) pool.set(c.id, (pool.get(c.id) ?? 0) + 1)
  return { pool, handAnalysis: analyzeHand(hand, ctx) }
}

/**
 * `allFromHand` 的池版：用预算好的 `pool` 替代每次 `new Map(hand...)`。
 *
 * cards 通常只有 1~6 张，直接线性扫：
 *   ① 收集每 id 出现次数（最多 2，两副牌）
 *   ② 逐 id 查 pool 够不够
 */
function allFromHandPool(pool: ReadonlyMap<number, number>, cards: readonly Card[]): boolean {
  if (cards.length === 1) {
    // 快路径：单张最常见，不分配任何中间结构
    return (pool.get(cards[0]!.id) ?? 0) > 0
  }
  // 逐张查 pool 并计数（模拟多重集消费）
  // 复制 pool 中被消费的条目到局部 map，避免修改原 pool
  // 但大多数候选 id 不重复，可以直接查 pool 足够
  // 对重复 id（两副牌同 id 出两张）才需要局部计数
  let dups = false
  for (let i = 1; i < cards.length; i++) {
    if (cards[i]!.id === cards[0]!.id) { dups = true; break }
  }
  if (!dups) {
    // 无重复 id：直接查 pool
    for (const c of cards) {
      if ((pool.get(c.id) ?? 0) === 0) return false
    }
    return true
  }
  // 有重复 id：用局部计数
  const need = new Map<number, number>()
  for (const c of cards) need.set(c.id, (need.get(c.id) ?? 0) + 1)
  for (const [id, n] of need) {
    if ((pool.get(id) ?? 0) < n) return false
  }
  return true
}

export interface CheckPlayOptions {
  readonly hand: readonly Card[]
  readonly cards: readonly Card[]
  readonly ctx: RuleContext
  /** 本墩首出方已出的牌。我是首出时省略 */
  readonly lead?: { readonly cards: readonly Card[]; readonly analysis: PlayAnalysis }
  /** 其他三家的手牌（甩牌校验需要）。首出时必填 */
  readonly opponents?: readonly (readonly Card[])[]
}

/** 统一入口：按「是否首出」分派 */
export function checkPlay(o: CheckPlayOptions): PlayResult {
  const { hand, cards, ctx, lead } = o
  if (cards.length === 0) return reject('empty', '没有选牌')
  if (!allFromHand(hand, cards)) return reject('cards-not-in-hand', '出的牌不在手里')

  const my = analyze(cards, ctx)
  if (lead) return checkFollow(hand, cards, my, lead.analysis, ctx)

  // **甩牌必须拿到真实对手手牌**（docs/33 C1-01）。
  //
  // `opponents` 缺省成 `[]` 时，`checkLead` 的「每一组都要大于其他三家同类型最大值」
  // 会变成**空集上的全称命题**，恒为真 —— 于是任何甩牌都被放行，甩牌规则形同虚设。
  // 这里 fail closed：没有对手信息就拒绝甩牌，而不是默默放过。
  // 单组首出（单张/对子/连对）不需要对手信息，不受影响。
  const opponents = o.opponents
  // 只拦「真甩牌」（同槽多组）。混花色首出（suitSlot === -1）本来就会被 checkLead
  // 以更准确的 `mixed-suit-lead` 拒掉，不该被这条抢走原因。
  const isRealThrow = my.isMultiGroup && my.suitSlot !== -1
  if (isRealThrow && (opponents === undefined || opponents.length === 0)) {
    return reject('throw-failed', '缺少对手手牌，无法校验甩牌')
  }
  return checkLead(cards, my, ctx, opponents ?? [], my)
}

/** 批量校验：预算好的 hand 共享结构复用，避免逐候选 `new Map` + `analyzeHand` */
export interface CheckPlayBatchOptions {
  readonly ctx: RuleContext
  readonly lead?: { readonly cards: readonly Card[]; readonly analysis: PlayAnalysis }
  readonly opponents?: readonly (readonly Card[])[]
  /** 预算好的手牌结构 */
  readonly pre: HandPreComputed
}

/**
 * 批量校验：用预算好的 `preComputeHand` 替代逐候选的 `allFromHand` + `checkFollow` 里的 `analyzeHand`。
 *
 * 热路径 `legalOnly`（AI `decide`）一次调 60 个候选，旧实现每个都
 * `new Map(hand...)`（~25 张）+ `analyzeHand(hand, ctx)`（遍历 + 5 桶分配 + sort）。
 * 预算一次后每候选只遍历自己的 1~6 张牌。
 */
export function checkPlayBatch(
  cards: readonly Card[],
  o: CheckPlayBatchOptions,
): PlayResult {
  const { ctx, lead, pre } = o
  if (cards.length === 0) return reject('empty', '没有选牌')
  if (!allFromHandPool(pre.pool, cards)) return reject('cards-not-in-hand', '出的牌不在手里')

  const my = analyze(cards, ctx)
  if (lead) return checkFollowWithHand(pre.handAnalysis, cards, my, lead.analysis, ctx)

  const opponents = o.opponents
  const isRealThrow = my.isMultiGroup && my.suitSlot !== -1
  if (isRealThrow && (opponents === undefined || opponents.length === 0)) {
    return reject('throw-failed', '缺少对手手牌，无法校验甩牌')
  }
  return checkLead(cards, my, ctx, opponents ?? [], my)
}

/* ---------- 首出 ---------- */

/**
 * 首出：必须同一花色槽；单一牌型直接合法；多组混出（甩牌）需逐组校验。
 *
 * 甩牌校验：每一组的**每一个单位**都要大于其他三家同槽同类型的最大值。
 *   - 单张组：每一张都要 > 三家该槽最大单张
 *   - 对子组：每一对都要 > 三家该槽最大对子（原版只比最大一对，是缺陷，见 ADR-008）
 *   - 拖拉机组：整组最弱的那对也要 > 三家该槽最大对子
 */
export function checkLead(
  cards: readonly Card[],
  my: PlayAnalysis,
  ctx: RuleContext,
  opponents: readonly (readonly Card[])[],
  /** 调用方已算好的 analysis，返回成功时带上避免上层重复调 analyze */
  analysis?: PlayAnalysis,
): PlayResult {
  if (my.suitSlot === -1) return reject('mixed-suit-lead', '首出必须同一花色')
  if (!my.isMultiGroup) return { ok: true, cards, analysis: analysis ?? my }

  const slot = my.suitSlot as SuitSlot
  // 单次遍历收集 maxCard/maxPair，省掉旧实现的 map + 两次 spread + 两个中间数组
  let maxCard = -1
  let maxPair = -1
  for (const h of opponents) {
    const b = bestInSlot(h, slot, ctx)
    if (b.maxCardPower > maxCard) maxCard = b.maxCardPower
    if (b.maxPairPower > maxPair) maxPair = b.maxPairPower
  }
  const power = ctx.power

  for (const g of my.groups) {
    const bad = failingUnit(g, power, maxCard, maxPair)
    if (bad) {
      // 裁剪后的牌与原始 my 不同，必须重新 analyze
      return {
        ok: true,
        cards: bad,
        analysis: analyze(bad, ctx),
        adjusted: true,
        reason: 'throw-failed',
        detail: describeFailure(g),
      }
    }
  }
  return { ok: true, cards, analysis: analysis ?? my }
}

/** 返回该组里最小的失败单位（null 表示该组通过） */
function failingUnit(
  g: Group,
  power: RuleContext['power'],
  maxCard: number,
  maxPair: number,
): Card[] | null {
  // 三个分支都要「组内最弱牌」，一次遍历算好共用，
  // 替代旧实现三次重复的 reduce（每次分配闭包 + 反复 power.get）
  let weakest = g.cards[0] as Card
  let weakestPower = power.get(weakest.value)
  for (let i = 1; i < g.cards.length; i++) {
    const c = g.cards[i] as Card
    const p = power.get(c.value)
    if (p < weakestPower) { weakest = c; weakestPower = p }
  }
  if (g.kind === 'single') return weakestPower > maxCard ? null : [weakest]
  // pair / tractor 都用「最弱的一对 > 对手最大对子」判定，逻辑相同
  return weakestPower > maxPair ? null : g.cards.slice()
}

function describeFailure(g: Group): string {
  if (g.kind === 'single') return '甩牌失败：有单张不是最大，只能出最小的那张'
  if (g.kind === 'pair') return '甩牌失败：有对子不是最大，只能出最小的那一对'
  return '甩牌失败：拖拉机不是最大，只能出这个拖拉机'
}

/* ---------- 跟牌 ---------- */

/**
 * 跟牌：
 *   ① 张数必须与首出相同
 *   ② 该花色张数必须 = min(首出张数, 手里该花色张数)
 *   ③ 该花色不够 → 垫牌自由，直接合法
 *   ④ 该花色够 → 对子数必须 = min(首出对子数, 手里该花色对子数)
 *
 * 注意：**不要求跟连对**（ADR-007 宽松结构跟随）。
 */
export function checkFollow(
  hand: readonly Card[],
  cards: readonly Card[],
  my: PlayAnalysis,
  lead: PlayAnalysis,
  ctx: RuleContext,
): PlayResult {
  // 预算一次 analyzeHand，传给 checkFollowWithHand 复用
  return checkFollowWithHand(analyzeHand(hand, ctx), cards, my, lead, ctx)
}

/**
 * `checkFollow` 的预计算版：接受外部已算好的 `HandAnalysis`，
 * 避免 `legalOnly` / `legalCandidates` 在 60 个候选里逐个 `analyzeHand`。
 */
export function checkFollowWithHand(
  handAnalysis: HandAnalysis,
  cards: readonly Card[],
  my: PlayAnalysis,
  lead: PlayAnalysis,
  ctx: RuleContext,
): PlayResult {
  const leadCount = lead.groups.reduce((n, g) => n + g.cards.length, 0)
  if (cards.length !== leadCount) {
    return reject('count-mismatch', `跟牌张数必须与首出相同（首出 ${leadCount} 张）`)
  }
  if (lead.suitSlot === -1) return reject('must-follow-suit', '首出牌型异常')

  const slot = lead.suitSlot as SuitSlot
  const handSlot = handAnalysis.slots[slot]!
  const handCount = handSlot.cards.length
  const handPairs = handSlot.pairCount

  let sameSuit = 0
  for (const c of cards) if (suitSlotOf(c.value, ctx.power) === slot) sameSuit += 1

  const needSuit = Math.min(leadCount, handCount)
  if (sameSuit !== needSuit) {
    return reject(
      'must-follow-suit',
      `有该花色时必须跟满 ${needSuit} 张（你出了 ${sameSuit} 张）`,
    )
  }
  if (sameSuit < leadCount) return { ok: true, cards, analysis: my } // 花色不够，垫牌自由

  const needPairs = Math.min(lead.pairCount, handPairs)
  // **「至少」而不是「恰好」**（v1.3.29 修正，docs/32 B-2 的连带缺陷）。
  //
  // 原实现要求 `my.pairCount === needPairs`，于是出现**无解死锁**：
  // 首出是甩牌（2 张散单，pairCount = 0），跟家手里该花色恰好只有一对 ——
  // 必须出 2 张该花色（needSuit = 2），但任何 2 张都是对子 ⇒ pairCount = 1 ≠ 0
  // ⇒ 没有任何合法出法，AI 卡死、人类也无牌可出。
  //
  // 规则本意是「有对子必须跟出来」（不能藏着对子只出散牌），而不是「不许比对子多」。
  // 所以放宽成「不能少于」：多出对子只是自己吃亏，不影响合法性。
  if (my.pairCount < needPairs) {
    return reject('must-follow-pairs', `有对子必须跟 ${needPairs} 对（你出了 ${my.pairCount} 对）`)
  }
  return { ok: true, cards, analysis: my }
}
