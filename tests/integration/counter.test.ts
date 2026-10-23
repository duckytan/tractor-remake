import { describe, it, expect } from 'vitest'
import { DEFAULT_RULE_CONFIG, makeDeck } from '@core'
import type { Card, Seat } from '@core'
import { declareTrump, guardTrump, passCounter } from '@app/game'
import { emptyState } from '@app/state'
import type { GameState } from '@app/state'

/**
 * 反主 / 加固流转集成测试（v1.2 张数阶梯）。
 *
 * 手工摆牌保证确定性：
 *   人类(0) 持 ♠3×2 + ♥3×2      → 能亮 ♠；被反后还需 3 张才能再反（拿不到）
 *   AI1(1)  持 ♣3×2 + 5 张 ♣     → 满足「2 张级牌 + 该门 ≥5 张」⇒ 会反成 ♣
 *   AI2(2)  持 ♦3×2 但只有 4 张 ♦ → 张数够 2 张但不愿反（<5 张）
 *   AI3(3)  无级牌                → 不反
 *
 * 张数阶梯：首次亮主 1 张 → 反主需 2 张 → 再反需 3 张（每门只有 2 张 ⇒ 不可达 = 锁死）。
 */

const LV = 3
const R = (LV + 11) % 13 // 级牌 3 → rank 下标 1
const V = { spade3: 0 * 13 + R, heart3: 1 * 13 + R, club3: 2 * 13 + R, diamond3: 3 * 13 + R }

function buildHands(): { hands: Card[][]; bottom: Card[] } {
  const deck = makeDeck()
  const used = new Set<number>()
  const pick = (pred: (c: Card) => boolean, n: number): Card[] => {
    const out: Card[] = []
    for (const c of deck) {
      if (out.length >= n) break
      if (!used.has(c.id) && pred(c)) {
        out.push(c)
        used.add(c.id)
      }
    }
    return out
  }
  const isClub = (c: Card) => Math.floor(c.value / 13) === 2 && c.value < 52
  const isDiamond = (c: Card) => Math.floor(c.value / 13) === 3 && c.value < 52

  const human = [...pick((c) => c.value === V.spade3, 2), ...pick((c) => c.value === V.heart3, 2)] // ♠3 ×2 + ♥3 ×2
  const ai1 = [...pick((c) => c.value === V.club3, 2), ...pick(isClub, 5)] // ♣3 ×2 + 5 张 ♣
  const ai2 = [...pick((c) => c.value === V.diamond3, 2), ...pick(isDiamond, 2)] // ♦3 ×2 + 2 张 ♦ = 4 张（<5，不反）

  // 补齐 25 张（AI3 拿剩余，确保不带任何级牌）
  human.push(...pick(() => true, 25 - human.length))
  ai1.push(...pick(() => true, 25 - ai1.length))
  ai2.push(...pick(() => true, 25 - ai2.length))
  const ai3 = pick(
    (c) => c.value !== V.spade3 && c.value !== V.heart3 && c.value !== V.club3 && c.value !== V.diamond3,
    25,
  )
  const bottom = pick(() => true, 8)
  return { hands: [human, ai1, ai2, ai3], bottom }
}

function setup(): GameState {
  const { hands, bottom } = buildHands()
  return {
    ...emptyState(),
    phase: 'contract',
    dealer: 1,
    levelRank: LV,
    levels: { a: LV, b: LV },
    hands,
    bottom,
    config: DEFAULT_RULE_CONFIG,
  }
}

/** 复制一份状态并替换某座位的手牌 */
function withHand(s: GameState, seat: Seat, hand: readonly Card[]): GameState {
  const hands = s.hands.map((h) => [...h])
  hands[seat] = [...hand]
  return { ...s, hands }
}

/** 删掉手里第一张指定牌值的牌（模拟「只持 1 张级牌」） */
function dropOne(hand: readonly Card[], value: number): Card[] {
  const i = hand.findIndex((c) => c.value === value)
  return i < 0 ? [...hand] : [...hand.slice(0, i), ...hand.slice(i + 1)]
}

/** 造一个「AI1 已经用 1 张 ♣3 定了 ♣」的定主阶段（人类还持 ♥3×2） */
function aiDeclaredClub(): GameState {
  return {
    ...setup(),
    trump: 2,
    trumpDeclarer: 1,
    trumpCount: 1,
    usedTrumps: [2],
    counterPending: true,
    counterOptions: [1],
  }
}

describe('反主 / 加固流转', () => {
  it('人类亮 ♠（1 张）→ AI1 反成 ♣（2 张）→ 门槛升到 3 张，人类反不动 ⇒ 直接进定约', () => {
    const s = declareTrump(setup(), 0) // 亮 ♠
    expect(s.trump).toBe(2) // ♣（被 AI1 反掉）
    expect(s.usedTrumps).toEqual([0, 2])
    expect(s.trumpDeclarer).toBe(1)
    expect(s.trumpCount).toBe(2) // 反主 = 2 张
    expect(s.guardBy).toBeNull()
    // 人类只有 ♥3×2，门槛要 3 张 ⇒ 没有反主选项，也不再等人类
    expect(s.counterOptions).toEqual([])
    expect(s.counterPending).toBe(false)
    expect(s.phase === 'bury' || s.phase === 'play').toBe(true)
  })

  it('AI1 只持 1 张 ♣3 ⇒ 反不动（门槛 2 张），人类保持 ♠ 定主', () => {
    const s0 = setup()
    const s1 = withHand(s0, 1, dropOne(s0.hands[1] as readonly Card[], V.club3))
    const s = declareTrump(s1, 0)
    expect(s.trump).toBe(0) // 还是 ♠
    expect(s.trumpDeclarer).toBe(0)
    expect(s.trumpCount).toBe(1)
    expect(s.usedTrumps).toEqual([0])
  })

  it('人类放弃反主 → 定约生效，进入埋底/出牌', () => {
    const s = declareTrump(setup(), 0)
    const after = passCounter(s)
    expect(after.counterPending).toBe(false)
    expect(after.phase === 'bury' || after.phase === 'play').toBe(true)
    // 庄家（AI1）收底后 33 张，自动扣 8 张
    expect(after.hands[1]?.length).toBe(25)
    expect(after.bottom.length).toBe(8)
  })

  it('人类反成 ♥（持 2 张 ♥3、门槛 2 张）→ 主变 ♥，张数抬到 2', () => {
    const after = declareTrump(aiDeclaredClub(), 1)
    expect(after.trump).toBe(1)
    expect(after.trumpDeclarer).toBe(0)
    expect(after.trumpCount).toBe(2)
    expect(after.usedTrumps).toEqual([2, 1])
    expect(after.counterPending).toBe(false)
    expect(after.counterOptions).toEqual([])
  })

  it('门槛已是 2 张时，人类只持 2 张 ♥3 也反不动（需 3 张）', () => {
    const s: GameState = { ...aiDeclaredClub(), trumpCount: 2, counterOptions: [] }
    const after = declareTrump(s, 1)
    expect(after.lastReject?.reason).toBe('cannot-counter')
    expect(after.trump).toBe(2) // 主没变
    expect(after.trumpCount).toBe(2)
  })

  it('不能反成同一门已被用过的花色', () => {
    const after = declareTrump(aiDeclaredClub(), 2) // ♣ 已经用过
    expect(after.lastReject?.reason).toBe('cannot-counter')
    expect(after.trump).toBe(2)
  })

  it('人类不能反自己刚亮的主（trumpDeclarer 是自己时无选项）', () => {
    const s0 = setup()
    const s1 = withHand(s0, 1, dropOne(s0.hands[1] as readonly Card[], V.club3))
    const s = declareTrump(s1, 0)
    expect(s.counterPending).toBe(false)
    expect(s.trump).toBe(0)
  })

  it('人类加固：队友（座位 2）定主 + 人类持同花色 2 张级牌 ⇒ 张数 1→2', () => {
    // 造一个「北家(2) 用 1 张 ♠3 定了 ♠」的局面：人类是北家的队友
    const s0 = setup()
    const north = [...(s0.hands[2] as readonly Card[]), ...(s0.hands[1] as readonly Card[]).slice(0, 2)]
    const s1: GameState = {
      ...withHand(s0, 2, north),
      trump: 0,
      trumpDeclarer: 2,
      trumpCount: 1,
      usedTrumps: [0],
      counterPending: true,
      counterOptions: [],
      guardOption: true,
    }
    const after = guardTrump(s1)
    expect(after.trumpCount).toBe(2)
    expect(after.guardBy).toBe(0)
    expect(after.counterPending).toBe(false)
    expect(after.guardOption).toBe(false)
    expect(after.phase === 'bury' || after.phase === 'play').toBe(true)
  })

  it('没有加固选项时 guard 是 no-op', () => {
    const s = { ...aiDeclaredClub(), guardOption: false }
    const after = guardTrump(s)
    expect(after).toBe(s)
  })
})
