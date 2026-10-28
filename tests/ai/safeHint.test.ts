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
import { DEFAULT_RULE_CONFIG, analyze, canBeat, cardsScore, checkPlay, trickStanding } from '@core'
import type { Card } from '@core'
import { enumeratePlays } from '@ai/enumerate'
import type { PlayContext } from '@ai/enumerate'
import { isSureToHold } from '@ai/policy'
import { aiPlayFor, choosePlay, chooseSafePlay, newGame, reduce } from '@app/game'
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
      const canWin = legalCandidates(s).some((c) => canBeat(analyze(c, ctx), standing.winner.analysis))
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

  it('队友赢着、**还有对手没出** → 收着打（垫最小，不送分）', () => {
    let checked = 0
    for (const s of SAMPLES) {
      if (s.trick.plays.length === 0) continue
      const ctx = ctxOf(s)
      const standing = trickStanding(s.trick.plays, ctx)
      if (standing === null || standing.winner.seat !== 2) continue
      // 预条件：还有敌方座位没出牌（否则那是「锁定」局面，见下一条）
      const enemyLeft = [0, 1, 2, 3]
        .filter((x) => x !== HUMAN_SEAT && (x % 2) !== (HUMAN_SEAT % 2))
        .some((x) => !s.trick.plays.some((p) => p.seat === x))
      if (!enemyLeft) continue
      const cands = legalCandidates(s)
      if (!cands.some((c) => cardsScore(c) === 0)) continue
      const cards = chooseSafePlay(s, HUMAN_SEAT)
      if (cards.length === 0) continue
      checked++
      expect(cardsScore(cards), `对手还没出却垫了 ${cardsScore(cards)} 分`).toBe(0)
    }
    if (checked === 0) console.log('  --  样本里没有「队友赢着但对手未出完」的跟牌局面，跳过')
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
