/**
 * AI 对局 dump 工具（docs/30 批 2 取证 · B 维度「AI 决策质量」证据来源）
 *
 * 跑 N 局「四家全自动」对局，逐墩记录首出 / 每家的牌 / 墩内分 / 赢家，
 * 并**自动标出三类可机检的失误**（不需要人读牌谱就能判定）：
 *
 *   - `over-teammate`  队友已经最大、后面也没有对手了，还出更大的牌压过队友（纯内耗）
 *   - `dump-points`    本队输掉这墩，却丢了分牌 —— 而它**本来有 0 分的合法出法**
 *   - `missed-points`  本队赢下这墩，却出了 0 分牌 —— 而它**本来有带分的合法出法**
 *
 * 后两条用 `enumeratePlays` 枚举合法出法来判「本来有没有别的选择」，
 * 所以不会把「被迫垫分」误报成失误（宁可漏报，不要假报）。
 *
 * 为什么需要它：前几轮审查对 AI 的结论**全是读代码推断**，没有一局实际证据。
 * 有了 dump 才能回答「AI 到底蠢在哪」，而不是「AI 看起来可能蠢」。
 *
 * 跑法：
 *   npx vite-node scripts/dump-ai-round.ts                  # 默认 3 局
 *   npx vite-node scripts/dump-ai-round.ts --rounds 8
 *   npx vite-node scripts/dump-ai-round.ts --seeds 1000,1002,1007
 *   npx vite-node scripts/dump-ai-round.ts --json           # 只出 JSON
 *   npx vite-node scripts/dump-ai-round.ts --verbose        # 打印每处失误明细
 */
import {
  DEAL_TOTAL,
  DEFAULT_RULE_CONFIG,
  analyze,
  analyzeHand,
  cardScore,
  checkPlay,
  rankOfValue,
  suitOfValue,
  teamOf,
  trickStanding,
} from '@core'
import type { Card, Play, Seat, Suit, Trump } from '@core'
import { enumeratePlays } from '@ai/enumerate'
import { aiLevelForSeat, aiPlayFor, newGame, reduce } from '@app/game'
import { ctxOf, seatToPlay } from '@app/state'
import type { GameState } from '@app/state'

const SUIT = ['♠', '♥', '♣', '♦']
const RANK = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']
const SEAT = ['南(你)', '西', '北', '东']

/** 埋底张数 = 庄家 33 张 − 手上留 25 张 */
const BURY_COUNT = 8
/** 人类位代理的抢主门槛（与 game.ts 的 AI_GRAB_SUIT_MIN 对齐） */
const PROXY_GRAB_MIN = 3
/** 判定「有没有别的合法出法」时的候选上限（越大越准，越慢） */
const ALT_LIMIT = 80
const GUARD_MAX = 20000

const cardText = (c: Card): string =>
  c.value >= 52 ? (c.value === 53 ? '大王' : '小王') : `${SUIT[suitOfValue(c.value)]}${RANK[rankOfValue(c.value)]}`
const cardsText = (cs: readonly Card[]): string => cs.map(cardText).join(' ')
const seatText = (s: Seat): string => SEAT[s] as string
const teamText = (t: number): string => (t === 0 ? '南北方' : '东西方')
const pointsOf = (cs: readonly Card[]): number => cs.reduce((a, c) => a + cardScore(c.value), 0)

/* ---------------- 数据结构 ---------------- */

interface PlayDump {
  readonly seat: Seat
  readonly cards: string
  readonly points: number
}

interface TrickDump {
  readonly no: number
  readonly leader: Seat
  readonly plays: PlayDump[]
  readonly points: number
  readonly winner: Seat
}

type AnomalyKind =
  | 'over-teammate'
  | 'dump-points'
  | 'missed-points'
  | 'miss-win'
  | 'miss-ruff'

interface Anomaly {
  readonly kind: AnomalyKind
  readonly trick: number
  readonly seat: Seat
  readonly detail: string
}

/** 一手牌出完后先挂起，等本墩结算知道赢家才能判对错 */
interface PendingPlay {
  readonly seat: Seat
  readonly cards: readonly Card[]
  readonly points: number
  /** 存在 0 分的合法出法 */
  readonly zeroAlt: boolean
  /** 存在带分的合法出法 */
  readonly pointAlt: boolean
  /** 出这手之后自己成了本墩当前最大（= 在抢这墩） */
  readonly becameBest: boolean
  /** 出这手之前本墩最大已经是队友（= 这墩对本队已安全） */
  readonly teammateWasBest: boolean
  /** 队友已最大、后面没有对手，仍然压过队友 */
  readonly overTeammate: boolean
  /** 出牌前的手牌（写进明细，方便人工复核判定是否正确） */
  readonly hand: readonly Card[]
  /** 出这手时本墩已有的分 */
  readonly trickPoints: number
  /** 本墩分 ≥10、自己是最后一手、存在能赢的合法出法，却没赢 */
  readonly missWin: boolean
  /** 缺门 + 手里有主牌 + 本墩分 ≥10，却没毙 */
  readonly missRuff: boolean
}

interface RoundDump {
  readonly seed: number
  readonly round: number
  readonly dealer: Seat
  readonly dealerTeam: string
  readonly trump: string
  readonly levelRank: number
  readonly bottom: string[]
  readonly bottomScore: number
  readonly tricks: TrickDump[]
  readonly anomalies: Anomaly[]
  readonly defenderScore: number
  readonly levels: number
  readonly levelUpTeam: string
  readonly actualLevels: number
  readonly guardLevel: number | null
  readonly stuck: string | null
  /** 首出统计：首出次数 / 其中「出的是手里最小牌」/ 其中出主牌 */
  readonly leadStats: {
    readonly leads: number
    readonly minCard: number
    readonly trump: number
    readonly joker: number
    /** 甩牌（同槽多组）首出次数 */
    readonly multi: number
  }
  /** 决策耗时（毫秒），逐手记录 */
  readonly decisionMs: number[]
  /** 抢主统计：亮主时该门手里有几张（按已发到的牌算） */
  readonly grabLens: number[]
}

/* ---------------- 人类位代理 ----------------
   本工具要「四家全自动」。人类座位在定主 / 反主 / 埋底三处会停下来等人点，
   不接管就永远卡在 contract 阶段（实测 8 个种子里 4 个卡死在 revealed=10）。
   代理只做**最低限度的合法决策**，不追求强度 —— 它的目的是让对局能跑完，
   好观察三家真 AI 的出牌。                                   */

const proxyRevealed = (s: GameState): readonly Card[] => {
  const h = s.hands[0] as readonly Card[]
  return s.revealed >= h.length ? h : h.slice(0, s.revealed)
}

/** 已揭示前缀里张数最多、且持级牌的可亮花色（镜像 game.ts 的 aiGrabPick） */
function proxyGrabPick(s: GameState): Suit | null {
  const hand = proxyRevealed(s)
  let best: Suit | null = null
  let bestN = -1
  for (const t of s.declareOptions) {
    if (t === 'NT') continue
    const n = hand.filter((c) => suitOfValue(c.value) === t).length
    if (n >= PROXY_GRAB_MIN && n > bestN) {
      best = t
      bestN = n
    }
  }
  return best
}

/** 发完 25 张后的定主面板：挑手牌最长的可选花色，没有花色就用无将 */
function proxyFinalPick(s: GameState): Trump {
  let best: Trump = (s.declareOptions[0] ?? 'NT') as Trump
  let bestN = -1
  for (const t of s.declareOptions) {
    if (t === 'NT') continue
    const n = (s.hands[0] as readonly Card[]).filter((c) => suitOfValue(c.value) === t).length
    if (n > bestN) {
      best = t
      bestN = n
    }
  }
  return best
}

/** 埋底：先扔没分的，再扔牌力最小的 */
function proxyBuryIds(s: GameState): number[] {
  const ctx = ctxOf(s)
  const hand = s.hands[0] as readonly Card[]
  const ranked = [...hand].sort((a, b) => {
    const sa = cardScore(a.value) > 0 ? 1 : 0
    const sb = cardScore(b.value) > 0 ? 1 : 0
    if (sa !== sb) return sa - sb
    return ctx.power.of(a) - ctx.power.of(b)
  })
  return ranked.slice(0, BURY_COUNT).map((c) => c.id)
}

/* ---------------- 单局驱动 ---------------- */

const trumpText = (s: GameState): string =>
  s.forcedNT ? '打王级强制无将' : s.trump === 'NT' ? '无将' : `主 ${SUIT[s.trump]}`

function driveRound(seed: number, level = 3): RoundDump {
  let s = newGame(DEFAULT_RULE_CONFIG, level, 0, seed)
  const tricks: TrickDump[] = []
  const anomalies: Anomaly[] = []
  let pending: PendingPlay[] = []
  let leadStats = { leads: 0, minCard: 0, trump: 0, joker: 0, multi: 0 }
  const decisionMs: number[] = []
  const grabLens: number[] = []
  let stuck: string | null = null
  let guard = 0

  while (guard++ < GUARD_MAX) {
    if (s.phase === 'settle' || s.phase === 'over') break

    /* --- 定约阶段：人类位的三个决策点 + 发牌推进 --- */
    if (s.phase === 'contract') {
      if (s.counterPending) {
        s = reduce(s, { type: 'passCounter' })
        continue
      }
      if (s.dealPrompt) {
        const pick = proxyGrabPick(s)
        if (pick !== null) {
          grabLens.push(proxyRevealed(s).filter((c) => suitOfValue(c.value) === pick).length)
        }
        s = pick === null ? reduce(s, { type: 'passDeal' }) : reduce(s, { type: 'declareTrump', trump: pick })
        continue
      }
      // 「发完 25 张」的定主面板。
      // **必须判 `revealed >= DEAL_TOTAL`**：`newGame` 一开局就把 `declareOptions`
      // 填成了整手牌的可亮花色（game.ts:229），此时 `declareTrump` 会因为
      // 「这张级牌还没发到手」全部拒绝 —— 不看发牌进度就会无限重试。
      if (s.revealed >= DEAL_TOTAL && s.declareOptions.length > 0) {
        s = reduce(s, { type: 'declareTrump', trump: proxyFinalPick(s) })
        continue
      }
      const prevRevealed = s.revealed
      s = reduce(s, { type: 'revealTick' })
      if (s.phase === 'contract' && s.revealed === prevRevealed && !s.dealPrompt && s.declareOptions.length === 0) {
        stuck = `revealTick 无进展（revealed=${s.revealed}）`
        break
      }
      continue
    }

    /* --- 埋底阶段：只有人类坐庄才会走到这里 --- */
    if (s.phase === 'bury') {
      s = reduce(s, { type: 'bury', ids: proxyBuryIds(s) })
      if (s.phase === 'bury') {
        stuck = 'bury 被拒'
        break
      }
      continue
    }

    /* --- 出牌阶段 --- */
    const seat = seatToPlay(s)
    if (seat === null) {
      stuck = 'seatToPlay 返回 null'
      break
    }

    const before = s
    const ctx = ctxOf(before)
    const hand = before.hands[seat] as readonly Card[]
    const lead = before.trick.plays[0] ?? null
    const t0 = performance.now()
    const next = aiPlayFor(before, seat, aiLevelForSeat(before, seat))
    decisionMs.push(performance.now() - t0)
    const played = (next.trick.plays.at(-1) ?? null) as Play | null

    if (played !== null && lead === null) {
      // 首出统计：这一手是不是「手里牌力最小的那张」/ 是不是主牌 / 是不是王
      leadStats = {
        leads: leadStats.leads + 1,
        minCard:
          leadStats.minCard +
          (played.cards.length === 1 &&
          ctx.power.get((played.cards[0] as Card).value) === Math.min(...hand.map((c) => ctx.power.get(c.value)))
            ? 1
            : 0),
        trump: leadStats.trump + (played.analysis.suitSlot === 4 ? 1 : 0),
        joker: leadStats.joker + (played.cards.some((c) => c.value >= 52) ? 1 : 0),
        multi: leadStats.multi + (played.analysis.isMultiGroup ? 1 : 0),
      }
    }

    if (played !== null) {
      let zeroAlt = false
      let pointAlt = false
      if (lead !== null) {
        // 「本来有没有别的选择」—— 只看合法出法里有没有 0 分 / 带分的
        const cands = enumeratePlays(
          hand,
          ctx,
          { kind: 'follow', leadCards: lead.cards, leadAnalysis: lead.analysis },
          ALT_LIMIT,
          true,
        )
        // **必须过滤空候选**：`pointsOf([]) === 0`，一个空的 `[]` 会让
        // 「本可出 0 分牌」永远为真（实测把「手里只剩 ♠10 ♠5 ♥5 全分牌」
        // 误判成「本可出 0 分牌」）。
        //
        // v1.3.39 再修（三司会审 P2）：**还必须过 `checkPlay`**。
        // `enumeratePlays` 只负责"给候选"，不保证合法（跟对子时可能给出两张散牌）。
        // 不过滤的话「本可带分」会混进非法出法 —— 实测复核 40 局，
        // 「队友赢着、我出 0 分」的 304 次决策里 **291 次合法候选根本没有分牌**，
        // 也就是说这个指标被高估了约 25 倍，之前报的「该垫没垫」几乎全是误报。
        const board = [0, 1, 2, 3]
          .filter((x) => x !== seat)
          .map((x) => before.hands[x as Seat] as readonly Card[])
        const legal = cands.filter(
          (cs) =>
            cs.length > 0 &&
            checkPlay({
              hand,
              cards: cs,
              ctx,
              lead: { cards: lead.cards, analysis: lead.analysis },
              opponents: board,
            }).ok,
        )
        zeroAlt = legal.some((cs) => pointsOf(cs) === 0)
        pointAlt = legal.some((cs) => pointsOf(cs) > 0)
      }

      // 出牌前后的「谁最大」——判定「在抢」还是「在送」的关键
      const done = before.trick.plays.length
      const standingBefore = done > 0 ? trickStanding(before.trick.plays, ctx) : null
      const standingAfter = trickStanding([...before.trick.plays, played], ctx)
      const becameBest = standingAfter !== null && standingAfter.winner.seat === seat
      const teammateWasBest = standingBefore !== null && teamOf(standingBefore.winner.seat) === teamOf(seat)

      // 内耗：队友已经是本墩最大，且**后面没有对手**再出，仍然压过队友
      let overTeammate = false
      if (teammateWasBest && becameBest) {
        const laterSeats: Seat[] = []
        for (let i = done + 1; i < 4; i++) laterSeats.push(((before.trick.leader + i) % 4) as Seat)
        overTeammate = !laterSeats.some((x) => teamOf(x) !== teamOf(seat))
      }

      // ---- B2 该赢不赢 / B3 该毙不毙 ----
      const trickPoints = before.trick.plays.reduce((x, p) => x + pointsOf(p.cards), 0)
      const isLast = before.trick.plays.length === 3
      let missWin = false
      let missRuff = false
      if (lead !== null && trickPoints >= 10 && !becameBest) {
        // 同一批候选给 B2 / B3 共用：枚举一次，避免重复计算
        const cands = enumeratePlays(
          hand,
          ctx,
          { kind: 'follow', leadCards: lead.cards, leadAnalysis: lead.analysis },
          ALT_LIMIT,
          true,
        ).filter((cs) => cs.length > 0)
        /** 这一手出完能不能成为本墩当前最大 */
        const wins = (cs: readonly Card[]): boolean => {
          const st = trickStanding([...before.trick.plays, { seat, cards: cs, analysis: analyze(cs, ctx) }], ctx)
          return st !== null && st.winner.seat === seat
        }

        // B2：最后一手 + 分 ≥10 + 存在能赢的合法出法，却没赢
        if (isLast) missWin = cands.some(wins)

        // B3：缺门 + 有主牌能毙 + 分 ≥10 + 却出了非主牌
        //
        // **必须同时验证「毙了真能赢」**：只要手里有主牌就算失误会产生大量假阳性 ——
        // 手里只剩小主牌、对手还有更大的主时，「不毙」是**正确**判断。
        // 第一版判据没加这一条，把 L3 的 6 处「聪明弃牌」误判成失误。
        const slot = lead.analysis.suitSlot
        if (slot !== -1) {
          const ha = analyzeHand(hand, ctx)
          const voidInLead = ha.slots[slot]!.cards.length === 0
          const hasTrump = ha.slots[4]!.cards.length > 0
          if (voidInLead && hasTrump && played.analysis.suitSlot !== 4) {
            missRuff = cands.some((cs) => analyze(cs, ctx).suitSlot === 4 && wins(cs))
          }
        }
      }

      pending.push({
        seat,
        cards: played.cards,
        points: pointsOf(played.cards),
        zeroAlt,
        pointAlt,
        becameBest,
        teammateWasBest,
        overTeammate,
        hand,
        trickPoints,
        missWin,
        missRuff,
      })
    }

    s = next

    /* --- 本墩结算 ⇒ 从 history 取最后一墩，并结算挂起的判定 --- */
    if (s.history.length > tricks.length) {
      const rec = s.history[s.history.length - 1]!
      const no = tricks.length + 1
      const winnerTeam = teamOf(rec.winner)

      for (const p of pending) {
        const mineTeam = teamOf(p.seat)
        if (p.overTeammate) {
          anomalies.push({
            kind: 'over-teammate',
            trick: no,
            seat: p.seat,
            detail: `${seatText(p.seat)} 后面已无对手，仍用 ${cardsText(p.cards)} 压过队友`,
          })
        }
        // 真·垫分 = **没在抢这墩**（出完还不是最大）+ 本队输 + 有 0 分替代。
        // 只看「本队输 + 丢分」会把「出大牌抢分结果被对手压」误判成垫分。
        if (!p.becameBest && mineTeam !== winnerTeam && p.points > 0 && p.zeroAlt) {
          anomalies.push({
            kind: 'dump-points',
            trick: no,
            seat: p.seat,
            detail:
              `${seatText(p.seat)} 在对手赢的墩里白丢 ${p.points} 分（${cardsText(p.cards)}），` +
              `本可出 0 分牌 —— 手牌 ${cardsText(p.hand)}`,
          })
        }
        if (p.missWin) {
          anomalies.push({
            kind: 'miss-win',
            trick: no,
            seat: p.seat,
            detail:
              `${seatText(p.seat)} 最后一手、本墩已 ${p.trickPoints} 分、有能赢的牌，` +
              `却出 ${cardsText(p.cards)} 让掉 —— 手牌 ${cardsText(p.hand)}`,
          })
        }
        if (p.missRuff) {
          anomalies.push({
            kind: 'miss-ruff',
            trick: no,
            seat: p.seat,
            detail:
              `${seatText(p.seat)} 缺门、有主牌、本墩已 ${p.trickPoints} 分，却垫 ${cardsText(p.cards)} 不毙` +
              ` —— 手牌 ${cardsText(p.hand)}`,
          })
        }
        // 真·该垫没垫 = 出这手之前**这墩已经是队友最大**（分稳拿），却出了 0 分牌
        if (p.teammateWasBest && mineTeam === winnerTeam && p.points === 0 && p.pointAlt) {
          anomalies.push({
            kind: 'missed-points',
            trick: no,
            seat: p.seat,
            detail:
              `${seatText(p.seat)} 本队已稳赢这墩，却出 ${cardsText(p.cards)}（0 分），` +
              `本可带分 —— 手牌 ${cardsText(p.hand)}`,
          })
        }
      }
      pending = []

      tricks.push({
        no,
        leader: rec.leader,
        plays: rec.plays.map((p) => ({ seat: p.seat, cards: cardsText(p.cards), points: pointsOf(p.cards) })),
        points: rec.plays.reduce((sum, p) => sum + pointsOf(p.cards), 0),
        winner: rec.winner,
      })
    }
  }

  const settle = s.lastSettle
  // 守卫耗尽也是一种卡住：不显式报出来会伪装成「跑完了但 0 墩」，非常误导
  if (stuck === null && guard >= GUARD_MAX) stuck = `守卫耗尽（phase=${s.phase}）`
  const dealerTeam = teamOf(s.dealer)
  // 注意：`levelUpTeam` 是**队号**（0 = 座位 0/2），不是「0 = 庄家方」。
  // 早期版本直接写 `=== 0 ? '庄家方'`，把闲家上台报成了庄家升级。
  const levelUpTeam = settle == null ? '—' : settle.levelUpTeam === dealerTeam ? '庄家方' : '闲家'

  return {
    seed,
    round: s.round,
    dealer: s.dealer,
    dealerTeam: teamText(dealerTeam),
    trump: trumpText(s),
    levelRank: s.levelRank,
    bottom: s.bottom.map(cardText),
    bottomScore: s.bottomScore,
    tricks,
    anomalies,
    defenderScore: settle?.defenderScore ?? s.defenderScore,
    levels: settle?.levels ?? 0,
    levelUpTeam,
    actualLevels: settle?.actualLevels ?? 0,
    guardLevel: settle?.guardLevel ?? null,
    stuck,
    leadStats,
    decisionMs,
    grabLens,
  }
}

/* ---------------- 输出 ---------------- */

const LEVEL_LABEL = (lr: number): string => (lr === 18 ? '王' : (RANK[lr - 1] ?? String(lr)))

function printRound(d: RoundDump, verbose: boolean): void {
  console.log(`\n${'='.repeat(78)}`)
  console.log(
    `seed ${d.seed} · 第 ${d.round} 局 · 庄 ${seatText(d.dealer)}（${d.dealerTeam}）` +
      ` · ${d.trump} · 打 ${LEVEL_LABEL(d.levelRank)}`,
  )
  console.log(`底牌(${d.bottom.length} 张) 底分 ${d.bottomScore}: ${d.bottom.join(' ') || '（空）'}`)
  if (d.stuck !== null) console.log(`!! 卡住：${d.stuck}`)
  console.log(`${'─'.repeat(78)}`)
  for (const t of d.tricks) {
    const plays = t.plays.map((p) => `${seatText(p.seat)}[${p.cards}]`).join('  ')
    console.log(
      `第 ${String(t.no).padStart(2)} 墩 · 首出 ${seatText(t.leader)}` +
        ` · 分 ${String(t.points).padStart(2)} · 赢 ${seatText(t.winner)}`,
    )
    console.log(`         ${plays}`)
  }
  console.log(`${'─'.repeat(78)}`)
  console.log(
    `闲家得分 ${d.defenderScore} → ${d.levelUpTeam} 升 ${d.levels} 级` +
      `（实际 ${d.actualLevels}${d.guardLevel !== null ? `，停在必打 ${LEVEL_LABEL(d.guardLevel)}` : ''}）`,
  )
  if (verbose && d.anomalies.length > 0) {
    console.log(`疑似失误 ${d.anomalies.length} 处：`)
    for (const a of d.anomalies) console.log(`  · [${a.kind}] 第 ${a.trick} 墩 ${a.detail}`)
  }
}

function main(): void {
  const argv = process.argv.slice(2)
  const jsonOnly = argv.includes('--json')
  const verbose = argv.includes('--verbose')

  const levelArg = argv.indexOf('--level')
  const level = levelArg >= 0 ? Number(argv[levelArg + 1] ?? 3) : 3
  const seedsArg = argv.indexOf('--seeds')
  const roundsArg = argv.indexOf('--rounds')
  let seeds: number[]
  if (seedsArg >= 0) {
    seeds = (argv[seedsArg + 1] ?? '')
      .split(',')
      .map(Number)
      .filter((n) => Number.isFinite(n))
  } else {
    const n = roundsArg >= 0 ? Number(argv[roundsArg + 1] ?? 3) : 3
    seeds = Array.from({ length: n }, (_, i) => 1000 + i)
  }
  if (seeds.length === 0) seeds = [1000, 1001, 1002]

  const all = seeds.map((seed) => driveRound(seed, level))
  if (!jsonOnly) for (const d of all) printRound(d, verbose)

  if (jsonOnly) {
    console.log(JSON.stringify(all, null, 1))
    return
  }

  /* ---- 汇总：这几个指标能直接回答「AI 蠢在哪」 ---- */
  const done = all.filter((d) => d.stuck === null)
  const n = all.length
  const nd = done.length || 1
  const avg = (f: (d: RoundDump) => number): number =>
    done.length === 0 ? 0 : done.reduce((s, d) => s + f(d), 0) / done.length
  const count = (kind: AnomalyKind): number =>
    all.reduce((s, d) => s + d.anomalies.filter((a) => a.kind === kind).length, 0)
  const trickTotal = done.reduce((s, d) => s + d.tricks.length, 0) || 1

  console.log(`\n${'='.repeat(78)}`)
  console.log(`汇总（AI 档位 L${level}）`)
  console.log(`  局数 ${n} · 跑完 ${nd}${n !== nd ? ` · **卡住 ${n - nd}**` : ''}`)
  console.log(`  平均墩数 ${avg((d) => d.tricks.length).toFixed(1)}（100 张牌，含对子/拖拉机一墩多张）`)
  console.log(
    `  平均底分 ${avg((d) => d.bottomScore).toFixed(1)}` +
      ` · 底分 > 0 的局 ${done.filter((d) => d.bottomScore > 0).length}/${nd}`,
  )
  const dealerUp = done.filter((d) => d.levelUpTeam === '庄家方').length
  console.log(`  庄家方升级 ${dealerUp}/${nd} · 闲家上台 ${nd - dealerUp}/${nd}`)
  console.log(`  平均闲家得分 ${avg((d) => d.defenderScore).toFixed(1)} / 200（≥80 闲家上台）`)
  console.log(`  底分明细: ${all.map((d) => d.bottomScore).join(' / ')}`)
  console.log(`  闲家得分: ${all.map((d) => d.defenderScore).join(' / ')}`)
  const total = (['over-teammate', 'dump-points', 'missed-points', 'miss-win', 'miss-ruff'] as AnomalyKind[]).reduce(
    (x, k) => x + count(k),
    0,
  )
  console.log(
    `  可机检失误 ${total} 处 / ${trickTotal} 墩（${((total / trickTotal) * 100).toFixed(1)}%）：` +
      `内耗 ${count('over-teammate')} · 可避免垫分 ${count('dump-points')}` +
      ` · 该垫没垫 ${count('missed-points')}`,
  )
  console.log(`    其中 B2 该赢不赢 ${count('miss-win')} · B3 该毙不毙 ${count('miss-ruff')}`)
  // **每局失误数**比「失误/墩」更稳：甩牌/对子会让一墩吃多张牌，墩数在 20~25 之间浮动，
  // 用墩数做分母会让「同样的失误数」算出不同的比率（v1.3.29 实测 562 墩 → 468 墩）。
  console.log(`    每局失误 ${(total / nd).toFixed(2)} 处 · 每局墩数 ${avg((d) => d.tricks.length).toFixed(1)}`)

  const leads = done.reduce((x, d) => x + d.leadStats.leads, 0) || 1
  const minLeads = done.reduce((x, d) => x + d.leadStats.minCard, 0)
  const trumpLeads = done.reduce((x, d) => x + d.leadStats.trump, 0)
  const jokerLeads = done.reduce((x, d) => x + d.leadStats.joker, 0)
  const multiLeads = done.reduce((x, d) => x + d.leadStats.multi, 0)
  console.log(
    `  首出 ${leads} 次：出「手里最小牌」${((minLeads / leads) * 100).toFixed(1)}%` +
      ` · 出主牌 ${((trumpLeads / leads) * 100).toFixed(1)}%` +
      ` · 出王 ${((jokerLeads / leads) * 100).toFixed(1)}%` +
      ` · 甩牌 ${multiLeads} 次（${((multiLeads / leads) * 100).toFixed(1)}%）`,
  )

  const ms = done.flatMap((d) => d.decisionMs).sort((a, b) => a - b)
  if (ms.length > 0) {
    const pct = (q: number): number => ms[Math.min(ms.length - 1, Math.floor(ms.length * q))] as number
    console.log(
      `  单次决策耗时 P50 ${pct(0.5).toFixed(2)}ms · P95 ${pct(0.95).toFixed(2)}ms` +
        ` · 最大 ${(ms[ms.length - 1] as number).toFixed(2)}ms（样本 ${ms.length}）`,
    )
  }

  const lens = done.flatMap((d) => d.grabLens)
  if (lens.length > 0) {
    const le3 = lens.filter((x) => x <= 3).length
    console.log(
      `  抢主 ${lens.length} 次：该门 ≤3 张仍抢 ${le3} 次（${((le3 / lens.length) * 100).toFixed(1)}%）` +
        ` · 平均该门 ${(lens.reduce((a, b) => a + b, 0) / lens.length).toFixed(1)} 张`,
    )
  }

  if (n !== nd) {
    console.log(`  卡住明细: ${all.filter((d) => d.stuck !== null).map((d) => `seed${d.seed}(${d.stuck})`).join(' / ')}`)
  }
}

main()
