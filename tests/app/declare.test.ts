/**
 * 亮主持牌校验（修复 2）
 *
 * 规则依据：
 *   - 花色主：smallnest/Tractor `Algorithm.cs:157-178` —— 首次亮主必须持该门级牌。
 *   - 无将：`Algorithm.cs:211` —— 必须持**一对王**（一对小王 或 一对大王）。
 *     重制版另留一个兜底：一个选项都没有时仍放行无将，避免定主面板 5 个按钮全灰卡死。
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_RULE_CONFIG, SMALL_JOKER, hasJokerPair, isJokerValue, levelRankToRankIndex, makeDeck } from '@core'
import type { Card, Suit, Trump } from '@core'
import { declareTrump, newGame } from '@app/game'
import { HUMAN_SEAT, emptyState } from '@app/state'
import type { GameState } from '@app/state'

const LV = 3
const R = levelRankToRankIndex(LV) ?? 0 // 级牌 3 → 点数下标 1
const V = {
  spade3: 0 * 13 + R,
  heart3: 1 * 13 + R,
  club3: 2 * 13 + R,
  diamond3: 3 * 13 + R,
}
const LEVEL_VALUES = new Set<number>([V.spade3, V.heart3, V.club3, V.diamond3])

/**
 * 造一个只有人类有手牌、且人类只持 ♥3 的定主阶段。
 *
 * `smallJokers` 指定补几张**小王**：0（默认）⇒ 没有一对王 ⇒ 亮不了无将；
 * 2 ⇒ 一对小王 ⇒ 无将可选。
 */
function stateWithOnlyHeartLevel(smallJokers = 0): GameState {
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
  const human = [
    ...pick((c) => c.value === V.heart3, 2), // ♥3 ×2
    ...pick((c) => c.value === SMALL_JOKER, smallJokers), // 小王（一对才能亮无将）
    // 补齐 25 张：不带任何级牌，也不带王（王由上面单独控制，免得用例之间互相干扰）
    ...pick((c) => !LEVEL_VALUES.has(c.value) && !isJokerValue(c.value), 25 - 2 - smallJokers),
  ]
  return {
    ...emptyState(),
    phase: 'contract',
    dealer: 1,
    levelRank: LV,
    levels: { a: LV, b: LV },
    config: DEFAULT_RULE_CONFIG,
    hands: [human, [], [], []],
    bottom: [],
    // 无将只在持一对王时可选
    declareOptions: smallJokers >= 2 ? [1, 'NT'] : [1],
  }
}

describe('亮主必须持该门级牌', () => {
  it('只持 ♥3 时亮 ♠ 被拒，主不变', () => {
    const s = stateWithOnlyHeartLevel()
    const after = declareTrump(s, 0) // ♠
    expect(after.lastReject?.reason).toBe('cannot-counter')
    expect(after.trump).toBe('NT') // 主没变
    expect(after.trumpDeclarer).toBeNull()
    expect(after.usedTrumps).toEqual([])
  })

  it('只持 ♥3 时亮 ♥ 成功', () => {
    const s = stateWithOnlyHeartLevel()
    const after = declareTrump(s, 1) // ♥
    expect(after.lastReject).toBeNull()
    expect(after.trump).toBe(1)
    expect(after.trumpDeclarer).toBe(HUMAN_SEAT)
    expect(after.usedTrumps).toEqual([1])
  })

  it('没有一对王时亮无将被拒（v1.2.8：无将需一对王）', () => {
    const s = stateWithOnlyHeartLevel() // ♥3 ×2，但一张王都没有
    const after = declareTrump(s, 'NT')
    expect(after.lastReject?.reason).toBe('cannot-counter')
    expect(after.trumpDeclarer).toBeNull()
    expect(after.usedTrumps).toEqual([])
  })

  it('只有一张王不算一对，亮无将仍被拒', () => {
    const s = stateWithOnlyHeartLevel(1)
    expect(declareTrump(s, 'NT').lastReject?.reason).toBe('cannot-counter')
  })

  it('持一对小王时亮无将成功', () => {
    const s = stateWithOnlyHeartLevel(2)
    const after = declareTrump(s, 'NT')
    expect(after.lastReject).toBeNull()
    expect(after.trump).toBe('NT')
    expect(after.usedTrumps).toEqual(['NT'])
  })
})

describe('第 1 局抢庄（首个亮主者坐庄）', () => {
  it('人类首个亮主 → 庄家变成人类，并进入埋底', () => {
    const s = stateWithOnlyHeartLevel()
    expect(s.dealer).toBe(1) // 原始庄家是 AI
    const after = declareTrump(s, 1) // 亮 ♥
    expect(after.trumpDeclarer).toBe(HUMAN_SEAT)
    expect(after.dealer).toBe(HUMAN_SEAT)
    expect(after.phase).toBe('bury') // 人类坐庄 ⇒ 手动扣底
  })

  it('第 2 局不再抢庄（庄家由轮庄决定）', () => {
    const s: GameState = { ...stateWithOnlyHeartLevel(), round: 2 }
    const after = declareTrump(s, 1)
    expect(after.dealer).toBe(1) // 保持原庄家
  })

  it('双方级牌不同时不抢庄（否则换庄会改变本局级牌）', () => {
    const s: GameState = { ...stateWithOnlyHeartLevel(), levels: { a: LV, b: 5 } }
    const after = declareTrump(s, 1)
    expect(after.dealer).toBe(1)
    expect(after.levelRank).toBe(LV) // 级牌没被换庄带跑
  })
})

describe('declareOptions 由 startRound 按手牌算好', () => {
  it('清单里的每个花色都对应手里真有该门级牌；无将只在持一对王时出现', () => {
    let sawDeclare = 0
    for (const seed of [7, 42, 2024, 88888, 1, 2, 3, 4, 5, 6, 11, 12, 13, 14, 15]) {
      const s = newGame(DEFAULT_RULE_CONFIG, 1, 0, seed)
      // 第 1 局 AI 可能抢庄成功：
      //   ① 人类能反主 → 停在反主阶段，此时 declareOptions 应为空（只能反主）
      //   ② 人类不能反主 → 直接进入埋底/出牌
      if (s.counterPending) {
        expect(s.declareOptions, `seed ${seed}: 反主阶段不该有亮主选项`).toEqual([])
        continue
      }
      if (s.phase !== 'contract') {
        expect(s.usedTrumps.length, `seed ${seed}: 非定主阶段说明已有人亮主`).toBeGreaterThan(0)
        continue
      }
      sawDeclare++
      const hand = s.hands[HUMAN_SEAT] as readonly Card[]
      // 无将：持一对王才出现；一个花色都亮不了时兜底放行（见 humanDeclareOptions）
      const suitOpts = s.declareOptions.filter((t) => t !== 'NT')
      expect(
        s.declareOptions.includes('NT'),
        `seed ${seed}: 无将选项应与「一对王 / 无花色可选」一致`,
      ).toBe(hasJokerPair(hand) || suitOpts.length === 0)

      const lv = levelRankToRankIndex(s.levelRank) ?? 0
      for (const t of s.declareOptions) {
        if (t === 'NT') continue
        expect(
          hand.some((c) => c.value === (t as Suit) * 13 + lv),
          `seed ${seed}: 可选 ${String(t)} 就必须持该门级牌`,
        ).toBe(true)
      }
      // 反向：手里有级牌的花色也必须在清单里（不能漏选项）
      for (const suit of [0, 1, 2, 3] as Suit[]) {
        const holds = hand.some((c) => c.value === suit * 13 + lv)
        expect(s.declareOptions.includes(suit as Trump), `seed ${seed}: ${suit} 选项应与持牌一致`).toBe(holds)
      }
    }
    // 至少要有一个 seed 走到「人类自己定主」的路径，否则这个用例什么都没验到
    expect(sawDeclare).toBeGreaterThan(0)
  })

  it('打王级（强制无将）时只有无将可选', () => {
    const base = newGame(DEFAULT_RULE_CONFIG, 1, 0, 5)
    // 重置定主相关字段：newGame 可能已被 AI 抢庄，这里要一个干净的「打王级待亮主」状态
    const s: GameState = {
      ...base,
      phase: 'contract',
      forcedNT: true,
      levelRank: 18,
      trump: 'NT',
      trumpDeclarer: null,
      usedTrumps: [],
      counterPending: false,
      counterOptions: [],
      declareOptions: ['NT'],
    }
    expect(declareTrump(s, 'NT').trump).toBe('NT')
    // 点花色也只会被强制成无将，不会因「没有级牌」被拒
    const after = declareTrump(s, 0)
    expect(after.lastReject).toBeNull()
    expect(after.trump).toBe('NT')
  })
})
