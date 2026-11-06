/**
 * 提示质量分析：把「稳妥提示」和「最强 AI（L3）」的分歧逐手推演，看谁更优。
 *
 * 跑法：`npx vite-node scripts/analyze-hint-quality.ts <导出的 json>`
 *
 * 背景（2026-11-02）：第 3 批真实对局里，玩家 40 次看提示、按提示出 27 次（68%）。
 * 但提示与 L3 只有 27/40 一致 —— 剩下 13 次提示给的是"稳妥但不必然最优"的一手。
 * 用户问：是不是该把提示默认改成 L3？
 *
 * 做法：对每个「提示 ≠ L3」的决策点，
 *   ① 用日志的 hands + bottom + trump + dealer **重建局面**（不能用 seed，见 judge-divergences 注释）
 *   ② 分别应用「提示高亮的牌」与「L3 建议的牌」，各用 L3 打完剩下的牌
 *   ③ 比较终局 **我方视角价值**（越大越好）
 *
 * 为什么必须推演而不是看总分：L3 的即时打分是启发式，只有打到底的终局分才算数。
 * 本项目已经多次出现「改得更正确反而更弱」，所以只出结论、不在这里改任何权重。
 *
 * 注意：
 *   · 悔牌会留多条同一墩记录 ⇒ 只取「与最终出牌一致」的最后一条
 *   · `tricks[].plays` 是 `[座位, 牌值[]]` 元组
 *   · 甩牌（多组首出）局面下回放可能不收敛 ⇒ 单独统计跳过，不硬下结论
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
const txt = (vs: readonly number[]): string => vs.map(nm).join(' ')
const same = (x: readonly number[], y: readonly number[]): boolean =>
  [...x].sort((a, b) => a - b).join() === [...y].sort((a, b) => a - b).join()

type Play = [number, number[]]
interface Trick { leader: number; plays: Play[]; winner: number; score: number }
interface Human { trick: number; cards: number[]; ai: number[]; hint: boolean; hintCards?: number[] }
interface Round {
  seed: number; round: number; trump: number | string; levelRank: number; dealer: number
  hands: number[][]; bottom: number[]; tricks: Trick[]; human: Human[]
  settle: { defenderScore: number; dealerChanged: boolean; gameOver: boolean }
}

const path = process.argv[2]
if (!path) {
  console.error('用法：npx vite-node scripts/analyze-hint-quality.ts <导出的 json>')
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

/** 用日志直接重建开局状态（seed 重现不了 dealer/trump） */
function buildState(r: Round): GameState | null {
  const used = new Map<number, number>()
  const mk = (v: number): Card => {
    const n = used.get(v) ?? 0
    used.set(v, n + 1)
    return { id: v * 2 + Math.min(n, 1), value: v }
  }
  if (r.hands.length !== 4) return null
  const first = r.tricks[0]
  if (!first) return null
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
    trick: { leader: first.leader as Seat, plays: [] },
    history: [],
    aiPeekHands: true,
  } as GameState
}

const valueOf = (s: GameState): number =>
  teamOf(s.dealer) === teamOf(HUMAN_SEAT) ? -s.defenderScore : s.defenderScore

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
function stateBefore(r: Round, trick: number): GameState | null {
  let s = buildState(r)
  if (!s) return null
  for (let t = 0; t < trick; t++) {
    const tr = r.tricks[t]
    if (!tr) return null
    for (const [seat, vals] of tr.plays) {
      const cards = toCards(s.hands[seat as Seat] as readonly Card[], vals)
      if (!cards) return null
      const next = playCards(s, seat as Seat, cards)
      if (next === s) return null
      s = next
    }
  }
  const tr = r.tricks[trick]
  if (!tr) return null
  for (const [seat, vals] of tr.plays) {
    if (seat === HUMAN_SEAT) return s
    const cards = toCards(s.hands[seat as Seat] as readonly Card[], vals)
    if (!cards) return null
    const next = playCards(s, seat as Seat, cards)
    if (next === s) return null
    s = next
  }
  return null
}

/* ---------------- 统计 ---------------- */
let hintTotal = 0          // 看过提示的决策数
let agree = 0              // 提示 == L3
let diff = 0               // 提示 != L3
let judged = 0
let aiBetter = 0
let hintBetter = 0
let tie = 0
let skipped = 0
let netIfSwitchToL3 = 0    // 若把提示换成 L3，这批分歧的净收益（我方视角）
const skipReasons: Record<string, number> = {}
// 分歧时你实际听了谁
let followedHint = 0
let followedL3 = 0
let thirdWay = 0
const rows: { where: string; detail: string; delta: number; who: string }[] = []

for (const r of data.rounds) {
  for (let t = 0; t < r.tricks.length; t++) {
    const tr = r.tricks[t]!
    const mine = tr.plays.find(([seat]) => seat === HUMAN_SEAT)
    if (!mine) continue
    // 悔牌去重：只取与最终出牌一致、且带 hintCards 的最后一条
    const cands = r.human.filter(
      (h) =>
        h.trick === t &&
        h.hint &&
        (h.hintCards?.length ?? 0) > 0 &&
        same(h.cards, mine[1]),
    )
    const rec = cands[cands.length - 1]
    if (!rec) continue
    hintTotal++
    const hc = rec.hintCards!
    const ai = rec.ai

    if (same(hc, ai)) {
      agree++
      continue
    }
    diff++

    // 你实际听了谁
    if (same(rec.cards, hc)) followedHint++
    else if (same(rec.cards, ai)) followedL3++
    else thirdWay++

    const before = stateBefore(r, t)
    if (!before) {
      skipped++
      skipReasons.noState = (skipReasons.noState ?? 0) + 1
      continue
    }
    const hand = before.hands[HUMAN_SEAT] as readonly Card[]
    const hCards = toCards(hand, hc)
    const aCards = toCards(hand, ai)
    if (!hCards || !aCards) {
      skipped++
      skipReasons.noCards = (skipReasons.noCards ?? 0) + 1
      continue
    }
    const apply = (cs: Card[]): GameState | null => {
      const x = playCards(before, HUMAN_SEAT, cs)
      return x === before ? null : x
    }
    const sh = apply(hCards)
    const sa = apply(aCards)
    if (!sh || !sa) {
      skipped++
      skipReasons.rejected = (skipReasons.rejected ?? 0) + 1
      continue
    }
    const vh = rollout(sh)
    const va = rollout(sa)
    if (vh === null || va === null) {
      skipped++
      skipReasons.noRollout = (skipReasons.noRollout ?? 0) + 1
      continue
    }
    judged++
    netIfSwitchToL3 += va - vh
    const lead = tr.plays[0]
    const where = `局${r.round} 墩${t + 1}${lead ? `（首出 ${txt([lead[1][0]!])}）` : ''}`
    const detail = `${where} 提示 ${txt(hc)} → ${vh} ｜ L3 ${txt(ai)} → ${va} ｜ 你出 ${txt(rec.cards)}`
    if (va > vh) {
      aiBetter++
      rows.push({ where, detail, delta: va - vh, who: 'L3' })
    } else if (vh > va) {
      hintBetter++
      rows.push({ where, detail, delta: vh - va, who: '提示' })
    } else tie++
  }
}

console.log(`\n【提示 vs 最强 AI】看提示 ${hintTotal} 次`)
console.log(`  提示 == L3：${agree} 次（${((agree / Math.max(1, hintTotal)) * 100).toFixed(0)}%）—— 无分歧`)
console.log(`  提示 ≠ L3：${diff} 次（${((diff / Math.max(1, hintTotal)) * 100).toFixed(0)}%）—— 下面逐手推演`)
console.log(`\n  分歧时你实际：按提示 ${followedHint} · 按 L3 ${followedL3} · 都没听 ${thirdWay}`)
console.log(`\n【推演判定】可判定 ${judged} 手（跳过 ${skipped} 手 ${JSON.stringify(skipReasons)}）`)
console.log(`  **L3 更优 ${aiBetter} · 提示更优 ${hintBetter} · 打平 ${tie}**`)
console.log(`  若把提示全换成 L3：这批分歧净收益 ${netIfSwitchToL3 >= 0 ? '+' : ''}${netIfSwitchToL3} 分（我方视角，跨 ${judged} 手累计）`)
rows.sort((a, b) => b.delta - a.delta)
console.log('\n【差距最大的分歧】（数字 = 我方视角终局价值，越大越好）')
for (const x of rows.slice(0, 12)) console.log(`  ±${x.delta.toFixed(0).padStart(3)}  ${x.detail}`)
