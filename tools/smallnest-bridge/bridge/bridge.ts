/**
 * smallnest 插件桥（离线工具）
 *
 * 协议：stdin 每行一个 JSON 请求 → stdout 每行一个 JSON 响应。
 * C# 插件（`plugin/OurAiPlugin.cs`）通过它拿到要出的牌。
 *
 * **第一阶段是"冒烟"**：只做最小合法出牌（最小的单张/对子，永不甩牌），
 * 目的是验证三件事：① 插件被加载 ② 连出的牌不被 `TractorRules` 拒绝 ③ 一局能打完。
 * 冒烟通过后把 `pickCards()` 换成 `choosePlay()` 即可接正式 AI（见文件末尾注释）。
 *
 * 为什么不直接上 `choosePlay`：`decide` 需要近乎完整的 `GameState`
 *（四家手牌、本墩 plays、dealer/level/trump、step/seed…），而插件只给得到
 * 「我的手牌 + 各家整局已出的牌 + 本墩各家出的牌」。先用少量信息跑通管道，
 * 再决定补多少状态 —— 这是三司会审（docs/42）定的顺序。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { analyze, buildPowerTable, checkPlay, DEFAULT_RULE_CONFIG } from '@core'
import type { Card, LevelRank, RuleContext, Trump } from '@core'
import { enumeratePlays } from '@ai/enumerate'
import type { PlayContext } from '@ai/enumerate'
import { parseTheirCards, theirSuitToTrump, trickOrder, ourCardToTheirId } from './smallnestMap'

interface Req {
  readonly seq: number
  readonly kind: 'lead' | 'follow'
  readonly who: number // 1..4（1=南）
  readonly suit: number // 1♥ 2♠ 3♦ 4♣ 5无主
  readonly rank: number // 0=打2 … 12=打A，53=打王
  readonly master: number // 庄家 1..4
  readonly whoIsFirst?: number
  readonly sendCards?: readonly string[]
  readonly currentSendCards?: readonly string[]
  readonly myCards: string
}

interface Res {
  readonly seq: number
  readonly cards: number[]
}

/**
 * 2 为常主：smallnest 侧由 GameConfig 决定。冒烟阶段默认 **开**（对齐本项目默认，见 KN-4）。
 * 要用 smallnest 口径就在启动桥时设 `TWO_AS_PERMANENT=0`。
 */
const TWO_AS_PERMANENT = process.env.TWO_AS_PERMANENT !== '0'

/** 决策日志：冒烟阶段唯一能证明「插件还在被调用」的证据 */
const LOG = process.env.BRIDGE_LOG ?? 'tools/smallnest-bridge/out/decisions.jsonl'

function log(obj: unknown): void {
  try {
    mkdirSync(dirname(LOG), { recursive: true })
    appendFileSync(LOG, JSON.stringify(obj) + '\n')
  } catch {
    /* 日志失败不能拖垮对局 */
  }
}

/** 他们的 rank（0=打2）→ 我们的 LevelRank（1..13 | 18=打王） */
const toLevelRank = (rank: number): LevelRank => (rank <= 12 ? ((rank + 1) as LevelRank) : 18)

function makeCtx(suit: number, rank: number): RuleContext {
  const trump: Trump = theirSuitToTrump(suit)
  const levelRank = toLevelRank(rank)
  return {
    power: buildPowerTable({
      mode: TWO_AS_PERMANENT ? 1 : 0,
      levelRank,
      trump,
      forcedNT: trump === 'NT',
    }),
    trump,
    levelRank,
    forcedNT: trump === 'NT',
    config: { ...DEFAULT_RULE_CONFIG, twoAsPermanent: TWO_AS_PERMANENT },
  }
}

/**
 * 冒烟阶段的出牌策略：**最小的一手单张/对子**，绝不甩牌。
 *
 * 为什么排除甩牌：`checkPlay` 校验甩牌要拿真实对手手牌；插件侧拿不到三家手牌，
 * 用空手牌校验会「一律合法」⇒ 一旦被 `TractorRules` 拒绝，插件会被**永久踢掉**（docs/42 F1）。
 * 宁可先只出单张/对子。
 */
function pickCards(req: Req, hand: readonly Card[], ctx: RuleContext): Card[] {
  const isLead = req.kind === 'lead'
  let pc: PlayContext
  if (isLead) {
    pc = { kind: 'lead' }
  } else {
    const first = req.whoIsFirst ?? req.who
    const per = req.currentSendCards ?? []
    const order = trickOrder(first, per)
    const lead = order[0]
    if (!lead) return [] // 信息不足，交给它自己的算法（它会回退内置）
    pc = { kind: 'follow', leadCards: lead.cards, leadAnalysis: analyze(lead.cards, ctx) }
  }

  const raw = enumeratePlays(hand, ctx, pc, 40, true)
  for (const cards of raw) {
    const a = analyze(cards, ctx)
    if (a.groups.length > 1) continue // 不甩牌（见上）
    const r = checkPlay({
      hand,
      cards,
      ctx,
      ...(pc.kind === 'follow' ? { lead: { cards: pc.leadCards, analysis: pc.leadAnalysis } } : {}),
      // 甩牌校验才用得到 opponents；这里已排除甩牌，传空数组即可
      opponents: [[], [], []],
    })
    if (r.ok) return r.cards.slice()
  }
  return []
}

function handle(req: Req): Res {
  const ctx = makeCtx(req.suit, req.rank)
  const hand = parseTheirCards(req.myCards)
  const picked = pickCards(req, hand, ctx)
  const cards = picked.map(ourCardToTheirId)

  log({
    ts: Date.now(),
    seq: req.seq,
    seat: req.who,
    kind: req.kind,
    trump: req.suit,
    level: req.rank,
    master: req.master,
    handSize: hand.length,
    hand: req.myCards,
    lead: req.currentSendCards ?? null,
    picked: cards,
    pickedCount: cards.length,
  })

  return { seq: req.seq, cards }
}

/* ---------------- stdin/stdout 行协议 ---------------- */

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  buf += chunk
  let idx: number
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim()
    buf = buf.slice(idx + 1)
    if (line === '') continue
    let res: Res
    try {
      res = handle(JSON.parse(line) as Req)
    } catch (e) {
      res = { seq: -1, cards: [] }
      log({ ts: Date.now(), error: String(e).slice(0, 300) })
    }
    process.stdout.write(JSON.stringify(res) + '\n')
  }
})

/**
 * 接正式 AI 的接口点（冒烟通过后再改这里）：
 *   把 `pickCards` 换成构造一个最小 `GameState` 再调 `choosePlay(s, seat, 2)`，
 *   其中 `hands` 里非我方的三家可以用「未见牌池」占位，`belief` 传 `buildBelief` 的结果。
 * 参见 `src/app/game.ts` 的 `choosePlay` 与 `src/ai/belief.ts`。
 */
