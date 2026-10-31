/**
 * 检测「本墩有分、手里有能赢的牌，却出了赢不了的牌」（用户报：队友有 A 却不赢，让敌家赢）。
 *
 * 跑法：`npx vite-node scripts/detect-missed-win.ts --rounds 24`
 *
 * 判据：跟牌、本墩已有分、且**存在一手能真的压过当前最大**的合法候选，
 * 但 L3 实际出的那手压不过 ⇒ 记一次。
 */
import { DEFAULT_RULE_CONFIG, analyze, beatsPlay, cardsScore, teamOf, trickStanding } from '@core'
import type { Card, Seat } from '@core'
import { aiPlayFor, newGame, playCards, reduce } from '@app/game'
import { ctxOf, seatToPlay } from '@app/state'
import type { GameState } from '@app/state'
import { enumeratePlays } from '@ai/enumerate'
import { declareAndPass } from '../tests/helpers/declare'

const argv = process.argv.slice(2)
const ri = argv.indexOf('--rounds')
const ROUNDS = ri >= 0 ? Number(argv[ri + 1] ?? 24) : 24

const nm = (v: number): string => {
  const S = ['♠', '♥', '♣', '♦']
  const R = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']
  return v >= 52 ? (v === 53 ? '大王' : '小王') : `${S[Math.floor(v / 13)]}${R[v % 13]}`
}
const text = (cs: readonly Card[]): string => cs.map((c) => nm(c.value)).join(' ')

let follows = 0
let scored = 0
let missed = 0
let missedMid = 0 // 非残局（剩 > 12 张）的"该赢不赢"—— 这才是打分器的锅
const samples: string[] = []

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
    const ctx = ctxOf(s)
    const isFollow = s.trick.plays.length > 0
    if (isFollow) {
      follows++
      const pts = s.trick.plays.reduce((n, p) => n + cardsScore(p.cards as readonly Card[]), 0)
      const standing = trickStanding(s.trick.plays, ctx)
      if (pts > 0 && standing !== null && teamOf(standing.winner.seat) !== teamOf(seat)) {
        scored++
        const hand = s.hands[seat] as readonly Card[]
        const lead = s.trick.plays[0]!
        const pc = { kind: 'follow' as const, leadCards: lead.cards, leadAnalysis: lead.analysis }
        const cands = enumeratePlays(hand, ctx, pc, 60, true).filter((cs) => cs.length > 0)
        const winners = cands.filter((cs) => beatsPlay(analyze(cs, ctx), standing.winner.analysis, ctx))
        const before = s
        const next = aiPlayFor(s, seat, 3)
        const played = (before.hands[seat] as readonly Card[]).filter(
          (c) => !(next.hands[seat] as readonly Card[]).some((a) => a.id === c.id),
        )
        if (winners.length > 0 && played.length > 0) {
          const chosenWins = beatsPlay(analyze(played, ctx), standing.winner.analysis, ctx)
          if (!chosenWins) {
            missed++
            const left = (s.hands as readonly (readonly Card[])[]).reduce((n, h) => n + h.length, 0)
            if (left > 12) missedMid++
            // 推演判定：实际出的 vs 能赢的那手，各用 L3 打到底，比终局闲家得分（我方视角）
            const valueOf = (x: GameState): number =>
              teamOf(x.dealer) === teamOf(seat) ? -x.defenderScore : x.defenderScore
            const roll = (cards: readonly Card[]): number | null => {
              let x = playCards(before, seat, cards)
              if (x === before) return null
              for (let k = 0; k < 400 && x.phase === 'play'; k++) {
                const sd = seatToPlay(x)
                if (sd === null) break
                const nx = aiPlayFor(x, sd, 3)
                if (nx === x) break
                x = nx
              }
              return x.phase === 'settle' || x.phase === 'over' ? valueOf(x) : null
            }
            const va = roll(played)
            const vb = roll(winners[0]!)
            const verdict =
              va === null || vb === null
                ? '（推演未收敛）'
                : vb > va
                  ? `**该赢（赢下来 +${(vb - va).toFixed(0)} 分）**`
                  : va > vb
                    ? `实际更优（省下来 +${(va - vb).toFixed(0)} 分）`
                    : '打平'
            if (samples.length < 10) {
              samples.push(
                `座位${seat} · 剩 ${(s.hands as readonly (readonly Card[])[]).reduce((n, h) => n + h.length, 0)} 张` +
                  ` · 首出 ${text(lead.cards)} · 当前最大 ${text(standing.winner.cards)}（${pts} 分）` +
                  ` ⇒ 出了 ${text(played)}，本可 ${text(winners[0]!)} ｜ ${verdict}`,
              )
            }
          }
        }
        s = next
        continue
      }
    }
    const next = aiPlayFor(s, seat, 3)
    if (next === s) break
    s = next
  }
}

console.log(`\n跟牌 ${follows} 次 · 其中「对方赢着且本墩有分」${scored} 次`)
console.log(`**有能赢的牌却不出：${missed} 次（${((missed / Math.max(1, scored)) * 100).toFixed(1)}%）**`)
console.log(`  其中**非残局（剩 >12 张）：${missedMid} 次** ← 这才是打分器的问题，其余是残局求解器接管\n`)
for (const x of samples) console.log('  ' + x)
