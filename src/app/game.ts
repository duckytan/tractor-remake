/**
 * 状态转移（纯函数）
 *
 * 约定：
 *   - 不修改入参 state
 *   - 非法动作返回原 state 并写 lastReject，不抛异常
 *   - 随机源由 (seed, step) 派生，保证同种子可复现（ADR-012）
 */

import { decide } from '@ai/policy'
import type { AiLevel } from '@ai/policy'
import { buildBelief } from '@ai/belief'
import { enumeratePlays } from '@ai/enumerate'
import { safeHint } from '@ai/safeHint'
import type { PlayContext } from '@ai/enumerate'
import { isSameTeam,
  DEAL_TOTAL,
  HAND_SIZE,
  RANKS_PER_SUIT,
  TRUMP_POWER_BASE,
  advanceLevel,
  analyze,
  buildPowerTable,
  calcBottomBonus,
  canCounter,
  canGuard,
  cardsScore,
  checkPlay,
  counterNeed,
  dealWithGuard,
  hasJokerPair,
  levelRankToRankIndex,
  levelsFor,
  mulberry32,
  nextSeat,
  partnerOf,
  rankOfValue,
  resolveTrick,
  settleRound,
  suitOfValue,
  teamOf,
  trickStanding,
} from '@core'
import type { Card, LevelRank, Play, PlayRejectReason, Rng, RuleContext, Seat, Suit, Trump } from '@core'
import type { Action, GameState, TrickRecord } from './state'
import { HUMAN_SEAT, STATE_VERSION, ctxOf, emptyState, seatToPlay } from './state'

/* ---------- 工具 ---------- */

const rngFor = (seed: number, step: number): Rng => mulberry32((seed * 2654435761 + step * 40503) >>> 0)

const withStep = (s: GameState): GameState => ({ ...s, step: s.step + 1 })

const reject = (s: GameState, reason: PlayRejectReason, detail: string): GameState => ({
  ...withStep(s),
  lastReject: { reason, detail },
})

/**
 * 把「外部传进来的牌 id 列表」收敛成「人类手牌里真实存在的 id（去重）」。
 *
 * 返回 null = 当前阶段不该有选中态（出牌/埋底之外），调用方直接返回原状态。
 *
 * 为什么需要它（docs/33 C1-02）：`setSelection` / `showHint` / `hintSelect`
 * 原来把 `action.ids` 原样写进 state，不校验、不限阶段。后果是
 * ① 不存在的 id 会留在 `selected` 里，`playSelected` 过滤后变成「先选牌」；
 * ② 定主/结算阶段也能写进 `selected`，被 `saveState` 带进存档。
 */
function validHandIds(s: GameState, ids: readonly number[]): number[] | null {
  if (s.phase !== 'play' && s.phase !== 'bury') return null
  const hand = s.hands[HUMAN_SEAT] as readonly Card[]
  const own = new Set(hand.map((c) => c.id))
  const out: number[] = []
  const seen = new Set<number>()
  for (const id of ids) {
    if (!own.has(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

const buildPower = (mode: 0 | 1, levelRank: LevelRank, trump: Trump) =>
  buildPowerTable({ mode, levelRank, trump })

/** 该局打的级别 = 庄家队的级牌 */
const levelOfDealer = (levels: { a: LevelRank; b: LevelRank }, dealer: Seat): LevelRank =>
  teamOf(dealer) === 0 ? levels.a : levels.b

/**
 * 副牌花色的展示顺序（重制版编码 0=♠ 1=♥ 2=♣ 3=♦）。
 *
 * **目标是「红黑相间」**：相邻两组一黑一红，一眼能分出花色段（用户要求）。
 *
 * 三门副牌必然是「2 + 1」的配色，所以相间只有一种形态 —— 多数色在两端、少数色在中间。
 * 下面四行就是在「相间」这条硬约束下、各主花色的具体取法：
 *
 * | 主花色 | 副牌顺序 |
 * |---|---|
 * | ♦(3) | ♠ ♥ ♣ |
 * | ♣(2) | ♦ ♠ ♥ |
 * | ♥(1) | ♠ ♦ ♣ |
 * | ♠(0) | ♥ ♣ ♦ |
 *
 * 注：这四行是用户逐条指定的。其中 ♦ / ♥ / ♠ 三档也等价于「同色内按 ♠♥♣♦ 原序」，
 * 只有 ♣ 档是「同色内倒序」（♦ 在 ♥ 前面）—— 按相间约束两者都成立，这里以用户口径为准。
 */
const SIDE_ORDER: Record<Suit, readonly Suit[]> = {
  0: [1, 2, 3], // 主 ♠ → ♥ ♣ ♦
  1: [0, 3, 2], // 主 ♥ → ♠ ♦ ♣
  2: [3, 0, 1], // 主 ♣ → ♦ ♠ ♥
  3: [0, 1, 2], // 主 ♦ → ♠ ♥ ♣
}

/**
 * 无将 / 打王级：没有主花色，四门都要排。
 * 取 ♠ ♥ ♣ ♦（原序）—— 它本身就是黑红相间，且与上面三档「同色内按原序」的口径一致。
 */
const SIDE_ORDER_NT: readonly Suit[] = [0, 1, 2, 3]

/**
 * AI 侧的手牌顺序：**纯牌力降序，且与输入顺序无关的全序**。
 *
 * 为什么必须是全序：AI 的候选生成（`enumeratePlays`）与并列取舍都按手牌遍历顺序走，
 * 所以「手牌在数组里的顺序」会渗进 AI 决策。展示排序 `sortHand` 已经改过两次
 * （v1.2.1 换成 smallnest 序、v1.3.0 换成红黑相间），每次都顺手改变了 AI 的强度测量
 * （v1.3.0 那次把 L2 vs L1 打到 50.0%，见 docs/15 与 CHANGELOG v1.3.4）。
 *
 * 修法：给 AI 一份按「牌力降序 → 牌值升序 → 卡 id 升序」排序的副本 ——
 * 同一手牌无论怎么打乱，AI 看到的顺序都一样，展示序再也影响不到决策。
 *
 * 用途两处：AI 埋底（留大牌）、AI 出牌（`aiPlayFor` 传给 `decide`）。
 */
function sortByPowerDesc(hand: readonly Card[], ctx: RuleContext): Card[] {
  return [...hand].sort((a, b) => {
    const byPower = ctx.power.get(b.value) - ctx.power.get(a.value)
    if (byPower !== 0) return byPower
    // 四门副牌同点数牌力相同 ⇒ 必须再比牌值；两副牌同值两张 ⇒ 最后比 id
    const byValue = a.value - b.value
    return byValue !== 0 ? byValue : a.id - b.id
  })
}

/**
 * 手牌展示排序。
 *
 * 顺序：大王 → 小王 → 主级牌 → 副级牌 → [主2 → 副2] → 主花色(点数降序)
 *       → 其余三门按「红黑相间」排（见 `SIDE_ORDER`），花色内点数降序。
 *
 * **为什么不能只按牌力降序排**：牌力表给四门副牌的同一点数编了相同牌力
 * （副牌 A 与副牌 K 之差在所有门相同），按牌力降序会把四张 A 排到一起、
 * 同花色被拆散 —— 这正是「不是拖拉机排序方式」的根因。
 * 所以主牌段按牌力（王/级牌/常主2 的先后只有牌力能表达），
 * 副牌段改按「花色优先、花色内点数降序」。
 */
export function sortHand(hand: readonly Card[], ctx: RuleContext): Card[] {
  const trumpSuit: Suit | null = ctx.forcedNT || ctx.trump === 'NT' ? null : ctx.trump
  // 主花色接在最后：它不参与「副牌顺序」，但花色下标表必须覆盖四门，
  // 否则主牌段并列时的 sd 会拿到 undefined（NaN 比较器 = 排序结果不确定）。
  const suitOrder: readonly Suit[] =
    trumpSuit === null ? SIDE_ORDER_NT : [...SIDE_ORDER[trumpSuit], trumpSuit]
  const suitRank = new Map<Suit, number>(suitOrder.map((s, i) => [s, i]))
  const suitIdx = (v: number): number => suitRank.get(suitOfValue(v) as Suit) as number
  const rankDesc = (a: number, b: number): number =>
    (rankOfValue(b) as number) - (rankOfValue(a) as number)

  return [...hand].sort((a, b) => {
    const pa = ctx.power.get(a.value)
    const pb = ctx.power.get(b.value)
    const ta = pa >= TRUMP_POWER_BASE
    const tb = pb >= TRUMP_POWER_BASE
    if (ta !== tb) return ta ? -1 : 1 // ① 主牌整段在前
    const sd = suitIdx(a.value) - suitIdx(b.value)
    if (ta) {
      // ② 主牌段按牌力降序 ⇒ 大王 > 小王 > 主级牌 > 副级牌 > 主2 > 副2 > 主花色普通牌
      if (pa !== pb) return pb - pa
      // ③ 主牌段并列（副级牌三门 / 副2 三门 / 无将四门级牌）：花色次序 + 点数降序，
      //    保证输出与输入顺序无关、可复现
      return sd !== 0 ? sd : rankDesc(a.value, b.value)
    }
    // ②′ 副牌段：**花色优先**，花色内点数降序。
    //     牌力表给四门副牌的同一点数编了相同牌力，先比牌力会把四张 A 排到一起、
    //     同花色拆散 —— 这正是「不是拖拉机排序方式」的根因。
    return sd !== 0 ? sd : rankDesc(a.value, b.value)
  })
}

/* ---------- 开局 ---------- */

export function startRound(s: GameState, seed: number): GameState {
  const rng = rngFor(seed, 0)
  // 第 1 局（全新游戏）随机定庄；之后庄家由上一局结算决定
  // （nextRound 已把 settle.newDealer 写进 s.dealer，这里不能再用 rng 覆盖）
  const dealer = s.round > 1 ? s.dealer : (rng.int(4) as Seat)

  // FR-18 ③：规则开关改动在下一局生效 —— 开新局时把 pending 合并进 config
  const config = s.pendingConfig
  const levelRank = levelOfDealer(s.levels, dealer)
  const forcedNT = levelRank === 18

  const deal = dealWithGuard(
    rngFor(seed, 1),
    dealer,
    // 注意：这里不传「2 为常主」开关 —— 发牌守卫内部对 mode 0/1 两种牌力表**双跑**，
    // 因为定主前主牌未定，任何一家在任何可能的定约下都不该拿到现成拖拉机（见 core/deal.ts）。
    { levels: [s.levels.a, s.levels.b] },
    buildPower,
  )

  const base: GameState = {
    ...s,
    version: STATE_VERSION,
    phase: 'contract',
    config,
    seed,
    step: 0,
    dealer,
    levelRank,
    forcedNT,
    // 打王级强制无将；否则默认无将，等玩家亮主
    trump: 'NT',
    trumpDeclarer: null,
    trumpCount: 0,
    guardBy: null,
    askedTrumps: [],
    usedTrumps: [],
    counterPending: false,
    counterOptions: [],
    declareOptions: [],
    guardOption: false,
    // 逐张发牌：动画开启时从 0 张开始渐进揭示，关闭时直接给满。
    // 「满」= DEAL_TOTAL（33 轮全局口径）—— 不能写人类手牌长（非庄家人类只有 25 张，
    // 那会导致后 8 轮「庄家独得」永远不发，牌堆计数卡在 8，见 core/deal.ts）。
    revealed: s.animation ? 0 : DEAL_TOTAL,
    declarePrompted: false,
    dealPrompt: false,
    hands: deal.hands.map((h) => h.slice()),
    // 底牌在埋底时才确定（庄家从 33 张里扣 8 张）—— 发牌时不再单独放一堆
    bottom: [],
    bottomScore: 0,
    trick: { leader: dealer, plays: [], winner: null },
    tricksDone: 0,
    defenderScore: 0,
    history: [],
    selected: [],
    lastReject: null,
    notice: deal.degraded ? '发牌约束未能满足，已降级发牌' : null,
    lastSettle: null,
    hintIds: [],
  }
  // **不排序**：`hands` 保持发牌原序，`revealed` 切片才等于「真的摸到的牌」。
  // 展示序一律由 app 层的 `handView()` 负责（它内部调 sortHand），
  // 埋底完成后 `finishBury` 再落最终顺序。
  return {
    ...base,
    declareOptions: humanDeclareOptions(base),
  }
}

/* ---------- 逐张发牌 ---------- */

/** 某座位「已揭示」的手牌（= 真的摸到的牌）。发牌期的亮主校验一律用它 */
function revealedHandOf(s: GameState, seat: Seat): readonly Card[] {
  const hand = s.hands[seat] as readonly Card[]
  return s.revealed >= hand.length ? hand : hand.slice(0, s.revealed)
}

/** 人类「已揭示」的手牌 */
function revealedHand(s: GameState): readonly Card[] {
  return revealedHandOf(s, HUMAN_SEAT)
}

/** 一手牌里持有哪几门级牌（顺序固定 ♠♥♣♦，便于 UI 与测试断言） */
function levelSuitsIn(hand: readonly Card[], s: GameState): Suit[] {
  const lv = levelRankToRankIndex(s.levelRank)
  if (lv === null) return []
  const out: Suit[] = []
  for (const suit of [0, 1, 2, 3] as Suit[]) {
    if (hand.some((c) => c.value === suit * RANKS_PER_SUIT + lv)) out.push(suit)
  }
  return out
}

/** 人类完整手牌里持有级牌的花色 */
function humanLevelSuits(s: GameState): Suit[] {
  return levelSuitsIn(s.hands[HUMAN_SEAT] as readonly Card[], s)
}

/**
 * 人类「还没被问过」的级牌花色（完整手牌口径）。
 *
 * v1.3 起它**不再是 AI 抢主的闸门**（闸门改成「按发牌顺序赛跑」），
 * 只用于「人类手里还有没有值得问的花色」这个快速判断。
 */
function humanUnexaminedSuits(s: GameState): Suit[] {
  return humanLevelSuits(s).filter((suit) => !s.askedTrumps.includes(suit))
}

/**
 * 该座位**第一张级牌**在发牌顺序里的位置（1 基）；没有级牌则 Infinity。
 *
 * 这就是「谁先摸到级牌谁先亮」的度量 —— 四家比大小，
 * 位置小的先有机会；同位置按座位号小的优先（人类座位 0 因此占一点便宜，
 * 但只在「同一张序号上都有级牌」这种极小概率下才生效）。
 */
function firstLevelPos(s: GameState, seat: Seat): number {
  const lv = levelRankToRankIndex(s.levelRank)
  if (lv === null) return Number.POSITIVE_INFINITY // 打王级没有级牌
  const hand = s.hands[seat] as readonly Card[]
  for (let i = 0; i < hand.length; i++) {
    const c = hand[i] as Card
    if (c.value < 52 && c.value % RANKS_PER_SUIT === lv) return i + 1
  }
  return Number.POSITIVE_INFINITY
}

/**
 * 中途提示 / 抢主的最小牌数。
 * 摸到级牌就立刻暂停的话，玩家手上可能只有两三张牌、根本没法判断该不该亮这门，
 * 所以等发到 10 张（约 40%）再问 —— 此时看花色分布已经有意义了。
 * **人类与 AI 用同一个门槛**（发牌早期谁都不许亮）。
 */
const DEAL_PROMPT_MIN = 10

/**
 * 该门至少 3 张才值得抢。
 *
 * 这里定的是「**抢的速度**」，不是「挑牌的质量」——判断一手牌好坏是 AI 出牌阶段的事。
 * 门槛低是为了让四家赛跑接近公平：AI 犹豫一次就等于把庄让给下一位，
 * 门槛高会把人类份额虚高（实测 ≥5 张 + 55% 意愿 ⇒ 人类定主 47.7%，
 * 而四家公平赛跑应当是 ~25%）。
 */
const AI_GRAB_SUIT_MIN = 3
/** AI 抢主意愿百分比。100 = 抢到就亮，不犹豫 */
const AI_GRAB_PCT = 100

/**
 * 挂机反主的门槛：反过去那门至少 5 张。
 *
 * 与 `aiWantsCounter` 同一个数、同一个理由 —— 只有 2 张级牌但那门只有 1 张牌时反主，
 * 等于把主牌拱手送人。**两处必须一起改**（将来若抽成常量请共用这一份）。
 */
const AUTO_COUNTER_SUIT_MIN = 5

/** 已揭示的牌里能亮的花色（发牌中途暂停用；不含无将） */
function declareOptionsIn(s: GameState): Trump[] {
  if (s.forcedNT) return []
  return levelSuitsIn(revealedHand(s), s)
}

/** 已揭示、且还没问过人类的花色 */
function unexaminedRevealedSuits(s: GameState): Trump[] {
  return declareOptionsIn(s).filter((t) => !s.askedTrumps.includes(t))
}

/** AI 想抢哪门主（null = 不抢）。门槛：持该门级牌 + 该门 ≥5 张 + 掷骰通过 */
function aiGrabPick(s: GameState, seat: Seat): Trump | null {
  if (s.forcedNT) return null
  const hand = revealedHandOf(s, seat)
  const suits = levelSuitsIn(hand, s).filter(
    (suit) => hand.filter((c) => suitOfValue(c.value) === suit).length >= AI_GRAB_SUIT_MIN,
  )
  if (suits.length === 0) return null
  if (rngFor(s.seed, s.step + 2000).int(100) >= AI_GRAB_PCT) return null
  // 张数最多的一门（并列取编码小的，保证确定性）
  let best = suits[0] as Suit
  let bestN = -1
  for (const suit of suits) {
    const n = hand.filter((c) => suitOfValue(c.value) === suit).length
    if (n > bestN) {
      best = suit
      bestN = n
    }
  }
  return best
}

/**
 * 发牌期仲裁：**按发牌顺序赛跑**（谁的级牌先发到谁先亮）。
 *
 * 不再有「人类先手」特权 —— 人类与 AI 用同一个 10 张门槛、同一套先后顺序。
 * 顺序：`firstLevelPos` 升序，同位置按座位号升序。
 *
 * 依次尝试每个候选座位：
 *   - 人类：已揭示前缀里还有没问过的级牌花色 ⇒ 弹面板（`dealPrompt`）；
 *     没有可亮的花色就跳过，继续看下一位。
 *   - AI：`aiGrabPick` 愿意抢 ⇒ 亮主并直接进 `resolveContract`；不愿抢就跳过。
 * 全部跳过 ⇒ 返回原状态，继续发牌。
 */
function dealArbitrate(s: GameState): GameState {
  if (s.phase !== 'contract' || s.forcedNT) return s
  if (s.trumpCount > 0) return s
  // 统一门槛：10 张之前谁都不许亮
  if (s.revealed < DEAL_PROMPT_MIN) return s

  const order = ([0, 1, 2, 3] as Seat[])
    .map((seat) => ({ seat, pos: firstLevelPos(s, seat) }))
    .filter((x) => x.pos <= s.revealed)
    .sort((a, b) => a.pos - b.pos || a.seat - b.seat)

  for (const { seat } of order) {
    if (seat === HUMAN_SEAT) {
      // 手里已经没有任何「没问过」的级牌花色 ⇒ 不必再看前缀
      if (humanUnexaminedSuits(s).length === 0) continue
      const suits = unexaminedRevealedSuits(s)
      if (suits.length === 0) continue
      return {
        ...s,
        dealPrompt: true,
        declarePrompted: true,
        declareOptions: suits,
        // 问过就算「已知会」：同门不会每个 tick 反复打断
        askedTrumps: [...s.askedTrumps, ...suits],
        notice: null,
      }
    }
    const pick = aiGrabPick(s, seat)
    if (pick !== null) return resolveContract(applyDeclare(s, seat, pick, 1))
  }
  return s
}

/**
 * 发一张牌（每家各一张）。
 *
 * 顺序：揭示 → 仲裁（四家按「第一张级牌的发牌位置」赛跑，见 dealArbitrate）。
 */
export function revealTick(s: GameState): GameState {
  if (s.phase !== 'contract' || s.dealPrompt) return s
  // 全局发牌轮次：第 26..33 轮只有庄家得牌，人类是不是庄家都要发满 33 轮
  //（否则非庄家人类的视角里，牌堆会永远停在「剩 8 张」）。
  const total = DEAL_TOTAL
  if (s.revealed >= total) return s

  // **发牌期也要推进 `step`**（docs/33 C1-04）：`aiGrabPick` 用
  // `rngFor(s.seed, s.step + 2000)` 掷骰，而 `revealTick` 原来不走 `withStep`
  // ⇒ 整段发牌期 step 恒为 0 ⇒ 每个种子只有一次掷骰结果。
  // 当前 `AI_GRAB_PCT = 100`（掷骰恒通过）所以无害，但一旦调低就会退化成
  // 「要么四家全抢、要么全不抢」。
  const next: GameState = { ...withStep(s), revealed: s.revealed + 1 }
  if (next.revealed >= total) {
    // 发完 ⇒ 直接进定主面板，不再仲裁。
    // 最后一 tick 必须给「完整清单」：中途面板只列级牌花色、没有「继续发牌」按钮，
    // 如果在这一刻才弹面板，玩家就既不能改选无将也退不回去了。
    // 清单由 humanDeclareOptions 决定（无将需一对王；一个选项都没有时兜底放行无将）。
    return { ...next, declareOptions: humanDeclareOptions(next), notice: null }
  }
  return dealArbitrate(next)
}

/**
 * 人类选择「继续发牌」= 放弃本轮**所有**可亮花色。
 *
 * 不只记面板上那几门：凡是「已揭示且没问过」的一律记进 `askedTrumps`，
 * 否则下一个 tick 又会因为同一批花色把人类叫起来。
 */
export function passDeal(s: GameState): GameState {
  if (s.phase !== 'contract' || !s.dealPrompt) return s
  const asked = [...s.askedTrumps]
  for (const t of declareOptionsIn(s)) if (!asked.includes(t)) asked.push(t)
  const next: GameState = {
    ...withStep(s),
    dealPrompt: false,
    declareOptions: [],
    askedTrumps: asked,
    notice: null,
  }
  return dealArbitrate(next)
}

/**
 * 体验项（与对局无关的显示偏好）。新游戏 / 换局都要原样带过去，
 * 否则「新游戏」会把四色、牌面尺寸、动画、历史牌条悄悄重置成默认值。
 */
/**
 * 重开时必须继承的「玩家偏好」字段。
 *
 * 这些既不是规则（不走 pendingConfig），也不是局内状态（不该归零）——
 * 它们是玩家的长期选择。**加字段时只改这一处**，两处重开路径都自动跟上。
 *
 * v1.3.28 之前是手写搬运，只搬了 5 项，导致「切到冬主题 / 调好音量 / 开记牌器，
 * 点一次新游戏全部回默认」，而且 afterChange 会把默认值回写 localStorage，刷新也救不回。
 */
const PREF_FIELDS = [
  'fourColor',
  'cardSize',
  'animation',
  'animSpeed',
  'showHistory',
  'showOppHands',
  'showCounter',
  'hintSelects',
  'hintStyle',
  'aiPeekHands',
  'musicTheme',
  'soundEnhanced',
  'autoVariation',
  'volumeMaster',
  'volumeBgm',
  'volumeSfx',
  'autoPlay',
  'autoLevel',
] as const

type PrefField = (typeof PREF_FIELDS)[number]

/**
 * 从 `src` 里取出全部偏好字段（`GameState` 的字段是 readonly，只能整体构造）。
 *
 * 导出给 `main.ts` 的悔牌用（docs/33 C5-01）：悔牌快照是整个 `GameState`，
 * 如果直接恢复，会把「出牌 → 改设置 → 悔牌」之间改的设置一起退回，
 * 而且 `afterChange()` 还会把回滚后的值写回 localStorage ⇒ 用户的设置被永久抹掉。
 */
export function pickPrefs(src: GameState): Pick<GameState, PrefField> {
  return Object.fromEntries(PREF_FIELDS.map((k) => [k, src[k]])) as Pick<GameState, PrefField>
}

function withExperience(base: GameState, src: GameState): GameState {
  return { ...base, ...pickPrefs(src) }
}

/**
 * 开局。
 *
 * `aiLevel` 是**两侧同置**的便捷入口（保留旧签名 ⇒ 既有调用点零改动）；
 * 需要分侧时先 newGame 再派发 `setAiLevelSide`。
 * `src` 用来继承体验项（四色 / 尺寸 / 动画 / 历史牌条）。
 */
export function newGame(
  config: GameState['config'],
  aiLevel: AiLevel,
  aiSpeedMs: number,
  seed?: number,
  src?: GameState,
): GameState {
  const base: GameState = {
    ...emptyBase(),
    config,
    pendingConfig: config,
    aiLevelPartner: aiLevel,
    aiLevelOpponent: aiLevel,
    aiSpeedMs,
  }
  return startRound(src ? withExperience(base, src) : base, seed ?? (Date.now() % 1e9))
}

/**
 * 空状态模板。
 *
 * **只有一份**：直接复用 `state.ts` 的 `emptyState()`。
 * v1.3.28 之前这里手抄了第二份 56 字段的字面量（与 `emptyState` 逐字段等价，
 * 只是书写顺序不同），后果是：
 *   - 加字段时改一处不会报错，另一处悄悄漏掉（v1.3.28 就漏了 8 个偏好字段）
 *   - 4 个测试文件用 `emptyState()` 搭基线，**测试覆盖的是另一条构造路径**
 */
const emptyBase = emptyState

/* ---------- 亮主 / 反主 / 加固 ---------- */

/** 人类当前能反成的主（供 UI 置灰按钮用） */
function humanCounterOptions(s: GameState): Trump[] {
  // 只能反「别人的主」：自己刚亮的主没有再反一次的道理
  if (s.trumpDeclarer === HUMAN_SEAT) return []
  const hand = s.hands[HUMAN_SEAT] as readonly Card[]
  const ctx = ctxOf(s)
  const sameTeam = s.trumpDeclarer !== null && isSameTeam(HUMAN_SEAT, s.trumpDeclarer)
  const all: Trump[] = [0, 1, 2, 3, 'NT']
  return all.filter((t) =>
    canCounter({
      hand,
      ctx,
      currentTrump: s.trump,
      newTrump: t,
      sameTeamAsDeclarer: sameTeam,
      usedTrumps: s.usedTrumps,
      currentCount: s.trumpCount,
    }),
  )
}

/** 人类能否加固（把定主张数 1 → 2，等于锁死） */
function humanGuardOption(s: GameState): boolean {
  if (s.trumpDeclarer === null || s.trumpDeclarer === HUMAN_SEAT) return false
  return canGuard({
    hand: s.hands[HUMAN_SEAT] as readonly Card[],
    ctx: ctxOf(s),
    currentTrump: s.trump,
    declarer: s.trumpDeclarer,
    seat: HUMAN_SEAT,
    currentCount: s.trumpCount,
  })
}

/**
 * 人类首次亮主可选的项。
 *
 * - **花色主**：必须持该门级牌（smallnest `Algorithm.cs:157-178`）。
 * - **无将**：必须持**一对王**（一对小王 或 一对大王）—— smallnest `Algorithm.cs:211`
 *   的 `SmallJack == 2 || BigJack == 2`。无将没有「某门级牌」可作为亮主凭据，只能拿一对王顶，
 *   这是升级/拖拉机的通行规则（v1.2.8 之前重制版是无条件可亮，属规则放宽）。
 * - **打王级**（`forcedNT`）：主牌固定无将，无条件可选。
 *
 * **兜底**：若一个花色都亮不了、也没有一对王，仍把无将放进清单 ——
 * 否则定主面板 5 个按钮全灰、`declareTrump` 也会全部拒绝，玩家无路可走。
 * 这个兜底实际几乎不触发：AI 见级牌必抢（`AI_GRAB_PCT = 100`），
 * 真走到「没人亮主」时人类多半也没级牌，才会用到它。
 *
 * 注意：这里用**完整手牌**算「能不能选」，真正的持牌校验在 `declareTrump` 里
 * 用已揭示前缀再做一遍（发牌中途不能拿还没摸到的牌亮主）。
 */
export function humanDeclareOptions(s: GameState): Trump[] {
  if (s.forcedNT) return ['NT'] // 打王级强制无将
  const hand = s.hands[HUMAN_SEAT] as readonly Card[]
  const out: Trump[] = levelSuitsIn(hand, s)
  // 无将需一对王；一手牌一个选项都没有时兜底放行，避免定主面板全灰卡死
  if (hasJokerPair(hand) || out.length === 0) out.push('NT')
  return out
}

/**
 * AI 是否愿意反主。
 * 除了「持新花色级牌」这条硬条件，再加一个「该花色至少 5 张」的门槛 ——
 * 否则只要摸到一张别门级牌就无脑反，人类每局都被反，体验很差。
 *
 * 只收 `Suit` —— 没有「反成无将」这个选项：`canCounter` 对 `newTrump === 'NT'`
 * 恒返回 false（无将没有级牌可依），所以候选清单里本来就不该出现 `'NT'`。
 * （旧代码里有一个 `if (newTrump === 'NT') return true` 分支，永远走不到，v1.2.7 删掉。）
 */
function aiWantsCounter(hand: readonly Card[], newTrump: Suit): boolean {
  const n = hand.filter((c) => suitOfValue(c.value) === newTrump).length
  return n >= 5
}

/**
 * 落一次定主（亮主 / 反主 / AI 抢主共用）。
 *
 * - `count` 是这次声明后累计投入的级牌张数（首次 1、反主 = 旧值 + 1）
 * - 第 1 局首个亮主者坐庄（抢庄），换庄会重算本局级牌
 * - 亮主后不再逐张发牌，直接补满（剩下的牌一次性到手上）
 */
function applyDeclare(s: GameState, seat: Seat, trump: Trump, count: number): GameState {
  const isFirst = s.trumpCount === 0
  // 第 1 局抢庄：首个亮主者坐庄。
  // 三个前提：① 首次亮主 ② 第 1 局 ③ 双方同级（换庄不会改变 levelRank）
  // 打王级不抢（主是强制的，换庄没意义）
  const grabDealer = isFirst && s.round === 1 && s.levels.a === s.levels.b && !s.forcedNT
  const newDealer = grabDealer ? seat : s.dealer
  // 只有换庄时才重算级牌（第 1 局双方同级，重算结果不变；其余情况沿用原值，
  // 否则会把「打王级」这类由 levelRank 决定的状态冲掉）
  const newLevel = grabDealer ? levelOfDealer(s.levels, newDealer) : s.levelRank

  // 抢庄易主时，把「庄家多拿的 8 张」从暂定庄家移交给新庄家。
  // 发牌时这 8 张（牌堆最后 8 张）在暂定庄家手上（见 core/deal.ts），
  // 但底牌必须跟着**最终的庄家**走 —— 不移交的话新庄家只有 25 张，
  // 埋底时反而少扣 8 张（旁家 25 张 vs 庄家 25 张，牌局直接歪掉）。
  let hands = s.hands
  if (newDealer !== s.dealer) {
    const oldHand = s.hands[s.dealer] as readonly Card[]
    const extra = oldHand.length > HAND_SIZE ? oldHand.slice(HAND_SIZE) : []
    hands = hands.map((h, i) => {
      if (i === s.dealer) return h.slice(0, HAND_SIZE)
      if (i === newDealer) return [...h, ...extra]
      return h
    })
  }

  return {
    ...withStep(s),
    hands,
    trump,
    trumpDeclarer: seat,
    trumpCount: count,
    guardBy: null,
    usedTrumps: isFirst ? [trump] : [...s.usedTrumps, trump],
    dealer: newDealer,
    levelRank: newLevel,
    forcedNT: newLevel === 18,
    // 补满到「人类整手」：庄家 33 张、旁家 25 张 —— 不能写死 25，
    // 否则庄家定主后最后 8 张永远停在「未揭示」，埋底界面只能看到 25 张。
    // 必须用上面易主移交后的 hands 算（人类可能就是新庄家）。
    revealed: (hands[HUMAN_SEAT] as readonly Card[]).length,
    declarePrompted: true,
    dealPrompt: false,
    declareOptions: [],
    counterPending: false,
    counterOptions: [],
    guardOption: false,
    notice: grabDealer ? `${SEAT_NAMES[seat]}抢到庄，定主 ${trumpLabelOf(trump)}` : null,
    lastReject: null,
  }
}

const SEAT_NAMES = ['南', '西', '北', '东'] as const
const TRUMP_NAMES = ['♠黑桃', '♥红心', '♣梅花', '♦方片'] as const
const trumpLabelOf = (t: Trump): string => (t === 'NT' ? '无将' : (TRUMP_NAMES[t] as string))

/** AI 是否愿意加固（队友把门槛抬到 3 张）。加固几乎总是划算，不加额外门槛 */
function aiWantsGuard(s: GameState, seat: Seat): boolean {
  if (s.trumpDeclarer === null) return false
  return canGuard({
    hand: s.hands[seat] as readonly Card[],
    ctx: ctxOf(s),
    currentTrump: s.trump,
    declarer: s.trumpDeclarer,
    seat,
    currentCount: s.trumpCount,
  })
}

/**
 * 定主之后：AI 依次反主 / 加固，然后判断人类是否还能反或加固。
 *
 * 门槛是 `counterNeed(trumpCount)`：1 张 → 要 2 张 → 2 张 → 要 3 张（不可达 = 锁死）。
 */
function resolveContract(s: GameState): GameState {
  let cur = s
  // 每反一次主就重扫一遍（主变了，其他 AI 的机会也变了）。
  // 反主必须换一门没用过的花色，最多 5 种主；新规则下张数最多抬到 2，所以循环必然很快收敛。
  for (let guard = 0; guard < 8; guard++) {
    const ctx = ctxOf(cur)
    let changed = false
    for (const seat of [1, 2, 3] as Seat[]) {
      const hand = cur.hands[seat] as readonly Card[]
      // ① 反主
      const sameTeam = cur.trumpDeclarer !== null && isSameTeam(seat, cur.trumpDeclarer)
      const pick = ([0, 1, 2, 3] as Suit[]).find(
        (t) =>
          canCounter({
            hand,
            ctx,
            currentTrump: cur.trump,
            newTrump: t,
            sameTeamAsDeclarer: sameTeam,
            usedTrumps: cur.usedTrumps,
            currentCount: cur.trumpCount,
          }) && aiWantsCounter(hand, t),
      )
      if (pick !== undefined) {
        cur = applyDeclare(cur, seat, pick, counterNeed(cur.trumpCount))
        changed = true
        break
      }
      // ② 加固（队友用同花色再亮一次，把门槛抬到 3 张）
      if (aiWantsGuard(cur, seat)) {
        cur = {
          ...withStep(cur),
          trumpCount: counterNeed(cur.trumpCount),
          guardBy: seat,
          counterPending: false,
          counterOptions: [],
          guardOption: false,
          notice: `${SEAT_NAMES[seat]}加固了 ${trumpLabelOf(cur.trump)}，反主门槛升到 3 张`,
        }
        changed = true
        break
      }
    }
    if (!changed) break
  }

  const counterOptions = humanCounterOptions(cur)
  const guardOption = humanGuardOption(cur)
  if (counterOptions.length > 0 || guardOption) {
    // 反主/加固阶段没有「首次亮主」这回事 ⇒ 亮主清单失效（UI 改看 counterOptions）
    return {
      ...cur,
      counterPending: true,
      counterOptions,
      guardOption,
      declareOptions: [],
      notice:
        counterOptions.length > 0
          ? '你可以反主，或点「过」'
          : '你可以加固（反主门槛升到 3 张），或点「过」',
    }
  }
  return proceedAfterContract(cur)
}

/**
 * 扣底选牌：按牌力留最强 25 张，其余 8 张扣掉。
 *
 * 抽出来给三处共用：AI 庄家自动扣底、人类庄家手动扣底时的「挂机」代选、
 * 以及将来任何需要「机器替庄家扣底」的场合 —— 三份实现迟早会漂移。
 *
 * **必须用牌力序而不是展示序**：埋底要留「最强 25 张」，
 * 展示序会把整门 ♥ 排在 ♠ 前面，与强弱无关。
 */
export function chooseBuryIds(s: GameState, seat: Seat): number[] {
  const ctx = ctxOf(s)
  const hand = s.hands[seat] as readonly Card[]
  const sorted = sortByPowerDesc(hand, ctx)
  const keep = new Set(sorted.slice(0, HAND_SIZE).map((c) => c.id))
  return hand.filter((c) => !keep.has(c.id)).map((c) => c.id)
}

/**
 * 定约结束：庄家埋底（人类手动 / AI 自动）。
 *
 * 庄家的手牌在**发牌时就是 33 张**（四家各 25 + 庄家多拿 8，见 `core/deal.ts`），
 * 所以这里没有「收底」这一步 —— 直接把多出来的 8 张交给埋底。
 */
function proceedAfterContract(s: GameState): GameState {
  // 定约已生效 ⇒ 三份「可选项」都失效，避免残留到存档里被 UI 误用
  const withTrump: GameState = {
    ...s,
    counterPending: false,
    counterOptions: [],
    declareOptions: [],
    guardOption: false,
  }

  if (s.dealer === HUMAN_SEAT) {
    return { ...withTrump, phase: 'bury', notice: '你是庄家，选 8 张牌扣底' }
  }
  // AI 庄家自动扣底（与「人类庄家挂机代扣」共用同一套启发式，见 chooseBuryIds）
  const buriedIds = new Set(chooseBuryIds(withTrump, s.dealer))
  const buried = (withTrump.hands[s.dealer] as Card[]).filter((c) => buriedIds.has(c.id))
  return finishBury(withTrump, withTrump.hands.map((h) => h.slice()), buried)
}

/**
 * 人类亮主 / 反主。
 *
 * - 首次亮主（`trumpCount === 0`）：必须持该门级牌，且这张牌**已经发到手**
 *   （用已揭示前缀校验，避免「用还没摸到的牌亮主」）
 * - 反主（`trumpCount > 0`）：张数要达到 `counterNeed(trumpCount)`
 */
export function declareTrump(s: GameState, trump: Trump): GameState {
  if (s.phase !== 'contract') return s
  // **运行时守卫**（docs/33 P2）：`Trump` 类型是 `0|1|2|3|'NT'`，但 JS 调用方
  // 传个 4 也能进来。`buildPowerTable({trump: 4})` 会让 `s === trumpSuit` 永不成立
  // ⇒ 四门全当副牌、整张牌力表失去主牌段，后面全乱。
  if (!(trump === 'NT' || trump === 0 || trump === 1 || trump === 2 || trump === 3)) {
    return reject(s, 'cannot-counter', '主牌标识非法')
  }
  const finalTrump: Trump = s.forcedNT ? 'NT' : trump

  if (s.trumpCount === 0) {
    if (!humanDeclareOptions(s).includes(finalTrump)) {
      return reject(
        s,
        'cannot-counter',
        finalTrump === 'NT'
          ? '无将需要一对王（一对小王或一对大王），你没有'
          : '你没有这门花色的级牌，不能亮主',
      )
    }
    // 持牌校验用「已揭示」的前缀：发牌中途不能用还没摸到的牌亮主。
    // 无将不走这一步 —— 它只在「发完 25 张」的定主面板上出现，
    // 中途的面板只列级牌花色（见 dealArbitrate / revealTick）。
    if (finalTrump !== 'NT' && !declareOptionsIn(s).includes(finalTrump)) {
      return reject(s, 'cannot-counter', '这张级牌还没发到手，不能亮主')
    }
  } else {
    const sameTeam = s.trumpDeclarer !== null && isSameTeam(HUMAN_SEAT, s.trumpDeclarer)
    const ok = canCounter({
      hand: s.hands[HUMAN_SEAT] as readonly Card[],
      ctx: ctxOf(s),
      currentTrump: s.trump,
      newTrump: finalTrump,
      sameTeamAsDeclarer: sameTeam,
      usedTrumps: s.usedTrumps,
      currentCount: s.trumpCount,
    })
    if (!ok) {
      return reject(
        s,
        'cannot-counter',
        `反主要 ${counterNeed(s.trumpCount)} 张该门级牌，你没有`,
      )
    }
  }

  const count = s.trumpCount === 0 ? 1 : counterNeed(s.trumpCount)
  return resolveContract(applyDeclare(s, HUMAN_SEAT, finalTrump, count))
}

/** 人类加固：队友定主后，用同花色级牌把门槛抬到 3 张 */
export function guardTrump(s: GameState): GameState {
  if (s.phase !== 'contract' || !s.guardOption) return s
  const declarer = s.trumpDeclarer
  if (declarer === null) return s
  if (!humanGuardOption(s)) return reject(s, 'cannot-counter', '你没有该门级牌，不能加固')
  return proceedAfterContract({
    ...withStep(s),
    trumpCount: counterNeed(s.trumpCount),
    guardBy: HUMAN_SEAT,
    counterPending: false,
    counterOptions: [],
    guardOption: false,
    declareOptions: [],
    notice: '你加固成功，反主门槛升到 3 张',
  })
}

/** 人类放弃反主 / 加固，定约立即生效 */
export function passCounter(s: GameState): GameState {
  if (s.phase !== 'contract' || !s.counterPending) return s
  return proceedAfterContract(withStep(s))
}

function finishBury(s: GameState, hands: Card[][], buried: readonly Card[]): GameState {
  const next = hands.slice()
  const buriedIds = new Set(buried.map((c) => c.id))
  for (let seat = 0; seat < 4; seat++) {
    next[seat] = (next[seat] as Card[]).filter((c) => !buriedIds.has(c.id))
  }
  const ctx = ctxOf(s)
  return {
    ...s,
    hands: next.map((h) => sortHand(h, ctx)),
    bottom: buried.slice(),
    bottomScore: cardsScore(buried),
    phase: 'play',
    trick: { leader: s.dealer, plays: [], winner: null },
    notice: null,
  }
}

export function buryCards(s: GameState, ids: readonly number[]): GameState {
  if (s.phase !== 'bury') return s
  if (ids.length !== 8) return reject(s, 'count-mismatch', '必须扣满 8 张')
  const hand = s.hands[s.dealer] as readonly Card[]
  const idSet = new Set(ids)
  const buried = hand.filter((c) => idSet.has(c.id))
  if (buried.length !== 8) return reject(s, 'cards-not-in-hand', '扣底的牌不在手里')
  return finishBury(withStep(s), s.hands.map((h) => h.slice()), buried)
}

/* ---------- 出牌 ---------- */

/**
 * 把「某座位出这几张牌」落到状态上（规则裁决入口）。
 *
 * 导出给**离线工具**用（`scripts/judge-divergences.ts` 按对局日志重放）：
 * 重放别的座位不能走 `setSelection` + `playSelected` —— 那两个动作只作用于人类座位。
 */
export function playCards(s: GameState, seat: Seat, cards: readonly Card[]): GameState {
  const ctx = ctxOf(s)
  const isLead = s.trick.plays.length === 0
  const leadPlay = isLead ? undefined : (s.trick.plays[0] as Play)

  // ---- 防御性校验（docs/33 C6-01 / C6-03）----
  //
  // ① 手牌为空却还要出牌：`checkPlay` 会以 'empty' 拒绝，`playCards` 返回原状态，
  //    而 `aiCanAct` 只判 phase/座位 —— 于是 aiStep 会**无限空转**（实测 phase 永远停在 play）。
  //    这里显式拒绝并给出可读原因，配合 `aiCanAct` 一起把循环断掉。
  if ((s.hands[seat] as readonly Card[]).length === 0) {
    return reject(s, 'empty', '该座位已经没有手牌')
  }
  // ② 同一座位在一墩里出两次牌：凑满 4 手后 `resolveTrick` 会按「4 手牌」结算，
  //    于是算出一个**非法赢家**（有人出了两次、有人一次没出）而没有任何报错。
  if (s.trick.plays.some((p) => p.seat === seat)) {
    return reject(s, 'cards-not-in-hand', '该座位本墩已经出过牌')
  }

  const result = checkPlay({
    hand: s.hands[seat] as readonly Card[],
    cards,
    ctx,
    ...(leadPlay ? { lead: { cards: leadPlay.cards, analysis: leadPlay.analysis } } : {}),
    opponents: [0, 1, 2, 3]
      .filter((x) => x !== seat)
      .map((x) => s.hands[x] as readonly Card[]),
  })

  if (!result.ok) return reject(s, result.reason, result.detail)

  const actual = result.cards
  const analysis = analyze(actual, ctx)
  const play: Play = { seat, cards: actual, analysis }

  const hands = s.hands.map((h) => h.slice())
  const usedIds = new Set(actual.map((c) => c.id))
  hands[seat] = (hands[seat] as Card[]).filter((c) => !usedIds.has(c.id))

  let next: GameState = {
    ...withStep(s),
    hands,
    selected: [],
    lastReject: null,
    notice: result.adjusted ? result.detail : null,
    trick: { ...s.trick, plays: [...s.trick.plays, play] },
  }

  if (next.trick.plays.length === 4) next = resolveCurrentTrick(next)
  return next
}

function resolveCurrentTrick(s: GameState): GameState {
  const ctx = ctxOf(s)
  const result = resolveTrick(s.trick.plays, ctx)
  const record: TrickRecord = {
    leader: s.trick.leader,
    plays: s.trick.plays.map((p) => ({ seat: p.seat, cards: p.cards })),
    winner: result.winner,
    score: result.score,
  }

  const dealerSide = teamOf(s.dealer)
  const winnerSide = teamOf(result.winner)
  const gain = winnerSide === dealerSide ? 0 : result.score
  const tricksDone = s.tricksDone + 1

  const base: GameState = {
    ...withStep(s),
    tricksDone,
    defenderScore: s.defenderScore + gain,
    history: [...s.history, record],
    trick: { leader: result.winner, plays: [], winner: result.winner },
  }

  // 终局判定：四家手牌全部出完才进结算。
  // 不能写死墩数 —— 出对子/拖拉机时一墩消耗多张牌，实际墩数会少于 25
  // （例：24 墩里有一墩出对子，100 张牌就打完了）。
  const cardsLeft = s.hands.reduce((n, h) => n + h.length, 0)
  if (cardsLeft > 0) return base
  return settleCurrentRound(base, result.winnerAnalysis)
}

function settleCurrentRound(s: GameState, lastWinnerAnalysis: ReturnType<typeof analyze>): GameState {
  const dealerSide = teamOf(s.dealer)
  const bonus = calcBottomBonus(
    lastWinnerAnalysis,
    s.bottomScore,
    teamOf((s.history[s.history.length - 1] as TrickRecord).winner) === dealerSide,
  )
  const defenderScore = s.defenderScore + bonus.extra

  const settle = settleRound({
    defenderScore,
    dealerSeat: s.dealer,
    levels: s.levels,
    config: s.config,
    mode: s.config.twoAsPermanent ? 1 : 0,
  })

  return {
    ...withStep(s),
    phase: settle.gameOver ? 'over' : 'settle',
    defenderScore,
    lastSettle: settle,
    selected: [],
    notice: bonus.applies
      ? `扣底 ×${bonus.multiplier}，底分 ${s.bottomScore} → 加 ${bonus.extra} 分`
      : null,
  }
}

/**
 * 当前这一墩的最大牌（首出时为 null）。
 *
 * **必须走 core 的 `trickStanding`** —— 一墩判定全项目只此一份。
 * 这里原来自己写「遍历取 keyCard 最大者」，不比花色也不比结构，
 * 于是任何人垫牌（非同花色）的大牌都会被当成「当前最大」，
 * AI 据此误判「我赢不了」而白垫小牌（docs/15 KN-7）。
 */
export function currentWinnerOf(s: GameState): { seat: Seat; analysis: ReturnType<typeof analyze> } | null {
  const standing = trickStanding(s.trick.plays, ctxOf(s))
  if (standing === null) return null
  return { seat: standing.winner.seat, analysis: standing.winner.analysis }
}

/**
 * 让指定座位**选一手牌**（纯计算，不落子）。
 *
 * 抽出来的原因：**「提示」和 AI 必须共用一个大脑**。
 * 早先提示走的是 `enumeratePlays(...)` 取第一个合法候选，而候选是按小到大枚举的
 * ⇒ 提示永远只会让你出最小的一手（用户反馈「提示还是太弱智」）。
 * 现在提示直接调这里，拿到的是 L3（超强 + 残局搜索）算出来的那一手。
 *
 * `aiPlayFor` 也走这里，所以「AI 会怎么打」和「提示建议怎么打」不可能分叉。
 *
 * 座位无关 —— 测试可以给四个座位都套 AI，不必把「人类座位」特殊对待；
 * 随机源统一 —— 同一步用同一个 rng 派生式，公平对比不同档位。
 */
export function choosePlay(
  s: GameState,
  seat: Seat,
  level: AiLevel,
  /**
   * 调试/标定用开关。
   *
   * `peek: true` = **旧行为**：把三家真实手牌塞进 `opponents`，让策略直接读（明牌）。
   * 默认跟玩家设置 `aiPeekHands` 走（默认开）—— 见 docs/15 KN-10。
   * 保留这个开关是为了能配对测量「明牌 vs 推断」的强度差，正常对局不要传。
   */
  opts?: {
    readonly peek?: boolean
    /** 是否启用残局搜索（默认开；标定脚本用它做 A/B） */
    readonly endgame?: boolean
  },
): readonly Card[] {
  // 显式 opts 优先（标定用），否则跟玩家设置走（默认读牌）
  const peek = opts?.peek ?? s.aiPeekHands

  // L3：残局先做完全搜索（含抠底的跨墩交换，启发式看不到）。
  // 搜索不接管（牌太多 / 关掉读牌 / 超预算）时返回 null，落回启发式。
  if (level === 3 && opts?.endgame !== false) {
    const solved = solveEndgame(s, seat, peek)
    if (solved !== null) return solved
  }
  const ctx = ctxOf(s)
  const isLead = s.trick.plays.length === 0

  const pc: PlayContext = isLead
    ? { kind: 'lead' }
    : {
        kind: 'follow',
        leadCards: (s.trick.plays[0] as Play).cards,
        leadAnalysis: (s.trick.plays[0] as Play).analysis,
      }

  const currentWinner = currentWinnerOf(s)

  const decision = decide(
    {
      seat,
      // 用与展示序解耦的全序副本（见 sortByPowerDesc 注释）——
      // 否则改手牌展示排序会连带改变 AI 决策与强度测量
      hand: sortByPowerDesc(s.hands[seat] as readonly Card[], ctx),
      ctx,
      play: pc,
      currentWinner,
      partnerLeading: currentWinner !== null && isSameTeam(currentWinner.seat, seat),
      // 对家手牌：L2 用它做前瞻（这手能不能守住）
      opponents: [0, 1, 2, 3]
        .filter((x) => x !== seat)
        .map((x) => s.hands[x] as readonly Card[]),
      // 本墩还没出牌的座位：L3 靠它排除「已经出过牌的人」（他们压不了我）。
      // 不传会让 L3 退化成「把出过牌的人也当威胁」。
      remainingSeats: [0, 1, 2, 3].filter(
        (x) => x !== seat && !s.trick.plays.some((p) => p.seat === x),
      ) as Seat[],
      // 概率推断（只吃公开信息）。`peek` 时不给，退回旧的全信息判定。
      ...(peek ? {} : { belief: buildBelief(s, seat) }),
      // 本墩已经落在桌面上的分 —— 定价「赢下这墩值不值」要用整墩的分，
      // 不是只有当前最大那一手的分（见 policy.ts 的 trickPointsSoFar）。
      trickPoints: s.trick.plays.reduce((n, p) => n + cardsScore(p.cards as readonly Card[]), 0),
    },
    level,
    rngFor(s.seed, s.step + 1000),
  )

  return decision.cards
}

/**
 * 让指定座位用 AI 出一手牌（`choosePlay` 算完直接落子）。
 *
 * 与 `choosePlay` 分开是为了让「提示」能只取建议、不动状态。
 */
export function aiPlayFor(
  s: GameState,
  seat: Seat,
  level: AiLevel,
  opts?: {
    readonly peek?: boolean
    readonly endgame?: boolean
  },
): GameState {
  return playCards(s, seat, choosePlay(s, seat, level, opts))
}

/**
 * 「稳妥提示」：一套像人的保守打法（`ai/safeHint.ts`）。
 *
 * 与 `choosePlay`（L3）并列，由设置项 `hintStyle` 选择用哪套。
 * 这里只负责**把 GameState 翻译成 SafeHintInput** —— 决策逻辑全在 ai 层，
 * 与 `choosePlay` 同一套分层（ui → app → ai → core）。
 */
export function chooseSafePlay(s: GameState, seat: Seat): readonly Card[] {
  const ctx = ctxOf(s)
  const leadPlay = s.trick.plays[0]
  const play: PlayContext = leadPlay
    ? { kind: 'follow', leadCards: leadPlay.cards, leadAnalysis: leadPlay.analysis }
    : { kind: 'lead' }
  const winner = currentWinnerOf(s)
  return safeHint({
    hand: s.hands[seat] as readonly Card[],
    ctx,
    play,
    currentWinner: winner === null ? null : winner.analysis,
    partnerLeading: winner !== null && isSameTeam(winner.seat, seat),
    opponents: [0, 1, 2, 3].filter((x) => x !== seat).map((x) => s.hands[x] as readonly Card[]),
    seat,
    remainingSeats: [0, 1, 2, 3].filter(
      (x) => x !== seat && !s.trick.plays.some((p) => p.seat === x),
    ) as Seat[],
    trickPoints: s.trick.plays.reduce((sum, p) => sum + cardsScore(p.cards as readonly Card[]), 0),
  })
}

/* ============================================================
   挂机（v1.3.34）：让 AI 代打「人类座位」
   ------------------------------------------------------------
   与 `aiPlayFor` 的区别：那个是**替别的座位**出牌（AI 对手/队友），
   这个是把「人类这一侧的每一个待办」逐个交给机器 —— 选牌、出牌、
   抢主、反主、加固、扣底、下一局。

   为什么要单独一层 `autoAction`（而不是在 main.ts 里 if-else）：
   这些分支都在和状态机打交道（`phase` / 各种 pending 标记），
   写在 main.ts 里就永远测不到（单测跑不到 DOM 入口）。抽成纯函数后
   可以逐分支断言，见 `tests/app/autoPlay.test.ts`。
   ============================================================ */

/**
 * 挂机时「人类座位」下一步该派发什么 action；没得做返回 `null`。
 *
 * `null` 是 main.ts 停止排定时器的**唯一信号** —— 所以每个分支都必须
 * 在「确实有事可做」时才返回 action，否则定时器链条会空转。
 */
export function autoAction(s: GameState): Action | null {
  if (!s.autoPlay) return null
  // 回放期间必须停手：玩家在看历史墩，局面不该自己往前走
  if (s.replayAt !== null) return null

  if (s.phase === 'contract') {
    // ---- 反主 / 加固面板 ----
    if (s.counterPending) {
      // 加固是纯增益（把反主门槛抬到 2 张级牌 ⇒ 不可达），能做就做
      if (s.guardOption) return { type: 'guard' }
      const counter = autoCounterTrump(s)
      return counter !== null ? { type: 'declareTrump', trump: counter } : { type: 'passCounter' }
    }
    // ---- 亮主：摸到级牌的中途暂停，或整副发完等定主 ----
    const waiting = s.dealPrompt || s.revealed >= DEAL_TOTAL
    if (!waiting) return null // 还在逐张发牌，交给 revealTick
    const declare = autoDeclareTrump(s)
    if (declare !== null) return { type: 'declareTrump', trump: declare }
    // 一手牌一门都亮不了：中途面板只能「继续发牌」，发完后面板会放行无将
    return s.dealPrompt ? { type: 'passDeal' } : null
  }

  if (s.phase === 'bury') {
    // 人类坐庄要扣底 —— 与 AI 庄家同一套启发式
    return { type: 'bury', ids: chooseBuryIds(s, HUMAN_SEAT) }
  }

  if (s.phase === 'play') {
    if (seatToPlay(s) !== HUMAN_SEAT) return null // 轮到别人，走 aiStep
    return { type: 'autoPlayTurn' }
  }

  // 结算页「下一局」也交给机器，否则挂机得有人守着点按钮
  if (s.phase === 'settle' || s.phase === 'over') return { type: 'nextRound' }

  return null
}

/** 挂机期间没法亮主时挑哪门：手牌张数最多的一门（无将只作兜底） */
function autoDeclareTrump(s: GameState): Trump | null {
  // `declareOptions` 是「已发到手」的合法清单（发牌中途），
  // `humanDeclareOptions` 按整手牌算 —— 两者取有值的那个，优先前者。
  const pool = s.declareOptions.length > 0 ? s.declareOptions : humanDeclareOptions(s)
  if (pool.length === 0) return null
  const hand = s.hands[HUMAN_SEAT] as readonly Card[]
  let best: Trump | null = null
  let bestN = -1
  for (const t of pool) {
    if (t === 'NT') continue // 无将没有「张数」可比，只在没有花色可亮时兜底
    const n = hand.filter((c) => suitOfValue(c.value) === t).length
    if (n > bestN) {
      bestN = n
      best = t
    }
  }
  if (best !== null) return best
  return pool.includes('NT') ? 'NT' : null
}

/**
 * 挂机期间要不要反主：**只在「反过去那门 ≥5 张」时才反**。
 *
 * 与 AI 自己的门槛一致（`aiWantsCounter`）—— 手里只有 2 张级牌、这门却只有 1 张牌时
 * 反主等于把主牌交给对手，比不反更差。宁可 `过`。
 */
function autoCounterTrump(s: GameState): Trump | null {
  const hand = s.hands[HUMAN_SEAT] as readonly Card[]
  let best: Trump | null = null
  let bestN = AUTO_COUNTER_SUIT_MIN - 1
  for (const t of s.counterOptions) {
    if (t === 'NT') continue
    const n = hand.filter((c) => suitOfValue(c.value) === t).length
    if (n > bestN) {
      bestN = n
      best = t
    }
  }
  return best
}

/**
 * 把 `autoAction` 算出来的一步真正落下去。
 *
 * 与 `autoAction` 分开：main.ts 需要先问「有没有事可做」再决定要不要排定时器
 * （没有可做动作就不排，这是防空转的硬保证），测试则想直接看到结果。
 */
export function autoStep(s: GameState): GameState {
  const action = autoAction(s)
  return action === null ? s : reduce(s, action)
}

/* ---------- AI ---------- */

/**
 * 某个座位该用哪一档 AI。
 *
 * 对家（座位 2，与人类同队）用 `aiLevelPartner`；两个敌家用 `aiLevelOpponent`。
 */
export function aiLevelForSeat(s: GameState, seat: Seat): AiLevel {
  return isSameTeam(seat, HUMAN_SEAT) ? s.aiLevelPartner : s.aiLevelOpponent
}

function aiPlay(s: GameState): GameState {
  const seat = seatToPlay(s)
  if (seat === null || seat === HUMAN_SEAT) return s
  return aiPlayFor(s, seat, aiLevelForSeat(s, seat))
}

/* ---------- reducer ---------- */

export function reduce(s: GameState, action: Action): GameState {
  switch (action.type) {
    case 'newGame': {
      // 新游戏也应用待生效的规则设置；两侧强度与体验项原样带过去
      const fresh = newGame(s.pendingConfig, s.aiLevelOpponent, s.aiSpeedMs, action.seed, s)
      return { ...fresh, aiLevelPartner: s.aiLevelPartner }
    }

    case 'declareTrump':
      return { ...declareTrump(s, action.trump), hintIds: [] }

    case 'guard':
      return { ...guardTrump(s), hintIds: [] }

    case 'passCounter':
      return { ...passCounter(s), hintIds: [] }

    case 'revealTick':
      return revealTick(s)

    case 'passDeal':
      return { ...passDeal(s), hintIds: [] }

    case 'bury':
      return { ...buryCards(s, action.ids), hintIds: [] }

    case 'toggleSelect': {
      if (s.phase !== 'play' && s.phase !== 'bury') return s
      // 防御：只有手牌里的牌能被选中。UI 已经挡住了非手牌的点击，
      // 但这里再挡一层 —— 选中一张不在手上的牌会让「出牌」亮着却永远出不去。
      if (!(s.hands[HUMAN_SEAT] as readonly Card[]).some((c) => c.id === action.id)) return s
      const has = s.selected.includes(action.id)
      return {
        ...s,
        selected: has ? s.selected.filter((x) => x !== action.id) : [...s.selected, action.id],
        hintIds: [], // 用户自己动手了，提示失效
      }
    }

    case 'clearSelect':
      return { ...s, selected: [], hintIds: [] }

    case 'setSelection': {
      // **id 必须真的在手里**（docs/33 C1-02）：原来原样写入，UI 侧一点 bug
      // 就能把不存在的 id 塞进 selected，然后 `playSelected` 会静默变成「先选牌」。
      // 顺带限制阶段：只有出牌/埋底需要选中态。
      const ids = validHandIds(s, action.ids)
      if (ids === null) return s
      return { ...s, selected: ids, hintIds: [] }
    }

    case 'playSelected': {
      if (s.phase !== 'play') return s
      if (seatToPlay(s) !== HUMAN_SEAT) return s
      const hand = s.hands[HUMAN_SEAT] as readonly Card[]
      const idSet = new Set(s.selected)
      const cards = hand.filter((c) => idSet.has(c.id))
      if (cards.length === 0) return reject(s, 'empty', '先选牌')
      return playCards(s, HUMAN_SEAT, cards)
    }

    case 'aiStep':
      return aiPlay(s)

    case 'nextRound': {
      if (s.phase !== 'settle' && s.phase !== 'over') return s
      if (s.phase === 'over') {
        return startRound(
          {
            ...emptyBase(),
            config: s.config,
            pendingConfig: s.pendingConfig,
            aiLevelPartner: s.aiLevelPartner,
            aiLevelOpponent: s.aiLevelOpponent,
            aiSpeedMs: s.aiSpeedMs,
            // 偏好项统一走清单（见 PREF_FIELDS）——
            // 以前这里手写搬运，漏了音乐主题/增强音效/自动变奏/三个音量，
            // 「游戏结束 → 再来一局」会把这些悄悄重置成默认值
            ...pickPrefs(s),
          },
          s.seed + 1,
        )
      }
      const settle = s.lastSettle
      const levels = settle ? settle.newLevels : s.levels
      const dealer = settle ? settle.newDealer : s.dealer
      return startRound(
        {
          ...s,
          round: s.round + 1,
          levels,
          dealer,
          lastSettle: null,
          history: [],
          replayAt: null,
        },
        s.seed + 1,
      )
    }

    case 'updateConfig':
      // FR-18 ③：规则开关改动在下一局生效 —— 只改 pending，不动当前局的 config
      return { ...s, pendingConfig: { ...s.pendingConfig, ...action.patch } }

    case 'setAiLevel':
      // 两侧同置（保留旧的单档语义）
      return { ...s, aiLevelPartner: action.level, aiLevelOpponent: action.level }

    case 'setAiLevelSide':
      return action.side === 'partner'
        ? { ...s, aiLevelPartner: action.level }
        : { ...s, aiLevelOpponent: action.level }

    case 'setAiSpeed': {
      // 夹到 0..5000，与 `loadPrefs` 的读档口径保持一致；
      // 非有限值直接忽略，否则 NaN 会让 setTimeout 立刻触发（= AI 瞬移）
      if (!Number.isFinite(action.ms)) return s
      return { ...s, aiSpeedMs: Math.max(0, Math.min(5000, Math.round(action.ms))) }
    }

    case 'toggleFourColor':
      return { ...s, fourColor: !s.fourColor }

    case 'setCardSize':
      return { ...s, cardSize: action.size }

    case 'setAnimSpeed':
      return { ...s, animSpeed: action.speed }

    case 'askNewGame':
      return { ...s, confirmNew: true }

    case 'cancelNewGame':
      return { ...s, confirmNew: false }

    case 'showHint': {
      // 纯视觉提示，不碰 selected / 不推进局面（FR-19 ③）
      const ids = validHandIds(s, action.ids)
      if (ids === null) return s
      return { ...s, hintIds: ids }
    }

    case 'hintSelect': {
      // 「提示即选中」模式：一次 dispatch 同时写 selected 与 hintIds（避免两次 save）
      const ids = validHandIds(s, action.ids)
      if (ids === null) return s
      return { ...s, selected: ids, hintIds: ids }
    }

    case 'clearHint':
      return { ...s, hintIds: [] }

    case 'toggleAnimation':
      return { ...s, animation: !s.animation }

    case 'toggleShowHistory':
      return { ...s, showHistory: !s.showHistory }
    case 'toggleShowOppHands':
      // 纯展示项：只影响三家牌背画成牌面，规则 / AI 一律照旧
      return { ...s, showOppHands: !s.showOppHands }

    case 'toggleHintSelects':
      return { ...s, hintSelects: !s.hintSelects }
    case 'setHintStyle':
      return { ...s, hintStyle: action.style }

    case 'toggleAutoPlay': {
      // 关掉挂机时顺手清掉提示高亮：那些高亮是机器上一手留下的，容易让人以为还能出
      const on = !s.autoPlay
      return { ...s, autoPlay: on, ...(on ? {} : { hintIds: [], selected: [] }) }
    }

    case 'setAutoLevel':
      return { ...s, autoLevel: action.level }

    case 'autoStep':
      return autoStep(s)

    case 'autoPlayTurn': {
      // 只有「轮到你 + 出牌阶段」才代打；否则原样返回（防御：UI 按键与定时器可能竞态）
      if (s.phase !== 'play' || seatToPlay(s) !== HUMAN_SEAT) return s
      // 挂机 = **你自己在打**，所以信息规则跟对手一致（`peek` 跟随设置）。
      // 这里显式写出来，而不是让 `choosePlay` 的默认值静默继承 —— 三司会审 F2 的教训：
      // 一个开关同时决定「对手能不能看我」和「我的助手有多强」时，行为会变得不可解释。
      return playCards(
        s,
        HUMAN_SEAT,
        choosePlay(s, HUMAN_SEAT, s.autoLevel, { peek: s.aiPeekHands }),
      )
    }

    case 'toggleShowCounter':
      return { ...s, showCounter: !s.showCounter }

    case 'toggleAiPeek':
      return { ...s, aiPeekHands: !s.aiPeekHands }

    case 'setMusicTheme':
      return { ...s, musicTheme: action.theme }

    case 'toggleSoundEnhanced':
      return { ...s, soundEnhanced: !s.soundEnhanced }

    case 'toggleAutoVariation':
      return { ...s, autoVariation: !s.autoVariation }

    case 'setVolume': {
      // `Math.round(NaN)` 还是 NaN，`Math.max/min` 也拦不住 ⇒ volume 会被写成 NaN，
      // 然后一路传到音频层（gain = NaN）与存档（docs/33 C1-03）。非有限值直接忽略。
      if (!Number.isFinite(action.value)) return s
      const v = Math.max(0, Math.min(100, Math.round(action.value)))
      if (action.which === 'master') return { ...s, volumeMaster: v }
      if (action.which === 'bgm') return { ...s, volumeBgm: v }
      return { ...s, volumeSfx: v }
    }

    case 'replayStart': {
      if (s.history.length === 0) return s
      const idx = Math.max(0, Math.min(s.history.length - 1, Math.trunc(action.index)))
      // 进回放要顺手收起记录面板，否则面板盖着牌桌看不到回放
      return { ...s, replayAt: idx, logOpen: false, selected: [], hintIds: [] }
    }

    case 'replayStep': {
      if (s.replayAt === null) return s
      // `Math.trunc(NaN)` 是 NaN，两个边界判断（NaN < 0 / NaN >= len）**都是 false**
      // ⇒ replayAt 会被写成 NaN，回放界面从此错位（docs/33 C1-03）
      if (!Number.isFinite(action.delta)) return s
      const next = s.replayAt + Math.trunc(action.delta)
      if (!Number.isFinite(next) || next < 0 || next >= s.history.length) return s
      return { ...s, replayAt: next }
    }

    case 'replayExit':
      return { ...s, replayAt: null }

    case 'openSettings':
      return { ...s, settingsOpen: true, logOpen: false }

    case 'closeSettings':
      return { ...s, settingsOpen: false }

    case 'toggleLog':
      return { ...s, logOpen: !s.logOpen, settingsOpen: false }

    case 'dismissNotice':
      return { ...s, notice: null }

    default:
      return s
  }
}

/** 供 UI 判断「AI 是否可以继续动」 */
export function aiCanAct(s: GameState): boolean {
  if (s.phase !== 'play') return false
  // 回放期间 AI 必须停手：否则看着历史墩的同时局面还在往前走
  if (s.replayAt !== null) return false
  const seat = seatToPlay(s)
  if (seat === null || seat === HUMAN_SEAT) return false
  // 该座位没有手牌就出不了牌 —— 返回 true 会让 main.ts 的 setTimeout 链条
  // 每 aiSpeedMs 触发一次 aiStep，而 aiStep 每次都返回原状态 ⇒ **无限空转**
  // （docs/33 C6-01：phase 永远停在 play，玩家看到的是「卡住了」）。
  return (s.hands[seat] as readonly Card[]).length > 0
}

export { TRUMP_POWER_BASE, advanceLevel, levelsFor, nextSeat, partnerOf }

/* ============================================================
   残局精确求解（v1.3.29 · docs/28 §5「残局搜索」）
   ------------------------------------------------------------
   为什么要它：启发式打分（policy.ts）永远是「逐手局部最优」，
   看不到「这一墩让出去、下一墩用主牌收 20 分」这种跨墩交换；
   也看不到**抠底**（最后一墩由闲家赢时底分 ×2/×4/×8）——
   而抠底往往是整局最大的一次分数摆动。

   做法：牌少的时候直接做**完全信息极小极大 + α-β 剪枝**。
   为什么敢用完全信息：这个搜索只在「AI 读牌」开着时启用
   （`aiPeekHands`），与 L3 既有的 `exactBeatable` 同一信息假设；
   关掉读牌就不接管，交给概率推断的启发式。

   为什么放在 app 层而不是 ai/：搜索要把「出一手牌」应用成新状态，
   而那套逻辑（含抠底、终局判定）在 `playCards` / `resolveCurrentTrick` 里。
   放 ai/ 会形成 `ai → app → ai` 的双向依赖；放这里零依赖、零重复。

   触发门槛刻意很紧（总剩牌 ≤ `ENDGAME_MAX_CARDS`）：
   节点数随剩牌数指数增长，而残局一局只出现一次，宁可只在真能算完时接管。
   ============================================================ */

/** 接管阈值：四家手牌总数 ≤ 这个值才做完全搜索（8 = 最多 2 墩） */
export const ENDGAME_MAX_CARDS = 12
/** 节点上限：超了就放弃（返回已找到的最好一手，或 null） */
const ENDGAME_NODE_BUDGET = 120_000
/** 时间上限（ms）：兜底，防止慢机器上卡住主线程 */
const ENDGAME_TIME_BUDGET_MS = 40
/** 每个节点的候选上限（α-β 的宽度） */
const ENDGAME_BRANCH = 12

const ENDGAME_ABORT = Symbol('endgame-abort')

/**
 * 某座位在当前局面下的**合法**候选出法（最多 `ENDGAME_BRANCH` 个）。
 *
 * 与 `policy.ts` 的 `legalOnly` 同口径（枚举 + `checkPlay` 过滤），
 * 但不能直接复用 —— 那是 policy 的私有函数，而 policy 反过来要调本文件，
 * 会形成双向依赖。这段只有十几行，重复的代价小于依赖环的代价。
 */
function endgameCandidates(s: GameState, seat: Seat): Card[][] {
  const ctx = ctxOf(s)
  // **手牌必须按规范序排**：`enumeratePlays` 的产出顺序跟着输入走，
  // 而搜索结果里有大量并列最优（同一分值的不同出法）。不规范化的话
  // 「手牌数组顺序不同 ⇒ 选出不同的并列解」—— 直接违反
  // `tests/ai/order-independence.test.ts` 的不变量。
  const hand = [...(s.hands[seat] as readonly Card[])].sort(
    (a, b) => ctx.power.get(a.value) - ctx.power.get(b.value) || a.id - b.id,
  )
  const isLead = s.trick.plays.length === 0
  const leadPlay = isLead ? undefined : (s.trick.plays[0] as Play)
  const pc = isLead
    ? ({ kind: 'lead' } as const)
    : ({ kind: 'follow', leadCards: leadPlay!.cards, leadAnalysis: leadPlay!.analysis } as const)
  const raw = enumeratePlays(hand, ctx, pc, ENDGAME_BRANCH, true)
  const opponents = [0, 1, 2, 3]
    .filter((x) => x !== seat)
    .map((x) => s.hands[x] as readonly Card[])
  const out: Card[][] = []
  for (const cards of raw) {
    if (cards.length === 0) continue
    const r = checkPlay({
      hand,
      cards,
      ctx,
      ...(leadPlay ? { lead: { cards: leadPlay.cards, analysis: leadPlay.analysis } } : {}),
      opponents,
    })
    if (r.ok) out.push(r.cards.slice())
  }
  // 候选也按规范键排序：并列最优时永远取「值序列最小」的那一手
  out.sort((x, y) => {
    const kx = x.map((c) => c.value).sort((a, b) => a - b).join(',')
    const ky = y.map((c) => c.value).sort((a, b) => a - b).join(',')
    return kx < ky ? -1 : kx > ky ? 1 : 0
  })
  return out
}

/**
 * 残局求解：返回「本手应该出哪几张」，null = 不接管（交给启发式）。
 *
 * 目标函数直接用**真实结算口径**：`defenderScore`（已含抠底）。
 * 我在庄家方就最小化它、在闲家就最大化它 —— 这样连「该不该让出这一墩
 * 换取最后一墩的抠底权」这种跨墩交换也能被算出来。
 */
export function solveEndgame(
  s: GameState,
  seat: Seat,
  /** 是否允许用四家真实手牌（默认跟玩家设置走；标定脚本可以强制） */
  allowPeek: boolean = s.aiPeekHands,
): Card[] | null {
  if (s.phase !== 'play') return null
  if (seatToPlay(s) !== seat) return null
  // 搜索要用四家的真实手牌 ⇒ 只在「读牌」开着时启用（否则等于偷偷用隐藏信息）
  if (!allowPeek) return null
  const total = s.hands.reduce((n, h) => n + h.length, 0)
  if (total === 0 || total > ENDGAME_MAX_CARDS) return null

  const myTeam = teamOf(seat)
  const deadline = Date.now() + ENDGAME_TIME_BUDGET_MS
  let nodes = 0

  /** 终局得分：换成「我方视角越大越好」 */
  const terminalValue = (st: GameState): number =>
    teamOf(st.dealer) === myTeam ? -st.defenderScore : st.defenderScore

  const search = (st: GameState, alpha: number, beta: number, depth: number): number => {
    nodes += 1
    if (nodes > ENDGAME_NODE_BUDGET) throw ENDGAME_ABORT
    // 每 256 个节点查一次时间，避免 Date.now() 成为热点
    if ((nodes & 0xff) === 0 && Date.now() > deadline) throw ENDGAME_ABORT

    if (st.phase !== 'play') return terminalValue(st)
    const acting = seatToPlay(st)
    if (acting === null) return terminalValue(st)
    const cands = endgameCandidates(st, acting)
    if (cands.length === 0) return terminalValue(st)

    const maximizing = teamOf(acting) === myTeam
    let best = maximizing ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY
    let a = alpha
    let b = beta
    for (const cards of cands) {
      const next = playCards(st, acting, cards)
      if (next === st) continue // 被规则拒绝
      const v = search(next, a, b, depth + 1)
      if (maximizing) {
        if (v > best) best = v
        if (best > a) a = best
      } else {
        if (v < best) best = v
        if (best < b) b = best
      }
      if (b <= a) break // 剪枝
    }
    if (!Number.isFinite(best)) return terminalValue(st)
    return best
  }

  const rootCands = endgameCandidates(s, seat)
  if (rootCands.length === 0) return null

  let bestCards: Card[] | null = null
  let bestVal = Number.NEGATIVE_INFINITY
  try {
    for (const cards of rootCands) {
      const next = playCards(s, seat, cards)
      if (next === s) continue
      const v = search(next, bestVal, Number.POSITIVE_INFINITY, 1)
      if (v > bestVal) {
        bestVal = v
        bestCards = cards
      }
    }
  } catch (e) {
    // 超出预算：返回**已经算出来的最好一手**（比启发式不会更差，因为它是真算过的）
    if (e !== ENDGAME_ABORT) throw e
    return bestCards
  }
  return bestCards
}
