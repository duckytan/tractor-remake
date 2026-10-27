/**
 * 「提示」用的建议牌 —— 必须与 AI 共用同一个大脑。
 *
 * 背景（用户反馈）：「提示还是太弱智了，只会选最小的牌出」。
 * 根因：`main.ts` 的 `hint()` 取的是 `enumeratePlays(...)` 的**第一个合法候选**，
 * 而候选按小到大枚举 ⇒ 提示恒等于「最小的一手」。
 * 修法：提示改调 `choosePlay()`（L3 超强 + 残局搜索），与 `aiPlayFor` 同源。
 *
 * 本文件锁三件事：
 *   ① 提示建议**永远合法**（任何局面、首出/跟牌都要过 checkPlay）；
 *   ② 提示与 AI 的建议**不可能分叉**（choosePlay 的牌 == aiPlayFor 落下的牌）；
 *   ③ **不再退化成「枚举第一个候选」**（旧实现的指纹）。
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_RULE_CONFIG, checkPlay } from '@core'
import type { Card } from '@core'
import { enumeratePlays } from '@ai/enumerate'
import type { PlayContext } from '@ai/enumerate'
import { aiPlayFor, choosePlay, newGame, reduce } from '@app/game'
import { HUMAN_SEAT, ctxOf, seatToPlay } from '@app/state'
import type { GameState } from '@app/state'
import { declareAndPass } from '../helpers/declare'

/** 进入出牌阶段（含埋底） */
function playPhase(seed: number): GameState {
  let s = newGame(DEFAULT_RULE_CONFIG, 2, 0, seed)
  s = declareAndPass(s, 0)
  if (s.phase === 'bury') {
    const hand = s.hands[s.dealer] as readonly Card[]
    s = reduce(s, { type: 'bury', ids: hand.slice(0, 8).map((c) => c.id) })
  }
  return s
}

/**
 * 采样本局里「轮到人类」的所有局面。
 *
 * 注意 `declareAndPass(s, 0)` 会触发抢庄（第 1 局首次亮主者坐庄）⇒ 人类几乎总是庄家、
 * 总是先首出。只取第一次轮到人类，样本会 100% 是首出、一条跟牌都没有 ——
 * 所以这里让四家都用 AI 打到底，沿途把人类回合的局面全收下来。
 */
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

const ids = (cards: readonly Card[]): number[] => cards.map((c) => c.id).sort((a, b) => a - b)

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

/** 旧实现的产物：枚举候选里的第一个（= 「最小的一手」） */
function oldFirstCandidate(s: GameState): readonly Card[] | null {
  const hand = s.hands[HUMAN_SEAT] as readonly Card[]
  const leadPlay = s.trick.plays[0]
  const pc: PlayContext = leadPlay
    ? { kind: 'follow', leadCards: leadPlay.cards, leadAnalysis: leadPlay.analysis }
    : { kind: 'lead' }
  for (const cards of enumeratePlays(hand, ctxOf(s), pc, 40)) {
    if (legal(s, cards)) return cards
  }
  return null
}

const SEEDS = Array.from({ length: 24 }, (_, i) => 3001 + i)

/** 所有样本局面（24 局 × 每局最多 10 个人类回合） */
const SAMPLES: GameState[] = SEEDS.flatMap((seed) => humanTurnPositions(seed))

describe('choosePlay · 提示与 AI 同源', () => {
  it('样本足够，且首出 / 跟牌两种局面都覆盖到', () => {
    const leads = SAMPLES.filter((s) => s.trick.plays.length === 0).length
    const follows = SAMPLES.length - leads
    expect(SAMPLES.length).toBeGreaterThan(60)
    expect(leads, '首出样本').toBeGreaterThan(10)
    expect(follows, '跟牌样本').toBeGreaterThan(10)
  })

  it('建议永远合法', () => {
    for (const s of SAMPLES) {
      const cards = choosePlay(s, HUMAN_SEAT, 3)
      expect(cards.length, `建议为空（step=${s.step}）`).toBeGreaterThan(0)
      expect(legal(s, cards), `建议不合法：${ids(cards)}（step=${s.step}）`).toBe(true)
    }
  })

  it('choosePlay 是纯函数：不修改状态、两次结果一致', () => {
    const s = SAMPLES[0] as GameState
    const before = JSON.stringify(s)
    const a = ids(choosePlay(s, HUMAN_SEAT, 3))
    const b = ids(choosePlay(s, HUMAN_SEAT, 3))
    expect(a).toEqual(b)
    expect(JSON.stringify(s)).toBe(before)
  })

  it('aiPlayFor 落下的牌 == choosePlay 的建议（两者不可能分叉）', () => {
    let compared = 0
    for (const s of SAMPLES) {
      const advice = ids(choosePlay(s, HUMAN_SEAT, 3))
      const after = aiPlayFor(s, HUMAN_SEAT, 3)
      const played = after.trick.plays.find((p) => p.seat === HUMAN_SEAT)
      // 这一手刚好打完一墩时 trick 会被清空，跳过这种局面
      if (!played) continue
      expect(ids(played.cards), `step=${s.step}`).toEqual(advice)
      compared++
    }
    expect(compared).toBeGreaterThan(20)
  })

  it('不再退化成「枚举第一个候选」＝不再只会出最小的一手', () => {
    let same = 0
    let total = 0
    for (const s of SAMPLES) {
      const old = oldFirstCandidate(s)
      if (old === null) continue
      total++
      if (ids(choosePlay(s, HUMAN_SEAT, 3)).join() === ids(old).join()) same++
    }
    expect(total).toBeGreaterThan(20)
    // 旧实现在 100% 的局面下等于「第一个候选」；修好后只应在少数局面巧合一致
    const ratio = same / total
    expect(ratio, `与旧实现重合 ${same}/${total} = ${(ratio * 100).toFixed(0)}%`).toBeLessThan(0.5)
  })
})
