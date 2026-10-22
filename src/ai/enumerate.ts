/**
 * 合法出法枚举（供 AI 与「提示」使用）
 *
 * 目标不是穷举全部组合（25 张手牌的组合是天文数字），
 * 而是产出一批**确定性、由小到大**的候选，够 AI 选就行。
 */

import { analyze, analyzeHand } from '@core'
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
 * @param limit 最多返回多少个（默认 40）
 */
export function enumeratePlays(
  hand: readonly Card[],
  ctx: RuleContext,
  pc: PlayContext,
  limit = 40,
): Card[][] {
  return pc.kind === 'lead' ? enumerateLeads(hand, ctx, limit) : enumerateFollows(hand, ctx, pc, limit)
}

/* ---------- 首出 ---------- */

function enumerateLeads(hand: readonly Card[], ctx: RuleContext, limit: number): Card[][] {
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

function enumerateFollows(
  hand: readonly Card[],
  ctx: RuleContext,
  pc: FollowContext,
  limit: number,
): Card[][] {
  const lead = pc.leadAnalysis
  const leadCount = pc.leadCards.length
  const slot = lead.suitSlot
  if (slot === -1) return []

  const ha = analyzeHand(hand, ctx)
  const handSlot = asc(ha.slots[slot]!.cards, ctx)
  const needSuit = Math.min(leadCount, handSlot.length)
  const needPairs = needSuit === leadCount ? Math.min(lead.pairCount, ha.slots[slot]!.pairCount) : 0

  // 该花色的候选：对子池 + 全部牌（拆对子也要能跟）
  const groups = byValue(handSlot)
  const pairPool: Card[][] = []
  for (const [, cs] of [...groups.entries()].sort(
    (a, b) => ctx.power.get(a[0]) - ctx.power.get(b[0]),
  )) {
    if (cs.length >= 2) pairPool.push([cs[0] as Card, cs[1] as Card])
  }

  const out: Card[][] = []

  /**
   * 挑 needPairs 个对子 + 从剩余牌里补够 needSuit 张。
   * 关键：补牌必须从**整槽所有牌**里挑，不能只从「非对子牌」里挑 ——
   * 否则手里只有对子、首出却是单张时，会凑不出合法出法（曾经的真实 bug）。
   */
  const pick = (pairs: Card[][], preferHigh: boolean): Card[] | null => {
    const picked: Card[] = []
    const used = new Set<number>()
    for (const p of pairs) {
      picked.push(...p)
      for (const c of p) used.add(c.id)
    }
    const rest = handSlot.filter((c) => !used.has(c.id))
    const order = preferHigh ? [...rest].reverse() : rest
    for (const c of order) {
      if (picked.length >= needSuit) break
      picked.push(c)
    }
    return picked.length === needSuit ? picked : null
  }

  const minPairs = pairPool.slice(0, needPairs)
  const maxPairs = pairPool.slice(pairPool.length - needPairs).reverse()

  const candA = pick(minPairs, false)
  if (candA) out.push(candA)

  const candB = pick(maxPairs, true)
  if (candB) out.push(candB)

  // 只跟对子、不跟单张的变体（首出全是连对时）
  if (needSuit === needPairs * 2) {
    const onlyPairs = pick(minPairs, false)
    if (onlyPairs) out.push(onlyPairs)
  }

  // 垫牌：该花色不够时，从其他花色补最小的
  if (needSuit < leadCount) {
    const slotIds = new Set(handSlot.map((c) => c.id))
    const fillers = asc(
      hand.filter((c) => !slotIds.has(c.id)),
      ctx,
    )
    for (const cand of out.slice()) {
      const used = new Set(cand.map((c) => c.id))
      const picked = cand.slice()
      for (const f of fillers) {
        if (picked.length >= leadCount) break
        if (used.has(f.id)) continue
        picked.push(f)
      }
      if (picked.length === leadCount) out.push(picked)
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
