/**
 * 分歧判定：拿真实对局数据，用推演回答「这手到底谁对」。
 *
 * 跑法：`npx vite-node scripts/judge-divergences.ts <导出的 json>`
 *
 * 做法（对每个人类决策）：
 *   ① 用 `seed` 重放这一局到「决策那一刻」（手牌/发牌是确定性的，实测与日志一致）
 *   ② 分别应用「你出的牌」与「L3 会出的牌」，各用 L3 打完剩下的牌
 *   ③ 比较终局 `defenderScore`（换算成我方视角），分高者更优
 *
 * 为什么不用"AI 说的就是对的"：AI 也会错。只有推演能给独立判断。
 *
 * 注意：悔牌会产生多条同一墩的记录 —— 只判定**最终生效**的那一手
 *（与 `tricks[i].plays` 里座位 0 的牌一致的那条），被撤销的尝试不计。
 */

import { readFileSync } from 'node:fs'
import { DEFAULT_RULE_CONFIG, teamOf } from '@core'
import type { Card, Seat } from '@core'
import { aiPlayFor, playCards } from '@app/game'
import { HUMAN_SEAT, emptyState, seatToPlay } from '@app/state'
import type { GameState } from '@app/state'

const NAMES = ['♠', '♥', '♣', '♦']
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']
const nm = (v: number): string => (v >= 52 ? (v === 53 ? '大王' : '小王') : `${NAMES[Math.floor(v / 13)]}${RANKS[v % 13]}`)
const cardText = (vs: readonly number[]): string => vs.map(nm).join(' ')

/** 导出格式里每手牌是 `[座位, 牌值数组]` 元组（不是对象） */
type Play = [number, number[]]
interface Trick { leader: number; plays: Play[]; winner: number; score: number }
interface Human { trick: number; cards: number[]; ai: number[]; hint: boolean }
interface Round {
  seed: number; round: number; trump: number | string; levelRank: number; dealer: number
  hands: number[][]; bottom: number[]; tricks: Trick[]; human: Human[]
  settle: { defenderScore: number; dealerChanged: boolean }
}

const path = process.argv[2]
if (!path) {
  console.error('用法：npx vite-node scripts/judge-divergences.ts <导出的 json>')
  process.exit(1)
}
const data = JSON.parse(readFileSync(path, 'utf8')) as { rounds: Round[] }

/** 把 value 换成手里实际那张 Card（同一 value 可能有两张） */
function takeFromHand(hand: readonly Card[], value: number): Card | null {
  return hand.find((x) => x.value === value) ?? null
}
function toCards(hand: readonly Card[], values: readonly number[]): Card[] | null {
  const pool = [...hand]
  const out: Card[] = []
  for (const v of values) {
    const c = takeFromHand(pool, v)
    if (!c) return null
    out.push(c)
    pool.splice(pool.indexOf(c), 1)
  }
  return out
}

/**
 * 用日志**直接重建**这一局的开局状态。
 *
 * 为什么不用 `seed` 重放：`seed` 只能重现**发到手的牌**，不能重现「谁坐庄、亮什么主」——
 * 那是当时玩家的决策结果。实测 8 局里有 3 局重放出来的 dealer/trump 与日志不同，
 * 于是后续每一手都对不上（50/52 手因此跳过）。
 * 日志里本来就有 `hands` + `bottom` + `trump` + `dealer`，直接拼状态最可靠。
 */
function buildState(round: Round): GameState | null {
  const used = new Map<number, number>()
  const mk = (v: number): Card => {
    const n = used.get(v) ?? 0
    used.set(v, n + 1)
    return { id: v * 2 + Math.min(n, 1), value: v }
  }
  if (round.hands.length !== 4) return null
  const hands = round.hands.map((h) => h.map(mk))
  const bottom = round.bottom.map(mk)
  const trump = round.trump === 'NT' ? 'NT' : (round.trump as 0 | 1 | 2 | 3)
  const first = round.tricks[0]
  if (!first) return null
  const base = emptyState()
  return {
    ...base,
    phase: 'play',
    config: DEFAULT_RULE_CONFIG,
    seed: round.seed,
    round: round.round,
    dealer: round.dealer as Seat,
    levelRank: round.levelRank as GameState['levelRank'],
    trump,
    forcedNT: trump === 'NT',
    hands,
    bottom,
    trick: { leader: first.leader as Seat, plays: [] },
    history: [],
    aiPeekHands: true,
  } as GameState
}

/** 我方视角的终局价值：越大越好 */
const valueOf = (s: GameState): number =>
  teamOf(s.dealer) === teamOf(HUMAN_SEAT) ? -s.defenderScore : s.defenderScore

/** 从 s 开始让四家都用 L3 打到底 */
function rollout(s0: GameState): number | null {
  let s = s0
  for (let i = 0; i < 600 && s.phase === 'play'; i++) {
    const seat = seatToPlay(s)
    if (seat === null) break
    const next = aiPlayFor(s, seat, 3)
    if (next === s) break
    s = next
  }
  return s.phase === 'settle' || s.phase === 'over' ? valueOf(s) : null
}

/** 重放到「第 trick 墩、座位 0 出牌之前」 */
function stateBefore(round: Round, trick: number): GameState | null {
  let s = buildState(round)
  if (!s) return null
  for (let t = 0; t < trick; t++) {
    const tr = round.tricks[t]
    if (!tr) return null
    for (const [seat, vals] of tr.plays) {
      const hand = s.hands[seat as Seat] as readonly Card[]
      const cards = toCards(hand, vals)
      if (!cards) return null
      const next = playCards(s, seat as Seat, cards)
      if (next === s) return null
      s = next
    }
  }
  const tr = round.tricks[trick]
  if (!tr) return null
  for (const [seat, vals] of tr.plays) {
    if (seat === HUMAN_SEAT) return s
    const hand = s.hands[seat as Seat] as readonly Card[]
    const cards = toCards(hand, vals)
    if (!cards) return null
    const next = playCards(s, seat as Seat, cards)
    if (next === s) return null
    s = next
  }
  return null
}

let judged = 0
let aiBetter = 0
let humanBetter = 0
let tie = 0
const rows: { text: string; delta: number }[] = []
let skipped = 0
const reasons: Record<string, number> = {}

for (const round of data.rounds) {
  for (let t = 0; t < round.tricks.length; t++) {
    const tr = round.tricks[t]!
    const mine = tr.plays.find(([seat]) => seat === HUMAN_SEAT)
    if (!mine) continue
    // 只取「最终生效」的那条（悔牌产生的旧记录丢弃）
    const cands = round.human.filter(
      (h) =>
        h.trick === t &&
        h.cards.length === mine[1].length &&
        [...h.cards].sort((a, b) => a - b).join() === [...mine[1]].sort((a, b) => a - b).join(),
    )
    const rec = cands[cands.length - 1]
    if (!rec) continue
    const same = (x: number[], y: number[]): boolean =>
      [...x].sort((a, b) => a - b).join() === [...y].sort((a, b) => a - b).join()
    if (same(rec.cards, rec.ai)) continue // 一致，不用判

    const before = stateBefore(round, t)
    if (!before) {
      skipped++
      reasons.noState = (reasons.noState ?? 0) + 1
      continue
    }
    const hand = before.hands[HUMAN_SEAT] as readonly Card[]
    const aCards = toCards(hand, rec.cards)
    const bCards = toCards(hand, rec.ai)
    if (!aCards || !bCards) {
      skipped++
      reasons.noCards = (reasons.noCards ?? 0) + 1
      continue
    }
    const apply = (cards: Card[]): GameState | null => {
      const x = playCards(before, HUMAN_SEAT, cards)
      return x === before ? null : x
    }
    const sa = apply(aCards)
    const sb = apply(bCards)
    if (!sa || !sb) {
      skipped++
      reasons.rejected = (reasons.rejected ?? 0) + 1
      continue
    }
    const va = rollout(sa)
    const vb = rollout(sb)
    if (va === null || vb === null) {
      skipped++
      continue
    }
    judged++
    const lead = tr.plays[0]
    const where = `局${data.rounds.indexOf(round) + 1} 墩${t + 1}${lead ? `（首出 ${nm(lead[1][0]!)}）` : ''}`
    const detail = `${where} 你 ${cardText(rec.cards)} → ${va} ｜ AI ${cardText(rec.ai)} → ${vb}`
    if (vb > va) {
      aiBetter++
      rows.push({ text: detail, delta: vb - va })
    } else if (va > vb) {
      humanBetter++
      rows.push({ text: detail, delta: va - vb })
    } else tie++
  }
}

console.log(`\n【分歧判定】可判定 ${judged} 手（跳过 ${skipped} 手）`)
console.log('  跳过原因:', JSON.stringify(reasons))
console.log(`  AI 更优 ${aiBetter} · 你更优 ${humanBetter} · 打平 ${tie}`)
rows.sort((x, y) => y.delta - x.delta)
console.log('\n【差距最大的 12 手】（数字 = 我方视角的终局价值，越大越好）')
for (const r of rows.slice(0, 12)) console.log(`  ±${r.delta.toFixed(0).padStart(3)}  ${r.text}`)
