/**
 * 「队友赢着、有分就该垫」—— 双升最基本的一条人类经验。
 *
 * 回归 v1.3.37 修的 bug：`scoreCandidate` 里「垫分奖励」写在 else 分支里，
 * 只要这张分牌比队友的牌大（会「抢过」队友），奖励就被整段跳过 ⇒
 * 「队友明明已经最大、手里有 10 分，却垫了最小的一张」。
 *
 * 正确口径取决于**还有没有对手没出牌**：
 *   · 对手都出完了 ⇒ 这一墩已锁定是我方，抢不抢队友都是我们的分，垫分纯赚；
 *   · 还有对手   ⇒ 抢过去可能被一张 A 反压，这时收着打是对的。
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_RULE_CONFIG, cardsScore, checkPlay, trickStanding, teamOf } from '@core'
import type { Card } from '@core'
import { enumeratePlays } from '@ai/enumerate'
import type { PlayContext } from '@ai/enumerate'
import { aiPlayFor, choosePlay, newGame, reduce } from '@app/game'
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

function humanTurnPositions(seed: number, max = 14): GameState[] {
  const out: GameState[] = []
  let s = playPhase(seed)
  for (let i = 0; i < 400 && s.phase === 'play' && out.length < max; i++) {
    const seat = seatToPlay(s)
    if (seat === null) break
    if (seat === HUMAN_SEAT) out.push(s)
    s = aiPlayFor(s, seat, 3)
  }
  return out
}

const SAMPLES: GameState[] = Array.from({ length: 40 }, (_, i) => humanTurnPositions(9101 + i)).flat()

/** 合法候选（与 policy 内部同一套枚举 + checkPlay） */
function candidates(s: GameState): Card[][] {
  const hand = s.hands[HUMAN_SEAT] as readonly Card[]
  const ctx = ctxOf(s)
  const leadPlay = s.trick.plays[0]
  if (!leadPlay) return []
  const pc: PlayContext = { kind: 'follow', leadCards: leadPlay.cards, leadAnalysis: leadPlay.analysis }
  return enumeratePlays(hand, ctx, pc, 60, true).filter(
    (cards) =>
      checkPlay({
        hand,
        cards,
        ctx,
        lead: { cards: leadPlay.cards, analysis: leadPlay.analysis },
        opponents: [1, 2, 3].map((x) => s.hands[x] as readonly Card[]),
      }).ok,
  )
}

describe('垫分 · 队友赢着', () => {
  it('对手都出完了：有分就垫（这一墩已锁定是我方的）', () => {
    let checked = 0
    for (const s of SAMPLES) {
      if (s.trick.plays.length === 0) continue
      const ctx = ctxOf(s)
      const standing = trickStanding(s.trick.plays, ctx)
      if (standing === null || teamOf(standing.winner.seat) !== teamOf(HUMAN_SEAT)) continue
      // 敌方（座位 1 / 3）都出过牌了 ⇒ 锁定
      const enemyLeft = [1, 3].some((x) => !s.trick.plays.some((p) => p.seat === x))
      if (enemyLeft) continue
      const cands = candidates(s)
      const pts = cands.filter((c) => cardsScore(c) > 0)
      if (pts.length === 0) continue
      const play = choosePlay(s, HUMAN_SEAT, 3)
      checked++
      expect(cardsScore(play), `锁定局面却没垫分（step=${s.step}）`).toBeGreaterThan(0)
    }
    expect(checked, '样本里没有「队友赢着 + 对手已出完」的局面').toBeGreaterThan(5)
  })
})
