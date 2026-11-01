/**
 * 整局**不变量**（v1.3.55）
 *
 * 为什么单独一个文件：`core/` 的单测都是「给定局面 → 给定结果」，
 * 没有任何用例检查**跨手、跨墩的守恒关系**。v1.3.48 那个「打王回卷」bug
 * 就是这样漏掉的 —— 600 例全绿，但 200 副连打里回卷了 134 次。
 * 这里补的是「每出一手都校验」的口径：
 *
 *   ① 108 张守恒（手牌 + 底牌 + 历史墩 + 当前墩，且 id 不重复）
 *   ② 每墩赢家必须能由 `trickStanding` 复算出来，得分必须等于牌面分
 *   ③ 每墩出牌顺序 = 从 leader 起顺时针；下一墩 leader = 上墩赢家
 *   ④ `defenderScore` 逐墩累加一致；结算时 = 闲家墩分 + 扣底
 *
 * 四条都用「打完整副」来验证，而不是构造局面 —— 只有这样才会覆盖到
 * 甩牌、毙牌、扣底这些组合路径。
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_RULE_CONFIG, analyze, calcBottomBonus, cardsScore, checkPlay, trickStanding } from '@core'
import type { Card, Play } from '@core'
import { newGame, reduce } from '@app/game'
import { HUMAN_SEAT, ctxOf, seatToPlay } from '@app/state'
import type { GameState } from '@app/state'
import { enumeratePlays } from '@ai/enumerate'
import type { PlayContext } from '@ai/enumerate'
import { declareAndPass } from '../helpers/declare'

/** 人类座位：挑第一个合法出法（与 `fullRound.test.ts` 同一策略） */
function humanMove(s: GameState): { type: 'setSelection'; ids: number[] } {
  const ctx = ctxOf(s)
  const hand = s.hands[HUMAN_SEAT] as readonly Card[]
  const leadPlay = s.trick.plays[0] as Play | undefined
  const pc: PlayContext = leadPlay
    ? { kind: 'follow', leadCards: leadPlay.cards, leadAnalysis: leadPlay.analysis }
    : { kind: 'lead' }
  for (const cards of enumeratePlays(hand, ctx, pc, 80)) {
    const r = checkPlay({
      hand,
      cards,
      ctx,
      ...(leadPlay ? { lead: { cards: leadPlay.cards, analysis: leadPlay.analysis } } : {}),
      opponents: [1, 2, 3].map((x) => s.hands[x] as readonly Card[]),
    })
    if (r.ok) return { type: 'setSelection', ids: r.cards.map((c) => c.id) }
  }
  throw new Error('人类找不到合法出法')
}

const side = (seat: number): 'a' | 'b' => (seat === 0 || seat === 2 ? 'a' : 'b')
/** 闲家 = 庄家对面那一队（`defenderScore` 只累加闲家赢下的墩） */
const defendersOf = (s: GameState): 'a' | 'b' => (side(s.dealer) === 'a' ? 'b' : 'a')

/** 打一整副，逐手校验不变量，返回最终状态与违规清单 */
function playAndCheck(seed: number): { s: GameState; problems: string[] } {
  const problems: string[] = []
  let s = newGame(DEFAULT_RULE_CONFIG, 1, 0, seed)
  s = declareAndPass(s, 0)
  if (s.phase === 'bury') {
    const hand = s.hands[HUMAN_SEAT] as readonly Card[]
    const ctx = ctxOf(s)
    const weakest = [...hand].sort((a, b) => ctx.power.get(a.value) - ctx.power.get(b.value)).slice(0, 8)
    s = reduce(s, { type: 'bury', ids: weakest.map((c) => c.id) })
  }

  const checkCards = (): void => {
    const ids: number[] = []
    for (const h of s.hands) for (const c of h) ids.push(c.id)
    for (const c of s.bottom) ids.push(c.id)
    for (const p of s.trick.plays) for (const c of p.cards) ids.push(c.id)
    for (const t of s.history) for (const p of t.plays) for (const c of p.cards) ids.push(c.id)
    if (ids.length !== 108) problems.push(`第 ${s.step} 步：牌张 ${ids.length} ≠ 108`)
    if (new Set(ids).size !== ids.length) problems.push(`第 ${s.step} 步：牌 id 重复`)
  }

  const checkHistory = (): void => {
    const ctx = ctxOf(s)
    for (let i = 0; i < s.history.length; i++) {
      const t = s.history[i]
      if (t === undefined) continue
      if (t.plays.length !== 4) problems.push(`第 ${i + 1} 墩只有 ${t.plays.length} 手`)
      for (let j = 0; j < t.plays.length; j++) {
        const p = t.plays[j]
        if (p !== undefined && p.seat !== (t.leader + j) % 4)
          problems.push(`第 ${i + 1} 墩第 ${j + 1} 手座位 ${p.seat} ≠ ${(t.leader + j) % 4}`)
      }
      const plays = t.plays.map((p) => ({ seat: p.seat, cards: p.cards, analysis: analyze(p.cards, ctx) }))
      const st = trickStanding(plays, ctx)
      if (st === null) problems.push(`第 ${i + 1} 墩判定为 null`)
      else if (st.winner.seat !== t.winner) problems.push(`第 ${i + 1} 墩赢家 ${t.winner} ≠ 复算 ${st.winner.seat}`)
      const pts = t.plays.reduce((n, p) => n + cardsScore(p.cards), 0)
      if (pts !== t.score) problems.push(`第 ${i + 1} 墩得分 ${t.score} ≠ 牌面 ${pts}`)
      const next = s.history[i + 1]
      if (next !== undefined && next.leader !== t.winner) problems.push(`第 ${i + 2} 墩 leader ≠ 上墩赢家`)
    }
  }

  checkCards()
  let steps = 0
  while (s.phase === 'play' && steps < 4000) {
    steps++
    const before = s
    if (seatToPlay(s) === HUMAN_SEAT) {
      s = reduce(s, humanMove(s))
      s = reduce(s, { type: 'playSelected' })
    } else {
      s = reduce(s, { type: 'aiStep' })
    }
    checkCards()
    checkHistory()
    // 逐墩累加（末墩之后可能加扣底，故只在还没结算时严格比较）
    if (s.history.length > before.history.length && s.phase === 'play') {
      const defenders = defendersOf(s)
      const expectPts = s.history.filter((x) => side(x.winner) === defenders).reduce((n, x) => n + x.score, 0)
      if (s.defenderScore !== expectPts) problems.push(`defenderScore ${s.defenderScore} ≠ 累加 ${expectPts}`)
    }
  }
  return { s, problems }
}

describe('整局不变量', () => {
  it('6 副连打：牌张守恒 / 墩判定 / 出牌顺序 / 得分累加 全程成立', () => {
    const all: string[] = []
    for (let seed = 1; seed <= 6; seed++) {
      const { s, problems } = playAndCheck(seed)
      expect(s.phase === 'settle' || s.phase === 'over', `seed ${seed} 没打完：${s.phase}`).toBe(true)
      for (const p of problems) all.push(`seed ${seed}: ${p}`)
    }
    expect(all).toEqual([])
  })

  it('结算口径：闲家得分 = 闲家赢下的墩分 + 扣底（末墩闲家赢时）', () => {
    for (let seed = 1; seed <= 4; seed++) {
      const { s } = playAndCheck(seed)
      const defenders = defendersOf(s)
      const trickPts = s.history.filter((x) => side(x.winner) === defenders).reduce((n, x) => n + x.score, 0)
      const last = s.history[s.history.length - 1]
      let bonus = 0
      if (last !== undefined && side(last.winner) === defenders) {
        const winCards = last.plays.find((p) => p.seat === last.winner)
        if (winCards !== undefined) {
          const b = calcBottomBonus(analyze(winCards.cards, ctxOf(s)), s.bottomScore, false)
          if (b.applies) bonus = b.extra
        }
      }
      expect(s.defenderScore, `seed ${seed}`).toBe(trickPts + bonus)
    }
  })
})
