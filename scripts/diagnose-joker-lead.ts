/**
 * 诊断「首出烧王偏多」（H1）。
 *
 * 跑法：`npx vite-node scripts/diagnose-joker-lead.ts --rounds 24`
 *
 * 输出：
 *   ① 首出里出王的比例
 *   ② 每次"出王"时，把「王」与「最好的非王候选」的打分明细逐项作差 ——
 *      看是哪一项把王推上去的（聚合统计）
 *
 * 目的：在动手改权重之前，先确认驱动项。本项目已经栽过三次「加项重复计分」。
 */
import { DEFAULT_RULE_CONFIG, analyze, cardsScore, teamOf, trickStanding } from '@core'
import type { Card, PlayAnalysis, Seat } from '@core'
import { aiPlayFor, newGame, reduce } from '@app/game'
import { ctxOf, seatToPlay } from '@app/state'
import type { GameState } from '@app/state'
import { enumeratePlays } from '@ai/enumerate'
import { explainPlay } from '@ai/policy'
import type { AiDecisionInput, ScorePart } from '@ai/policy'
import { declareAndPass } from '../tests/helpers/declare'

const argv = process.argv.slice(2)
const ri = argv.indexOf('--rounds')
const ROUNDS = ri >= 0 ? Number(argv[ri + 1] ?? 24) : 24

const hasJoker = (cs: readonly Card[]): boolean => cs.some((c) => c.value >= 52)

/** 与 choosePlay 一致的输入构造（首出） */
function leadInput(s: GameState, seat: Seat): AiDecisionInput {
  const ctx = ctxOf(s)
  return {
    seat,
    hand: s.hands[seat] as readonly Card[],
    ctx,
    play: { kind: 'lead' },
    currentWinner: null,
    partnerLeading: false,
    opponents: [0, 1, 2, 3].filter((x) => x !== seat).map((x) => s.hands[x] as readonly Card[]),
    remainingSeats: [0, 1, 2, 3].filter(
      (x) => x !== seat && !s.trick.plays.some((p) => p.seat === x),
    ) as Seat[],
    trickPoints: s.trick.plays.reduce((n, p) => n + cardsScore(p.cards as readonly Card[]), 0),
  }
}

const byName = (parts: readonly ScorePart[]): Map<string, number> => {
  const m = new Map<string, number>()
  for (const p of parts) m.set(p.name, (m.get(p.name) ?? 0) + p.value)
  return m
}

let leads = 0
let jokerLeads = 0
const cause = new Map<string, number>()
const examples: string[] = []

for (let seed = 1; seed <= ROUNDS; seed++) {
  let s = newGame(DEFAULT_RULE_CONFIG, 3, 0, seed)
  s = declareAndPass(s, 0)
  if (s.phase === 'bury') {
    const hand = s.hands[s.dealer] as readonly Card[]
    s = reduce(s, { type: 'bury', ids: hand.slice(0, 8).map((c) => c.id) })
  }
  for (let i = 0; i < 500 && s.phase === 'play'; i++) {
    const seat = seatToPlay(s)
    if (seat === null) break
    const isLead = s.trick.plays.length === 0
    const picked = isLead ? null : null
    void picked
    const before = s
    const next = aiPlayFor(s, seat, 3)
    if (next === s) break

    if (isLead) {
      // **用「手牌差」取实际出的牌**：不能读 `next.trick.plays` ——
      // 第四家出完牌后这一墩会立刻结算、`plays` 被清空，读到空数组会把
      // 「每墩的最后一手」漏掉（上一版还因此把首出次数统计成每局 46 次，明显不对）。
      const beforeHand = before.hands[seat] as readonly Card[]
      const afterHand = next.hands[seat] as readonly Card[]
      const played = beforeHand.filter((c) => !afterHand.some((a) => a.id === c.id))
      if (played.length === 0) {
        s = next
        continue // 出牌没落地（被拒），不计入
      }
      leads++
      const play = { cards: played }
      if (hasJoker(play.cards)) {
        jokerLeads++
        // 对比：所有非王候选里分数最高的那一手
        const input = leadInput(before, seat)
        const cands = enumeratePlays(input.hand, input.ctx, { kind: 'lead' }, 60, true).filter(
          (cs) => cs.length > 0 && !hasJoker(cs),
        )
        let bestAlt: { cards: readonly Card[]; total: number } | null = null
        for (const cs of cands) {
          const e = explainPlay(input, cs, 3)
          if (bestAlt === null || e.total > bestAlt.total) bestAlt = { cards: cs, total: e.total }
        }
        if (bestAlt === null) continue
        const ej = explainPlay(input, play.cards, 3)
        const mj = byName(ej.parts)
        const ma = byName(bestAlt.cards.length ? explainPlay(input, bestAlt.cards, 3).parts : [])
        const diffs = [...new Set([...mj.keys(), ...ma.keys()])].map((k) => ({
          k,
          d: (mj.get(k) ?? 0) - (ma.get(k) ?? 0),
        }))
        diffs.sort((x, y) => Math.abs(y.d) - Math.abs(x.d))
        const top = diffs[0]
        if (top && Math.abs(top.d) > 1e-9) cause.set(top.k, (cause.get(top.k) ?? 0) + 1)
        if (examples.length < 6) {
          examples.push(
            `王 ${play.cards.map((c) => (c.value === 53 ? '大王' : '小王')).join(' ')}（${ej.total.toFixed(2)}）` +
              ` vs 最优非王 ${bestAlt.cards.map((c) => c.value).join(',')}（${bestAlt.total.toFixed(2)}）｜` +
              diffs.slice(0, 3).map((x) => `${x.k} ${x.d > 0 ? '+' : ''}${x.d.toFixed(2)}`).join(' · '),
          )
        }
      }
    }
    s = next
  }
}

console.log(`\n首出 ${leads} 次 · **出王 ${jokerLeads} 次（${((jokerLeads / Math.max(1, leads)) * 100).toFixed(1)}%）**\n`)
console.log('把王推上去的主因：')
for (const [k, v] of [...cause.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(2)} 次  ${k}`)
}
console.log('\n样本：')
for (const e of examples) console.log('  ' + e)
