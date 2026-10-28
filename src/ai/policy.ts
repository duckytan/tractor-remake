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
import { BEAT_THRESHOLD, beatChance } from './belief'
import type { Belief } from './belief'
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
/**
 * 王（大小王）的**留存溢价**。
 *
 * 旧实现只用 `powerCost / (cards.length * 80)` 给牌定价：大王牌力约 60，
 * 摊到单张只有 0.75 —— 而 L3 判「会被压」要扣 `exactOver = 1.15`。
 * 于是「首出大王保墩」(−0.75+0.35=−0.40) 比「出小牌被压」(−0.04−1.15=−1.19) 便宜，
 * L3 反复烧王（docs/32 B-1 实测：首出王 11.8%，L2 只有 1.6%）。
 *
 * 取值 1.0：大王单张的首出成本 ≈ 60/80 + 1.0 = 1.75，明显高于 `exactOver = 1.15`，
 * 于是「首出大王保墩」不再比「出小牌被压」便宜。
 *
 * **只作用于首出**（见 `scoreCandidate` 里的 `avgLeadCost`）：跟牌时王的价值
 * 由「这墩多少分」决定，加溢价会让 AI 该毙不毙 —— 实测把溢价也加到跟牌上，
 * L2 的「该毙不毙」从 0 涨到 12 处。
 * 改这个值必须重跑 `tests/ai/difficulty.test.ts` 的座位互换配对测量。
 */
const JOKER_KEEP_COST = 1.0

/**
 * 单张牌的「出牌成本」（越大越舍不得出）。
 *
 * ① 牌力归一化到 0..1：保留「省牌」语义，但不再让一张大王只值 0.75
 * ② 王单独加留存溢价：它是「必胜一张」的稀缺资源，价值不随牌力线性增长
 */
function cardCost(c: Card, ctx: RuleContext): number {
  // 与旧口径同单位（牌力 ÷ 80），这样「省牌」项的绝对量级不变，
  // 只是王多了一份溢价。
  const base = ctx.power.get(c.value) / 80
  return c.value >= 52 ? base + JOKER_KEEP_COST : base
}

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
  /**
   * 跟牌：精确判定「这手会被压」时的扣分。
   *
   * **从 1.15 降到 0.1**（v1.3.29 重标定）。原因不是「调低好看」，而是这条惩罚
   * 在**全信息**下系统性偏保守：`exactBeatable` 看到的是「对手手里有没有更大的牌」，
   * 而不是「对手会不会真的压」—— 有牌 ≠ 会出。于是 AI 一味留着大牌不敢兑现。
   *
   * 扫描记录（L3 vs L2，300 副 × 2 配对）：
   *   1.15 → 59.7%   0.9 → 60.7%   0.5 → 63.0%   0.3 → 63.7%
   *   0.15 → 68.7%   0.05 → 69.0%   0.0 → 70.3%
   * 取 0.1：留一个「被压不是免费的」小惩罚，又不至于压过「赢墩吃分」。
   */
  exactOver: 0.1,
  /**
   * 首出：精确判定「这手会被压」时的扣分。
   *
   * **必须比 `exactOver` 小得多，且与 L2 的 `overLead` 同量级**。
   * 旧实现首出也复用 `exactOver = 1.15`，于是 L3 的首出变成「只要能保证不被压，
   * 烧王也认」—— 实测首出王 11.8%，而 L2 只有 1.6%（docs/32 B-1）。
   * 首出时墩里还没有分，被压的代价本来就比跟牌小，两者不该共用一个权重。
   */
  exactOverLead: 0.6,
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
  followUp: 0.2,
  /**
   * 副牌顶牌「先兑现」的溢价（v1.3.36）。
   *
   * 为什么需要它（用户反馈：「有 A 居然不先出 A，有对 K 也不先出，反而出小牌」）：
   * 打分里 `-powerCost` 只知道「留大牌好」，看不到**副牌顶牌真正的风险不是被压、是留到
   * 后面被毙掉 / 被垫掉**。人类打牌的第一原则就是「有把握的牌先跑掉」。
   * 只对「非主牌槽 + 是我手里这门最大的那张（且 ≥ K 级）+ 压得住」生效 ——
   * 主牌顶牌不急（它可以等），王另算（有 JOKER_KEEP_COST 的留存溢价，不能再加一条反着推）。
   */
  cashTop: 0.55,
  /** 首出「压得住的牌」时，牌力成本打的折（兑现不是浪费，但也不是免费） */
  cashDiscount: 0.6,
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
  /**
   * 对手手牌的概率推断（docs/15 KN-10）。
   *
   * 传了就**不再读 `opponents`** 做策略判断 —— 只用公开信息（我的手牌 +
   * 已出的牌 + 每家张数）算「被压概率」。不传则退回旧的全信息精确判定
   * （单元测试里构造的局面没有完整对局状态，走这条）。
   *
   * 注意 `opponents` 仍然必须传：`legalOnly` 校验**甩牌合法性**时要用真实手牌，
   * 那是规则要求（甩牌不合法会当场失败），不是 AI 的策略选择。
   */
  readonly belief?: Belief
  /**
   * 本墩**已经落在桌面上**的总分（首出 + 已跟过的牌之和）。
   *
   * 只用于「赢下这墩值不值」的定价（`L3_WEIGHTS.trickEv`）。
   * 不传则退回旧口径（只算当前最大那一手的分）—— 旧口径会漏掉别人垫进来的分，
   * 实测 30% 的跟牌局面被低估、平均少 9.4 分。
   */
  readonly trickPoints?: number
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
  wide: boolean,
): Card[][] {
  const raw = enumeratePlays(hand, ctx, play, limit, wide)
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
  /** 已经落在桌面上的总分（调用方从 `s.trick.plays` 求和） */
  trickPoints: number | undefined,
): number {
  // 优先用**整墩**已出的分。旧实现只取「当前最大那一手」的分：
  // 别人垫进来的 10 分不算，于是「这墩值不值得花大牌去抢」被系统性低估
  //（实测 30% 的跟牌局面少算，平均少 9.4 分）。
  if (trickPoints !== undefined) return trickPoints
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
  // 合法甩牌是**整组**比较的：`checkLead` 已经保证每一组都大于其他三家同类型的最大值，
  // 所以「甩出去」本身不可能被压。L3 的 `exactBeatable` 早就这么判了，L2 漏了这条 ——
  // 后果是 L2 把每一个甩牌都当成「会被压」，永远不甩（实测甩牌率 0%）。
  if (mine.groups.length > 1) return false
  if (!mine.keyCard) return false

  const myPower = ctx.power.get(mine.keyCard.value)
  const mySlot = mine.suitSlot

  for (const hand of opponents) {
    // 对手能出的最大牌：同花色槽里最大的；**只有缺这门的人**才能用主牌毙。
    // v1.3.38：旧实现无条件把主牌算进来（`slot === 4 ? mySlot !== 4 : ...`），
    // 于是只要对手有任意一张主（几乎永远成立），任何副牌首出都被判「会被压」——
    // 与 bestUnitPower 里修过的是同一个错，L2 这条路径漏改了（实测 4% 误判）。
    let best = -1
    let hasSuit = false
    for (const c of hand) {
      const slot = suitSlotOf(c.value, ctx.power)
      if (slot !== mySlot) continue
      hasSuit = true
      const p = ctx.power.get(c.value)
      if (p > best) best = p
    }
    if (mySlot !== 4 && !hasSuit) {
      for (const c of hand) {
        if (suitSlotOf(c.value, ctx.power) !== 4) continue
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
  // 副牌还要看「能不能毙」—— 但**只有这门已经跟不出牌的人才能毙**。
  //
  // v1.3.36 修：旧实现无条件把主牌也算进来，于是只要对手手里有任意一张主
  //（几乎永远成立），任何副牌首出都会被判成「可能被压」—— 包括 ♦A。
  // 连锁后果：`exactOverLead` 每手都扣 → AI 从不敢兑现副牌大牌，
  // 首出恒选最小的一张（用户反馈「有 A 居然不先出 A」）。
  // 规则上「有该花色就必须跟该花色」，不可能一边跟牌一边毙牌。
  if (slot !== 4 && same.length === 0) {
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
  // 合法甩牌是**整组**比较的：`checkLead` 已经保证每一组都大于其他三家同类型的最大值，
  // 所以「甩出去」本身不可能被压。L3 的 `exactBeatable` 早就这么判了，L2 漏了这条 ——
  // 后果是 L2 把每一个甩牌都当成「会被压」，永远不甩（实测甩牌率 0%）。
  if (mine.groups.length > 1) return false
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
 * 「这一手甩出去，对手压得住吗」—— `exactBeatable` 的对外薄封装。
 *
 * 只给「稳妥提示」（`ai/safeHint.ts`）用：那套策略要判断「有没有稳赢的牌可以兑现」，
 * 需要的就是这个判定。**不要拿它当通用工具** —— 它假设能看到 `opponents` 的手牌。
 */
export function isSureToHold(
  cards: readonly Card[],
  ctx: RuleContext,
  opponents: readonly (readonly Card[])[],
  remaining: readonly Seat[] | undefined,
  seat: Seat,
): boolean {
  return !exactBeatable(cards, ctx, opponents, remaining, false, seat)
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


/**
 * 队友当前这一手，**剩下的对手压得住吗**？
 *
 * 专门服务「队友赢着时该不该垫分」：只在「压得住」时才需要收着打。
 * 判据与 `exactBeatable` 同源（结构 + 缺门才能毙），但对象换成**队友打出的那一手**
 * 而不是我准备出的这一手 —— 所以这里按 `analysis` 判，不重新分析牌面。
 *
 * 信息假设：只有全信息（`belief === undefined`，即「AI 读牌」开着）时才算得准；
 * 概率推断下没有「队友这手守不守得住」的对应模型，调用方应退回保守分支。
 */
function rivalIsSafe(
  rival: { readonly seat: Seat; readonly analysis: PlayAnalysis },
  ctx: RuleContext,
  opponents: readonly (readonly Card[])[],
  remaining: readonly Seat[] | undefined,
  mySeat: Seat,
  memo?: Map<string, number>,
): boolean {
  const pairs = pairsNeededOf(rival.analysis)
  if (pairs < 0) return true // 甩牌：规则上每组都大于三家，压不了
  if (rival.analysis.keyCard === null) return true
  if (rival.analysis.suitSlot === -1) return true // 混槽：规则上不可能出现，按「压不了」处理
  const myPower = ctx.power.get(rival.analysis.keyCard.value)
  const oppSeats = seatsOpponentOf(mySeat)
  for (let i = 0; i < opponents.length; i++) {
    const s = oppSeats[i]
    if (s === undefined || s === rival.seat) continue // 队友自己不是威胁
    if (remaining !== undefined && !remaining.includes(s)) continue
    const key = `r|${i}|${rival.analysis.suitSlot}|${pairs}`
    let p = memo?.get(key)
    if (p === undefined) {
      p = bestUnitPower(opponents[i]!, ctx, rival.analysis.suitSlot, pairs)
      memo?.set(key, p)
    }
    if (p > myPower) return false
  }
  return true
}

/**
 * 「我这手会不会被对手压」——**唯一入口**。
 *
 * 有 `belief` 时走概率推断（只用公开信息）；没有时退回旧的全信息精确判定。
 * 两条路径的语义完全一致（布尔），所以打分公式不用改。
 */
function willBeBeaten(
  cards: readonly Card[],
  mine: PlayAnalysis,
  ctx: RuleContext,
  input: AiDecisionInput,
  level: AiLevel,
  partnerLeading: boolean,
  memo?: Map<string, number>,
): boolean {
  if (partnerLeading) return false // 队友已经赢着，不需要防守
  const belief = input.belief
  if (belief !== undefined) {
    if (mine.suitSlot === -1) return true
    const pairs = pairsNeededOf(mine)
    if (pairs < 0) return false // 合法甩牌：压不了
    if (!mine.keyCard) return false
    // **精度分档**：L2 用粗推断、L3 用细推断。
    //
    // 这一条是 L2/L3 的「信息质量差」，与旧实现一一对应：
    //   · 旧 L2 的 `canBeOverturned` 只比牌力 —— 不看结构（对子当单张算）
    //     也不看谁已经出过牌（把出过牌的人也当威胁）；
    //   · 旧 L3 的 `exactBeatable` 补了这两点。
    // 现在两者共用概率模型，如果不在这里分档，L2 和 L3 的「会不会被压」判定
    // 就完全一样了 —— 实测 L3 vs L2 从 64.7% 掉到 52.3%（L3 的主优势被抹平）。
    const fine = level === 3
    return (
      beatChance({
        belief,
        ctx,
        mySlot: mine.suitSlot,
        pairs: fine ? pairs : 0,
        myPower: ctx.power.get(mine.keyCard.value),
        remaining: fine ? input.remainingSeats : undefined,
      }) >= BEAT_THRESHOLD
    )
  }
  return level === 3
    ? exactBeatable(cards, ctx, input.opponents, input.remainingSeats, partnerLeading, input.seat, memo)
    : canBeOverturned(cards, ctx, input.opponents)
}

/** 各档的决策理由（也用于测试断言与日志可读性） */
const DECISION_REASONS: readonly string[] = ['随机', '启发式', '评估', '精确']

export function decide(input: AiDecisionInput, level: AiLevel, rng: Rng): AiDecision {
  const { hand, ctx, play, opponents } = input
  // 候选广度按档位：L0/L1 用窄集（等价旧行为），L2+ 用宽集。
  // 这是「算力分档」最直接的体现 —— 低档不是打得更差，而是**看得更少**。
  const wide = level >= 2
  const candidates = legalOnly(hand, ctx, play, 60, opponents, wide)
  if (candidates.length === 0) {
    /**
     * 兜底：**逐个 `checkPlay` 试，取第一个合法的**。
     *
     * 旧实现是「按牌力排序后 `slice(0, count)`」，三个问题（docs/32 B-7）：
     *   ① `slot === -1`（混槽首出）时比较器的两个分支都返回 1 ⇒ 等于**不排序**，
     *      取到的是发牌原序的前 N 张；
     *   ② 完全不校验对子/拖拉机结构 —— 首出是对子时取两张散牌，非法；
     *   ③ 出非法牌后 `playCards` 会拒绝并返回原状态，于是 AI 这一手**永远出不去**，
     *      主线程的 setTimeout 链条变成无限空转（配合 `aiCanAct` 就是死循环）。
     *
     * 现在改成「候选逐个验证」，宁可多算几次也绝不返回未经验证的牌。
     */
    const count = play.kind === 'follow' ? play.leadCards.length : 1
    const byPower = [...hand].sort((a, b) => ctx.power.get(a.value) - ctx.power.get(b.value))
    const tries: Card[][] = []
    if (play.kind === 'lead') {
      for (const c of byPower) tries.push([c])
    } else if (byPower.length >= count) {
      tries.push(byPower.slice(0, count))
      tries.push([...byPower].reverse().slice(0, count))
    }
    for (const cards of tries) {
      const r = checkPlay({
        hand,
        cards,
        ctx,
        ...(play.kind === 'follow'
          ? { lead: { cards: play.leadCards, analysis: play.leadAnalysis } }
          : {}),
        opponents,
      })
      if (r.ok) return { cards: r.cards.slice(), reason: '兜底' }
    }
    // 真的没有合法出法（畸形局面）：返回最小的一手，让 `playCards` 拒绝并给出原因，
    // 由 `aiCanAct` 那一侧的守卫把循环断掉。
    return { cards: byPower.slice(0, Math.max(1, count)), reason: '兜底' }
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
  /** 跟牌口径：纯牌力均值（与旧实现完全一致） */
  const avgPower = cards.reduce((s, c) => s + ctx.power.get(c.value), 0) / (cards.length * 80)
  /** 首出口径：牌力均值 + 王的留存溢价 */
  const avgLeadCost = cards.reduce((s, c) => s + cardCost(c, ctx), 0) / cards.length
  const points = cardsScore(cards)
  const isL3 = level === 3
  const isL2Plus = level >= 2

  let score = 0
  // ---- 基础：省牌（牌力越低越好）----
  // **首出和跟牌用不同口径**：首出时王是「白花」（墩里还没有分），要计留存溢价；
  // 跟牌时王是「用来赢这墩的分」的，溢价会让 AI 该毙不毙。
  score -= play.kind === 'follow' ? avgPower : avgLeadCost

  if (play.kind === 'follow') {
    // 比较对象必须是**本墩当前最大牌**，不是首出牌。
    // 首出之后可能已被别人压过；拿首出牌当基准会误判「我能赢」，
    // 导致 AI 以为自己能压过而白白打大牌。
    const rival = currentWinner ? currentWinner.analysis : play.leadAnalysis
    const iAmWinning = canIWin(a, rival, ctx)
    if (partnerLeading) {
      // 队友已经赢着：尽量出小牌、别抢。
      //
      // 但「垫分牌」要额外加分 —— 一墩只比一次大小，队友最大就等于我方赢，
      // 所以垫出去的 5/10/K 仍然是我方的分（docs/27 §4 F1）。
      // 人类经验：「队友上手了，有分就往里垫」。
      //
      // 风险：如果对手还能压过队友，这些分会被对手抢走。
      // 这个风险由 L2/L3 的前瞻（canBeOverturned / exactBeatable）扣分兜住；
      // L1 没有前瞻，会盲目垫 —— 这正是 L2 应该比 L1 强的地方。
      //
      // 标定（600 次配对）：这个系数从 0.05 扫到 0.2 结果**完全一样**
      // （L2vsL1 56.3% / L3vsL2 60.3%）。因为决策只取最高分，
      // 只要「垫分牌 > 垫废牌」的序关系成立，具体数值不影响选择。
      // 所以这类「单调偏好」参数不必精调，方向对就行。
      //
      // v1.3.37 修：旧实现把「垫分奖励」写在 else 分支里，一旦这张分牌比队友的牌大
      //（= 会抢过队友），奖励就被整段跳过 —— 于是「队友赢着、手里有 10，却垫最小的牌」。
      // 而「抢过队友」到底亏不亏，取决于**还有没有对手没出牌**：
      //   · 对手都出完了 ⇒ 这一墩已经锁定是我方的，抢不抢都是我们的分，垫分纯赚；
      //   · 还有对手 ⇒ 抢过去反而可能被反压，这时才该收着打（旧的 -0.5 惩罚是对的）。
      // 能不能放心垫分 = 「这一墩还会不会被对手抢走」，而不是「还有没有对手没出牌」。
      // v1.3.38：只有「对手都出完」才允许垫 → 实测 12 局里仍有 7 次「该垫没垫」
      //（`scripts/dump-ai-round.ts` 的 missed-points）。对手还在、但压不住队友的那一手时，
      // 垫分同样零风险 —— 那正是人类说的「对家已经最大了，有分就垫」。
      const oppLeft = (input.remainingSeats ?? []).some((x) => teamOf(x) !== teamOf(input.seat))
      const safe =
        !oppLeft ||
        (input.belief === undefined &&
          input.currentWinner !== null &&
          rivalIsSafe(input.currentWinner, ctx, opponents, input.remainingSeats, input.seat, memo))
      if (safe) score += 0.4 + points * 0.15
      else score += iAmWinning ? -0.5 : 0.4 + points * 0.1
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
      const beaten = willBeBeaten(cards, a, ctx, input, level, partnerLeading, memo)
      if (beaten) score -= isL3 ? L3_WEIGHTS.exactOver : L2_WEIGHTS.over
      // ② 赢墩价值：这一墩已有的分越多，越值得花代价去赢
      if (iAmWinning && !partnerLeading) {
        score +=
          trickPointsSoFar(currentWinner, play, input.trickPoints) *
            (isL3 ? L3_WEIGHTS.trickEv : L2_WEIGHTS.trick)
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
      // 长套权重 0.05 → 0.07（v1.3.29）：
      // 旧值最多只能贡献 0.5，而 `-powerCost` 单张就能到 1.0 ⇒ 首出排序几乎完全由
      // 「省牌」决定，L1 于是有 53.2% 的首出是「手里最小的那张」（docs/32 B-3）。
      // 提到 0.07 后长套最多贡献 0.7，能与省牌项抗衡，又不至于把「主牌多」变成
      // 「永远出主牌」—— 试过 0.10，L2 的首出王从 1.6% 涨到 4.2%。
      score += Math.min(slotCount(hand, slot, ctx), 10) * 0.07
    }
    score -= points * 0.02 // 首出别急着甩分

    // ④ 前瞻：首出这手，对手能不能压？（L2 只比牌力，L3 精确判结构）
    //
    // **必须先算**：它同时决定下面两项 ——
    //   · 「省牌」要不要打折（压得住的牌现在出是兑现，不是浪费）
    //   · 副牌顶牌要不要给「先兑现」溢价
    // 旧实现把省钱无条件扣满，于是「有 A 却先出小牌」成了默认行为（用户反馈）。
    let beaten = false
    if (isL2Plus) {
      beaten = willBeBeaten(cards, a, ctx, input, level, partnerLeading, memo)
      if (beaten) score -= isL3 ? L3_WEIGHTS.exactOverLead : L2_WEIGHTS.overLead
      // ⑤ 有连对的长套优先 —— 把拖拉机先兑现
      if (slot !== -1 && hasTractor(hand, slot, ctx)) score += L2_WEIGHTS.tractor

      if (!beaten) {
        // ⑥ 兑现：压得住的牌现在出不亏，牌力成本打折（**王的留存溢价不参与打折**，
        //    那条是 v1.3.29 专门为「首出王 11.8%」加的，打折会把它打回原形）
        const powerPart =
          cards.reduce((n, c) => n + ctx.power.get(c.value) / 80, 0) / cards.length
        score += avgLeadCost - powerPart * L3_WEIGHTS.cashDiscount

        // ⑦ 副牌顶牌先兑现：副牌 A/K 真正的风险不是被压，是留到后面**被毙掉 / 被垫掉**。
        //    `-powerCost` 只看得到「留大牌好」，看不到这一层，所以人类会觉得「有 A 不出 A」很蠢。
        if (slot !== -1 && slot !== 4 && a.keyCard !== null && a.keyCard.value < 52) {
          const mine = hand.filter(
            (c) => c.value < 52 && Math.floor(c.value / 13) === slot,
          )
          const myMax = mine.reduce((m, c) => Math.max(m, ctx.power.get(c.value)), 0)
          const p = ctx.power.get(a.keyCard.value)
          // 副牌的牌力就是**这门里的名次**（2→0 … K→10、A→11），不是 0..80 的连续值
          // （踩过的坑：一度按 64 做阈值，结果这条加分永远不触发）。
          // ≥10 即 K 及以上；并且必须是「我手里这门最大的那张」，不是随便一张大牌。
          if (p >= myMax && p >= 10) score += L3_WEIGHTS.cashTop
        }
      }
    }

    if (isL3) {
      // ⑥ 续庄溢价：这一手出完，我方还能不能接着首出
      //    有 belief 时用概率（`beatChance < 阈值` = 守得住 = 续庄）
      const followUp =
        input.belief !== undefined
          ? a.suitSlot !== -1 && a.keyCard && pairsNeededOf(a) >= 0
            ? beatChance({
                belief: input.belief,
                ctx,
                mySlot: a.suitSlot,
                pairs: pairsNeededOf(a),
                myPower: ctx.power.get(a.keyCard.value),
                remaining: input.remainingSeats,
              }) < BEAT_THRESHOLD
              ? 1
              : 0
            : a.groups.length > 1
              ? 1 // 合法甩牌：默认续庄
              : 0
          : leadFollowUp(cards, ctx, opponents, input.seat, input.remainingSeats, memo)
      score += L3_WEIGHTS.followUp * followUp
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
 *
 * 判定必须与 `core/trick.ts` 的 `canBeat` 保持一致：花色、对子数、**拖拉机长度**三项都过，
 * 再比 keyCard。原来漏了拖拉机长度 —— 首出 2 连对、跟 2 个不连续对子时
 * （`legality.test.ts` 明确判为合法跟牌）AI 会以为「我赢了」，
 * 实际结算时 `canBeat` 的 `runLen` 不等 ⇒ 判首出方赢，AI 打分虚高。
 */
function canIWin(mine: PlayAnalysis, rival: PlayAnalysis, ctx: RuleContext): boolean {
  if (mine.suitSlot === -1) return false
  const rivalTrump = rival.suitSlot === 4
  const myTrump = mine.suitSlot === 4
  // 主牌压副牌；副牌只能压同花色
  if (rivalTrump) {
    if (!myTrump) return false
  } else if (myTrump) {
    // **主牌毙副牌是合法的，而且是必胜**（v1.3.29 修正）。
    //
    // 旧实现这里直接走 `mine.suitSlot !== rival.suitSlot ⇒ return false`，
    // 于是「我毙这墩」永远被判成「我赢不了」⇒ 跟牌分支走「压不过：垫牌时别送分」，
    // 毙牌被当成垫牌扣分 ⇒ **该毙不毙**（docs/32 B-4 实测 L3 有 12 处，
    // L2 只有 1 处）。同一处错误还让「队友赢着时我毙过去」被判成「我在垫分」，
    // 反过来鼓励了内耗。
  } else if (mine.suitSlot !== rival.suitSlot) {
    return false
  }
  if (mine.pairCount !== rival.pairCount) return false
  // 拖拉机长度一致（与 core/trick.ts canBeat 的 runLen 同源）
  if (runLenOf(mine) !== runLenOf(rival)) return false
  if (!mine.keyCard || !rival.keyCard) return false
  return ctx.power.get(mine.keyCard.value) > ctx.power.get(rival.keyCard.value)
}

/** 连对长度：单一拖拉机组返回其对数，其余（散对 / 单张 / 多组）返回 0 */
function runLenOf(a: PlayAnalysis): number {
  return a.groups.length === 1 && a.groups[0]?.kind === 'tractor' ? a.groups[0].length : 0
}

export { handStrength }
