/**
 * 「稳妥提示」（`ai/safeHint.ts`）—— 一套**像人**的保守打法。
 *
 * 它存在的理由（docs/15 KN-14）：提示直接用 L3 的 `choosePlay` 时，会走
 * 「先跑小副牌、主牌留到最后控场」这类人类不会打的线路，玩家只能判断成「弱智」。
 * 稳妥策略反过来：**规则少、可预测、一眼能懂**。本文件锁的就是这份「可预测」：
 *
 *   ① 永远合法（走 `checkPlay`）
 *   ② 首出不主动送分牌（手里有 0 分牌可选时，绝不首出带 5/10/K 的牌）
 *   ③ 跟牌压不过时不垫分（有 0 分牌可选时）
 *   ④ 跟牌队友赢着时出最小的一手
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_RULE_CONFIG, analyze, buildPowerTable, canFollowShape, cardsScore, checkPlay, trickStanding } from '@core'
import type { Card, RuleContext } from '@core'
import { enumeratePlays } from '@ai/enumerate'
import type { PlayContext } from '@ai/enumerate'
import { isSureToHold, rivalIsSafe } from '@ai/policy'
import { aiPlayFor, choosePlay, chooseSafePlay, newGame, reduce } from '@app/game'
import { safeHint } from '@ai/safeHint'
import { HUMAN_SEAT, ctxOf, seatToPlay } from '@app/state'
import type { GameState } from '@app/state'
import { declareAndPass } from '../helpers/declare'

function playPhase(seed: number): GameState {
  let s = newGame(DEFAULT_RULE_CONFIG, 2, 0, seed)
  s = declareAndPass(s, 0)
  if (s.phase === 'bury') {
    const hand = s.hands[s.dealer] as readonly Card[]
    s = reduce(s, { type: 'bury', ids: hand.slice(0, 8).map((c) => c.id) })
  }
  return s
}

function humanTurnPositions(seed: number, max = 10): GameState[] {
  const out: GameState[] = []
  let s = playPhase(seed)
  for (let i = 0; i < 400 && s.phase === 'play' && out.length < max; i++) {
    const seat = seatToPlay(s)
    if (seat === null) break
    if (seat === HUMAN_SEAT) out.push(s)
    s = aiPlayFor(s, seat, 2)
  }
  return out
}

const SAMPLES: GameState[] = Array.from({ length: 24 }, (_, i) => humanTurnPositions(3001 + i)).flat()

/** 与 main.ts 的 `hintIdsFor` 同一套校验口径 */
function legal(s: GameState, cards: readonly Card[]): boolean {
  const hand = s.hands[HUMAN_SEAT] as readonly Card[]
  const leadPlay = s.trick.plays[0]
  return checkPlay({
    hand,
    cards,
    ctx: ctxOf(s),
    ...(leadPlay ? { lead: { cards: leadPlay.cards, analysis: leadPlay.analysis } } : {}),
    opponents: [1, 2, 3].map((x) => s.hands[x] as readonly Card[]),
  }).ok
}

/** 当前局面的合法候选（与 safeHint 内部同一套枚举 + checkPlay） */
function legalCandidates(s: GameState): Card[][] {
  const hand = s.hands[HUMAN_SEAT] as readonly Card[]
  const ctx = ctxOf(s)
  const leadPlay = s.trick.plays[0]
  const pc: PlayContext = leadPlay
    ? { kind: 'follow', leadCards: leadPlay.cards, leadAnalysis: leadPlay.analysis }
    : { kind: 'lead' }
  const out: Card[][] = []
  for (const cards of enumeratePlays(hand, ctx, pc, 60, true)) {
    if (legal(s, cards)) out.push(cards.slice())
  }
  return out
}

describe('safeHint · 稳妥提示', () => {
  it('建议永远合法', () => {
    let n = 0
    for (const s of SAMPLES) {
      const cards = chooseSafePlay(s, HUMAN_SEAT)
      if (cards.length === 0) continue // 没有合法候选时退回 choosePlay（由调用方兜底）
      expect(legal(s, cards), `不合法：${cards.map((c) => c.value)}（step=${s.step}）`).toBe(true)
      n++
    }
    expect(n).toBeGreaterThan(20)
  })

  it('首出不主动送分牌：手里有 0 分牌可选时，绝不首出带 5/10/K 的牌', () => {
    let checked = 0
    for (const s of SAMPLES) {
      if (s.trick.plays.length > 0) continue
      const cards = chooseSafePlay(s, HUMAN_SEAT)
      if (cards.length === 0) continue
      const hand = s.hands[HUMAN_SEAT] as readonly Card[]
      // 手上有没有「0 分的单张」可出？有就该出 0 分的
      const hasZeroPointSingle = hand.some((c) => cardsScore([c]) === 0)
      if (!hasZeroPointSingle) continue
      checked++
      if (cardsScore(cards) === 0) continue
      // 例外：这手是「稳赢」的牌（对手压不过，分照样归自己）—— 允许
      expect(
        isSureToHold(
          cards,
          ctxOf(s),
          [1, 2, 3].map((x) => s.hands[x] as readonly Card[]),
          [1, 2, 3].filter((x) => !s.trick.plays.some((p) => p.seat === x)) as never,
          HUMAN_SEAT,
        ),
        `首出带了 ${cardsScore(cards)} 分，又不是稳赢（step=${s.step}）`,
      ).toBe(true)
    }
    expect(checked).toBeGreaterThan(5)
  })

  it('跟牌压不过时不垫分（有 0 分牌可选时）', () => {
    let checked = 0
    for (const s of SAMPLES) {
      if (s.trick.plays.length === 0) continue
      const ctx = ctxOf(s)
      const standing = trickStanding(s.trick.plays, ctx)
      if (standing === null) continue
      if (standing.winner.seat === 2) continue // 队友赢着的情况另算
      // 只看「真的压不过」的局面：合法候选里**没有任何一手**能压（含对子/连对，
      // 只检查单张会把「对子能压」误判成压不过）
      const canWin = legalCandidates(s).some((c) => canFollowShape(analyze(c, ctx), standing.winner.analysis))
      if (canWin) continue
      const cards = chooseSafePlay(s, HUMAN_SEAT)
      if (cards.length === 0) continue
      // 预条件：**合法候选里**有 0 分的（手里有 0 分牌但必须跟花色时不算）
      if (!legalCandidates(s).some((c) => cardsScore(c) === 0)) continue
      checked++
      expect(cardsScore(cards), `压不过却垫了 ${cardsScore(cards)} 分（step=${s.step}）`).toBe(0)
    }
    if (checked === 0) console.log('  --  样本里没有「压不过且合法候选含 0 分牌」的跟牌局面，跳过')
  })

  it('队友赢着、但**有人能压过队友** → 收着打（垫最小，不送分）', () => {
    let checked = 0
    for (const s of SAMPLES) {
      if (s.trick.plays.length === 0) continue
      const ctx = ctxOf(s)
      const standing = trickStanding(s.trick.plays, ctx)
      if (standing === null || standing.winner.seat !== 2) continue
      // 预条件：队友这一手**压不住**（rivalIsSafe === false）—— 这才是"别送分"的场合
      const remaining = [1, 3].filter((x) => !s.trick.plays.some((p) => p.seat === x)) as never
      const safe = rivalIsSafe(
        { seat: 2, analysis: standing.winner.analysis },
        ctx,
        [1, 2, 3].map((x) => s.hands[x] as readonly Card[]),
        remaining,
        HUMAN_SEAT,
      )
      if (safe) continue
      const cands = legalCandidates(s)
      if (!cands.some((c) => cardsScore(c) === 0)) continue
      const cards = chooseSafePlay(s, HUMAN_SEAT)
      if (cards.length === 0) continue
      checked++
      expect(cardsScore(cards), `队友压不住却垫了 ${cardsScore(cards)} 分`).toBe(0)
    }
    if (checked === 0) console.log('  --  样本里没有「队友赢着但压不住」的跟牌局面，跳过')
  })

  it('队友赢着、**这手压得住**（哪怕对手还没出）→ 有分就垫', () => {
    // 用户 2026-10-31 报的正是这个：队友 ♦A 拿下这墩、对手还没出，提示却让垫最小的。
    // 判据是「队友这手会不会被抢走」，不是「对手都出完没有」。
    let checked = 0
    for (const s of SAMPLES) {
      if (s.trick.plays.length === 0) continue
      const ctx = ctxOf(s)
      const standing = trickStanding(s.trick.plays, ctx)
      if (standing === null || standing.winner.seat !== 2) continue
      const remaining = [1, 3].filter((x) => !s.trick.plays.some((p) => p.seat === x)) as never
      const safe = rivalIsSafe(
        { seat: 2, analysis: standing.winner.analysis },
        ctx,
        [1, 2, 3].map((x) => s.hands[x] as readonly Card[]),
        remaining,
        HUMAN_SEAT,
      )
      if (!safe) continue
      const cands = legalCandidates(s)
      if (!cands.some((c) => cardsScore(c) > 0)) continue
      const cards = chooseSafePlay(s, HUMAN_SEAT)
      if (cards.length === 0) continue
      checked++
      expect(cardsScore(cards), `队友这手压得住却没垫分（出的是 ${cardsScore(cards)} 分）`).toBeGreaterThan(0)
    }
    if (checked === 0) console.log('  --  样本里没有「队友赢着且压得住」的跟牌局面，跳过')
  })

  it('队友赢着、**对手都出完了** → 有分就垫（这一墩已锁定是我方的）', () => {
    let checked = 0
    for (const s of SAMPLES) {
      if (s.trick.plays.length === 0) continue
      const ctx = ctxOf(s)
      const standing = trickStanding(s.trick.plays, ctx)
      if (standing === null || standing.winner.seat !== 2) continue
      const enemyLeft = [1, 3].some((x) => !s.trick.plays.some((p) => p.seat === x))
      if (enemyLeft) continue
      const cands = legalCandidates(s)
      const pts = cands.filter((c) => cardsScore(c) > 0)
      if (pts.length === 0) continue
      const cards = chooseSafePlay(s, HUMAN_SEAT)
      if (cards.length === 0) continue
      checked++
      expect(cardsScore(cards), `锁定局面却没垫分（出的是 ${cardsScore(cards)} 分）`).toBeGreaterThan(0)
    }
    if (checked === 0) console.log('  --  样本里没有「队友赢着且对手已出完」的跟牌局面，跳过')
  })

  it('与「最强 AI」策略确实不同（否则这个开关没意义）', () => {
    // 两条路径都合法即可；差异率由 .tmp 的推演脚本量化，这里只保证开关有实际效果
    let diff = 0
    for (const s of SAMPLES) {
      const a = chooseSafePlay(s, HUMAN_SEAT).map((c) => c.id).sort().join()
      if (a.length === 0) continue
      const b = choosePlay(s, HUMAN_SEAT, 3)
        .map((c) => c.id)
        .sort()
        .join()
      if (a !== b) diff++
    }
    expect(diff).toBeGreaterThan(5)
  })
})

/* ============================================================
   用户报的局面（2026-10-31）
   ------------------------------------------------------------
   「对家先出一个 A，当前最大，但自动提示还是让我出一个最小的牌，
     这时不是应该出 K 走分吗？」

   队友（座位 2）领出 ♦A、对手还没出，提示却建议 ♦6（0 分）。
   根因：`safeHint` 判「能不能垫分」用的是**「对手都出完了没有」**，
   而 L3 早在 v1.3.38 就改成了「队友这手会不会被抢走」（`rivalIsSafe`）。
   ============================================================ */

describe('safeHint · 队友领出 A（用户 2026-10-31 报的局面）', () => {
  /** ♦A 领出、我手里有 ♦K 与 ♦6；`enemyVoid` 控制对手能不能毙 */
  const position = (enemyVoid: boolean) => {
    const ctx: RuleContext = {
      power: buildPowerTable({ mode: 1, levelRank: 2, trump: 0, forcedNT: false }),
      trump: 0,
      levelRank: 2,
      forcedNT: false,
      config: DEFAULT_RULE_CONFIG,
    }
    const c = (value: number): Card => ({ id: value * 2, value })
    const D = (rank: number): number => 39 + rank // ♦ 的 value 起点
    const lead = [c(D(12))] // ♦A
    const myHand = [c(D(11)), c(D(4)), c(26 + 12), c(13 + 7)] // ♦K ♦6 ♣A ♥9
    // 对手：有 ♦ ⇒ 只能跟，毙不了；缺 ♦ ⇒ 能用主毙（这里给一张更大的主牌）
    const enemy1 = enemyVoid ? [c(0 + 12)] : [c(D(3)), c(D(2))]
    const enemy3 = enemyVoid ? [c(0 + 11)] : [c(D(7)), c(D(1))]
    return {
      hand: myHand,
      ctx,
      play: { kind: 'follow' as const, leadCards: lead, leadAnalysis: analyze(lead, ctx) },
      currentWinner: analyze(lead, ctx),
      partnerLeading: true,
      opponents: [enemy1, enemy3, [] as Card[]],
      seat: HUMAN_SEAT,
      remainingSeats: [0, 1, 3] as never,
      trickPoints: 0,
    }
  }

  it('队友 ♦A 压得住 ⇒ 应该垫 ♦K 走 10 分，而不是垫最小的 ♦6', () => {
    const cards = safeHint(position(false))
    expect(cards.map((x) => x.value)).toEqual([39 + 11]) // ♦K
    expect(cardsScore(cards)).toBe(10)
  })

  it('对手缺门且有更大的主牌（能反毙）⇒ 才收着打，垫最小的 0 分牌', () => {
    const cards = safeHint(position(true))
    expect(cardsScore(cards)).toBe(0)
  })
})

/* ============================================================
   用户报的局面 ②（2026-10-31）
   ------------------------------------------------------------
   「我这个主牌和上家一样，根本赢不了，还提示我这样出，
     这不是白白浪费我的主力去陪跑吗？」

   根因：`canFollowShape` 只判「花色 + 结构一致」，**不比牌力**。
   提示的「有分就抢」分支把它当成"能赢"用，于是任何同型牌都算赢，
   再按"最省"排序 ⇒ 挑一张**更小**的牌去陪跑。
   ============================================================ */

describe('safeHint · 有分时不能拿"同型但更小"的牌去陪跑', () => {
  const ctx: RuleContext = {
    power: buildPowerTable({ mode: 1, levelRank: 2, trump: 0, forcedNT: false }),
    trump: 0,
    levelRank: 2,
    forcedNT: false,
    config: DEFAULT_RULE_CONFIG,
  }
  const c = (value: number): Card => ({ id: value * 2, value })
  const D = (rank: number): number => 39 + rank // ♦

  /** 对手（座位 1）领出 `leadRank` 的 ♦，本墩已有 10 分；我手里有 ♦low 与 ♦high */
  const follow = (leadRank: number, low: number, high: number) => {
    const lead = [c(D(leadRank))]
    const myHand = [c(D(low)), c(D(high)), c(26 + 3), c(13 + 7)]
    return {
      hand: myHand,
      ctx,
      play: { kind: 'follow' as const, leadCards: lead, leadAnalysis: analyze(lead, ctx) },
      currentWinner: analyze(lead, ctx),
      partnerLeading: false,
      opponents: [[], [c(D(1))], [c(D(2))]] as readonly Card[][],
      seat: HUMAN_SEAT,
      remainingSeats: [0, 2, 3] as never,
      trickPoints: 10, // 本墩有分 ⇒ 该抢
    }
  }

  it('对手 ♦7 领出、本墩有分 ⇒ 出 ♦K 拿下，而不是 ♦5 陪跑', () => {
    const cards = safeHint(follow(5, 3, 11)) // 领出 ♦7(power 5)、我 ♦5 与 ♦K
    expect(cards.map((x) => x.value)).toEqual([39 + 11]) // ♦K
  })

  it('对手 ♦A 领出、我最大只有 ♦K ⇒ 压不过就出最小的，别拿 ♦K 去陪跑', () => {
    const cards = safeHint(follow(12, 3, 11)) // 领出 ♦A、我 ♦5 与 ♦K
    expect(cards.map((x) => x.value)).toEqual([39 + 3]) // ♦5
  })

  it('牌力相同不算压过：对手 ♦K 领出、我也有一张 ♦K ⇒ 出最小的', () => {
    const cards = safeHint(follow(11, 3, 11))
    expect(cards.map((x) => x.value)).toEqual([39 + 3]) // ♦5，不是 ♦K
  })
})
