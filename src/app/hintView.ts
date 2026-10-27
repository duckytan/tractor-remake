/**
 * 「提示」的一句话理由。
 *
 * 为什么需要它（v1.3.32）：
 * 提示现在与 AI 共用决策引擎（`choosePlay`），会走「看起来没道理但胜率高」的线 ——
 * 比如首出一对带分的 5、或者手里有王却先跑一张小副牌。玩家看不到对手的牌，
 * 也没被告知这一手在赌什么，于是**只能判断成「弱智」**（用户原话）。
 *
 * 所以这里把「这一手是什么、赌的是什么」摊开说：
 *   - 首出：什么槽 / 什么牌型 / 带多少分 / 这门还有几张
 *   - 跟牌：能不能压住 / 队友是不是已经赢着 / 是不是用主牌毙 / 本墩多少分
 *
 * 全部由 `analyze` + `canBeat` + `trickStanding` 推出来（**不编造策略意图**）——
 * 说错了玩家一眼能看出来，那才是真「弱智」。
 * 分层：规则概念留在 app 层，ui 只负责显示字符串（见 docs/07）。
 */

import { analyze, canBeat, cardsScore, isSameTeam, trickStanding } from '@core'
import type { Card, PlayAnalysis, RuleContext } from '@core'
import { HUMAN_SEAT, ctxOf } from './state'
import type { GameState } from './state'

const SUIT_NAME = ['♠', '♥', '♣', '♦'] as const

export interface HintExplain {
  /** 操作条里的短文案（窄屏也放得下） */
  readonly text: string
  /** 悬停看详情：多带「这门还有几张 / 本墩多少分」这类上下文 */
  readonly detail: string
}

/** 槽号 → 人话（0..3 花色，4 = 主牌段） */
function slotLabel(slot: number, ctx: RuleContext): string {
  if (slot === 4) return '主牌'
  const name = SUIT_NAME[slot] ?? '?'
  // 主花色单独点名，玩家才知道「这门就是主」
  return ctx.trump !== 'NT' && !ctx.forcedNT && slot === ctx.trump ? `${name}(主)` : name
}

/** 牌型 */
function shapeLabel(a: PlayAnalysis): string {
  if (a.isMultiGroup) return '甩牌'
  const g = a.groups[0]
  if (a.groups.length === 1 && g !== undefined) {
    if (g.kind === 'pair') return '对子'
    if (g.kind === 'tractor') return `${g.length} 连对`
  }
  return a.groups.length > 1 ? `${a.groups.length} 组` : '单张'
}

/** 该槽在手牌里还有几张（首出「长套」判断的唯一依据） */
function slotCountOf(hand: readonly Card[], slot: number, ctx: RuleContext): number {
  if (slot === 4) return hand.filter((c) => ctx.power.isTrump(c.value)).length
  return hand.filter((c) => c.value < 52 && Math.floor(c.value / 13) === slot).length
}

/**
 * 提示牌的一句话理由；没有提示时返回 null。
 *
 * 输出示例（text ｜ detail）：
 *   `首出 ♠对子 · 10 分` ｜ `首出 ♠ 对子（10 分）—— 这门你还有 7 张`
 *   `压住这墩 · 20 分`     ｜ `跟牌：能压过当前最大，本墩 20 分归我方`
 *   `队友赢着 · 垫最小`    ｜ `跟牌：队友已经赢着，垫掉最小的牌，别抢队友的墩`
 *   `压不过 · 垫 0 分`     ｜ `跟牌：压不过当前最大，垫一张 0 分小牌，别送分`
 *   `主牌毙 · 25 分`       ｜ `跟牌：用主牌毙掉这一手，抢下本墩 25 分`
 */
export function hintExplain(s: GameState): HintExplain | null {
  if (s.hintIds.length === 0 || s.phase !== 'play') return null
  const hand = s.hands[HUMAN_SEAT] as readonly Card[]
  const ids = new Set(s.hintIds)
  const cards = hand.filter((c) => ids.has(c.id))
  if (cards.length === 0) return null

  const ctx = ctxOf(s)
  const a = analyze(cards, ctx)
  const points = cardsScore(cards)

  /* ---------------- 首出 ---------------- */
  if (s.trick.plays.length === 0) {
    const slot = a.suitSlot
    const slotName = slot === -1 ? '混花色' : slotLabel(slot, ctx)
    const shape = shapeLabel(a)
    const text = `首出 ${slotName}${shape}${points > 0 ? ` · ${points} 分` : ''}`
    if (slot === -1) {
      return { text, detail: `首出：${shape}${points > 0 ? `（${points} 分）` : ''}` }
    }
    const left = slotCountOf(hand, slot, ctx)
    return {
      text,
      detail: `首出 ${slotName} ${shape}${points > 0 ? `（${points} 分）` : ''} —— 这门你还有 ${left} 张`,
    }
  }

  /* ---------------- 跟牌 ---------------- */
  const standing = trickStanding(s.trick.plays, ctx)
  const partnerWinning = standing !== null && isSameTeam(standing.winner.seat, HUMAN_SEAT)
  // **必须走 core 的 `canBeat`** —— 一墩判定全项目只此一份。
  // 自己写「比 keyCard 大小」会把「对子压单张」「散对压连对」都算成能压（docs/15 KN-7 的教训）。
  const iWin = standing === null ? true : canBeat(a, standing.winner.analysis)
  const trickPoints = s.trick.plays.reduce((sum, p) => sum + cardsScore(p.cards as readonly Card[]), 0)

  if (partnerWinning) {
    return {
      text: points > 0 ? `队友赢着 · 垫 ${points} 分` : '队友赢着 · 垫最小',
      detail:
        points > 0
          ? `跟牌：队友已经赢着，垫 ${points} 分的牌 —— 这一墩仍算我方赢，分还是我们的`
          : '跟牌：队友已经赢着，垫掉最小的牌，别抢队友的墩',
    }
  }
  if (iWin) {
    const leadSlot = s.trick.plays[0]?.analysis.suitSlot ?? -1
    const ruff = a.suitSlot === 4 && leadSlot !== -1 && leadSlot !== 4
    const head = ruff ? '主牌毙' : '压住这墩'
    return {
      text: trickPoints > 0 ? `${head} · ${trickPoints} 分` : head,
      detail: ruff
        ? `跟牌：用主牌毙掉这一手${trickPoints > 0 ? `，抢下本墩 ${trickPoints} 分` : ''}`
        : `跟牌：能压过当前最大${trickPoints > 0 ? `，本墩 ${trickPoints} 分归我方` : ''}`,
    }
  }
  return {
    text: points > 0 ? `压不过 · 垫 ${points} 分` : '压不过 · 垫 0 分',
    detail:
      points > 0
        ? `跟牌：压不过当前最大，垫的是 ${points} 分的牌（这一墩多半要给对手）`
        : '跟牌：压不过当前最大，垫一张 0 分小牌，别送分',
  }
}
