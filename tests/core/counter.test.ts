import { describe, it, expect } from 'vitest'
import { buildPowerTable, canCounter, canGuard, counterNeed, levelCardCount } from '@core'
import type { Card, LevelRank, RuleConfig, RuleContext, Trump } from '@core'

/**
 * 反主判定 `canCounter` —— 对齐原版 `FUN_004163A2`（规则书 §3.3）。
 * 核心规则：必须持有「新花色的级牌」。
 *
 * 牌值编码：suit*13 + rank，0=♠ 1=♥ 2=♣ 3=♦；rank 0..12 ↔ 2,3,…,K,A。
 * 级牌 LevelRank=3 ⇒ rank 下标 (3+11)%13 = 1。
 */

const mk = (value: number, id: number): Card => ({ id, value })

const cfg = (patch: Partial<RuleConfig> = {}): RuleConfig => ({
  allowSelfCounter: true,
  twoAsPermanent: false,
  allowPartnerGuard: false,
  allowCounterNT: false,
  guardScoreLevels: false,
  guardJack: true,
  guardAce: true,
  guardKingLevel: true,
  ...patch,
})

function ctxOf(trump: Trump, levelRank: LevelRank, patch: Partial<RuleConfig> = {}): RuleContext {
  return {
    power: buildPowerTable({ mode: 0, levelRank, trump, forcedNT: levelRank === 18 }),
    trump,
    levelRank,
    config: cfg(patch),
    forcedNT: levelRank === 18,
  }
}

const base = { sameTeamAsDeclarer: false, usedTrumps: [] as readonly Trump[] }

describe('canCounter —— 反主判定', () => {
  it('持有新花色级牌 → 可反', () => {
    const hand = [mk(1, 1), mk(40, 2)] // ♠3 + ♣A
    expect(canCounter({ ...base, hand, ctx: ctxOf(0, 3), currentTrump: 1, newTrump: 0 })).toBe(true)
  })

  it('不持有新花色级牌 → 不可反', () => {
    const hand = [mk(1, 1)] // 只有 ♠3，想反成 ♣
    expect(canCounter({ ...base, hand, ctx: ctxOf(0, 3), currentTrump: 1, newTrump: 2 })).toBe(
      false,
    )
  })

  it('级牌是 2 时，认的是 2 而不是 3', () => {
    // LevelRank=2 ⇒ rank 下标 (2+11)%13 = 0 ⇒ ♣2 = 2*13+0 = 26
    expect(
      canCounter({ ...base, hand: [mk(26, 1)], ctx: ctxOf(0, 2), currentTrump: 1, newTrump: 2 }),
    ).toBe(true)
    // 手里只有 ♣3 不够
    expect(
      canCounter({ ...base, hand: [mk(27, 1)], ctx: ctxOf(0, 2), currentTrump: 1, newTrump: 2 }),
    ).toBe(false)
  })

  it('不能反成当前同一个主', () => {
    expect(
      canCounter({ ...base, hand: [mk(1, 1)], ctx: ctxOf(0, 3), currentTrump: 0, newTrump: 0 }),
    ).toBe(false)
  })

  it('同一门已被反过 → 不可再反（保证终止）', () => {
    expect(
      canCounter({
        ...base,
        hand: [mk(1, 1)],
        ctx: ctxOf(0, 3),
        currentTrump: 2,
        newTrump: 0,
        usedTrumps: [0, 2],
      }),
    ).toBe(false)
  })

  it('同队反主：关「允许自反」时不可反，开时可反', () => {
    const hand = [mk(1, 1)]
    expect(
      canCounter({
        ...base,
        hand,
        ctx: ctxOf(0, 3, { allowSelfCounter: false }),
        currentTrump: 1,
        newTrump: 0,
        sameTeamAsDeclarer: true,
      }),
    ).toBe(false)
    expect(
      canCounter({
        ...base,
        hand,
        ctx: ctxOf(0, 3, { allowSelfCounter: true }),
        currentTrump: 1,
        newTrump: 0,
        sameTeamAsDeclarer: true,
      }),
    ).toBe(true)
  })

  it('普通级不能反成无将（无将没有级牌可依）', () => {
    expect(
      canCounter({ ...base, hand: [mk(52, 1), mk(53, 2)], ctx: ctxOf(0, 3), currentTrump: 0, newTrump: 'NT' }),
    ).toBe(false)
  })

  it('打王级（强制无将）：主牌固定，持王也不能反', () => {
    const hand = [mk(53, 1), mk(52, 2)]
    expect(
      canCounter({
        ...base,
        hand,
        ctx: ctxOf('NT', 18, { allowCounterNT: true }),
        currentTrump: 'NT',
        newTrump: 0,
      }),
    ).toBe(false)
  })
})

/* ================================================================
 * v1.2 张数阶梯：反主需「当前张数 + 1」张，加固把张数 1 抬到 2
 * ================================================================ */

/** ♠3 的两张（级牌 LevelRank=3 ⇒ rank 下标 1 ⇒ value = 0*13+1 = 1） */
const SPADE3_A = mk(1, 101)
const SPADE3_B = mk(1, 102)

describe('levelCardCount —— 某门级牌的张数（0..2）', () => {
  const c = ctxOf(0, 3)

  it('没有该门级牌 → 0', () => {
    expect(levelCardCount({ hand: [mk(14, 1), mk(27, 2)], ctx: c, trump: 0 })).toBe(0)
  })

  it('单张 → 1', () => {
    expect(levelCardCount({ hand: [SPADE3_A, mk(14, 2)], ctx: c, trump: 0 })).toBe(1)
  })

  it('一对 → 2', () => {
    expect(levelCardCount({ hand: [SPADE3_A, SPADE3_B], ctx: c, trump: 0 })).toBe(2)
  })

  it('无将 / 打王级没有级牌可依 → 0', () => {
    expect(levelCardCount({ hand: [SPADE3_A, SPADE3_B], ctx: c, trump: 'NT' })).toBe(0)
    expect(
      levelCardCount({ hand: [SPADE3_A, SPADE3_B], ctx: ctxOf('NT', 18), trump: 0 }),
    ).toBe(0)
  })
})

describe('counterNeed —— 门槛 = 当前张数 + 1', () => {
  it('0→1、1→2、2→3（3 张不可达 = 锁死）', () => {
    expect(counterNeed(0)).toBe(1)
    expect(counterNeed(1)).toBe(2)
    expect(counterNeed(2)).toBe(3)
  })

  it('非法输入按 0 处理，不产生 < 1 的门槛', () => {
    expect(counterNeed(-5)).toBe(1)
    expect(counterNeed(Number.NaN)).toBe(1)
  })
})

describe('canCounter 带 currentCount —— 张数阶梯', () => {
  const one = {
    ...base,
    hand: [SPADE3_A],
    ctx: ctxOf(0, 3),
    currentTrump: 1 as Trump,
    newTrump: 0 as Trump,
  }
  const two = {
    ...base,
    hand: [SPADE3_A, SPADE3_B],
    ctx: ctxOf(0, 3),
    currentTrump: 1 as Trump,
    newTrump: 0 as Trump,
  }

  it('缺省 currentCount = 旧语义「持 1 张即可反」', () => {
    expect(canCounter(one)).toBe(true)
    expect(canCounter(two)).toBe(true)
  })

  it('currentCount=1：只持 1 张不能反，持 2 张能反', () => {
    expect(canCounter({ ...one, currentCount: 1 })).toBe(false)
    expect(canCounter({ ...two, currentCount: 1 })).toBe(true)
  })

  it('currentCount=2：持 2 张也不能反（门槛 3 不可达）', () => {
    expect(canCounter({ ...two, currentCount: 2 })).toBe(false)
  })
})

describe('canGuard —— 队友加固（把张数 1 抬到 2）', () => {
  const guardCtx = ctxOf(0, 3, { allowPartnerGuard: true })
  const pair = { hand: [SPADE3_A, SPADE3_B], ctx: guardCtx, currentTrump: 0 as Trump }

  it('同队 + 一对同花色 → 可加固', () => {
    // 座位 0 与 2 同队；♠ 是当前主
    expect(canGuard({ ...pair, declarer: 0, seat: 2, currentCount: 1 })).toBe(true)
  })

  it('不同队 → 不可加固', () => {
    expect(canGuard({ ...pair, declarer: 0, seat: 1, currentCount: 1 })).toBe(false)
  })

  it('关掉 allowPartnerGuard → 不可加固', () => {
    expect(
      canGuard({
        ...pair,
        ctx: ctxOf(0, 3, { allowPartnerGuard: false }),
        declarer: 0,
        seat: 2,
        currentCount: 1,
      }),
    ).toBe(false)
  })

  it('currentCount=2 → 不可加固（门槛 3 不可达）', () => {
    expect(canGuard({ ...pair, declarer: 0, seat: 2, currentCount: 2 })).toBe(false)
  })

  it('还没人亮主（currentCount=0）→ 无主可加', () => {
    expect(canGuard({ ...pair, declarer: 0, seat: 2, currentCount: 0 })).toBe(false)
  })

  it('只持 1 张 → 可加固（门槛是 1 张，不是 counterNeed）', () => {
    // 每门级牌总共只有 2 张，定主人已占走 ≥1 张 ⇒ 队友最多只剩 1 张。
    // 门槛若取 2 张则结构性不可达，所以必须是 1 张。见 core/counter.ts 的 canGuard 注释。
    expect(
      canGuard({ ...pair, hand: [SPADE3_A], declarer: 0, seat: 2, currentCount: 1 }),
    ).toBe(true)
  })

  it('一张级牌都没有 → 不可加固', () => {
    // value 5 = ♠7，不是任何门级牌（级牌 rank 下标 1 ⇒ value%13===1）
    expect(
      canGuard({ ...pair, hand: [mk(5, 1), mk(5, 2)], declarer: 0, seat: 2, currentCount: 1 }),
    ).toBe(false)
  })

  it('持的是别门级牌 → 不可加固（必须同花色）', () => {
    // ♥3 = 1*13+1 = 14；当前主是 ♠
    expect(
      canGuard({ ...pair, hand: [mk(14, 1), mk(14, 2)], declarer: 0, seat: 2, currentCount: 1 }),
    ).toBe(false)
  })

  it('当前主是无将 / 打王级 → 不可加固', () => {
    expect(
      canGuard({ ...pair, currentTrump: 'NT', declarer: 0, seat: 2, currentCount: 1 }),
    ).toBe(false)
    expect(
      canGuard({
        ...pair,
        ctx: ctxOf('NT', 18, { allowPartnerGuard: true }),
        declarer: 0,
        seat: 2,
        currentCount: 1,
      }),
    ).toBe(false)
  })

  it('定主人不能给自己加固', () => {
    expect(canGuard({ ...pair, declarer: 2, seat: 2, currentCount: 1 })).toBe(false)
  })
})
