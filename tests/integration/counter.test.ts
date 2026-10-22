import { describe, it, expect } from 'vitest'
import { DEFAULT_RULE_CONFIG, makeDeck } from '@core'
import type { Card } from '@core'
import { declareTrump, passCounter } from '@app/game'
import { emptyState } from '@app/state'
import type { GameState } from '@app/state'

/**
 * 反主流转集成测试。
 *
 * 手工摆牌保证确定性：
 *   人类(0) 持 ♠3×2 + ♥3×2     → 能亮 ♠，声明 ♠ 后仍可反成 ♥
 *   AI1(1)  持 ♣3×2 + 5 张 ♣   → 会反成 ♣（满足「该花色 ≥5 张」门槛）
 *   AI2(2)  持 ♦3×2 但只有 4 张 ♦ → 不反
 *   AI3(3)  无级牌              → 不反
 *
 * 注意：修复「亮主必须持该门级牌」之后，人类要亮 ♠ 就必须真的持 ♠3，
 * 所以这里给人类同时发 ♠3×2 与 ♥3×2（原来是只有 ♥3 就亮 ♠，属于非法亮主）。
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
  const ai3 = pick((c) => c.value !== V.spade3 && c.value !== V.heart3 && c.value !== V.club3 && c.value !== V.diamond3, 25)
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

describe('反主流转', () => {
  it('人类亮 ♠ → AI1 反成 ♣ → 人类拿到「可反成 ♥」的选项', () => {
    const s = declareTrump(setup(), 0) // 亮 ♠
    expect(s.phase).toBe('contract')
    expect(s.counterPending).toBe(true)
    expect(s.trump).toBe(2) // ♣（被 AI1 反掉）
    expect(s.usedTrumps).toEqual([0, 2])
    expect(s.trumpDeclarer).toBe(1)
    expect(s.counterOptions).toEqual([1]) // 只剩 ♥ 可反
    expect(s.declareOptions).toEqual([]) // 反主阶段亮主清单已失效
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

  it('人类反成 ♥ → 主变为 ♥，且不再有反主选项', () => {
    const s = declareTrump(setup(), 0)
    const after = declareTrump(s, 1) // 反成 ♥
    expect(after.trump).toBe(1)
    expect(after.counterPending).toBe(false)
    expect(after.counterOptions).toEqual([])
    expect(after.usedTrumps).toEqual([0, 2, 1])
  })

  it('没有别门级牌时，亮主后立刻进入出牌（不会被卡在反主）', () => {
    const s0 = setup()
    // 把人类手里的 ♥3 换成普通牌
    const human = (s0.hands[0] as Card[]).filter((c) => c.value !== V.heart3)
    const s: GameState = {
      ...s0,
      hands: [human, s0.hands[1] as Card[], s0.hands[2] as Card[], s0.hands[3] as Card[]],
    }
    const after = declareTrump(s, 0)
    expect(after.counterPending).toBe(false)
    expect(after.counterOptions).toEqual([])
    expect(after.phase === 'bury' || after.phase === 'play').toBe(true)
  })

  it('不能反成同一门已被用过的花色', () => {
    const s = declareTrump(setup(), 0) // 已用 ♠(0) ♣(2)
    // 人类想反成 ♠ —— 已被用过，应被拒
    const after = declareTrump(s, 0)
    expect(after.lastReject?.reason).toBe('cannot-counter')
    expect(after.trump).toBe(2) // 主没变
  })

  it('人类不能反自己刚亮的主（trumpDeclarer 是自己时无选项）', () => {
    // 构造一个 AI 不会反、人类也没有别门级牌的场景 —— 直接把 AI1 的 ♣3 去掉
    const s0 = setup()
    const ai1 = (s0.hands[1] as Card[]).filter((c) => c.value !== V.club3)
    const s: GameState = {
      ...s0,
      hands: [s0.hands[0] as Card[], ai1, s0.hands[2] as Card[], s0.hands[3] as Card[]],
    }
    const after = declareTrump(s, 0)
    // AI 没反 ⇒ 定主人是人类 ⇒ 即使人类手里有 ♥3 也不该弹反主
    expect(after.counterPending).toBe(false)
    expect(after.trump).toBe(0)
  })
})
