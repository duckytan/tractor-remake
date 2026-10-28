/**
 * 「为什么 AI 这么出」—— 把每个分歧的打分拆开看。
 *
 * 跑法：`npx vite-node scripts/explain-divergences.ts <导出的 json>`
 *
 * 对每个人类决策点，分别计算「你出的牌」与「L3 建议」的**打分明细**（`explainPlay`），
 * 逐项作差，找出**是哪一项把决策推到了不同方向**，最后统计主因分布。
 *
 * 这是回答"为什么不一样"的唯一可靠方式：总分只告诉你结果，明细才告诉你原因。
 */

import { readFileSync } from 'node:fs'
import { cardsScore, teamOf, trickStanding } from '@core'
import type { Card, PlayAnalysis, Seat } from '@core'
import { ctxOf, HUMAN_SEAT } from '@app/state'
import type { GameState } from '@app/state'
import { emptyState } from '@app/state'
import { explainPlay } from '@ai/policy'
import type { AiDecisionInput, ScorePart } from '@ai/policy'
import { DEFAULT_RULE_CONFIG } from '@core'

const NAMES = ['♠', '♥', '♣', '♦']
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']
const nm = (v: number): string => (v >= 52 ? (v === 53 ? '大王' : '小王') : `${NAMES[Math.floor(v / 13)]}${RANKS[v % 13]}`)
const txt = (vs: readonly number[]): string => vs.map(nm).join(' ')

type Play = [number, number[]]
interface Trick { leader: number; plays: Play[]; winner: number; score: number }
interface Human { trick: number; cards: number[]; ai: number[] }
interface Round {
  seed: number; round: number; trump: number | string; levelRank: number; dealer: number
  hands: number[][]; bottom: number[]; tricks: Trick[]; human: Human[]
}

const path = process.argv[2]
if (!path) {
  console.error('用法：npx vite-node scripts/explain-divergences.ts <导出的 json>')
  process.exit(1)
}
const data = JSON.parse(readFileSync(path, 'utf8')) as { rounds: Round[] }

function toCards(hand: readonly Card[], values: readonly number[]): Card[] | null {
  const pool = [...hand]
  const out: Card[] = []
  for (const v of values) {
    const i = pool.findIndex((c) => c.value === v)
    if (i < 0) return null
    out.push(pool[i]!)
    pool.splice(i, 1)
  }
  return out
}

function buildState(round: Round): GameState | null {
  const used = new Map<number, number>()
  const mk = (v: number): Card => {
    const n = used.get(v) ?? 0
    used.set(v, n + 1)
    return { id: v * 2 + Math.min(n, 1), value: v }
  }
  if (round.hands.length !== 4) return null
  const first = round.tricks[0]
  if (!first) return null
  const trump = round.trump === 'NT' ? 'NT' : (round.trump as 0 | 1 | 2 | 3)
  return {
    ...emptyState(),
    phase: 'play',
    config: DEFAULT_RULE_CONFIG,
    seed: round.seed,
    round: round.round,
    dealer: round.dealer as Seat,
    levelRank: round.levelRank as GameState['levelRank'],
    trump,
    forcedNT: trump === 'NT',
    hands: round.hands.map((h) => h.map(mk)),
    bottom: round.bottom.map(mk),
    trick: { leader: first.leader as Seat, plays: [] },
    history: [],
    aiPeekHands: true,
  } as GameState
}

/** 与 choosePlay 完全一致的输入构造 */
function inputOf(s: GameState): AiDecisionInput | null {
  const ctx = ctxOf(s)
  const isLead = s.trick.plays.length === 0
  const lead = s.trick.plays[0]
  const standing = trickStanding(s.trick.plays, ctx)
  const played = new Set(s.trick.plays.map((p) => p.seat))
  const remaining = ([0, 1, 2, 3] as Seat[]).filter((x) => !played.has(x))
  return {
    seat: HUMAN_SEAT,
    hand: s.hands[HUMAN_SEAT] as readonly Card[],
    ctx,
    play: isLead
      ? { kind: 'lead' }
      : { kind: 'follow', leadCards: lead!.cards, leadAnalysis: lead!.analysis as PlayAnalysis },
    currentWinner: standing === null ? null : { seat: standing.winner.seat, analysis: standing.winner.analysis },
    partnerLeading: standing !== null && standing.winner.seat !== HUMAN_SEAT && teamOf(standing.winner.seat) === teamOf(HUMAN_SEAT),
    opponents: [1, 2, 3].map((x) => s.hands[x as Seat] as readonly Card[]),
    remainingSeats: remaining,
    trickPoints: s.trick.plays.reduce((n, p) => n + cardsScore(p.cards as readonly Card[]), 0),
  }
}

const byName = (parts: readonly ScorePart[]): Map<string, number> => {
  const m = new Map<string, number>()
  for (const p of parts) m.set(p.name, (m.get(p.name) ?? 0) + p.value)
  return m
}

const cause = new Map<string, number>()
const examples: { where: string; mine: number; ai: number; top: string; detail: string }[] = []
let n = 0

for (const round of data.rounds) {
  for (let t = 0; t < round.tricks.length; t++) {
    const tr = round.tricks[t]!
    const mine = tr.plays.find(([seat]) => seat === HUMAN_SEAT)
    if (!mine) continue
    const rec = round.human
      .filter((h) => h.trick === t && [...h.cards].sort((a, b) => a - b).join() === [...mine[1]].sort((a, b) => a - b).join())
      .pop()
    if (!rec) continue
    const same = [...rec.cards].sort((a, b) => a - b).join() === [...rec.ai].sort((a, b) => a - b).join()
    if (same) continue

    // 重放到决策点
    let s = buildState(round)
    if (!s) continue
    let ok = true
    for (let k = 0; k <= t && ok; k++) {
      for (const [seat, vals] of round.tricks[k]!.plays) {
        if (k === t && seat === HUMAN_SEAT) break
        const hand = s.hands[seat as Seat] as readonly Card[]
        const cards = toCards(hand, vals)
        if (!cards) { ok = false; break }
        const { playCards } = await import('@app/game')
        const next = playCards(s, seat as Seat, cards)
        if (next === s) { ok = false; break }
        s = next
      }
    }
    if (!ok) continue
    const input = inputOf(s)
    if (!input) continue
    const a = toCards(input.hand, rec.cards)
    const b = toCards(input.hand, rec.ai)
    if (!a || !b) continue

    const ea = explainPlay(input, a, 3)
    const eb = explainPlay(input, b, 3)
    const ma = byName(ea.parts)
    const mb = byName(eb.parts)
    const names = new Set([...ma.keys(), ...mb.keys()])
    // 每项对「差值」的贡献：AI 分 − 你的分
    const diffs = [...names].map((k) => ({ k, d: (mb.get(k) ?? 0) - (ma.get(k) ?? 0) }))
    diffs.sort((x, y) => Math.abs(y.d) - Math.abs(x.d))
    const top = diffs[0]
    if (!top || Math.abs(top.d) < 1e-9) continue
    n++
    cause.set(top.k, (cause.get(top.k) ?? 0) + 1)
    examples.push({
      where: `局${data.rounds.indexOf(round) + 1} 墩${t + 1}`,
      mine: ea.total,
      ai: eb.total,
      top: `${top.k} ${top.d > 0 ? '+' : ''}${top.d.toFixed(2)}`,
      detail:
        `你 ${txt(rec.cards)}（${ea.total.toFixed(2)}）vs AI ${txt(rec.ai)}（${eb.total.toFixed(2)}）｜` +
        diffs.slice(0, 3).map((x) => `${x.k} ${x.d > 0 ? '+' : ''}${x.d.toFixed(2)}`).join(' · '),
    })
  }
}

console.log(`\n【分歧归因】${n} 手（每手取「对差值贡献最大的一项」作为主因）\n`)
for (const [k, v] of [...cause.entries()].sort((x, y) => y[1] - x[1])) {
  console.log(`  ${String(v).padStart(2)} 次  ${k}  ${'█'.repeat(v)}`)
}
console.log('\n【前 12 个例子的明细】')
for (const e of examples.slice(0, 12)) console.log(`  ${e.where} ${e.detail}`)
