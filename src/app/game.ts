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
  TRUMP_POWER_BASE,
  advanceLevel,
  analyze,
  buildPowerTable,
  calcBottomBonus,
  cardsScore,
  checkPlay,
  dealWithGuard,
  levelsFor,
  mulberry32,
  nextSeat,
  partnerOf,
  resolveTrick,
  settleRound,
  teamOf,
} from '@core'
import type { Card, LevelRank, Play, PlayRejectReason, Rng, RuleContext, Seat, Trump } from '@core'
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

/** 手牌按牌力降序排好，便于展示 */
function sortHand(hand: readonly Card[], ctx: RuleContext): Card[] {
  return [...hand].sort((a, b) => ctx.power.get(b.value) - ctx.power.get(a.value))
}

/* ---------- 开局 ---------- */

export function startRound(s: GameState, seed: number): GameState {
  const rng = rngFor(seed, 0)
  const dealer = rng.int(4) as Seat

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
  return base
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
      guardScoreLevels: false,
      guardJA: true,
      guardKingLevel: true,
    },
    seed: 1,
    step: 0,
    round: 1,
    levels: { a: 2, b: 2 },
    dealer: 0,
    trump: 'NT',
    forcedNT: false,
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
      guardScoreLevels: false,
      guardJA: true,
      guardKingLevel: true,
    },
  }
}

/* ---------- 亮主 ---------- */

export function declareTrump(s: GameState, trump: Trump): GameState {
  if (s.phase !== 'contract') return s
  const finalTrump: Trump = s.forcedNT ? 'NT' : trump
  const withTrump: GameState = { ...withStep(s), trump: finalTrump }

  // 庄家收底牌 → 33 张
  const hands = withTrump.hands.map((h) => h.slice())
  const dealerHand = hands[s.dealer] as Card[]
  hands[s.dealer] = [...dealerHand, ...withTrump.bottom]

  if (s.dealer === HUMAN_SEAT) {
    return { ...withTrump, hands, phase: 'bury', notice: '你是庄家，选 8 张牌扣底' }
  }
  // AI 庄家自动扣底：留大牌、扣小牌与非分牌
  const ctx = ctxOf({ ...withTrump, levelRank: s.levelRank })
  const sorted = sortHand(hands[s.dealer] as Card[], ctx)
  const keep = new Set(sorted.slice(0, HAND_SIZE).map((c) => c.id))
  const buried = (hands[s.dealer] as Card[]).filter((c) => !keep.has(c.id))
  return finishBury(withTrump, hands, buried)
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
