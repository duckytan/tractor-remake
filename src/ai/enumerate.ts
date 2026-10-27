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

/**
 * 把一个花色槽拆成「可独立甩出的组」：单张 / 对子 / 连对。
 *
 * 甩牌的规则是「每一组都要大于其他三家同槽同类型的最大值」（见 `core/legality.ts`
 * 的 `checkLead`），所以候选必须按**组**组合，而不是按张数随便拼。
 *
 * 返回按牌力**降序**（甩牌通常是想把大的先兑现）。
 */
function groupsOfSlot(cards: readonly Card[], ctx: RuleContext): Card[][] {
  const a = analyze(cards, ctx)
  const out: Card[][] = []
  for (const g of a.groups) {
    if (g.kind === 'tractor') {
      // 连对整体作为一组（不能拆成两个对子甩，那样校验口径就变了）
      out.push(g.cards.slice())
    } else if (g.kind === 'pair') {
      out.push(g.cards.slice())
    } else {
      out.push([g.cards[0] as Card])
    }
  }
  return out.sort(
    (x, y) => ctx.power.get((y[0] as Card).value) - ctx.power.get((x[0] as Card).value),
  )
}

function enumerateLeads(
  hand: readonly Card[],
  ctx: RuleContext,
  limit: number,
  wide: boolean,
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

  /* ---- 甩牌（同槽多组）----
   *
   * v1.3.29 新增（docs/32 B-2）。旧实现只产单张/对子/连对，**AI 永远不会甩牌** ——
   * 人类甩 5 张，AI 只能一张一张出，是最容易被看穿的「不会玩」。
   *
   * 生成策略（不穷举，只要「够用且合法」）：
   *   - 每门取「最强的 2 组 / 3 组」—— 甩牌的目的就是一次性兑现大牌
   *   - 再取「最弱的 2 组」—— 残局把垃圾一起扔掉
   *   - `wide === false`（L0/L1）只给最强 2 组，保持低档「看得少」的语义
   *
   * 合法性不在这里判：`policy.ts` 的 `legalOnly` 会拿**真实对手手牌**逐个 `checkPlay`，
   * 不合格的自然被过滤掉（甩牌失败还会被裁剪成最小单位，那条路径也照常工作）。
   */
  for (const slot of [0, 1, 2, 3, 4] as SuitSlot[]) {
    const slotCards = ha.slots[slot]!.cards
    if (slotCards.length < 2) continue
    const gs = groupsOfSlot(slotCards, ctx)
    if (gs.length < 2) continue

    const take = (from: readonly Card[][], n: number): Card[] | null => {
      if (from.length < n) return null
      const picked: Card[] = []
      for (let i = 0; i < n; i++) picked.push(...(from[i] as Card[]))
      return picked
    }

    // 只给「最强 N 组」：甩牌的目的是把大牌一次性兑现。
    // 「最弱的 2 组」也试过，但那类候选几乎必然过不了 `checkLead` 的逐组校验
    // （每组都要大于三家最大值），只是白花算力，而且偶尔能过时也是坏首出。
    const top2 = take(gs, 2)
    if (top2 !== null) out.push(top2)
    if (wide) {
      const top3 = take(gs, 3)
      if (top3 !== null) out.push(top3)
    }
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
  if (slot === -1) {
    // 混槽首出（规则上不合法 —— `checkLead` 会以 `mixed-suit-lead` 拒掉）。
    // 纯防御：给两个「整手按牌力升/降序取前 N 张」的候选，让 `checkPlay` 去裁决，
    // 而不是返回空数组把上层推到兜底分支（那个分支在 v1.3.29 之前是坏的，
    // 见 docs/32 B-7：`slot === -1` 时比较器恒返回 1，等于不排序且不校验结构）。
    const byAsc = asc(hand, ctx)
    if (byAsc.length < leadCount) return []
    return dedupe([byAsc.slice(0, leadCount), [...byAsc].reverse().slice(0, leadCount)], limit)
  }

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
