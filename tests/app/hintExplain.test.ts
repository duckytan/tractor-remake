/**
 * 提示的「一句话理由」（`app/hintView.ts`）。
 *
 * 为什么要测：这是玩家唯一能看到「提示为什么这么打」的地方。
 * 说错了比不说更糟 —— 玩家会照着错的理由去理解牌局。
 * 所以这里锁的是**口径正确性**：压不压得住必须走 core 的 `beatsPlay`（结构 + 牌力）、
 * 队友是否赢着必须走 `trickStanding`，而不是自己再判一遍（docs/15 KN-7 的教训）。
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_RULE_CONFIG, analyze, beatsPlay, cardsScore, trickStanding } from '@core'
import type { Card } from '@core'
import { aiPlayFor, choosePlay, newGame, reduce } from '@app/game'
import { hintExplain } from '@app/hintView'
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

/** 沿途收下「轮到人类」的所有局面（首出与跟牌都会有） */
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

/** 给局面挂上「AI 会建议的那一手」，返回带 hintIds 的状态 */
function withHint(s: GameState): { state: GameState; cards: readonly Card[] } {
  const cards = choosePlay(s, HUMAN_SEAT, 3)
  return { state: { ...s, hintIds: cards.map((c) => c.id) }, cards }
}

const SAMPLES: GameState[] = Array.from({ length: 24 }, (_, i) => humanTurnPositions(3001 + i)).flat()

describe('hintExplain · 一句话理由', () => {
  it('没有提示时返回 null（不打扰玩家）', () => {
    const s = SAMPLES[0] as GameState
    expect(hintExplain({ ...s, hintIds: [] })).toBeNull()
    expect(hintExplain({ ...s, phase: 'settle', hintIds: [1] })).toBeNull()
  })

  it('样本覆盖首出与跟牌，理由分别以「首出」/ 跟牌口径开头', () => {
    let leads = 0
    let follows = 0
    for (const s of SAMPLES) {
      const { state, cards } = withHint(s)
      const e = hintExplain(state)
      expect(e, '有提示就该有理由').not.toBeNull()
      expect(e!.text.length).toBeGreaterThan(0)
      // 短文案必须放得进操作条（窄屏 ~14 字），detail 可以长
      expect(e!.text.length, `文案过长：${e!.text}`).toBeLessThanOrEqual(22)
      if (s.trick.plays.length === 0) {
        leads++
        expect(e!.text.startsWith('首出')).toBe(true)
        expect(e!.detail).toContain('首出')
      } else {
        follows++
        expect(e!.text.startsWith('首出'), `跟牌却写成首出：${e!.text}`).toBe(false)
        expect(e!.detail.startsWith('跟牌')).toBe(true)
      }
      // 文案里不该出现未替换的占位符
      expect(e!.text).not.toContain('undefined')
      expect(e!.detail).not.toContain('undefined')
      expect(cards.length).toBeGreaterThan(0)
    }
    expect(leads).toBeGreaterThan(5)
    expect(follows).toBeGreaterThan(5)
  })

  it('跟牌三分支与 core 判定一致（队友赢着 / 能压住 / 压不过）', () => {
    let partner = 0
    let win = 0
    let lose = 0
    for (const s of SAMPLES) {
      if (s.trick.plays.length === 0) continue
      const { state, cards } = withHint(s)
      const ctx = ctxOf(state)
      const a = analyze(cards, ctx)
      const standing = trickStanding(state.trick.plays, ctx)
      const partnerWinning = standing !== null && standing.winner.seat === 2 // 座位 2 = 队友
      // v1.3.51：必须用 `beatsPlay` —— `canFollowShape` 只判结构资格、不比牌力，
      // 用它当口径会把「同型但更小」的牌也算成能赢（提示文案会谎报「压住这墩」）。
      const iWin = standing === null ? true : beatsPlay(a, standing.winner.analysis, ctx)
      const e = hintExplain(state)!
      if (partnerWinning) {
        partner++
        expect(e.text, `队友赢着却写成：${e.text}`).toContain('队友赢着')
      } else if (iWin) {
        win++
        expect(e.text).toMatch(/压住这墩|主牌毙/)
      } else {
        lose++
        expect(e.text, `压不过却写成：${e.text}`).toContain('压不过')
      }
    }
    expect(partner + win + lose).toBeGreaterThan(5)
  })

  it('首出文案带上「带多少分」与「这门还有几张」', () => {
    const lead = SAMPLES.find((s) => s.trick.plays.length === 0)
    expect(lead).toBeDefined()
    const { state, cards } = withHint(lead!)
    const e = hintExplain(state)!
    const points = cardsScore(cards)
    if (points > 0) expect(e.text).toContain(`${points} 分`)
    expect(e.detail).toMatch(/这门你还有 \d+ 张|混花色/)
  })
})
