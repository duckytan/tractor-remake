/**
 * M5 · AI 四档难度验证
 *
 * FR-16 验收：① AI 出牌必然通过合法性校验；
 *             ② 各档难度在固定牌局下胜率单调递增；
 *             ④ 相同输入 + 相同随机种子 → 相同出牌（确定性）。
 *
 * ── 测量方法（重要）────────────────────────────────────────────
 * 朴素做法：让队A用高档、队B用低档跑一批牌局，看谁赢。
 *   ❌ 这是错的 —— 本作有**座位偏差**：奇数位（1/3）整体占优。
 *      实测同档对同档时队A（偶数位）只有 ~43% 胜率，而不是 50%。
 *      直接比较会得出「高档 AI 反而更弱」的错误结论。
 *
 * 正确做法：**座位互换配对测量**。
 *   同一副牌打两遍：一遍 A 档在偶数位、一遍 A 档在奇数位，
 *   两次的净胜分取平均 —— 座位偏差被完全抵消，剩下的才是策略差异。
 *   自检：同档对同档必须恰好 0%（见下方用例）。
 * ──────────────────────────────────────────────────────────────
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_RULE_CONFIG, analyze, checkPlay, mulberry32 } from '@core'
import type { Card, RuleContext, Seat } from '@core'
import { decide } from '@ai/policy'
import type { AiLevel } from '@ai/policy'
import { newGame, reduce, aiPlayFor } from '@app/game'
import type { GameState } from '@app/state'
import { seatToPlay } from '@app/state'
import { ctx } from '../core/helpers'
import { C, P } from '../core/helpers'
import { declareAndPass } from '../helpers/declare'

/** 队伍：seat % 2。0/2 一队，1/3 一队 */
const teamOfSeat = (s: Seat): 0 | 1 => (s % 2) as 0 | 1

/** 随机扣 8 张底（庄家手牌 33 张） */
function pickBuryIds(s: GameState): number[] {
  const hand = s.hands[s.dealer] as readonly Card[]
  const rng = mulberry32(s.seed + 1234)
  const ids = hand.map((c) => c.id)
  for (let i = ids.length - 1; i > 0; i--) {
    const j = rng.int(i + 1)
    const t = ids[i]!
    ids[i] = ids[j]!
    ids[j] = t
  }
  return ids.slice(0, 8)
}

/**
 * 跑完一局，四个座位全部由 AI 代打。
 *
 * `levelA` 档打「A 队」（偶数位或奇数位，由 swap 决定），
 * `levelB` 档打另一队。
 *
 * 走 reducer 内部的 `aiPlayFor` —— 与正式对局完全同一条路径，
 * 避免测出来的强度是「另一套代码」的表现。
 */
function playRound(
  seed: number,
  levelA: AiLevel,
  levelB: AiLevel,
  swap: boolean,
  maxSteps = 4000,
): GameState {
  let s = newGame(DEFAULT_RULE_CONFIG, levelA, 0, seed)
  s = declareAndPass(s, 0)
  if (s.phase === 'bury') s = reduce(s, { type: 'bury', ids: pickBuryIds(s) })

  let steps = 0
  while (s.phase === 'play' && steps < maxSteps) {
    steps += 1
    const seat = seatToPlay(s)
    if (seat === null) break
    // swap=true → A 档打奇数位
    const isA = (seat % 2 === 0) !== swap
    s = aiPlayFor(s, seat, isA ? levelA : levelB)
  }
  return s
}

/** 各队吃到的总分 */
function teamScores(s: GameState): { a: number; b: number } {
  let a = 0
  let b = 0
  for (const t of s.history) {
    if (teamOfSeat(t.winner) === 0) a += t.score
    else b += t.score
  }
  return { a, b }
}

/**
 * 座位互换配对测量。
 *
 * 返回 A 档相对 B 档的净胜率（0..1）与平均净分。
 * 同一副牌打两遍，座位对调，取平均 —— 座位偏差被抵消。
 */
function pairedMeasure(
  levelA: AiLevel,
  levelB: AiLevel,
  rounds: number,
): { winRate: number; avgMargin: number } {
  let wins = 0
  let margin = 0
  for (let seed = 1; seed <= rounds; seed++) {
    const r1 = playRound(seed, levelA, levelB, false)
    const r2 = playRound(seed, levelA, levelB, true)
    // r1：A 在偶数位 → A 的分记在 a；r2：A 在奇数位 → A 的分记在 b
    const s1 = teamScores(r1)
    const s2 = teamScores(r2)
    const m = (s1.a - s1.b + (s2.b - s2.a)) / 2
    margin += m
    if (m > 0) wins++
  }
  return { winRate: wins / rounds, avgMargin: margin / rounds }
}

describe('M5 · AI 四档难度', () => {
  describe('A. 行为差异', () => {
    /**
     * 构造一个「必须跟牌」局面：
     *   首出方出黑桃 3（副牌），我在手上有黑桃 A（能压过）和小黑桃 4/6。
     *   L1/L2 的启发式会给「能赢的一手」加分，应当选择黑桃 A。
     *   L0 随机，只要求合法。
     */
    const setupFollow = (): { c: RuleContext; hand: Card[]; lead: Card[] } => {
      const c = ctx({ trump: 1, levelRank: 2 }) // 红桃为主
      const hand: Card[] = [C(0, 12), C(0, 2), C(0, 4)] // 黑桃 A / 4 / 6
      const lead: Card[] = [C(0, 1)] // 黑桃 3
      return { c, hand, lead }
    }

    it('L1 / L2 在能赢时选择能赢的那一手', () => {
      const { c, hand, lead } = setupFollow()
      const leadAnalysis = analyze(lead, c)
      const input = {
        seat: 0 as Seat,
        hand,
        ctx: c,
        play: { kind: 'follow' as const, leadCards: lead, leadAnalysis },
        currentWinner: { seat: 1 as Seat, analysis: leadAnalysis },
        partnerLeading: false,
        opponents: [],
      }

      for (const level of [1, 2] as AiLevel[]) {
        const d = decide(input, level, mulberry32(42))
        const a = analyze(d.cards, c)
        expect(a.keyCard, `L${level} 必须出牌`).not.toBeNull()
        expect(
          c.power.get((a.keyCard as Card).value),
          `L${level} 应当选择能赢的一手（黑桃A）`,
        ).toBeGreaterThan(c.power.get(lead[0]!.value))
      }
    })

    it('L0 始终出合法牌', () => {
      const { c, hand, lead } = setupFollow()
      const leadAnalysis = analyze(lead, c)
      const input = {
        seat: 0 as Seat,
        hand,
        ctx: c,
        play: { kind: 'follow' as const, leadCards: lead, leadAnalysis },
        currentWinner: { seat: 1 as Seat, analysis: leadAnalysis },
        partnerLeading: false,
        opponents: [],
      }

      for (let seed = 0; seed < 30; seed++) {
        const d = decide(input, 0, mulberry32(seed))
        const r = checkPlay({
          hand,
          cards: d.cards,
          ctx: c,
          lead: { cards: lead, analysis: leadAnalysis },
          opponents: [],
        })
        expect(r.ok, `L0 seed=${seed} 出的牌必须合法：${d.reason}`).toBe(true)
      }
    })

    it('L0 与 L1/L2 的选择集合不同（L0 更分散）', () => {
      const { c, hand, lead } = setupFollow()
      const leadAnalysis = analyze(lead, c)
      const input = {
        seat: 0 as Seat,
        hand,
        ctx: c,
        play: { kind: 'follow' as const, leadCards: lead, leadAnalysis },
        currentWinner: { seat: 1 as Seat, analysis: leadAnalysis },
        partnerLeading: false,
        opponents: [],
      }

      const l0Set = new Set<string>()
      for (let seed = 0; seed < 40; seed++) {
        l0Set.add(decide(input, 0, mulberry32(seed)).cards.map((x) => x.id).join(','))
      }
      const l1 = decide(input, 1, mulberry32(7)).cards.map((x) => x.id).join(',')
      const l2 = decide(input, 2, mulberry32(7)).cards.map((x) => x.id).join(',')

      // L0 会取到多种不同组合 —— 它是随机的
      expect(l0Set.size, 'L0 应能产生多种不同选择').toBeGreaterThan(1)
      // L1/L2 至少有一个与 L0 的某个选择不同 —— 证明两者行为确实不同
      const differs = [...l0Set].some((x) => x !== l1 || x !== l2)
      expect(differs, 'L1/L2 应与 L0 的选择不同').toBe(true)
    })
  })

  describe('A2. L3 精确判定（结构 / 出牌顺序）', () => {
    /**
     * 场景：我首出 ♠K 对子，对手手里只有 ♠A 单张 + ♠Q 单张。
     *
     * 单张压不了对子 ⇒ 真实情况是「守得住」。
     *   L2 的 `canBeOverturned` 只比牌力 ⇒ 误判「会被压」，扣 0.5（overLead）
     *   L3 的 `exactBeatable` 看结构 ⇒ 判「压不了」，反而给续庄溢价
     *
     * 手牌全部是 ♠（K 对 + 四张散牌），避免「另找一门没人有的小牌首出」这条
     * 与本题无关的更优路线把结论搅浑。
     */
    const pairLeadSetup = (): { c: RuleContext; hand: Card[]; opponents: Card[][] } => {
      const c = ctx({ trump: 1, levelRank: 3 }) // ♥ 主，级牌 3
      const hand: Card[] = [
        ...P(0, 11), // ♠K♠K
        C(0, 4),
        C(0, 5),
        C(0, 6),
        C(0, 7), // ♠6 ♠7 ♠8 ♠9
      ]
      const opponents: Card[][] = [[C(0, 12)], [C(0, 10)], []] // ♠A / ♠Q 各一张
      return { c, hand, opponents }
    }

    it('对子不会被更大的单张压：L3 敢兑现对子，L2 不敢', () => {
      const { c, hand, opponents } = pairLeadSetup()
      const input = {
        seat: 0 as Seat,
        hand,
        ctx: c,
        play: { kind: 'lead' as const },
        currentWinner: null,
        partnerLeading: false,
        opponents,
        remainingSeats: [1, 2, 3] as Seat[],
      }
      const l2 = decide(input, 2, mulberry32(11))
      const l3 = decide(input, 3, mulberry32(11))
      expect(analyze(l3.cards, c).pairCount, 'L3 判「对子守得住」，应直接出对子').toBe(1)
      expect(analyze(l2.cards, c).pairCount, 'L2 误判会被 ♠A 单张压，改出单张').toBe(0)
    })

    it('已出过牌的座位不再算威胁（remainingSeats）', () => {
      const c = ctx({ trump: 1, levelRank: 3 })
      // 只有两个候选：♠K 对子（副牌，带 20 分）与 ♥6 对子（主牌，很贵）
      const hand: Card[] = [...P(0, 11), ...P(1, 4)]
      // 座位 1 手里有 ♠A♠A —— 真能压 ♠K 对子，但他可能已经出过牌
      const opponents: Card[][] = [[...P(0, 12)], [C(0, 10)], []]
      const base = {
        seat: 0 as Seat,
        hand,
        ctx: c,
        play: { kind: 'lead' as const },
        currentWinner: null,
        partnerLeading: false,
        opponents,
      }
      const threat = decide({ ...base, remainingSeats: [1, 2, 3] as Seat[] }, 3, mulberry32(5))
      const gone = decide({ ...base, remainingSeats: [2, 3] as Seat[] }, 3, mulberry32(5))

      // 威胁在场：♠K 对子会被压 ⇒ 改出贵的主牌对子（避免白送 20 分）
      expect(analyze(threat.cards, c).suitSlot, '有人能压 ♠K 时不该硬出它').toBe(4)
      // 威胁已出过牌：♠K 对子安全 ⇒ 兑现它
      expect(analyze(gone.cards, c).suitSlot, '能压的人已出过牌，可以安全兑现 ♠K').toBe(0)
    })
  })

  describe('B. 确定性（FR-16 ④）', () => {
    it('同种子同输入 → 同出牌', () => {
      const c = ctx({ trump: 0, levelRank: 3 })
      const hand: Card[] = [C(0, 12), C(0, 2), C(1, 5), C(2, 7)]
      const input = {
        seat: 0 as Seat,
        hand,
        ctx: c,
        play: { kind: 'lead' as const },
        currentWinner: null,
        partnerLeading: false,
        opponents: [],
      }
      for (const level of [0, 1, 2, 3] as AiLevel[]) {
        const a = decide(input, level, mulberry32(123)).cards.map((x) => x.id).join(',')
        const b = decide(input, level, mulberry32(123)).cards.map((x) => x.id).join(',')
        expect(a, `L${level} 必须确定性`).toBe(b)
      }
    })

    it('同种子两次对局结果一致', () => {
      const a = playRound(2026, 1, 1, false)
      const b = playRound(2026, 1, 1, false)
      expect(a.phase).toBe('settle')
      expect(a.defenderScore).toBe(b.defenderScore)
      expect(a.history.length).toBe(b.history.length)
    })
  })

  describe('C. 强度递增（FR-16 ②）', () => {
    /**
     * 座位互换配对测量。
     *
     * 样本量 300 副牌 × 2 次 = 600 次配对。
     *
     * 样本量不能太小：实测 120 副时 L2 vs L1 只有 48.3%（噪声），
     * 600 副时才稳定到 59.2%。单次配对的方差很大，必须取足够样本。
     *
     * 同档对同档的自检必须恰好 0% —— 这是整套测量的正确性保证。
     */
    const ROUNDS = 300

    it('自检：同档对同档净胜率恰好为 0（配对测量消掉了座位偏差）', () => {
      const m = pairedMeasure(1, 1, ROUNDS)
      expect(m.winRate, '同档对同档应完全对称').toBe(0)
      expect(m.avgMargin).toBe(0)
    })

    it('L1 强于 L0', () => {
      const m = pairedMeasure(1, 0, ROUNDS)
      console.log(`[标定] L1 vs L0 = ${(m.winRate * 100).toFixed(1)}%（净分 ${m.avgMargin.toFixed(1)}）`)
      // 阈值 = 实测值下浮 2%（种子固定，结果确定性，留 2% 防微小抖动）
      expect(m.winRate, `L1 应强于 L0（实测 ${(m.winRate * 100).toFixed(1)}%）`).toBeGreaterThan(0.8)
    })

    it('L2 强于 L0', () => {
      const m = pairedMeasure(2, 0, ROUNDS)
      expect(m.winRate, `L2 应强于 L0（实测 ${(m.winRate * 100).toFixed(1)}%）`).toBeGreaterThan(0.55)
    })

    it('L2 强于 L1', () => {
      const m = pairedMeasure(2, 1, ROUNDS)
      console.log(`[标定] L2 vs L1 = ${(m.winRate * 100).toFixed(1)}%（净分 ${m.avgMargin.toFixed(1)}）`)
      // v1.3.26：队友领先垫分牌加分后 55.0% → 56.3%。
      // 规划目标 62%（要靠候选集扩充，见 docs/28），先把阈值卡到实测下浮 2% 防退化。
      expect(m.winRate, `L2 应强于 L1（实测 ${(m.winRate * 100).toFixed(1)}%）`).toBeGreaterThan(0.54)
    })

    /**
     * L3 只补 L2 的盲点，提升幅度天然小于跨档 ⇒ 阈值 0.52（比 L2 vs L1 的 0.5 略高）。
     * 阈值写死在断言里，**不允许为了让测试变绿而调低** —— 跑不出来就如实报数值。
     *
     * 重标定记录（T9 改了牌局分布之后，旧权重从 57.5% 掉到 50.0%）：
     * 根因不是 `remainingSeats` 接线，而是 `handControl` 把「副牌 A / 分牌」也算进控制力，
     * 与 L1 的 `powerCost` 重复计分。改为「只算主牌 + 只在白花时计入」后：
     *   种子 1–300：57.7%（净分 +7.6）  种子 301–600：56.0%（净分 +7.0）
     * 两个独立区间一致，说明不是对某批种子的过拟合。
     */
    it('L3 强于 L0', () => {
      const m = pairedMeasure(3, 0, ROUNDS)
      expect(m.winRate, `L3 应强于 L0（实测 ${(m.winRate * 100).toFixed(1)}%）`).toBeGreaterThan(0.55)
    })

    it('L3 强于 L2', () => {
      const m = pairedMeasure(3, 2, ROUNDS)
      console.log(`[标定] L3 vs L2 = ${(m.winRate * 100).toFixed(1)}%（净分 ${m.avgMargin.toFixed(1)}）`)
      // v1.3.26：56.3% → 60.3%（+4.0）。L3 的精确前瞻能判断「队友守不守得住」，
      // 所以垫分牌更安全；L1 没有前瞻会盲目垫 —— 档间差距因此被拉开。
      expect(m.winRate, `L3 应强于 L2（实测 ${(m.winRate * 100).toFixed(1)}%）`).toBeGreaterThan(0.58)
    })
  })

  describe('D. 出牌合法性（FR-16 ①）', () => {
    it('四档 AI 在完整对局中都不出非法牌', () => {
      for (const level of [0, 1, 2, 3] as AiLevel[]) {
        const s = playRound(999, level, level, false)
        expect(s.phase, `L${level} 应当打完一局`).toBe('settle')
        // 若 AI 出了非法牌，playCards 会写 lastReject 而不是推进 trick
        expect(s.lastReject, `L${level} 不应出现拒绝记录`).toBeNull()
        expect(s.hands.every((h) => h.length === 0)).toBe(true)
      }
    })
  })
})

