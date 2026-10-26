/**
 * 合法出法枚举（供 AI 与「提示」使用）
 *
 * 目标不是穷举全部组合（25 张手牌的组合是天文数字），
 * 而是产出一批**确定性、由小到大**的候选，够 AI 选就行。
 */

import { analyze, analyzeHand, cardScore } from '@core'
import type { Card, PlayAnalysis, RuleContext, SuitSlot } from '@core'

export interface LeadContext {
  readonly kind: 'lead'
}
export interface FollowContext {
  readonly kind: 'follow'
  readonly leadCards: readonly Card[]
  readonly leadAnalysis: PlayAnalysis
}
export type PlayContext = LeadContext | FollowContext

/** 按牌力升序 */
function asc(cards: readonly Card[], ctx: RuleContext): Card[] {
  return [...cards].sort((a, b) => ctx.power.get(a.value) - ctx.power.get(b.value))
}

/** 按牌值分组 */
function byValue(cards: readonly Card[]): Map<number, Card[]> {
  const m = new Map<number, Card[]>()
  for (const c of cards) {
    const arr = m.get(c.value)
    if (arr) arr.push(c)
    else m.set(c.value, [c])
  }
  return m
}

/**
 * 枚举候选出法。
 *
 * @param limit 最多返回多少个（默认 40）
 * @param wide  **候选广度**（算力分档用）。`false` = 只给「最小/最大」两个，
 *              等价于旧行为；`true` = 按「对子档位 × 补牌策略」铺开。
 *              低档 AI 不是打得更差，而是**看得更少**（docs/28 §3）。
 */
export function enumeratePlays(
  hand: readonly Card[],
  ctx: RuleContext,
  pc: PlayContext,
  limit = 40,
  wide = true,
): Card[][] {
  return pc.kind === 'lead'
    ? enumerateLeads(hand, ctx, limit, wide)
    : enumerateFollows(hand, ctx, pc, limit, wide)
}

/* ---------- 首出 ---------- */

function enumerateLeads(
  hand: readonly Card[],
  ctx: RuleContext,
  limit: number,
  _wide: boolean,
): Card[][] {
  const out: Card[][] = []
  const ha = analyzeHand(hand, ctx)

  for (const slot of [0, 1, 2, 3, 4] as SuitSlot[]) {
    const cards = asc(ha.slots[slot]!.cards, ctx)
    if (cards.length === 0) continue
    const groups = byValue(cards)

    // 单张
    for (const [, cs] of groups) out.push([cs[0] as Card])
    // 对子
    for (const [, cs] of groups) if (cs.length >= 2) out.push([cs[0] as Card, cs[1] as Card])

    // 连对：找连续的对子串
    const pairValues = [...groups.entries()]
      .filter(([, cs]) => cs.length >= 2)
      .sort((a, b) => ctx.power.get(a[0]) - ctx.power.get(b[0]))
    let run: number[] = []
    const flush = () => {
      if (run.length >= 2) {
        for (let start = 0; start < run.length - 1; start++) {
          for (let end = start + 1; end < run.length; end++) {
            const picked: Card[] = []
            for (let i = start; i <= end; i++) {
              const cs = groups.get(run[i] as number) as Card[]
              picked.push(cs[0] as Card, cs[1] as Card)
            }
            out.push(picked)
          }
        }
      }
      run = []
    }
    for (const [v] of pairValues) {
      if (run.length === 0) {
        run.push(v)
      } else {
        const prev = run[run.length - 1] as number
        if (ctx.power.get(v) - ctx.power.get(prev) === 1) run.push(v)
        else {
          flush()
          run.push(v)
        }
      }
    }
    flush()
  }

  return dedupe(out, limit)
}

/* ---------- 跟牌 ---------- */

/**
 * 跟牌候选。
 *
 * **旧实现只给「最小的」和「最大的」两个**（candA / candB）—— 手里 4 张同花色
 * 跟 1 张时，中间两张永远出不来。打分再准也只能在两个坏选项里挑一个稍好的，
 * 这就是「超强只比强档强 6%」的天花板（见 docs/23 §4.1）。
 *
 * 现在按「对子档位 × 补牌策略」组合出 4~20 个候选：
 *
 *   - **对子档位**：needPairs 个连续对子的所有起点（最小 / 中间 / 最大都覆盖）。
 *     首出是对子时，我可能想用最小对子跟（省牌），也可能想用最大对子压（抢分）。
 *   - **补牌策略**：最小 / 最大 / 非分牌优先 / 分牌优先。
 *     缺门垫牌时，「垫 5 分还是垫 K 这 10 分」是两回事。
 *
 * 组合后去重截断，交给评估函数选。
 */
function enumerateFollows(
  hand: readonly Card[],
  ctx: RuleContext,
  pc: FollowContext,
  limit: number,
  wide: boolean,
): Card[][] {
  const lead = pc.leadAnalysis
  const leadCount = pc.leadCards.length
  const slot = lead.suitSlot
  if (slot === -1) return []

  const ha = analyzeHand(hand, ctx)
  const handSlot = asc(ha.slots[slot]!.cards, ctx)
  const needSuit = Math.min(leadCount, handSlot.length)
  const needPairs = needSuit === leadCount ? Math.min(lead.pairCount, ha.slots[slot]!.pairCount) : 0

  // 该花色的对子池（按牌力升序）
  const groups = byValue(handSlot)
  const pairPool: Card[][] = []
  for (const [, cs] of [...groups.entries()].sort(
    (a, b) => ctx.power.get(a[0]) - ctx.power.get(b[0]),
  )) {
    if (cs.length >= 2) pairPool.push([cs[0] as Card, cs[1] as Card])
  }

  const out: Card[][] = []

  /** 补牌顺序：非分牌优先（垫牌时先甩废牌） */
  const noScoreFirst = (arr: readonly Card[]): Card[] => arr.filter((c) => cardScore(c.value) === 0)
  /** 补牌顺序：分牌优先（队友赢着时往里垫分） */
  const scoreFirst = (arr: readonly Card[]): Card[] => [...arr].sort((a, b) => cardScore(b.value) - cardScore(a.value))

  /**
   * 挑 needPairs 个对子 + 从剩余牌里补够 needSuit 张。
   * 补牌必须从**整槽所有牌**里挑，不能只从「非对子牌」里挑 ——
   * 否则手里只有对子、首出却是单张时，会凑不出合法出法（曾经的真实 bug）。
   */
  const assemble = (pairs: readonly Card[][], order: (rest: readonly Card[]) => readonly Card[]): Card[] | null => {
    const picked: Card[] = []
    const used = new Set<number>()
    for (const p of pairs) {
      picked.push(...p)
      for (const c of p) used.add(c.id)
    }
    const rest = handSlot.filter((c) => !used.has(c.id))
    for (const c of order(rest)) {
      if (picked.length >= needSuit) break
      picked.push(c)
    }
    return picked.length === needSuit ? picked : null
  }

  const strategies: ((rest: readonly Card[]) => readonly Card[])[] = [
    (rest) => rest, // 最小（handSlot 已按牌力升序）
    (rest) => [...rest].reverse(), // 最大
    (rest) => [...noScoreFirst(rest), ...scoreFirst(rest)], // 非分牌优先
    (rest) => [...scoreFirst(rest), ...noScoreFirst(rest)], // 分牌优先
  ]

  // 对子窗口：needPairs 个连续对子的**所有起点**（不只是最小和最大）
  const windows: Card[][][] = []
  if (needPairs > 0 && pairPool.length >= needPairs) {
    for (let st = 0; st + needPairs <= pairPool.length; st++) {
      windows.push(pairPool.slice(st, st + needPairs))
    }
  } else {
    windows.push([])
  }

  // 窄集：只取「最小对子 + 最小补牌」和「最大对子 + 最大补牌」两个
  // （旧行为，给 L0/L1 用）。宽集：全部组合铺开。
  const windowsUsed = wide ? windows : [windows[0]!, windows[windows.length - 1]!]
  const strategiesUsed = wide ? strategies : [strategies[0]!, strategies[1]!]
  for (const w of windowsUsed) {
    for (const st of strategiesUsed) {
      const cand = assemble(w, st)
      if (cand !== null) out.push(cand)
    }
  }

  // 缺门垫牌：该花色不够时，从其他花色补
  if (needSuit < leadCount) {
    const slotIds = new Set(handSlot.map((c) => c.id))
    const fillers = asc(
      hand.filter((c) => !slotIds.has(c.id)),
      ctx,
    )
    // 窄集只保留「补最小的」—— 与旧实现完全一致，L0/L1 的行为不受本次扩充影响
    const fillerOrders: ((arr: readonly Card[]) => readonly Card[])[] = wide
      ? [(arr) => arr, (arr) => [...arr].reverse(), (arr) => [...noScoreFirst(arr), ...scoreFirst(arr)]]
      : [(arr) => arr]
    for (const cand of out.slice()) {
      for (const order of fillerOrders) {
        const used = new Set(cand.map((c) => c.id))
        const picked = cand.slice()
        for (const f of order(fillers)) {
          if (picked.length >= leadCount) break
          if (used.has(f.id)) continue
          picked.push(f)
        }
        if (picked.length === leadCount) out.push(picked)
      }
    }
  }

  return dedupe(out, limit)
}

/** 去重（按 id 集合）并截断 */
function dedupe(plays: Card[][], limit: number): Card[][] {
  const seen = new Set<string>()
  const out: Card[][] = []
  for (const p of plays) {
    const key = p
      .map((c) => c.id)
      .sort((a, b) => a - b)
      .join(',')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(p)
    if (out.length >= limit) break
  }
  return out
}

/** 该出法是否合法（内部自检，AI 出错时能立刻发现） */
export function isPlayLegal(cards: readonly Card[], ctx: RuleContext): boolean {
  return analyze(cards, ctx).groups.length > 0
}
