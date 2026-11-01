/**
 * 庄家防守分析：把我方坐庄的局单独拿出来，看**丢分最多的墩**是哪种类型。
 *
 * 跑法：`npx vite-node scripts/analyze-defender.ts <导出的 json>`
 *
 * 每一墩判三件事：
 *   ① **该压没压**：我方出牌时手里有能真正压过当前最大的合法牌，却没出
 *   ② **被毙**：对手用主牌毙掉了这一墩（首出是副牌）
 *   ③ **末墩抠底**：最后一墩被闲家赢下 ⇒ 底分 ×2/×4/×8
 */
import { readFileSync } from 'node:fs'
import { DEFAULT_RULE_CONFIG, analyze, beatsPlay, cardsScore, suitSlotOf, teamOf, trickStanding } from '@core'
import type { Card, RuleContext, Seat } from '@core'
import { playCards } from '@app/game'
import { ctxOf, emptyState } from '@app/state'
import type { GameState } from '@app/state'
import { buildPowerTable } from '@core'
import { enumeratePlays } from '@ai/enumerate'

type Play = [number, number[]]
interface Trick { leader: number; plays: Play[]; winner: number; score: number }
interface Round {
  seed: number; round: number; trump: number | 'NT'; levelRank: number; dealer: number
  hands: number[][]; bottom: number[]; tricks: Trick[]
  settle: { defenderScore: number }
}

const path = process.argv[2]
if (!path) {
  console.error('用法：npx vite-node scripts/analyze-defender.ts <导出的 json>')
  process.exit(1)
}
const data = JSON.parse(readFileSync(path, 'utf8')) as { rounds: Round[] }

const SU = ['♠', '♥', '♣', '♦']
const R = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']
const nm = (v: number): string => (v >= 52 ? (v === 53 ? '大王' : '小王') : `${SU[Math.floor(v / 13)]}${R[v % 13]}`)
const txt = (vs: readonly number[]): string => vs.map(nm).join(' ')
const SEAT = ['南', '西', '北', '东']

function toCards(hand: readonly Card[], vals: readonly number[]): Card[] | null {
  const pool = [...hand]
  const out: Card[] = []
  for (const v of vals) {
    const i = pool.findIndex((c) => c.value === v)
    if (i < 0) return null
    out.push(pool[i]!)
    pool.splice(i, 1)
  }
  return out
}

function buildState(r: Round): GameState | null {
  const used = new Map<number, number>()
  const mk = (v: number): Card => {
    const n = used.get(v) ?? 0
    used.set(v, n + 1)
    return { id: v * 2 + Math.min(n, 1), value: v }
  }
  if (r.hands.length !== 4 || r.tricks.length === 0) return null
  const trump = r.trump === 'NT' ? 'NT' : (r.trump as 0 | 1 | 2 | 3)
  return {
    ...emptyState(),
    phase: 'play',
    config: DEFAULT_RULE_CONFIG,
    seed: r.seed,
    round: r.round,
    dealer: r.dealer as Seat,
    levelRank: r.levelRank as GameState['levelRank'],
    trump,
    forcedNT: trump === 'NT',
    hands: r.hands.map((h) => h.map(mk)),
    bottom: r.bottom.map(mk),
    trick: { leader: r.tricks[0]!.leader as Seat, plays: [] },
    history: [],
    aiPeekHands: true,
  } as GameState
}

const myTeam = 0 // 座位 0/2 同队
const missPress: { where: string; score: number; who: string; detail: string }[] = []
let totalLost = 0
let lostTricks = 0
let ruffLoss = 0
let ruffScore = 0
let lastTrickLoss = 0
const koudi: { round: number; bottomPts: number; mult: number; dmg: number }[] = []
const ruffs: { where: string; score: number; who: string; suit: string; knownVoid: boolean }[] = []

for (const r of data.rounds) {
  if (teamOf(r.dealer) !== myTeam) continue // 只看我方坐庄
  let s = buildState(r)
  if (!s) continue
  const ctx: RuleContext = ctxOf(s)
  for (let t = 0; t < r.tricks.length; t++) {
    const tr = r.tricks[t]!
    for (const [seat, vals] of tr.plays) {
      const hand = s.hands[seat as Seat] as readonly Card[]
      const cards = toCards(hand, vals)
      if (!cards) break
      // ① 该压没压（我方座位、当前最大是对方）
      if (teamOf(seat) === myTeam && s.trick.plays.length > 0) {
        const lead = s.trick.plays[0]!
        // **必须用 core 的 `trickStanding`**：手写简化版处理不了甩牌（多组首出），
        // 会把"我方已经赢着"误判成"对方赢着"，进而产出假阳性的"该压没压"。
        const st = trickStanding(s.trick.plays, ctx)
        const standing = st === null ? null : { seat: st.winner.seat, analysis: st.winner.analysis }
        if (standing && teamOf(standing.seat) !== myTeam) {
          const cands = enumeratePlays(hand, ctx, {
            kind: 'follow',
            leadCards: lead.cards,
            leadAnalysis: lead.analysis,
          }, 60, true).filter((cs) => cs.length > 0)
          const winners = cands.filter((cs) => beatsPlay(analyze(cs, ctx), standing.analysis, ctx))
          const chosenWins = beatsPlay(analyze(cards, ctx), standing.analysis, ctx)
          if (winners.length > 0 && !chosenWins) {
            missPress.push({
              where: `局${r.round} 第 ${t + 1} 墩`,
              score: tr.score,
              who: SEAT[seat]!,
              detail: `出 ${txt(vals)}，本可 ${txt(winners[0]!.map((c) => c.value))}`,
            })
          }
        }
      }
      const next = playCards(s, seat as Seat, cards)
      if (next === s) break
      s = next
    }
    // ② 统计丢分墩
    if (teamOf(tr.winner) !== myTeam && tr.score > 0) {
      lostTricks++
      totalLost += tr.score
      const lead = tr.plays[0]!
      const winPlay = tr.plays.find(([seat]) => seat === tr.winner)
      if (winPlay) {
        const leadSlot = suitSlotOf(lead[1][0]!, ctx.power)
        const winSlot = suitSlotOf(winPlay[1][0]!, ctx.power)
        if (leadSlot !== 4 && winSlot === 4) {
          ruffLoss++
          ruffScore += tr.score
          // 关键判定：毙我们的人，此前是不是已经在这门跟不出过（= 我们知道他缺门）
          let knownVoid = false
          for (let k = 0; k < t; k++) {
            const prev = r.tricks[k]!
            const prevLeadSlot = suitSlotOf(prev.plays[0]![1][0]!, ctx.power)
            if (prevLeadSlot !== leadSlot) continue
            const p = prev.plays.find(([seat]) => seat === tr.winner)
            if (p && p[1].every((v) => suitSlotOf(v, ctx.power) !== leadSlot)) knownVoid = true
          }
          ruffs.push({
            where: `局${r.round} 第 ${t + 1} 墩`,
            score: tr.score,
            who: SEAT[tr.winner]!,
            suit: SU[leadSlot]!,
            knownVoid,
          })
        }
      }
      if (t === r.tricks.length - 1) {
        lastTrickLoss += tr.score
        // 抠底：底分 × 倍数（单张 ×2 / 对子 ×4 / 拖拉机 ×8）
        const bottomPts = r.bottom.reduce((n, v) => {
          if (v >= 52) return n
          const rk = v % 13
          // rank 索引：3='5'(5 分) · 8='10'(10 分) · 11='K'(10 分)
          return n + (rk === 3 ? 5 : rk === 8 || rk === 11 ? 10 : 0)
        }, 0)
        const wp = tr.plays.find(([seat]) => seat === tr.winner)
        const groups = wp ? analyze(wp[1].map((v) => ({ id: v * 2, value: v })), ctx).groups : []
        const mult = groups.some((g) => g.kind === 'tractor') ? 8 : (groups[0]?.length ?? 1) >= 2 ? 4 : 2
        koudi.push({ round: r.round, bottomPts, mult, dmg: bottomPts * mult })
      }
    }
  }
}

const mine = data.rounds.filter((r) => teamOf(r.dealer) === myTeam)
console.log(`\n我方坐庄 ${mine.length} 局（共 ${data.rounds.length} 局）`)
console.log(`  闲家得分：${mine.map((r) => r.settle.defenderScore).join(' / ')}（80 分上台）`)
console.log(`\n丢分墩：${lostTricks} 墩 · 共 ${totalLost} 分`)
console.log(`  其中**被毙**（副牌首出、对手用主赢）：${ruffLoss} 墩 · ${ruffScore} 分`)
console.log(`  末墩被闲家赢下（会抠底）：${lastTrickLoss} 分（不含底分倍数）`)
console.log(`\n**被毙明细**（我方首出副牌、对手用主赢）：`)
for (const x of ruffs) {
  console.log(`  ${x.where} · ${x.suit} 门 · ${x.who} 毙 · ${x.score} 分 · ${x.knownVoid ? '⚠️ 他此前已露缺门（可预判）' : '此前没露过缺门（不可预判）'}`)
}
const knowable = ruffs.filter((x) => x.knownVoid)
console.log(`  其中**可预判** ${knowable.length}/${ruffs.length} 墩 · ${knowable.reduce((n, x) => n + x.score, 0)} 分`)
const kdTotal = koudi.reduce((n, k) => n + k.dmg, 0)
console.log(`\n**抠底**：${koudi.length} 局被闲家赢下末墩`)
for (const k of koudi) console.log(`  局${k.round}：底分 ${k.bottomPts} × ${k.mult} 倍 = **${k.dmg} 分**`)
console.log(`  合计送出 **${kdTotal} 分**（占闲家总得分的 ${((kdTotal / mine.reduce((n, r) => n + r.settle.defenderScore, 0)) * 100).toFixed(0)}%）`)
console.log(`\n**该压没压**：${missPress.length} 处`)
for (const m of missPress.slice(0, 10)) {
  console.log(`  ${m.where} · ${m.who} · 本墩 ${m.score} 分 · ${m.detail}`)
}
