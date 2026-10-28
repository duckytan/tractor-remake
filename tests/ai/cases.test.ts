/**
 * 人类标注题库（外部锚的"人类刻度"部分）
 *
 * 为什么要有它：内部标定（同档对打、座位互换配对）只能回答"A 比 B 强多少"，
 * 回答不了"这手棋像不像人"。而人对"什么是好棋"有明确判断 —— 用户的每一次吐槽
 * 本质上都是一条标注。把吐槽固化成可跑的断言，以后改任何 AI 都先看这里掉不掉。
 *
 * 题目放 `tests/ai/cases/*.json`，一题一文件，格式见下。**加题不用改代码。**
 *
 * ```json
 * {
 *   "id": "唯一标识",
 *   "engine": "l3" | "safe",        // 用哪套策略作答（默认 l3）
 *   "desc": "为什么这手该这么打（写人话，将来出错时直接看懂）",
 *   "trump": 0|1|2|3|"NT",           // 主花色；0♠ 1♥ 2♣ 3♦
 *   "level": 2,                       // 打几：2=打2 … 13=打K，1=打A，18=打王
 *   "myHand": "♦A ♦3 ♥9",
 *   "trick": [{ "seat": 1, "cards": ["♠6"] }],   // 本墩已出的牌（首出为空数组）
 *   "expect": ["♦A"],                // 期望出的牌里**必须包含**（可省）
 *   "expectNot": ["♦3"]              // 期望出的牌里**不能包含**（可省）
 * }
 * ```
 *
 * 牌的写法：`♠A ♥10 ♣K ♦2 大王 小王`（花色 + 点数，或中文王名）。
 */

import { describe, expect, it } from 'vitest'
import { analyze, buildPowerTable, cardsScore, DEFAULT_RULE_CONFIG, trickStanding } from '@core'
import type { Card, LevelRank, RuleContext, Seat, Trump } from '@core'
import { mulberry32 } from '@core'
import { decide } from '@ai/policy'
import type { AiDecisionInput } from '@ai/policy'
import { safeHint } from '@ai/safeHint'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const SUIT_OF: Record<string, number> = { '♠': 0, '♥': 1, '♣': 2, '♦': 3 }
const RANK_OF: Record<string, number> = {
  '2': 0, '3': 1, '4': 2, '5': 3, '6': 4, '7': 5, '8': 6, '9': 7, '10': 8,
  J: 9, Q: 10, K: 11, A: 12,
}

/** "♠A" / "♣10" / "大王" → Card；两张同名自动分成两个 id（两副牌） */
function parseHand(s: string): Card[] {
  const seen = new Map<number, number>()
  const out: Card[] = []
  for (const tok of s.split(/\s+/).filter(Boolean)) {
    let value: number
    if (tok === '大王') value = 53
    else if (tok === '小王') value = 52
    else {
      const suit = SUIT_OF[tok[0] as string]
      const rank = RANK_OF[tok.slice(1)]
      if (suit === undefined || rank === undefined) throw new Error(`看不懂这张牌：${tok}`)
      value = suit * 13 + rank
    }
    const copy = seen.get(value) ?? 0
    seen.set(value, copy + 1)
    out.push({ id: value * 2 + Math.min(copy, 1), value })
  }
  return out
}

interface CaseTrick {
  readonly seat: number
  readonly cards: readonly string[]
}
interface CaseFile {
  readonly id: string
  readonly engine?: 'l3' | 'safe'
  readonly desc: string
  readonly trump: number | 'NT'
  readonly level: number
  readonly myHand: string
  readonly trick: readonly CaseTrick[]
  readonly expect?: readonly string[]
  readonly expectNot?: readonly string[]
}

const DIR = join(process.cwd(), 'tests', 'ai', 'cases')
const files = readdirSync(DIR).filter((f) => f.endsWith('.json'))
const cases: CaseFile[] = files.map((f) => JSON.parse(readFileSync(join(DIR, f), 'utf8')) as CaseFile)

function makeCtx(c: CaseFile): RuleContext {
  const trump: Trump = c.trump === 'NT' ? 'NT' : (c.trump as 0 | 1 | 2 | 3)
  const levelRank = c.level as LevelRank
  return {
    power: buildPowerTable({
      mode: 1,
      levelRank,
      trump,
      forcedNT: trump === 'NT',
    }),
    trump,
    levelRank,
    forcedNT: trump === 'NT',
    config: DEFAULT_RULE_CONFIG,
  }
}

/**
 * 三家对手的"占位手牌"：**除我手牌与桌上已出的牌之外的全部牌**，均分三份。
 *
 * 为什么不能传空数组：`checkPlay` 校验**甩牌**要用真实对手手牌（每组都要压过三家的最大值）。
 * 传空数组 = 谁都没有牌 → 任何甩牌都「合法」→ 实测会把「♦A+♦3」这种必然失败的甩牌
 * 当成候选（真实对局里它会被裁成最小单位）。
 */
function placeholderOpponents(hand: readonly Card[], played: readonly Card[]): Card[][] {
  const used = new Set([...hand, ...played].map((c) => c.value))
  const rest: Card[] = []
  for (let v = 0; v <= 53; v++) if (!used.has(v)) rest.push({ id: v * 2, value: v })
  const per = Math.ceil(rest.length / 3)
  return [rest.slice(0, per), rest.slice(per, per * 2), rest.slice(per * 2)]
}

/** 跑一题，返回它实际会出的牌（字符串形式，便于读断言信息） */
function answer(c: CaseFile): string[] {
  const ctx = makeCtx(c)
  const hand = parseHand(c.myHand)
  const trickPlays = c.trick.map((t) => {
    const cards = parseHand(t.cards.join(' '))
    return { seat: t.seat as Seat, cards, analysis: analyze(cards, ctx) }
  })
  const lead = trickPlays[0]
  const opponents = placeholderOpponents(
    hand,
    trickPlays.flatMap((p) => p.cards),
  )

  if (c.engine === 'safe') {
    return safeHint({
      hand,
      ctx,
      play: lead
        ? { kind: 'follow', leadCards: lead.cards, leadAnalysis: lead.analysis }
        : { kind: 'lead' },
      currentWinner: null,
      partnerLeading: false,
      opponents,
      seat: 0,
      remainingSeats: [0],
      trickPoints: trickPlays.reduce((n, p) => n + cardsScore(p.cards), 0),
    }).map(nameOf)
  }

  const standing = trickStanding(trickPlays, ctx)
  const input: AiDecisionInput = {
    seat: 0,
    hand,
    ctx,
    play: lead
      ? { kind: 'follow', leadCards: lead.cards, leadAnalysis: lead.analysis }
      : { kind: 'lead' },
    currentWinner: standing === null ? null : { seat: standing.winner.seat, analysis: standing.winner.analysis },
    partnerLeading: standing !== null && standing.winner.seat === 2,
    opponents,
    remainingSeats: [0],
    trickPoints: trickPlays.reduce((n, p) => n + cardsScore(p.cards), 0),
  }
  return decide(input, 3, mulberry32(20261028)).cards.map(nameOf)
}

const NAMES = ['♠', '♥', '♣', '♦']
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']
function nameOf(c: Card): string {
  if (c.value >= 52) return c.value === 53 ? '大王' : '小王'
  return NAMES[Math.floor(c.value / 13)]! + RANKS[c.value % 13]!
}

describe('人类标注题库（tests/ai/cases/*.json）', () => {
  it('题库非空', () => {
    expect(cases.length).toBeGreaterThanOrEqual(3)
  })

  for (const c of cases) {
    it(`${c.id} · ${c.desc.slice(0, 40)}`, () => {
      const got = answer(c)
      for (const want of c.expect ?? []) {
        expect(got, `期望包含 ${want}，实际出了 ${got.join(' ')}`).toContain(want)
      }
      for (const no of c.expectNot ?? []) {
        expect(got, `不该出 ${no}，实际出了 ${got.join(' ')}`).not.toContain(no)
      }
    })
  }
})
