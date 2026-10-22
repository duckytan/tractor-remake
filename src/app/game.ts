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
import type { PlayContext } from '@ai/enumerate'
import {
  HAND_SIZE,
  RANKS_PER_SUIT,
  TRUMP_POWER_BASE,
  advanceLevel,
  analyze,
  buildPowerTable,
  calcBottomBonus,
  canCounter,
  cardsScore,
  checkPlay,
  dealWithGuard,
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
} from '@core'
import type { Card, LevelRank, Play, PlayRejectReason, Rng, RuleContext, Seat, Suit, Trump } from '@core'
import type { Action, GameState, TrickRecord } from './state'
import { HUMAN_SEAT, STATE_VERSION, ctxOf, seatToPlay } from './state'

/* ---------- 工具 ---------- */

const rngFor = (seed: number, step: number): Rng => mulberry32((seed * 2654435761 + step * 40503) >>> 0)

const withStep = (s: GameState): GameState => ({ ...s, step: s.step + 1 })

const reject = (s: GameState, reason: PlayRejectReason, detail: string): GameState => ({
  ...withStep(s),
  lastReject: { reason, detail },
})

const buildPower = (mode: 0 | 1, levelRank: LevelRank, trump: Trump) =>
  buildPowerTable({ mode, levelRank, trump })

/** 该局打的级别 = 庄家队的级牌 */
const levelOfDealer = (levels: { a: LevelRank; b: LevelRank }, dealer: Seat): LevelRank =>
  teamOf(dealer) === 0 ? levels.a : levels.b

/**
 * 副牌花色的展示顺序（重制版编码 0=♠ 1=♥ 2=♣ 3=♦）。
 * 取自 smallnest/Tractor `CurrentPoker.Sort()` 的非主花色顺序 ♥ ♠ ♦ ♣。
 */
const OFF_SUIT_ORDER: readonly Suit[] = [1, 0, 3, 2]

/** 纯按牌力降序。AI 埋底「留大牌」用 —— 与展示序解耦，见 sortHand 注释。 */
function sortByPowerDesc(hand: readonly Card[], ctx: RuleContext): Card[] {
  return [...hand].sort((a, b) => ctx.power.get(b.value) - ctx.power.get(a.value))
}

/**
 * 手牌展示排序 —— 对齐 smallnest/Tractor `CurrentPoker.Sort()`
 * （用户确认的规则基准，「甚至比原版还好」）。
 *
 * 顺序：大王 → 小王 → 主级牌 → 副级牌 → [主2 → 副2] → 主花色(点数降序)
 *       → 其余三门按 ♥ ♠ ♦ ♣(点数降序)；无将时四门全按 ♥ ♠ ♦ ♣。
 *
 * **为什么不能只按牌力降序排**：牌力表给四门副牌的同一点数编了相同牌力
 * （副牌 A 与副牌 K 之差在所有门相同），按牌力降序会把四张 A 排到一起、
 * 同花色被拆散 —— 这正是「不是拖拉机排序方式」的根因。
 * 所以主牌段按牌力（王/级牌/常主2 的先后只有牌力能表达），
 * 副牌段改按「花色优先、花色内点数降序」。
 */
export function sortHand(hand: readonly Card[], ctx: RuleContext): Card[] {
  const trumpSuit: Suit | null = ctx.forcedNT || ctx.trump === 'NT' ? null : ctx.trump
  const suitOrder: readonly Suit[] =
    trumpSuit === null ? OFF_SUIT_ORDER : [trumpSuit, ...OFF_SUIT_ORDER.filter((s) => s !== trumpSuit)]
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
    { levels: [s.levels.a, s.levels.b], mode: config.twoAsPermanent ? 1 : 0 },
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
    usedTrumps: [],
    counterPending: false,
    counterOptions: [],
    declareOptions: [],
    // 逐张发牌：动画开启时从 0 张开始渐进揭示，关闭时直接给满
    revealed: s.animation ? 0 : HAND_SIZE,
    declarePrompted: false,
    dealPrompt: false,
    hands: deal.hands.map((h) => h.slice()),
    bottom: deal.bottom.slice(),
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
  // 发牌后立刻按展示序排好：定主阶段人类就能看清手牌，
  // 而不是看到一堆乱序牌。（亮主后主变了还会在 resolveContract 里重排）
  // declareOptions 依赖手牌，必须在 hands 定稿后算（基于 base 即可，排序不影响「是否持牌」）
  return {
    ...base,
    hands: base.hands.map((h) => sortHand(h, ctxOf(base))),
    declareOptions: humanDeclareOptions(base),
  }
}

/* ---------- 逐张发牌 ---------- */

/** 人类「已揭示」的手牌。规则判定一律用完整手牌，这个只用于发牌过程的提示 */
function revealedHand(s: GameState): readonly Card[] {
  const hand = s.hands[HUMAN_SEAT] as readonly Card[]
  return s.revealed >= hand.length ? hand : hand.slice(0, s.revealed)
}

/**
 * 中途提示的最小牌数。
 * 摸到级牌就立刻暂停的话，玩家手上可能只有两三张牌、根本没法判断该不该亮这门，
 * 所以等发到 10 张（约 40%）再问 —— 此时看花色分布已经有意义了。
 */
const DEAL_PROMPT_MIN = 10

/** 已揭示的牌里能亮的花色（发牌中途暂停用；不含无将） */
function declareOptionsIn(s: GameState): Trump[] {
  if (s.forcedNT) return []
  const lv = levelRankToRankIndex(ctxOf(s).levelRank)
  if (lv === null) return []
  const hand = revealedHand(s)
  const out: Trump[] = []
  for (const suit of [0, 1, 2, 3] as Suit[]) {
    if (hand.some((c) => c.value === suit * RANKS_PER_SUIT + lv)) out.push(suit)
  }
  return out
}

/**
 * 发一张牌（每家各一张）。
 *
 * 人类**第一次摸到级牌**时暂停，让 ta 决定「亮主」还是「继续发牌」——
 * 这就是「发牌中抢庄」：越早摸到级牌越早能抢。
 */
export function revealTick(s: GameState): GameState {
  if (s.phase !== 'contract' || s.dealPrompt) return s
  const total = (s.hands[HUMAN_SEAT] as readonly Card[]).length
  if (s.revealed >= total) return s

  const next: GameState = { ...s, revealed: s.revealed + 1 }
  if (next.revealed >= total) {
    // 发完 ⇒ 直接进定主面板（人类可能一直没摸到级牌，只能亮无将）
    return { ...next, declareOptions: humanDeclareOptions(next), notice: null }
  }
  // 已经发够牌、且第一次摸到级牌 ⇒ 停下来让玩家决定。
  // 注意不要把提示塞进 notice：toast 会压住面板底部的「继续发牌」按钮，
  // 面板文案本身已经说明了情况。
  if (!s.declarePrompted && next.revealed >= DEAL_PROMPT_MIN) {
    const opts = declareOptionsIn(next)
    if (opts.length > 0) {
      return { ...next, declarePrompted: true, dealPrompt: true, declareOptions: opts }
    }
  }
  return next
}

/** 人类选择「继续发牌」（放弃这次亮主机会，发完还能在面板里选） */
export function passDeal(s: GameState): GameState {
  if (s.phase !== 'contract' || !s.dealPrompt) return s
  return { ...withStep(s), dealPrompt: false, declareOptions: [], notice: null }
}

export function newGame(config: GameState['config'], aiLevel: GameState['aiLevel'], aiSpeedMs: number, seed?: number): GameState {
  const s: GameState = {
    ...emptyBase(),
    config,
    pendingConfig: config,
    aiLevel,
    aiSpeedMs,
  }
  return startRound(s, seed ?? (Date.now() % 1e9))
}

function emptyBase(): GameState {
  return {
    version: STATE_VERSION,
    phase: 'contract',
    config: {
      allowSelfCounter: true,
      twoAsPermanent: false,
      allowPartnerGuard: false,
      allowCounterNT: false,
      guardScoreLevels: true,
      guardJack: false,
      guardAce: true,
      guardKingLevel: true,
    },
    seed: 1,
    step: 0,
    round: 1,
    levels: { a: 2, b: 2 },
    dealer: 0,
    trump: 'NT',
    forcedNT: false,
    trumpDeclarer: null,
    usedTrumps: [],
    counterPending: false,
    counterOptions: [],
    declareOptions: [],
    revealed: 25,
    declarePrompted: true,
    dealPrompt: false,
    levelRank: 2,
    hands: [[], [], [], []],
    bottom: [],
    bottomScore: 0,
    trick: { leader: 0, plays: [], winner: null },
    tricksDone: 0,
    defenderScore: 0,
    history: [],
    selected: [],
    lastReject: null,
    notice: null,
    lastSettle: null,
    aiLevel: 1,
    aiSpeedMs: 420,
    fourColor: false,
    cardSize: 'M',
    animation: true,
    settingsOpen: false,
    logOpen: false,
    hintIds: [],
    pendingConfig: {
      allowSelfCounter: true,
      twoAsPermanent: false,
      allowPartnerGuard: false,
      allowCounterNT: false,
      guardScoreLevels: true,
      guardJack: false,
      guardAce: true,
      guardKingLevel: true,
    },
  }
}

/* ---------- 亮主 / 反主 ---------- */

/**
 * 人类当前能反成的主（供 UI 置灰按钮用） */
function humanCounterOptions(s: GameState): Trump[] {
  // 只能反「别人的主」：自己刚亮的主没有再反一次的道理
  if (s.trumpDeclarer === HUMAN_SEAT) return []
  const hand = s.hands[HUMAN_SEAT] as readonly Card[]
  const ctx = ctxOf(s)
  const sameTeam = s.trumpDeclarer !== null && teamOf(HUMAN_SEAT) === teamOf(s.trumpDeclarer)
  const all: Trump[] = [0, 1, 2, 3, 'NT']
  return all.filter((t) =>
    canCounter({
      hand,
      ctx,
      currentTrump: s.trump,
      newTrump: t,
      sameTeamAsDeclarer: sameTeam,
      usedTrumps: s.usedTrumps,
    }),
  )
}

/**
 * 人类首次亮主可选的花色：持该门级牌即可；无将不校验，保证永不卡死。
 *
 * 规则依据：smallnest/Tractor `Algorithm.cs:157-178` —— 亮主必须持有该门级牌。
 * 打王级（强制无将）时主牌固定，只有无将可选。
 */
function humanDeclareOptions(s: GameState): Trump[] {
  if (s.forcedNT) return ['NT'] // 打王级强制无将
  const hand = s.hands[HUMAN_SEAT] as readonly Card[]
  const lv = levelRankToRankIndex(ctxOf(s).levelRank)
  const out: Trump[] = []
  if (lv !== null) {
    for (const suit of [0, 1, 2, 3] as Suit[]) {
      if (hand.some((c) => c.value === suit * RANKS_PER_SUIT + lv)) out.push(suit)
    }
  }
  out.push('NT') // 无将不需要级牌
  return out
}

/**
 * AI 是否愿意反主。
 * 除了「持新花色级牌」这条硬条件，再加一个「该花色至少 5 张」的门槛 ——
 * 否则只要摸到一张别门级牌就无脑反，人类每局都被反，体验很差。
 */
function aiWantsCounter(hand: readonly Card[], newTrump: Trump): boolean {
  if (newTrump === 'NT') return true
  const n = hand.filter((c) => Math.floor(c.value / 13) === newTrump && c.value < 52).length
  return n >= 5
}

/** 让 AI 依次反主，然后判断人类是否还能反；不能则进入埋底/出牌 */
function resolveContract(s: GameState): GameState {
  let cur = s
  // 每反一次主就重扫一遍（主变了，其他 AI 的机会也变了）。
  // 反主必须换一门没用过的花色，最多 5 种主，所以 guard 取 8 足够。
  for (let guard = 0; guard < 8; guard++) {
    const ctx = ctxOf(cur)
    let countered = false
    for (let seat = 0 as Seat; seat < 4; seat++) {
      if (seat === HUMAN_SEAT) continue
      const hand = cur.hands[seat] as readonly Card[]
      const sameTeam = cur.trumpDeclarer !== null && teamOf(seat) === teamOf(cur.trumpDeclarer)
      const pick = ([0, 1, 2, 3, 'NT'] as Trump[]).find(
        (t) =>
          canCounter({
            hand,
            ctx,
            currentTrump: cur.trump,
            newTrump: t,
            sameTeamAsDeclarer: sameTeam,
            usedTrumps: cur.usedTrumps,
          }) && aiWantsCounter(hand, t),
      )
      if (pick !== undefined) {
        cur = {
          ...withStep(cur),
          trump: pick,
          usedTrumps: [...cur.usedTrumps, pick],
          trumpDeclarer: seat,
        }
        countered = true
        break
      }
    }
    if (!countered) break
  }

  // 主可能被反过 ⇒ 手牌展示序要按新主重排（排序依赖主花色）
  const finalCtx = ctxOf(cur)
  cur = { ...cur, hands: cur.hands.map((h) => sortHand(h, finalCtx)) }

  const options = humanCounterOptions(cur)
  if (options.length > 0) {
    // 反主阶段没有「首次亮主」这回事 ⇒ 亮主清单失效（UI 改看 counterOptions）
    return {
      ...cur,
      counterPending: true,
      counterOptions: options,
      declareOptions: [],
      notice: '你可以反主，或点「过」',
    }
  }
  return proceedAfterContract(cur)
}

/** 定约结束：庄家收底 → 埋底（人类手动 / AI 自动） */
function proceedAfterContract(s: GameState): GameState {
  // 定约已生效 ⇒ 两份「可选项」清单都失效，避免残留到存档里被 UI 误用
  const withTrump: GameState = { ...s, counterPending: false, counterOptions: [], declareOptions: [] }

  // 庄家收底牌 → 33 张
  const hands = withTrump.hands.map((h) => h.slice())
  const dealerHand = hands[s.dealer] as Card[]
  hands[s.dealer] = [...dealerHand, ...withTrump.bottom]

  if (s.dealer === HUMAN_SEAT) {
    return { ...withTrump, hands, phase: 'bury', notice: '你是庄家，选 8 张牌扣底' }
  }
  // AI 庄家自动扣底：留大牌、扣小牌与非分牌
  // 注意用牌力序而非展示序：埋底要留「最强 25 张」，
  // 展示序会把整门 ♥ 排在 ♠ 前面，与强弱无关。
  const ctx = ctxOf({ ...withTrump, levelRank: s.levelRank })
  const sorted = sortByPowerDesc(hands[s.dealer] as Card[], ctx)
  const keep = new Set(sorted.slice(0, HAND_SIZE).map((c) => c.id))
  const buried = (hands[s.dealer] as Card[]).filter((c) => !keep.has(c.id))
  return finishBury(withTrump, hands, buried)
}

export function declareTrump(s: GameState, trump: Trump): GameState {
  if (s.phase !== 'contract') return s
  const finalTrump: Trump = s.forcedNT ? 'NT' : trump

  // 首次亮主（还没人亮过）：必须持有该门级牌；无将不校验
  if (s.usedTrumps.length === 0) {
    if (!humanDeclareOptions(s).includes(finalTrump)) {
      return reject(s, 'cannot-counter', '你没有这门花色的级牌，不能亮主')
    }
  }

  // 已有人亮过主 ⇒ 这是「反主」，必须持有新花色的级牌
  if (s.usedTrumps.length > 0) {
    const sameTeam = s.trumpDeclarer !== null && teamOf(HUMAN_SEAT) === teamOf(s.trumpDeclarer)
    const ok = canCounter({
      hand: s.hands[HUMAN_SEAT] as readonly Card[],
      ctx: ctxOf(s),
      currentTrump: s.trump,
      newTrump: finalTrump,
      sameTeamAsDeclarer: sameTeam,
      usedTrumps: s.usedTrumps,
    })
    if (!ok) return reject(s, 'cannot-counter', '你没有这门花色的级牌，不能反主')
  }

  const isFirstDeclare = s.usedTrumps.length === 0
  // 第 1 局抢庄：首个亮主者坐庄。
  // 三个前提：① 首次亮主 ② 第 1 局 ③ 双方同级（换庄不会改变 levelRank）
  // 打王级不抢（主是强制的，换庄没意义）
  const grabDealer =
    isFirstDeclare && s.round === 1 && s.levels.a === s.levels.b && !s.forcedNT
  const newDealer = grabDealer ? HUMAN_SEAT : s.dealer
  // 只有换庄时才重算级牌（第 1 局双方同级，重算结果不变；其余情况沿用原值，
  // 否则会把「打王级」这类由 levelRank 决定的状态冲掉）
  const newLevel = grabDealer ? levelOfDealer(s.levels, newDealer) : s.levelRank

  const declared: GameState = {
    ...withStep(s),
    trump: finalTrump,
    trumpDeclarer: HUMAN_SEAT,
    usedTrumps: isFirstDeclare ? [finalTrump] : [...s.usedTrumps, finalTrump],
    dealer: newDealer,
    levelRank: newLevel,
    forcedNT: newLevel === 18,
    // 亮主后不再逐张发，直接补满（剩下的牌一次性到手上）
    revealed: HAND_SIZE,
    declarePrompted: true,
    dealPrompt: false,
    ...(grabDealer ? { notice: '你抢到庄，亮主成功' } : {}),
    lastReject: null,
  }
  return resolveContract(declared)
}

/** 人类放弃反主，定约立即生效 */
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

function playCards(s: GameState, seat: Seat, cards: readonly Card[]): GameState {
  const ctx = ctxOf(s)
  const isLead = s.trick.plays.length === 0
  const leadPlay = isLead ? undefined : (s.trick.plays[0] as Play)

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
 * AI 需要知道「现在谁最大」才能判断自己能不能压过 ——
 * 提取成共享函数，测试与正式路径用同一份逻辑，避免两边行为不一致。
 */
export function currentWinnerOf(s: GameState): { seat: Seat; analysis: ReturnType<typeof analyze> } | null {
  if (s.trick.plays.length === 0) return null
  const ctx = ctxOf(s)
  let best = s.trick.plays[0] as Play
  for (const p of s.trick.plays) {
    const a = p.analysis.keyCard
    const b = best.analysis.keyCard
    if (a && b && ctx.power.get(a.value) > ctx.power.get(b.value)) best = p
  }
  return { seat: best.seat, analysis: best.analysis }
}

/**
 * 让指定座位用 AI 出一手牌。
 *
 * 抽成独立函数有两个原因：
 *   1. 座位无关 —— 测试可以给四个座位都套 AI，不必把「人类座位」特殊对待；
 *   2. 随机源统一 —— 同一步用同一个 rng 派生式，公平对比不同档位。
 */
export function aiPlayFor(s: GameState, seat: Seat, level: AiLevel): GameState {
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
      hand: s.hands[seat] as readonly Card[],
      ctx,
      play: pc,
      currentWinner,
      partnerLeading: currentWinner !== null && teamOf(currentWinner.seat) === teamOf(seat),
      // 对家手牌：L2 用它做前瞻（这手能不能守住）
      opponents: [0, 1, 2, 3]
        .filter((x) => x !== seat)
        .map((x) => s.hands[x] as readonly Card[]),
    },
    level,
    rngFor(s.seed, s.step + 1000),
  )

  return playCards(s, seat, decision.cards)
}

/* ---------- AI ---------- */

function aiPlay(s: GameState): GameState {
  const seat = seatToPlay(s)
  if (seat === null || seat === HUMAN_SEAT) return s
  return aiPlayFor(s, seat, s.aiLevel)
}

/* ---------- reducer ---------- */

export function reduce(s: GameState, action: Action): GameState {
  switch (action.type) {
    case 'newGame':
      // 新游戏也应用待生效的规则设置
      return newGame(s.pendingConfig, s.aiLevel, s.aiSpeedMs, action.seed)

    case 'declareTrump':
      return { ...declareTrump(s, action.trump), hintIds: [] }

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
      const has = s.selected.includes(action.id)
      return {
        ...s,
        selected: has ? s.selected.filter((x) => x !== action.id) : [...s.selected, action.id],
        hintIds: [], // 用户自己动手了，提示失效
      }
    }

    case 'clearSelect':
      return { ...s, selected: [], hintIds: [] }

    case 'setSelection':
      return { ...s, selected: [...action.ids], hintIds: [] }

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
            aiLevel: s.aiLevel,
            aiSpeedMs: s.aiSpeedMs,
            fourColor: s.fourColor,
            cardSize: s.cardSize,
            animation: s.animation,
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
        },
        s.seed + 1,
      )
    }

    case 'updateConfig':
      // FR-18 ③：规则开关改动在下一局生效 —— 只改 pending，不动当前局的 config
      return { ...s, pendingConfig: { ...s.pendingConfig, ...action.patch } }

    case 'setAiLevel':
      return { ...s, aiLevel: action.level }

    case 'setAiSpeed':
      return { ...s, aiSpeedMs: action.ms }

    case 'toggleFourColor':
      return { ...s, fourColor: !s.fourColor }

    case 'setCardSize':
      return { ...s, cardSize: action.size }

    case 'showHint':
      // 纯视觉提示，不碰 selected / 不推进局面（FR-19 ③）
      return { ...s, hintIds: [...action.ids] }

    case 'clearHint':
      return { ...s, hintIds: [] }

    case 'toggleAnimation':
      return { ...s, animation: !s.animation }

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
  const seat = seatToPlay(s)
  return seat !== null && seat !== HUMAN_SEAT
}

export { TRUMP_POWER_BASE, advanceLevel, levelsFor, nextSeat, partnerOf }
