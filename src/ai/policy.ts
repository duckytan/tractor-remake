/**
 * AI 策略：四档难度
 *
 * L0 随机合法出牌
 * L1 启发式（省大牌、保分、跟牌优先出最小）
 * L2 L1 + 一层「这手能不能吃到分」的评估
 * L3 L2 + 精确压牌判定（看结构 / 看出牌顺序）+ 手牌控制力 + 首出续庄溢价
 *
 * 全部确定性：同 state + 同 rng 序列 → 同出牌（ADR-012）
 */

import { analyze, cardsScore, checkPlay, suitSlotOf, teamOf } from '@core'
import type { Card, PlayAnalysis, RuleContext, Seat, SuitSlot } from '@core'
import { enumeratePlays } from './enumerate'
import type { PlayContext } from './enumerate'
import type { Rng } from '@core'

export type AiLevel = 0 | 1 | 2 | 3

/**
 * L2 附加项的权重。
 *
 * 标定方法见 docs/08 ADR-014：用「座位互换配对测量」对比 L2 与 L1 的净胜率，
 * 消掉座位偏差后再取较优值。改动必须重跑标定。
 */
export const L2_WEIGHTS = {
  /** 跟牌：这一手会被对手反压时扣分（避免白打大牌） */
  over: 0.9,
  /** 首出：这一手会被对手压时扣分 */
  overLead: 0.5,
  /** 跟牌：这一墩已有的分越多，赢墩的溢价越高 */
  trick: 0.06,
  /** 首出：有连对的长套加分（把拖拉机先兑现） */
  tractor: 0.4,
}

/**
 * L3 附加项的权重（见 docs/14 §2.4）。
 *
 * L3 = L2 分（结构、续庄、省牌项保留）+ 下面三项，
 * 其中 `exactOver` **替换** L2 的 `over` / `overLead` —— 同一件事（会不会被压）
 * 只能有一个权重，否则等于把「被压」重复扣两次。
 *
 * 标定方法同 L2（座位互换配对测量，消座位偏差），改动必须重跑标定。
 */
export const L3_WEIGHTS = {
  /** 精确压牌判定为「会被压」时的扣分（比 L2 的 0.9 更重） */
  exactOver: 1.15,
  /** 本墩分值的期望溢价（比 L2 的 0.06 更敏感） */
  trickEv: 0.09,
  /**
   * 出牌后手牌控制力下降的惩罚系数。
   *
   * **只在「这手白花」时生效**（跟牌压不过 / 首出会被压）：赢了的一手不算损失，
   * 否则会与「赢墩吃分」互相抵消，实测掉 8 个百分点。
   */
  control: 0.55,
  /** 首出后「下一墩主动权」的溢价 */
  followUp: 0.35,
}

export interface AiDecisionInput {
  readonly seat: Seat
  readonly hand: readonly Card[]
  readonly ctx: RuleContext
  readonly play: PlayContext
  /** 本墩当前最大牌（用于判断「我跟了能不能赢」）；首出时为 null */
  readonly currentWinner: { readonly seat: Seat; readonly analysis: PlayAnalysis } | null
  /** 该座位是否与当前最大牌同队 */
  readonly partnerLeading: boolean
  /**
   * 三家对手的手牌。
   *
   * L2 用它做「这一手能不能守住」的前瞻判断：
   * 对手手里有没有更大的牌能压过我。L1 不用这个信息。
   *
   * **顺序约定**：按座位升序、排除自己（与 `game.ts` 的构造一致：
   * `[0,1,2,3].filter(x => x !== seat).map(x => hands[x])`）。
   * L3 的续庄模拟依赖这个顺序来还原「第几家是谁」。
   */
  readonly opponents: readonly (readonly Card[])[]
  /**
   * 本墩还没出牌的座位（可选）。
   *
   * L3 用它排除「已经出过牌的人」—— 他们不可能再压我。
   * 缺省 `undefined` ⇒ 退化为「全部视为威胁」，与 L2 的信息假设一致，
   * 因此所有既有调用点无需改动。
   */
  readonly remainingSeats?: readonly Seat[]
}

export interface AiDecision {
  readonly cards: readonly Card[]
  readonly reason: string
}

/** 过滤出真正合法的候选 */
function legalOnly(
  hand: readonly Card[],
  ctx: RuleContext,
  play: PlayContext,
  limit: number,
  opponents: readonly (readonly Card[])[],
): Card[][] {
  const raw = enumeratePlays(hand, ctx, play, limit)
  const out: Card[][] = []
  for (const cards of raw) {
    const r = checkPlay({
      hand,
      cards,
      ctx,
      ...(play.kind === 'follow'
        ? { lead: { cards: play.leadCards, analysis: play.leadAnalysis } }
        : {}),
      // 首出甩牌必须拿真实对手手牌校验，否则 maxCard 恒为 -1、任何甩牌都「合法」
      opponents,
    })
    if (r.ok) out.push(r.cards.slice())
  }
  return out
}

/** 手牌总牌力（用于评估「这手值不值得留」） */
function handStrength(hand: readonly Card[], ctx: RuleContext): number {
  let s = 0
  for (const c of hand) s += ctx.power.get(c.value)
  return s
}

/** 手牌里某个槽（花色或主牌）的张数 */
function slotCount(hand: readonly Card[], slot: number, ctx: RuleContext): number {
  let n = 0
  for (const c of hand) if (suitSlotOf(c.value, ctx.power) === slot) n++
  return n
}

/** 这一墩里已经出现的分数（不含分牌） */
function trickPointsSoFar(
  currentWinner: { readonly analysis: PlayAnalysis } | null,
  play: PlayContext,
): number {
  if (currentWinner) return currentWinner.analysis.score
  return play.kind === 'follow' ? play.leadAnalysis.score : 0
}

/**
 * 对手能不能压过我这一手。
 *
 * L2 的前瞻：AI 知道另外三家的手牌（游戏状态里就有），
 * 所以能判断「我这手出了以后，对手是不是还有更大的牌能反压」。
 *
 * 这是 L2 比 L1 强的核心：L1 只看当前墩，L2 会想「出完之后会不会被抢」。
 */
function canBeOverturned(
  cards: readonly Card[],
  ctx: RuleContext,
  opponents: readonly (readonly Card[])[],
): boolean {
  if (cards.length === 0) return false
  const mine = analyze(cards, ctx)
  if (mine.suitSlot === -1) return true // 混花色，不可能守住
  if (!mine.keyCard) return false

  const myPower = ctx.power.get(mine.keyCard.value)
  const mySlot = mine.suitSlot

  for (const hand of opponents) {
    // 对手能出的最大牌：主牌槽里最大的，或同花色槽里最大的
    let best = -1
    for (const c of hand) {
      const slot = suitSlotOf(c.value, ctx.power)
      // 主牌能压一切；副牌只能压同花色
      const canBeat =
        slot === 4 ? mySlot !== 4 : slot === mySlot
      if (canBeat) {
        const p = ctx.power.get(c.value)
        if (p > best) best = p
      }
    }
    if (best > myPower) return true
  }
  return false
}

/** 该槽里有没有连对（拖拉机） */
function hasTractor(hand: readonly Card[], slot: number, ctx: RuleContext): boolean {
  const cards = hand.filter((c) => suitSlotOf(c.value, ctx.power) === slot)
  if (cards.length < 4) return false
  return analyze(cards, ctx).groups.some((g) => g.kind === 'tractor')
}

/* ================================================================
 * L3：「精确」评估
 * ================================================================ */

/**
 * 出牌的结构需要「连续几对」。
 *
 *   单张 → 0；对子 → 1；拖拉机 → 连对长度；多组混出（甩牌）→ -1。
 *
 * 这是 L3 与 L2 的分水岭：压牌必须**结构相同**，L2 只比牌力，
 * 所以会把「对手有一张更大的单牌」误判成「我的对子守不住」。
 */
function pairsNeededOf(a: PlayAnalysis): number {
  if (a.groups.length !== 1) return -1
  const g = a.groups[0]!
  if (g.kind === 'single') return 0
  return g.length // pair → 1，tractor → 连对个数
}

/** `opponents[i]` 对应的座位：按座位升序、排除自己 */
function seatsOpponentOf(seat: Seat): Seat[] {
  return ([0, 1, 2, 3] as Seat[]).filter((x) => x !== seat)
}

/**
 * 一手牌里能打出的、指定结构的最大牌力（`-1` = 打不出这种结构）。
 *
 * @param cards  同一花色槽的牌（调用方已按槽过滤，避免跨花色拼出假连对）
 * @param pairs  0 = 单张；1 = 对子；n≥2 = n 连对
 */
function unitPowerOf(cards: readonly Card[], ctx: RuleContext, pairs: number): number {
  if (cards.length === 0) return -1
  // 单张：任意一张都能打，直接取最大牌力（对子里的牌也能拆开打）
  if (pairs === 0) {
    let best = -1
    for (const c of cards) best = Math.max(best, ctx.power.get(c.value))
    return best
  }
  // 对子 / 连对：交给 analyze 分组，只认「长度够」的 pair / tractor 组。
  // 注意 tractor 组天然覆盖它内部的对子（顶部 n 对仍是合法 n 连对），
  // 所以判 `g.length >= pairs` 而不是相等。
  const a = analyze(cards, ctx)
  let best = -1
  for (const g of a.groups) {
    if (g.kind === 'single') continue
    const len = g.kind === 'tractor' ? g.length : 1
    if (len < pairs) continue
    best = Math.max(best, ctx.power.get(g.keyCard.value))
  }
  return best
}

/**
 * 某家手里「能压过指定结构」的最大牌力。
 *
 * 副牌首出可以被主牌毙（对子也能被主牌对子毙），所以主牌槽要单独算一遍；
 * **必须分槽计算** —— 牌力表给四门副牌的同一点数编了相同牌力，
 * 混槽分析会把不同花色的牌拼成假连对。
 */
function bestUnitPower(
  hand: readonly Card[],
  ctx: RuleContext,
  slot: SuitSlot,
  pairs: number,
): number {
  const same = hand.filter((c) => suitSlotOf(c.value, ctx.power) === slot)
  let best = unitPowerOf(same, ctx, pairs)
  if (slot !== 4) {
    const trumps = hand.filter((c) => suitSlotOf(c.value, ctx.power) === 4)
    best = Math.max(best, unitPowerOf(trumps, ctx, pairs))
  }
  return best
}

/**
 * 精确版「这手会不会被压」。
 *
 * 相比 L2 的 `canBeOverturned` 补三个盲点：
 *   ① **看结构**：我出对子，对手一张更大的单牌压不了；我出 2 连对，散对也压不了
 *   ② **看出牌顺序**：`remaining` 之外（本墩已出过牌）的座位不再是威胁
 *   ③ 队友已经赢着时不需要防守
 *
 * 多组混出（甩牌）直接判「压不了」：合法的甩牌前提就是每组都是全场最大，
 * 这一条由 `legality.checkLead` 保证。
 *
 * @param memo 单次决策内的缓存（键 `对手下标|槽|连对数`）——
 *             60 个候选里 (槽, 结构) 只有十几种组合，缓存后 analyze 调用量降一个数量级。
 */
function exactBeatable(
  cards: readonly Card[],
  ctx: RuleContext,
  opponents: readonly (readonly Card[])[],
  remaining: readonly Seat[] | undefined,
  partnerLeading: boolean,
  seat: Seat,
  memo?: Map<string, number>,
): boolean {
  if (partnerLeading) return false // 队友已经赢着，不需要防守
  if (cards.length === 0) return false
  const mine = analyze(cards, ctx)
  if (mine.suitSlot === -1) return true // 混花色，不可能守住
  if (!mine.keyCard) return false
  if (mine.groups.length > 1) return false // 合法甩牌：压不了
  const pairs = pairsNeededOf(mine)
  if (pairs < 0) return false

  const myPower = ctx.power.get(mine.keyCard.value)
  const oppSeats = seatsOpponentOf(seat)

  for (let i = 0; i < opponents.length; i++) {
    const s = oppSeats[i]
    if (s === undefined) continue
    if (remaining !== undefined && !remaining.includes(s)) continue
    const key = `${i}|${mine.suitSlot}|${pairs}`
    let p = memo?.get(key)
    if (p === undefined) {
      p = bestUnitPower(opponents[i]!, ctx, mine.suitSlot, pairs)
      memo?.set(key, p)
    }
    if (p > myPower) return true
  }
  return false
}

/**
 * 手牌控制力：**主牌张数**（一张 0.30）。
 *
 * 只看自己的手牌与牌力表（不偷看对手），与 L2 的信息假设一致。
 *
 * **为什么只算主牌**（重标定结论，见 tests/ai/difficulty.test.ts 的标定说明）：
 * 把「副牌 A」「分牌」也计进来会与 L1 的 `powerCost`（省大牌）重复计分，
 * 实测把 L3 vs L2 从 58.0% 压到 50.0% —— 同一件事扣两次，AI 变得过度保守。
 * 主牌张数相对独立（能不能毙牌 / 有没有将权），留下它才有增量信息。
 */
function handControl(hand: readonly Card[], ctx: RuleContext): number {
  let trumps = 0
  for (const c of hand) if (suitSlotOf(c.value, ctx.power) === 4) trumps += 1
  return trumps * 0.3
}

/** 出这手牌会让控制力掉多少（≥ 0） */
function controlLoss(cards: readonly Card[], hand: readonly Card[], ctx: RuleContext): number {
  const ids = new Set(cards.map((c) => c.id))
  const rest = hand.filter((c) => !ids.has(c.id))
  return Math.max(0, handControl(hand, ctx) - handControl(rest, ctx))
}

/**
 * 首出专用：模拟三家回应，返回「我方（我或对家）能否续庄」（1 / 0）。
 *
 * 只模拟到「谁最大」这一层，不复现完整出牌（每家的具体出牌由 L1 决定不影响结论）：
 * 按座位顺序比较各家能打出的最大同结构单位，最大者赢墩。
 * 与 `exactBeatable` 的区别：这里把**队友赢墩**也算我方续庄。
 */
function leadFollowUp(
  cards: readonly Card[],
  ctx: RuleContext,
  opponents: readonly (readonly Card[])[],
  seat: Seat,
  remaining: readonly Seat[] | undefined,
  memo?: Map<string, number>,
): number {
  const mine = analyze(cards, ctx)
  if (mine.suitSlot === -1 || !mine.keyCard) return 0
  const pairs = pairsNeededOf(mine)
  if (pairs < 0) return 1 // 合法甩牌：默认续庄
  const mySlot = mine.suitSlot

  const oppSeats = seatsOpponentOf(seat)
  let bestPower = ctx.power.get(mine.keyCard.value)
  let bestTeam = teamOf(seat)

  for (let i = 0; i < opponents.length; i++) {
    const s = oppSeats[i]
    if (s === undefined) continue
    if (remaining !== undefined && !remaining.includes(s)) continue
    const key = `${i}|${mySlot}|${pairs}`
    let p = memo?.get(key)
    if (p === undefined) {
      p = bestUnitPower(opponents[i]!, ctx, mySlot, pairs)
      memo?.set(key, p)
    }
    if (p > bestPower) {
      bestPower = p
      bestTeam = teamOf(s)
    }
  }
  return bestTeam === teamOf(seat) ? 1 : 0
}


/** 各档的决策理由（也用于测试断言与日志可读性） */
const DECISION_REASONS: readonly string[] = ['随机', '启发式', '评估', '精确']

export function decide(input: AiDecisionInput, level: AiLevel, rng: Rng): AiDecision {
  const { hand, ctx, play, opponents } = input
  const candidates = legalOnly(hand, ctx, play, 60, opponents)
  if (candidates.length === 0) {
    // 兜底：优先出首出花色的牌，再按牌力从小到大
    const slot = play.kind === 'follow' ? play.leadAnalysis.suitSlot : -1
    const count = play.kind === 'follow' ? play.leadCards.length : 1
    const sorted = [...hand].sort((a, b) => {
      const sa = slot !== -1 && ctx.power.isTrump(a.value) === (slot === 4) ? 0 : 1
      const sb = slot !== -1 && ctx.power.isTrump(b.value) === (slot === 4) ? 0 : 1
      if (sa !== sb) return sa - sb
      return ctx.power.get(a.value) - ctx.power.get(b.value)
    })
    return { cards: sorted.slice(0, count), reason: '兜底' }
  }

  if (level === 0) {
    const pick = candidates[rng.int(candidates.length)] as Card[]
    return { cards: pick, reason: '随机' }
  }

  // L3 的压牌判定按 (对手, 槽, 结构) 缓存 —— 60 个候选里组合只有十几种，必须跨候选复用
  const memo = new Map<string, number>()
  const scored = candidates.map((cards) => ({
    cards,
    score: scoreCandidate(cards, input, level, memo),
  }))
  scored.sort((a, b) => b.score - a.score)

  // 并列最优里随机挑一个，避免每局一模一样
  const top = scored[0]!.score
  const best = scored.filter((s) => s.score >= top - 0.001)
  const chosen = best[rng.int(best.length)]!
  return { cards: chosen.cards, reason: DECISION_REASONS[level] ?? '启发式' }
}

/**
 * 给候选打分（越高越好）。
 *
 * L1（启发式）：
 *   - 出牌消耗的牌力越低越好（省大牌）
 *   - 能吃到分就加分；压不过时别送分
 *   - 队友领先时不抢
 *   - 首出优先长套
 *
 * L2（评估）在 L1 之上把「省牌」换成**位置评估**：
 *   出一手之后，剩下手牌的位置价值掉多少。
 *   位置价值考虑了冗余（成对的牌丢一张不心疼）、主牌控制权、
 *   对子/连对结构、以及分数牌资源 —— 比单纯的牌力总和更贴近真实牌力。
 *
 * L3（精确）在 L2 之上换掉「会不会被压」的判定，并补两项：
 *   ① `exactBeatable`：看结构（对子压不了单张）、看出牌顺序（已出过的人不算威胁）
 *   ② `handControl`：出牌后的主牌控制力损失（只在「这手白花」时计入）
 *   ③ `leadFollowUp`：首出后我方能否续庄
 */
function scoreCandidate(
  cards: readonly Card[],
  input: AiDecisionInput,
  level: AiLevel,
  memo?: Map<string, number>,
): number {
  const { ctx, play, currentWinner, partnerLeading, hand, opponents } = input
  const a = analyze(cards, ctx)
  const powerCost = cards.reduce((s, c) => s + ctx.power.get(c.value), 0)
  const points = cardsScore(cards)
  const isL3 = level === 3
  const isL2Plus = level >= 2

  let score = 0
  // ---- 基础：省牌（牌力越低越好）----
  score -= powerCost / (cards.length * 80)

  if (play.kind === 'follow') {
    // 比较对象必须是**本墩当前最大牌**，不是首出牌。
    // 首出之后可能已被别人压过；拿首出牌当基准会误判「我能赢」，
    // 导致 AI 以为自己能压过而白白打大牌。
    const rival = currentWinner ? currentWinner.analysis : play.leadAnalysis
    const iAmWinning = canIWin(a, rival, ctx)
    if (partnerLeading) {
      // 队友已经赢着：尽量出小牌、别抢
      score += iAmWinning ? -0.5 : 0.4
    } else if (iAmWinning) {
      // 我能压过当前最大：吃分是好事
      score += 0.6 + points * 0.08
    } else {
      // 压不过：垫牌时别送分
      score -= points * 0.15
    }

    if (isL2Plus) {
      // ① 前瞻：这一手能不能守住？
      //    L2 只比牌力；L3 换精确判定（看结构、看出牌顺序、队友领先时免防守）
      const beaten = isL3
        ? exactBeatable(
            cards,
            ctx,
            opponents,
            input.remainingSeats,
            partnerLeading,
            input.seat,
            memo,
          )
        : canBeOverturned(cards, ctx, opponents)
      if (beaten) score -= isL3 ? L3_WEIGHTS.exactOver : L2_WEIGHTS.over
      // ② 赢墩价值：这一墩已有的分越多，越值得花代价去赢
      if (iAmWinning && !partnerLeading) {
        score +=
          trickPointsSoFar(currentWinner, play) * (isL3 ? L3_WEIGHTS.trickEv : L2_WEIGHTS.trick)
      }
    }

    // ③ L3：压不过还花主牌，才是真的丢控制力（赢了就不算亏）
    if (isL3 && !iAmWinning) score -= L3_WEIGHTS.control * controlLoss(cards, hand, ctx)
  } else {
    // 首出：长套优先（同一槽牌多），大牌留手
    const slot = a.suitSlot
    if (slot !== -1) {
      // 同槽张数 —— 必须按花色槽统计。
      // 早先用「同为主/副」的粗略计数，把四种副牌混在一起，
      // 结果 AI 永远选不出真正的长套（黑桃 3 张 vs 红桃 6 张被算成一样）。
      score += Math.min(slotCount(hand, slot, ctx), 10) * 0.05
    }
    score -= points * 0.02 // 首出别急着甩分

    // ④ 前瞻：首出这手，对手能不能压？（L2 只比牌力，L3 精确判结构）
    let beaten = false
    if (isL2Plus) {
      beaten = isL3
        ? exactBeatable(
            cards,
            ctx,
            opponents,
            input.remainingSeats,
            partnerLeading,
            input.seat,
            memo,
          )
        : canBeOverturned(cards, ctx, opponents)
      if (beaten) score -= isL3 ? L3_WEIGHTS.exactOver : L2_WEIGHTS.overLead
      // ⑤ 有连对的长套优先 —— 把拖拉机先兑现
      if (slot !== -1 && hasTractor(hand, slot, ctx)) score += L2_WEIGHTS.tractor
    }

    if (isL3) {
      // ⑥ 续庄溢价：这一手出完，我方还能不能接着首出
      score +=
        L3_WEIGHTS.followUp *
        leadFollowUp(cards, ctx, opponents, input.seat, input.remainingSeats, memo)
      // ⑦ 控制力损耗：只在「这手会被压」时才算白花
      if (beaten) score -= L3_WEIGHTS.control * controlLoss(cards, hand, ctx)
    }
  }

  return score
}

/**
 * 我这一手能不能压过对方。
 *
 * `rival` 传的是**本墩当前最大牌**的分析（首出方首出时才是 lead）。
 */
function canIWin(mine: PlayAnalysis, rival: PlayAnalysis, ctx: RuleContext): boolean {
  if (mine.suitSlot === -1) return false
  const rivalTrump = rival.suitSlot === 4
  const myTrump = mine.suitSlot === 4
  // 主牌压副牌；副牌只能压同花色
  if (rivalTrump) {
    if (!myTrump) return false
  } else if (mine.suitSlot !== rival.suitSlot) {
    return false
  }
  if (mine.pairCount !== rival.pairCount) return false
  if (!mine.keyCard || !rival.keyCard) return false
  return ctx.power.get(mine.keyCard.value) > ctx.power.get(rival.keyCard.value)
}

export { handStrength }
